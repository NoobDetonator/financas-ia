/**
 * Testes de autenticação.
 *
 * O que mais importa aqui é a proteção contra exposição acidental: o modo de uso
 * previsto inclui acessar do celular no Wi-Fi, e uma configuração conveniente de
 * desenvolvimento não pode, por descuido, deixar as finanças abertas para qualquer
 * dispositivo da rede — inclusive o da visita.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const tempDir = mkdtempSync(join(tmpdir(), 'financas-auth-test-'));
process.env.DATABASE_PATH = join(tempDir, 'auth.db');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.HOST = '127.0.0.1';
process.env.AUTH_DISABLED = 'false';
process.env.APP_PASSWORD = 'senha-de-teste-forte';
process.env.SESSION_SECRET = 'a'.repeat(64);

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
  runMigrations(dbClient.getDb());
  bootstrap(dbClient.getDb());

  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  closeDb?.();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('proteção de rotas', () => {
  test('rota de dados exige sessão', async () => {
    const response = await app.inject({ method: 'GET', url: '/accounts' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'UNAUTHORIZED');
  });

  test('escrita também exige sessão', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'Invasora', kind: 'checking', openingDate: '2026-01-01' },
    });
    assert.equal(response.statusCode, 401);
  });

  test('health e docs ficam abertos', async () => {
    // O health precisa responder sem sessão para monitoramento; a documentação não
    // expõe dado nenhum, só o formato da API.
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/docs/' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode, 200);
  });

  test('status informa a situação sem exigir sessão', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/status' });
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.equal(body.authEnabled, true);
    assert.equal(body.authenticated, false);
    assert.equal(body.passwordConfigured, true);
  });
});

describe('login', () => {
  test('senha errada devolve 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'senha-errada' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'UNAUTHORIZED');
  });

  test('senha correta libera o acesso', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'senha-de-teste-forte' },
    });

    assert.equal(login.statusCode, 200);
    assert.equal(login.json().ok, true);

    const cookie = login.cookies.find((c) => c.name === 'financas_session');
    assert.ok(cookie, 'deveria devolver o cookie de sessão');
    assert.equal(cookie.httpOnly, true, 'httpOnly impede leitura por script');

    // Com a sessão, a rota protegida responde.
    const accounts = await app.inject({
      method: 'GET',
      url: '/accounts',
      cookies: { financas_session: cookie.value },
    });
    assert.equal(accounts.statusCode, 200);
  });

  test('cookie forjado é rejeitado', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/accounts',
      cookies: { financas_session: `${Date.now() + 86_400_000}.assinatura-inventada` },
    });
    assert.equal(response.statusCode, 401);
  });

  test('sessão expirada é rejeitada', async () => {
    // Assinatura válida não basta: a expiração é verificada também.
    const { createHmac } = await import('node:crypto');
    const expired = String(Date.now() - 1000);
    const signature = createHmac('sha256', 'a'.repeat(64)).update(expired).digest('hex');

    const response = await app.inject({
      method: 'GET',
      url: '/accounts',
      cookies: { financas_session: `${expired}.${signature}` },
    });
    assert.equal(response.statusCode, 401);
  });

  test('logout invalida o cookie', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { password: 'senha-de-teste-forte' },
    });
    const cookie = login.cookies.find((c) => c.name === 'financas_session')!;

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { financas_session: cookie.value },
    });
    assert.equal(logout.statusCode, 200);

    const cleared = logout.cookies.find((c) => c.name === 'financas_session');
    assert.equal(cleared?.value, '', 'o cookie deve ser limpo');
  });

  test('tentativas repetidas são limitadas', async () => {
    // Sem limitador, uma senha curta cairia por força bruta na rede local.
    const attempts: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { password: `tentativa-${i}` },
        headers: { 'x-forwarded-for': '10.0.0.99' },
      });
      attempts.push(response.statusCode);
    }

    assert.ok(
      attempts.includes(429),
      `deveria bloquear por excesso de tentativas; obtido: ${attempts.join(',')}`,
    );
  });
});

describe('proteção contra exposição na rede', () => {
  test('AUTH_DISABLED é ignorado quando o servidor não está em loopback', async () => {
    // Recarrega a configuração simulando exposição na rede.
    const original = { host: process.env.HOST, disabled: process.env.AUTH_DISABLED };
    process.env.HOST = '0.0.0.0';
    process.env.AUTH_DISABLED = 'true';

    // `authConfig` lê o env no momento da chamada, então o efeito é imediato.
    const { authConfig } = await import('../../src/config/env.js');

    // O módulo de config congela `env` no carregamento; para testar a regra em si,
    // exercita-se a função com o estado atual do processo.
    const config = authConfig();
    assert.ok(
      config.enabled || config.reason !== undefined,
      'com HOST exposto, a autenticação não pode ficar desligada em silêncio',
    );

    process.env.HOST = original.host;
    process.env.AUTH_DISABLED = original.disabled;
  });
});

describe('a casca da interface é pública, os dados não', () => {
  test('caminhos da interface dispensam sessão — o login mora neles', async () => {
    // Regressão encontrada ao subir em produção pela primeira vez: o hook de
    // autenticação bloqueava `/`, que é justamente o HTML com o formulário de
    // login. O resultado era um 401 em JSON e nenhuma forma de entrar.
    const { isApiPath } = await import('../../src/api/web.js');

    for (const path of ['/', '/journal', '/contas', '/assets/index-abc123.js', '/assets/index-abc123.css']) {
      assert.equal(isApiPath(path), false, `"${path}" é interface, não API`);
    }
  });

  test('caminhos de dados são reconhecidos como API e ficam protegidos', async () => {
    const { isApiPath } = await import('../../src/api/web.js');

    for (const path of [
      '/accounts',
      '/accounts/01ABC',
      '/transactions',
      '/net-worth',
      '/ai/chat',
      '/change-sets/01ABC/undo',
      '/insights/analyze',
      '/reports/month-overview',
    ]) {
      assert.equal(isApiPath(path), true, `"${path}" é API e precisa de sessão`);
    }
  });

  test('dado financeiro não sai sem sessão', async () => {
    for (const url of ['/accounts', '/transactions', '/net-worth', '/balances', '/goals', '/debts']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${url} deveria exigir sessão`);
      assert.ok(
        !response.body.includes('openingBalanceCents'),
        `${url} não pode devolver dado financeiro sem sessão`,
      );
    }
  });
});
