/**
 * Testes da API pela borda HTTP real (`app.inject`), não chamando os serviços.
 *
 * Cobre o que só quebra na fronteira: validação zod, códigos de status, formato
 * do envelope de escrita e a geração do OpenAPI que alimenta o `/docs`.
 *
 * ⚠️ A API usa o singleton `getDb()`, que lê `DATABASE_PATH` no momento em que o
 * módulo de configuração é carregado. Por isso este arquivo só faz import
 * estático de `node:test` e de tipos: a variável de ambiente é apontada para um
 * arquivo temporário **antes** dos imports dinâmicos, senão o teste rodaria
 * contra o banco de verdade.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const tempDir = mkdtempSync(join(tmpdir(), 'financas-api-test-'));
process.env.DATABASE_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// Autenticação desligada: o teste roda em loopback, e `authConfig()` só permite
// desligar nessa condição. A proteção de exposição na rede é testada em auth.test.ts.
process.env.HOST = '127.0.0.1';
process.env.AUTH_DISABLED = 'true';

let app: FastifyInstance;
let closeDb: () => void;

before(async () => {
  const [{ buildApp }, dbClient, { runMigrations }, { bootstrap }] = await Promise.all([
    import('../../src/api/app.js'),
    import('../../src/db/client.js'),
    import('../../src/db/migrate.js'),
    import('../../src/db/bootstrap.js'),
  ]);

  closeDb = dbClient.closeDb;
  const db = dbClient.getDb();
  runMigrations(db);
  bootstrap(db);

  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  closeDb?.();
  rmSync(tempDir, { recursive: true, force: true });
});

async function post(url: string, payload: unknown = {}): Promise<{ status: number; body: any }> {
  const response = await app.inject({ method: 'POST', url, payload: payload as object });
  return { status: response.statusCode, body: response.json() };
}

async function get(url: string): Promise<{ status: number; body: any }> {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() };
}

describe('sistema', () => {
  test('GET /health toca o banco e responde', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('GET /openapi.json documenta as rotas', async () => {
    const { status, body } = await get('/openapi.json');
    assert.equal(status, 200);

    const paths = Object.keys(body.paths);
    for (const expected of ['/accounts', '/transactions', '/transfers', '/balances', '/change-sets']) {
      assert.ok(paths.includes(expected), `rota ${expected} deveria estar documentada`);
    }
  });

  test('GET /docs serve a interface', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/' });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /html/);
  });

  test('rota inexistente devolve 404 com corpo padronizado', async () => {
    const { status, body } = await get('/nao-existe');
    assert.equal(status, 404);
    assert.equal(body.error, 'NOT_FOUND');
  });

  test('GET /integrity não acusa problema', async () => {
    const { status, body } = await get('/integrity');
    assert.equal(status, 200);
    assert.equal(body.ok, true, JSON.stringify(body.issues));
  });

  test('bootstrap deixou as categorias padrão disponíveis', async () => {
    const { body } = await get('/categories/tree?kind=expense');
    assert.ok(body.length >= 10, 'deveria haver categorias de despesa prontas');
    const food = body.find((c: any) => c.name === 'Alimentação');
    assert.ok(food, 'Alimentação deveria existir');
    assert.ok(food.children.some((c: any) => c.name === 'Supermercado'));
  });
});

describe('validação na borda', () => {
  let accountId: string;

  before(async () => {
    const { body } = await post('/accounts', {
      name: 'Conta de Validação',
      kind: 'checking',
      openingDate: '2026-01-01',
    });
    accountId = body.data.id;
  });

  test('corpo inválido devolve 400 com o campo que falhou', async () => {
    const { status, body } = await post('/accounts', { name: '', kind: 'inexistente' });
    assert.equal(status, 400);
    assert.equal(body.error, 'VALIDATION');
    assert.ok(Array.isArray(body.details.issues));
  });

  test('valor monetário fracionário é recusado', async () => {
    const { status, body } = await post('/transactions', {
      accountId,
      type: 'expense',
      date: '2026-07-10',
      amountCents: 45.9, // centavos são inteiros
      description: 'Errado',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'VALIDATION');
  });

  test('data em formato brasileiro é recusada — a API usa AAAA-MM-DD', async () => {
    const { status } = await post('/transactions', {
      accountId,
      type: 'expense',
      date: '26/07/2026',
      amountCents: 1000,
      description: 'Errado',
    });
    assert.equal(status, 400);
  });

  test('data impossível é recusada', async () => {
    const { status } = await post('/transactions', {
      accountId,
      type: 'expense',
      date: '2026-02-30',
      amountCents: 1000,
      description: 'Errado',
    });
    assert.equal(status, 400);
  });

  test('valor zero é recusado', async () => {
    const { status } = await post('/transactions', {
      accountId,
      type: 'expense',
      date: '2026-07-10',
      amountCents: 0,
      description: 'Errado',
    });
    assert.equal(status, 400);
  });
});

describe('fluxo completo de uso', () => {
  test('cria conta, lança gasto, confere saldo e desfaz', async () => {
    const created = await post('/accounts', {
      name: 'Conta do Fluxo',
      kind: 'checking',
      openingBalanceCents: 250_000,
      openingDate: '2026-01-01',
      aliases: ['fluxo'],
    });
    assert.equal(created.status, 200);
    assert.ok(created.body.changeSetId, 'escrita deve devolver changeSetId para permitir desfazer');
    const accountId = created.body.data.id;

    const { body: categories } = await get('/categories?kind=expense');
    const market = categories.find((c: any) => c.name === 'Supermercado');
    assert.ok(market);

    const expense = await post('/transactions', {
      accountId,
      type: 'expense',
      date: '2026-07-20',
      amountCents: 15_075,
      description: 'Compra do mês',
      categoryId: market.id,
      tags: ['essencial'],
    });
    assert.equal(expense.status, 200);
    assert.equal(expense.body.data.amountCents, -15_075, 'o sinal vem do tipo');

    const { body: balance } = await get(`/accounts/${accountId}/balance`);
    assert.equal(balance.availableCents, 250_000 - 15_075);

    const { body: detail } = await get(`/transactions/${expense.body.data.id}`);
    assert.deepEqual(
      detail.tags.map((t: any) => t.name),
      ['essencial'],
    );

    const undo = await post(`/change-sets/${expense.body.changeSetId}/undo`);
    assert.equal(undo.status, 200);

    const { body: after } = await get(`/accounts/${accountId}/balance`);
    assert.equal(after.availableCents, 250_000, 'saldo volta ao original');

    const again = await post(`/change-sets/${expense.body.changeSetId}/undo`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'CONFLICT');
  });

  test('transferência não aparece no fluxo de caixa', async () => {
    const { body: from } = await post('/accounts', {
      name: 'Origem CF',
      kind: 'checking',
      openingBalanceCents: 300_000,
      openingDate: '2026-01-01',
    });
    const { body: to } = await post('/accounts', {
      name: 'Destino CF',
      kind: 'savings',
      openingDate: '2026-01-01',
    });

    const { body: incomeCategories } = await get('/categories?kind=income');
    const salary = incomeCategories.find((c: any) => c.name === 'Salário' && c.parentId !== null);
    assert.ok(salary);

    await post('/transactions', {
      accountId: from.data.id,
      type: 'income',
      date: '2026-09-05',
      amountCents: 400_000,
      description: 'Salário de setembro',
      categoryId: salary.id,
    });

    const transfer = await post('/transfers', {
      fromAccountId: from.data.id,
      toAccountId: to.data.id,
      amountCents: 150_000,
      date: '2026-09-10',
    });
    assert.equal(transfer.status, 200);
    assert.equal(transfer.body.data.out.amountCents, -150_000);
    assert.equal(transfer.body.data.in.amountCents, 150_000);

    const { body: flow } = await get('/cash-flow?from=2026-09-01&to=2026-09-30');
    assert.equal(flow.incomeCents, 400_000, 'transferência não é receita');
    assert.equal(flow.expenseCents, 0, 'transferência não é despesa');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/transactions/${transfer.body.data.out.id}`,
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().data.deleted.length, 2, 'a outra perna vai junto');
  });

  test('regras de domínio devolvem 422, não 500', async () => {
    const { body: account } = await post('/accounts', {
      name: 'Conta 422',
      kind: 'checking',
      openingDate: '2026-01-01',
    });
    const { body: incomeCategories } = await get('/categories?kind=income');

    const { status, body } = await post('/transactions', {
      accountId: account.data.id,
      type: 'expense',
      date: '2026-07-10',
      amountCents: 1000,
      description: 'Categoria errada',
      categoryId: incomeCategories[0].id,
    });

    assert.equal(status, 422);
    assert.equal(body.error, 'RULE_VIOLATION');
    assert.match(body.message, /receita|despesa/);
  });

  test('cartão exige configuração de fatura', async () => {
    const { status, body } = await post('/accounts', {
      name: 'Cartão Sem Config',
      kind: 'credit_card',
      openingDate: '2026-01-01',
    });

    assert.equal(status, 422);
    assert.match(body.message, /fechamento/);
  });

  test('nome de conta duplicado devolve 409', async () => {
    await post('/accounts', { name: 'Conta Única', kind: 'checking', openingDate: '2026-01-01' });
    const { status, body } = await post('/accounts', {
      name: 'Conta Única',
      kind: 'savings',
      openingDate: '2026-01-01',
    });
    assert.equal(status, 409);
    assert.equal(body.error, 'CONFLICT');
  });

  test('conta com movimento não pode ser excluída', async () => {
    const { body: account } = await post('/accounts', {
      name: 'Conta Com Movimento',
      kind: 'checking',
      openingDate: '2026-01-01',
    });
    const { body: categories } = await get('/categories?kind=expense');

    await post('/transactions', {
      accountId: account.data.id,
      type: 'expense',
      date: '2026-07-10',
      amountCents: 1000,
      description: 'Movimento',
      categoryId: categories[0].id,
    });

    const response = await app.inject({ method: 'DELETE', url: `/accounts/${account.data.id}` });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().message, /Arquive/);
  });

  test('categoria do sistema não pode ser excluída', async () => {
    const { body: categories } = await get('/categories?kind=expense');
    const systemCategory = categories.find((c: any) => c.isSystem);
    assert.ok(systemCategory);

    const response = await app.inject({ method: 'DELETE', url: `/categories/${systemCategory.id}` });
    assert.equal(response.statusCode, 422);
  });

  test('auditoria registra o autor e o diff completo', async () => {
    const { body } = await get('/change-sets?limit=5');
    assert.ok(body.total > 0);
    assert.ok(body.items.every((cs: any) => ['user', 'ai', 'system'].includes(cs.actor)));

    const { body: detail } = await get(`/change-sets/${body.items[0].id}`);
    assert.ok(Array.isArray(detail.entries));
    assert.ok(detail.entries.length > 0);
    assert.ok('before' in detail.entries[0] && 'after' in detail.entries[0]);
  });

  test('integridade continua limpa depois de todo o fluxo', async () => {
    const { body } = await get('/integrity');
    assert.equal(body.ok, true, JSON.stringify(body.issues));
  });
});
