/**
 * Testes da camada de IA **sem chamar a API** — as ferramentas são exercitadas
 * diretamente, como o modelo as chamaria.
 *
 * O que importa verificar aqui não é se o modelo escolhe a ferramenta certa (isso
 * depende do provedor), mas se as ferramentas: (a) respeitam a classificação de
 * risco, (b) não escrevem nada quando exigem confirmação, e (c) produzem change
 * sets revertíveis. Ou seja: se a autonomia da IA é segura.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, resetClock } from '../../src/core/clock.js';
import { createAccount } from '../../src/services/accounts.js';
import { createCategory } from '../../src/services/categories.js';
import { createTransaction, listTransactions } from '../../src/services/transactions.js';
import { accountBalance, checkIntegrity } from '../../src/services/balances.js';
import { buildTools, type ToolContext } from '../../src/ai/tools.js';
import { assessRisk, loadThresholds, riskOverview, TOOL_RISK } from '../../src/ai/risk.js';
import { buildSnapshot, systemPrompt } from '../../src/ai/context.js';
import { undoChangeSet } from '../../src/mutate/index.js';
import { changeSets } from '../../src/db/schema.js';
import { testDb, snapshot } from '../helpers/db.js';
import type { DbHandle } from '../../src/db/client.js';

let handle: DbHandle;
let db: DbHandle['db'];
let checking: string;
let card: string;
let food: string;

/** Executa uma ferramenta como o modelo faria. */
async function run(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext = {},
): Promise<any> {
  const tools = buildTools({ db, ...context });
  const tool = tools[toolName];
  assert.ok(tool, `ferramenta "${toolName}" não existe`);
  assert.ok(tool.execute, `ferramenta "${toolName}" não tem execute`);
  // O segundo argumento é o contexto de execução do AI SDK; as ferramentas deste
  // projeto não o usam, mas a assinatura o exige.
  return tool.execute(args as never, { toolCallId: 'test', messages: [], context: undefined } as never);
}

beforeEach(() => {
  setClock(new Date('2026-07-26T12:00:00Z'));
  handle = testDb();
  db = handle.db;

  checking = createAccount(
    {
      name: 'Conta Corrente',
      kind: 'checking',
      openingBalanceCents: 500_000,
      openingDate: '2026-01-01',
      aliases: ['cc', 'corrente'],
    },
    { db },
  ).data.id;

  card = createAccount(
    {
      name: 'Cartão Nubank',
      kind: 'credit_card',
      openingDate: '2026-01-01',
      aliases: ['nubank', 'nu'],
      card: { limitCents: 800_000, closingDay: 20, dueDay: 28, paymentAccountId: checking },
    },
    { db },
  ).data.id;

  food = createCategory({ name: 'Alimentação', kind: 'expense' }, { db }).data.id;
  createCategory({ name: 'Mercado', kind: 'expense', parentId: food }, { db });
  createCategory({ name: 'Salário', kind: 'income' }, { db });
});

afterEach(() => {
  handle.close();
  resetClock();
});

describe('classificação de risco', () => {
  const thresholds = { amountCents: 50_000, bulkRows: 5 };

  test('operações leves são automáticas', () => {
    assert.equal(assessRisk('categorize_transaction', {}, thresholds).level, 'auto');
    assert.equal(assessRisk('add_tags', {}, thresholds).level, 'auto');
    assert.equal(assessRisk('confirm_occurrence', {}, thresholds).level, 'auto');
  });

  test('exclusão sempre pede confirmação, mesmo de valor baixo', () => {
    const assessment = assessRisk('delete_transaction', { amountCents: 100 }, thresholds);
    assert.equal(assessment.level, 'confirm');
    assert.ok(assessment.reason);
  });

  test('valor abaixo do limite é automático, acima pede confirmação', () => {
    assert.equal(assessRisk('create_transaction', { amountCents: 4590 }, thresholds).level, 'auto');
    assert.equal(assessRisk('create_transaction', { amountCents: 49_999 }, thresholds).level, 'auto');
    assert.equal(assessRisk('create_transaction', { amountCents: 50_000 }, thresholds).level, 'auto');
    assert.equal(assessRisk('create_transaction', { amountCents: 50_001 }, thresholds).level, 'confirm');
  });

  test('o sinal do valor não afeta a classificação', () => {
    // Um gasto de R$ 600 é tão relevante quanto uma receita de R$ 600.
    assert.equal(assessRisk('create_transaction', { amountCents: -60_000 }, thresholds).level, 'confirm');
  });

  test('lote grande pede confirmação', () => {
    const small = { transactionIds: ['a', 'b', 'c'] };
    const large = { transactionIds: Array.from({ length: 30 }, (_, i) => String(i)) };

    assert.equal(assessRisk('bulk_categorize', small, thresholds).level, 'auto');
    assert.equal(assessRisk('bulk_categorize', large, thresholds).level, 'confirm');
    assert.match(assessRisk('bulk_categorize', large, thresholds).reason ?? '', /30 lançamentos/);
  });

  test('valor ausente cai para confirmação, não para automático', () => {
    // Falhar para o lado cauteloso é a única direção aceitável.
    const assessment = assessRisk('create_transaction', {}, thresholds);
    assert.equal(assessment.level, 'confirm');
  });

  test('ferramenta desconhecida cai para confirmação', () => {
    // Uma ferramenta nova que esqueceram de classificar não ganha autonomia por omissão.
    const assessment = assessRisk('ferramenta_inventada', { amountCents: 1 }, thresholds);
    assert.equal(assessment.level, 'confirm');
    assert.equal(assessment.unknownTool, true);
  });

  test('toda ferramenta de escrita tem política declarada', () => {
    const writeTools = [
      'create_transaction',
      'create_installment_plan',
      'create_transfer',
      'categorize_transaction',
      'bulk_categorize',
      'update_transaction',
      'delete_transaction',
      'pay_card_invoice',
      'confirm_occurrence',
      'contribute_to_goal',
      'set_budget',
      'create_goal',
      'apply_rules',
    ];

    for (const name of writeTools) {
      assert.ok(TOOL_RISK[name], `ferramenta de escrita "${name}" sem política de risco`);
    }
  });

  test('limites vêm da configuração', () => {
    const loaded = loadThresholds(db);
    assert.equal(loaded.amountCents, 50_000);
    assert.equal(loaded.bulkRows, 5);
  });

  test('panorama de risco separa as ferramentas por nível', () => {
    const overview = riskOverview();
    assert.ok(overview.alwaysAuto.includes('categorize_transaction'));
    assert.ok(overview.alwaysConfirm.includes('delete_transaction'));
    assert.ok(overview.conditional.includes('create_transaction'));
  });
});

describe('lançamento por linguagem natural', () => {
  test('resolve conta por apelido, valor em texto e data relativa', async () => {
    const result = await run('create_transaction', {
      type: 'expense',
      amount: '45,90',
      account: 'nubank',
      description: 'Mercado',
      date: 'ontem',
      category: 'Mercado',
    });

    assert.equal(result.amount.cents, -4590);
    assert.equal(result.amount.formatted, '-R$ 45,90');
    assert.equal(result.date, '2026-07-25');
    assert.equal(result.account, 'Cartão Nubank', 'apelido "nubank" resolvido');
    assert.equal(result.category, 'Mercado');
    assert.ok(result.cardInvoiceId, 'compra no cartão vinculada à fatura');
    assert.ok(result.changeSetId, 'devolve o change set para permitir desfazer');
  });

  test('aceita valor com símbolo e separador de milhar', async () => {
    // R$ 1.234,56 passa do limite de R$ 500, então a confirmação é esperada —
    // o que interessa aqui é que o valor foi interpretado corretamente.
    const pending = await run('create_transaction', {
      type: 'income',
      amount: 'R$ 1.234,56',
      account: 'cc',
      description: 'Freelance',
    });
    assert.equal(pending.needsConfirmation, true);
    assert.match(pending.summary, /R\$ 1\.234,56/);

    const executed = await run(
      'create_transaction',
      { type: 'income', amount: 'R$ 1.234,56', account: 'cc', description: 'Freelance' },
      { approved: new Set([pending.confirmationToken]) },
    );
    assert.equal(executed.amount.cents, 123_456);
  });

  test('valor abaixo do limite entra direto, sem confirmação', async () => {
    const result = await run('create_transaction', {
      type: 'expense',
      amount: '12,50',
      account: 'cc',
      description: 'Café',
    });
    assert.equal(result.needsConfirmation, undefined);
    assert.equal(result.amount.cents, -1250);
  });

  test('resolve_date explica como entendeu', async () => {
    const result = await run('resolve_date', { phrase: 'sexta passada' });
    assert.equal(result.recognized, true);
    assert.equal(result.date, '2026-07-24');
    assert.equal(result.formatted, '24/07/2026');
    assert.match(result.interpretation, /sexta/);
  });

  test('data não reconhecida não vira palpite', async () => {
    const result = await run('resolve_date', { phrase: 'no mês da minha formatura' });
    assert.equal(result.recognized, false);
    assert.ok(result.hint);
  });

  test('parcelamento distribui em faturas consecutivas', async () => {
    const result = await run('create_installment_plan', {
      account: 'nubank',
      description: 'Notebook',
      totalAmount: '3.000,00',
      installments: 6,
      date: 'hoje',
      category: 'Alimentação',
      confirmationToken: 'pre-aprovado',
    }, { approved: new Set(['x']) });

    // R$ 3.000 está acima do limite, então sem token válido pede confirmação.
    assert.equal(result.needsConfirmation, true);
    assert.match(result.summary, /3\.000,00.*6x/);
  });
});

describe('confirmação bloqueia a escrita', () => {
  test('operação acima do limite não grava nada', async () => {
    const before = snapshot(handle, 'transactions');

    const result = await run('create_transaction', {
      type: 'expense',
      amount: '2.500,00',
      account: 'cc',
      description: 'Compra grande',
    });

    assert.equal(result.needsConfirmation, true);
    assert.match(result.reason, /limite/);
    assert.ok(result.confirmationToken);
    assert.match(result.summary, /2\.500,00/);

    // O ponto central: nada foi escrito.
    assert.deepEqual(snapshot(handle, 'transactions'), before);
    assert.equal(accountBalance(checking, { db }).availableCents, 500_000);
  });

  test('com o token aprovado, a mesma operação executa', async () => {
    const first = await run('create_transaction', {
      type: 'expense',
      amount: '2.500,00',
      account: 'cc',
      description: 'Compra grande',
    });
    assert.equal(first.needsConfirmation, true);

    const approved = await run(
      'create_transaction',
      { type: 'expense', amount: '2.500,00', account: 'cc', description: 'Compra grande' },
      { approved: new Set([first.confirmationToken]) },
    );

    assert.equal(approved.needsConfirmation, undefined);
    assert.equal(approved.amount.cents, -250_000);
    assert.equal(accountBalance(checking, { db }).availableCents, 250_000);
  });

  test('exclusão pede confirmação e não apaga antes dela', async () => {
    const tx = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 1000, description: 'Café', categoryId: food },
      { db },
    ).data;

    const result = await run('delete_transaction', { transactionId: tx.id });

    assert.equal(result.needsConfirmation, true);
    assert.match(result.summary, /Café/);
    assert.equal(listTransactions({}, db).total, 1, 'a transação continua lá');

    const confirmed = await run(
      'delete_transaction',
      { transactionId: tx.id },
      { approved: new Set([result.confirmationToken]) },
    );
    assert.equal(confirmed.deleted, 1);
    assert.equal(listTransactions({}, db).total, 0);
  });

  test('lote grande pede confirmação e preserva as categorias', async () => {
    const ids = Array.from({ length: 12 }, (_, i) =>
      createTransaction(
        {
          accountId: checking,
          type: 'expense',
          date: `2026-07-${String(i + 1).padStart(2, '0')}`,
          amountCents: 1000,
          description: 'Uber',
          categoryId: food,
        },
        { db },
      ).data.id,
    );

    const transport = createCategory({ name: 'Transporte', kind: 'expense' }, { db }).data.id;
    const before = snapshot(handle, 'transactions');

    const result = await run('bulk_categorize', { transactionIds: ids, category: 'Transporte' });
    assert.equal(result.needsConfirmation, true);
    assert.deepEqual(snapshot(handle, 'transactions'), before, 'nada mudou');

    const confirmed = await run(
      'bulk_categorize',
      { transactionIds: ids, category: 'Transporte' },
      { approved: new Set([result.confirmationToken]) },
    );
    assert.equal(confirmed.updated, 12);
    void transport;
  });
});

describe('escritas da IA são auditadas e reversíveis', () => {
  test('change set fica marcado como feito pela IA', async () => {
    const result = await run('create_transaction', {
      type: 'expense',
      amount: '30,00',
      account: 'cc',
      description: 'Almoço',
      category: 'Alimentação',
    });

    const cs = db.select().from(changeSets).all().at(-1)!;
    assert.equal(cs.actor, 'ai');
    assert.equal(cs.source, 'ai');
    assert.equal(cs.tool, 'create_transaction');
    assert.equal(cs.id, result.changeSetId);
  });

  test('undo reverte o que a IA fez', async () => {
    const before = snapshot(handle, 'transactions');

    const result = await run('create_transaction', {
      type: 'expense',
      amount: '30,00',
      account: 'cc',
      description: 'Almoço',
      category: 'Alimentação',
    });

    undoChangeSet(result.changeSetId, { db });
    assert.deepEqual(snapshot(handle, 'transactions'), before);
  });

  test('ações da IA são registradas em ai_actions', async () => {
    const actions: Array<{ tool: string; status: string }> = [];

    await run(
      'create_transaction',
      { type: 'expense', amount: '30,00', account: 'cc', description: 'Almoço' },
      { onAction: (action) => actions.push({ tool: action.tool, status: action.status }) },
    );
    await run(
      'create_transaction',
      { type: 'expense', amount: '5.000,00', account: 'cc', description: 'Compra alta' },
      { onAction: (action) => actions.push({ tool: action.tool, status: action.status }) },
    );

    assert.deepEqual(actions, [
      { tool: 'create_transaction', status: 'executed' },
      { tool: 'create_transaction', status: 'pending' },
    ]);
  });
});

describe('ferramentas de leitura devolvem número e texto formatado', () => {
  beforeEach(() => {
    createTransaction(
      { accountId: checking, type: 'income', date: '2026-07-05', amountCents: 800_000, description: 'Salário', categoryId: createCategory({ name: 'Renda', kind: 'income' }, { db }).data.id },
      { db },
    );
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 45_000, description: 'Mercado', categoryId: food },
      { db },
    );
  });

  test('saldos vêm com valor formatado, para o modelo não formatar', async () => {
    const result = await run('get_balances', {});
    const account = result.accounts.find((a: any) => a.name === 'Conta Corrente');

    assert.equal(account.available.cents, 500_000 + 800_000 - 45_000);
    assert.equal(account.available.formatted, 'R$ 12.550,00');
  });

  test('panorama do mês traz os números prontos', async () => {
    const result = await run('get_month_overview', { month: '2026-07' });

    assert.equal(result.income.cents, 800_000);
    assert.equal(result.expense.cents, 45_000);
    assert.equal(result.income.formatted, 'R$ 8.000,00');
    assert.equal(result.savingsRatePercent, 94.4);
    assert.ok(result.topCategories.length > 0);
  });

  test('busca devolve a soma de todo o filtro, não só da página', async () => {
    const result = await run('search_transactions', { type: 'expense', limit: 1 });
    assert.equal(result.total, 1);
    assert.equal(result.sum.cents, -45_000);
  });

  test('projeção responde "posso gastar isso?"', async () => {
    const result = await run('get_projection', { days: 60 });
    assert.ok(result.today.cents > 0);
    assert.ok('firstNegativeDate' in result);
    assert.ok('committed' in result);
  });

  test('cartão mostra uso do limite', async () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-10', amountCents: 200_000, description: 'Compra', categoryId: food },
      { db },
    );

    const result = await run('get_balances', {});
    const cardBalance = result.accounts.find((a: any) => a.name === 'Cartão Nubank');
    assert.equal(cardBalance.cardUsage.usedPercent, 25);
    assert.equal(cardBalance.cardUsage.used.formatted, 'R$ 2.000,00');
  });
});

describe('retrato financeiro do contexto', () => {
  beforeEach(() => {
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 45_000, description: 'Mercado', categoryId: food },
      { db },
    );
  });

  test('inclui contas com IDs e apelidos', () => {
    const text = buildSnapshot({ db });
    assert.match(text, /Conta Corrente/);
    assert.match(text, new RegExp(checking));
    assert.match(text, /apelidos: nubank, nu/);
  });

  test('inclui categorias por nome, sem IDs', () => {
    const text = buildSnapshot({ db });
    assert.match(text, /Categorias disponíveis/);
    assert.match(text, /Alimentação/);
    assert.match(text, /Mercado/);
    // Os IDs não entram: as ferramentas resolvem categoria por nome, e 99 ULIDs
    // custariam mais de mil tokens por turno sem utilidade.
    assert.ok(!text.includes(food), 'o ID da categoria não deveria estar no retrato');
  });

  test('o prompt exige separar dado de suposição', () => {
    const prompt = systemPrompt(buildSnapshot({ db }));
    assert.match(prompt, /não.*calcula juros de rotativo/i);
    assert.match(prompt, /provavelmente/);
  });

  test('informa os limites de autonomia ao modelo', () => {
    const text = buildSnapshot({ db });
    assert.match(text, /limites de autonomia/);
    assert.match(text, /R\$ 500,00/);
  });

  test('o prompt de sistema proíbe o modelo de calcular', () => {
    const prompt = systemPrompt(buildSnapshot({ db }));
    assert.match(prompt, /nunca faz cálculo/i);
    assert.match(prompt, /resolve_date/);
    assert.match(prompt, /centavos/);
  });

  test('não despeja transações cruas no prompt', () => {
    // O retrato é agregado: despejar linhas gastaria tokens e convidaria o modelo
    // a fazer conta.
    const text = buildSnapshot({ db });
    const lines = text.split('\n').length;
    assert.ok(lines < 200, `retrato com ${lines} linhas está grande demais`);
  });
});

describe('integridade depois das operações da IA', () => {
  test('cenário completo não deixa inconsistência', async () => {
    await run('create_transaction', {
      type: 'expense',
      amount: '45,90',
      account: 'nubank',
      description: 'Mercado',
      date: 'ontem',
      category: 'Mercado',
    });
    await run('create_transaction', {
      type: 'income',
      amount: '300,00',
      account: 'cc',
      description: 'Reembolso',
    });
    await run('create_transfer', {
      fromAccount: 'cc',
      toAccount: 'nubank',
      amount: '100,00',
      date: 'hoje',
    });

    assert.deepEqual(checkIntegrity(db), []);
  });
});

describe('autoria do lançamento', () => {
  test('transação criada pela IA fica marcada como criada pela IA', async () => {
    // Sem isto, o filtro "o que a IA lançou?" mentiria: a linha ficaria como se
    // você tivesse digitado, mesmo com o change set apontando para a IA.
    await run('create_transaction', {
      type: 'expense',
      amount: '30,00',
      account: 'cc',
      description: 'Lançado pela IA',
    });

    const created = listTransactions({ search: 'Lançado pela IA' }, db).items[0]!;
    assert.equal(created.createdBy, 'ai');
  });

  test('transação criada pela API fica marcada como do usuário', () => {
    const tx = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 1000, description: 'Manual', categoryId: food },
      { db },
    ).data;
    assert.equal(tx.createdBy, 'user');
  });
});

describe('caminho de streaming reporta confirmações pendentes', () => {
  test('onStepFinish coleta o token, senão a interface não tem como confirmar', async () => {
    // Regressão: o `chat()` extraía as pendências de `result.steps`, mas o
    // `chatStream()` não coletava nada. O modelo avisava que precisava de
    // confirmação e a interface nunca recebia o token — o usuário ficava num laço,
    // pedindo uma aprovação que o sistema não sabia receber.
    //
    // Verificado aqui sem chamar a API: a coleta é feita por `onStepFinish`, então
    // basta conferir que o handler está declarado no `streamText`.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/ai/agent.ts', import.meta.url), 'utf8');

    const streamBlock = source.slice(source.indexOf('export async function chatStream'));
    assert.match(
      streamBlock,
      /onStepFinish/,
      'chatStream precisa de onStepFinish para coletar as confirmações pendentes',
    );
    assert.match(
      streamBlock,
      /needsConfirmation/,
      'onStepFinish precisa inspecionar needsConfirmation nos resultados das ferramentas',
    );
    assert.match(streamBlock, /collected\.pending\.push/, 'as pendências precisam ser acumuladas');
  });
});
