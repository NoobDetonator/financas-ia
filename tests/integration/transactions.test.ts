import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createAccount } from '../../src/services/accounts.js';
import { createCategory } from '../../src/services/categories.js';
import {
  createTransaction,
  updateTransaction,
  deleteTransaction,
  listTransactions,
  getTransactionDetail,
  bulkCategorize,
} from '../../src/services/transactions.js';
import { createTransfer, linkAsTransfer, unlinkTransfer } from '../../src/services/transfers.js';
import { accountBalance, cashFlow, checkIntegrity, netWorth } from '../../src/services/balances.js';
import { undoChangeSet } from '../../src/mutate/index.js';
import { transactionSplits, transactionTags } from '../../src/db/schema.js';
import { AppError } from '../../src/core/errors.js';
import { testDb, snapshot } from '../helpers/db.js';
import type { DbHandle } from '../../src/db/client.js';

let handle: DbHandle;
let db: DbHandle['db'];
let checking: string;
let savings: string;
let food: string;
let salary: string;

beforeEach(() => {
  handle = testDb();
  db = handle.db;

  checking = createAccount(
    { name: 'Conta Corrente', kind: 'checking', openingBalanceCents: 100_000, openingDate: '2026-01-01' },
    { db },
  ).data.id;
  savings = createAccount(
    { name: 'Poupança', kind: 'savings', openingDate: '2026-01-01' },
    { db },
  ).data.id;
  food = createCategory({ name: 'Alimentação', kind: 'expense' }, { db }).data.id;
  salary = createCategory({ name: 'Salário', kind: 'income' }, { db }).data.id;
});

afterEach(() => handle.close());

describe('sinal derivado do tipo', () => {
  test('despesa fica negativa, receita positiva — mesmo recebendo valor positivo', () => {
    const expense = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 4590, description: 'Mercado', categoryId: food },
      { db },
    ).data;
    const income = createTransaction(
      { accountId: checking, type: 'income', date: '2026-07-05', amountCents: 500_000, description: 'Salário', categoryId: salary },
      { db },
    ).data;

    assert.equal(expense.amountCents, -4590);
    assert.equal(income.amountCents, 500_000);
  });

  test('recusa valor zero ou negativo na entrada', () => {
    for (const amountCents of [0, -100]) {
      assert.throws(() =>
        createTransaction(
          { accountId: checking, type: 'expense', date: '2026-07-10', amountCents, description: 'x' },
          { db },
        ),
      );
    }
  });
});

describe('categoria tem que combinar com o tipo', () => {
  test('despesa recusa categoria de receita', () => {
    assert.throws(
      () =>
        createTransaction(
          { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 1000, description: 'x', categoryId: salary },
          { db },
        ),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('receita recusa categoria de despesa', () => {
    assert.throws(
      () =>
        createTransaction(
          { accountId: checking, type: 'income', date: '2026-07-10', amountCents: 1000, description: 'x', categoryId: food },
          { db },
        ),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });
});

describe('rateio', () => {
  test('soma do rateio tem que fechar com o valor', () => {
    const mercado = createCategory({ name: 'Mercado', kind: 'expense', parentId: food }, { db }).data.id;

    assert.throws(
      () =>
        createTransaction(
          {
            accountId: checking,
            type: 'expense',
            date: '2026-07-10',
            amountCents: 10_000,
            description: 'Compra dividida',
            splits: [
              { categoryId: food, amountCents: 6000 },
              { categoryId: mercado, amountCents: 3000 }, // falta R$ 10
            ],
          },
          { db },
        ),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('rateio válido grava linhas com o sinal correto', () => {
    const mercado = createCategory({ name: 'Mercado', kind: 'expense', parentId: food }, { db }).data.id;

    const tx = createTransaction(
      {
        accountId: checking,
        type: 'expense',
        date: '2026-07-10',
        amountCents: 10_000,
        description: 'Compra dividida',
        splits: [
          { categoryId: food, amountCents: 6000 },
          { categoryId: mercado, amountCents: 4000 },
        ],
      },
      { db },
    ).data;

    assert.equal(tx.hasSplits, true);
    assert.equal(tx.categoryId, null);

    const splits = db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, tx.id)).all();
    assert.equal(splits.length, 2);
    // Rateio de despesa é negativo, como a transação.
    assert.deepEqual(splits.map((s) => s.amountCents).sort((a, b) => a - b), [-6000, -4000]);
    assert.equal(splits.reduce((sum, s) => sum + s.amountCents, 0), tx.amountCents);
  });

  test('rateio e categoria própria são mutuamente exclusivos', () => {
    assert.throws(
      () =>
        createTransaction(
          {
            accountId: checking,
            type: 'expense',
            date: '2026-07-10',
            amountCents: 10_000,
            description: 'x',
            categoryId: food,
            splits: [
              { categoryId: food, amountCents: 5000 },
              { categoryId: food, amountCents: 5000 },
            ],
          },
          { db },
        ),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('mudar o valor sem redefinir o rateio é recusado', () => {
    const mercado = createCategory({ name: 'Mercado', kind: 'expense', parentId: food }, { db }).data.id;
    const tx = createTransaction(
      {
        accountId: checking,
        type: 'expense',
        date: '2026-07-10',
        amountCents: 10_000,
        description: 'Compra',
        splits: [
          { categoryId: food, amountCents: 6000 },
          { categoryId: mercado, amountCents: 4000 },
        ],
      },
      { db },
    ).data;

    // Deixar passar produziria um rateio que não fecha — silenciosamente.
    assert.throws(
      () => updateTransaction(tx.id, { amountCents: 20_000 }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );

    // Com o novo rateio junto, funciona.
    const updated = updateTransaction(
      tx.id,
      {
        amountCents: 20_000,
        splits: [
          { categoryId: food, amountCents: 12_000 },
          { categoryId: mercado, amountCents: 8000 },
        ],
      },
      { db },
    ).data;
    assert.equal(updated.amountCents, -20_000);
    assert.equal(checkIntegrity(db).length, 0);
  });
});

describe('tags', () => {
  test('cria as tags que faltam e vincula', () => {
    const tx = createTransaction(
      {
        accountId: checking,
        type: 'expense',
        date: '2026-07-10',
        amountCents: 25_000,
        description: 'Hotel',
        categoryId: food,
        tags: ['Viagem', 'Férias'],
      },
      { db },
    ).data;

    const detail = getTransactionDetail(tx.id, db);
    assert.deepEqual(detail.tags.map((t) => t.name).sort(), ['Férias', 'Viagem']);
  });

  test('reaproveita tag existente em vez de duplicar', () => {
    const first = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 1000, description: 'A', categoryId: food, tags: ['viagem'] },
      { db },
    ).data;
    const second = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-11', amountCents: 1000, description: 'B', categoryId: food, tags: ['Viagem'] },
      { db },
    ).data;

    const tagA = getTransactionDetail(first.id, db).tags[0]!;
    const tagB = getTransactionDetail(second.id, db).tags[0]!;
    assert.equal(tagA.id, tagB.id, 'variação de caixa não deve criar tag nova');
  });
});

describe('saldos', () => {
  test('disponível conta só o efetivado; projetado inclui o previsto', () => {
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 20_000, description: 'Efetivado', categoryId: food, status: 'cleared' },
      { db },
    );
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-20', amountCents: 5000, description: 'Pendente', categoryId: food, status: 'pending' },
      { db },
    );
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-08-05', amountCents: 3000, description: 'Agendado', categoryId: food, status: 'scheduled' },
      { db },
    );

    const balance = accountBalance(checking, { db });
    assert.equal(balance.availableCents, 100_000 - 20_000);
    assert.equal(balance.projectedCents, 100_000 - 20_000 - 5000 - 3000);
    assert.equal(balance.forecastCents, -8000);
  });

  test('reconstrói o saldo numa data passada', () => {
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 10_000, description: 'Julho', categoryId: food },
      { db },
    );
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-08-10', amountCents: 30_000, description: 'Agosto', categoryId: food },
      { db },
    );

    assert.equal(accountBalance(checking, { upTo: '2026-07-31', db }).availableCents, 90_000);
    assert.equal(accountBalance(checking, { db }).availableCents, 60_000);
  });

  test('uso do limite do cartão', () => {
    const card = createAccount(
      {
        name: 'Cartão',
        kind: 'credit_card',
        openingDate: '2026-01-01',
        card: { limitCents: 500_000, closingDay: 20, dueDay: 28 },
      },
      { db },
    ).data.id;

    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-10', amountCents: 125_000, description: 'Compra', categoryId: food },
      { db },
    );

    const balance = accountBalance(card, { db });
    assert.equal(balance.availableCents, -125_000, 'saldo do cartão é a dívida');
    assert.deepEqual(balance.cardUsage, {
      limitCents: 500_000,
      usedCents: 125_000,
      availableCents: 375_000,
      usedPercent: 25,
    });
  });

  test('patrimônio separa ativos de dívidas', () => {
    const card = createAccount(
      { name: 'Cartão', kind: 'credit_card', openingDate: '2026-01-01', card: { limitCents: 500_000, closingDay: 20, dueDay: 28 } },
      { db },
    ).data.id;
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-10', amountCents: 40_000, description: 'Compra', categoryId: food },
      { db },
    );

    const worth = netWorth({ db });
    assert.equal(worth.assetsCents, 100_000);
    assert.equal(worth.liabilitiesCents, 40_000);
    assert.equal(worth.netCents, 60_000);
  });
});

describe('transferências', () => {
  test('cria duas pernas que somam zero', () => {
    const pair = createTransfer(
      { fromAccountId: checking, toAccountId: savings, amountCents: 30_000, date: '2026-07-15' },
      { db },
    ).data;

    assert.equal(pair.out.amountCents, -30_000);
    assert.equal(pair.in.amountCents, 30_000);
    assert.equal(pair.out.amountCents + pair.in.amountCents, 0);
    assert.equal(pair.out.transferId, pair.in.transferId);
    assert.equal(pair.out.categoryId, null);
    assert.equal(pair.in.categoryId, null);

    assert.equal(accountBalance(checking, { db }).availableCents, 70_000);
    assert.equal(accountBalance(savings, { db }).availableCents, 30_000);
  });

  test('não entra no fluxo de caixa — dinheiro só trocou de bolso', () => {
    createTransaction(
      { accountId: checking, type: 'income', date: '2026-07-05', amountCents: 500_000, description: 'Salário', categoryId: salary },
      { db },
    );
    createTransfer(
      { fromAccountId: checking, toAccountId: savings, amountCents: 200_000, date: '2026-07-15' },
      { db },
    );

    const flow = cashFlow('2026-07-01', '2026-07-31', { db });
    // Se a transferência entrasse, a receita viraria R$ 7.000 e a despesa R$ 2.000.
    assert.equal(flow.incomeCents, 500_000);
    assert.equal(flow.expenseCents, 0);
    assert.equal(flow.netCents, 500_000);
    assert.equal(flow.savingsRatePercent, 100);
  });

  test('recusa transferência para a mesma conta', () => {
    assert.throws(
      () => createTransfer({ fromAccountId: checking, toAccountId: checking, amountCents: 1000, date: '2026-07-15' }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('excluir uma perna exclui a outra', () => {
    const pair = createTransfer(
      { fromAccountId: checking, toAccountId: savings, amountCents: 30_000, date: '2026-07-15' },
      { db },
    ).data;

    const result = deleteTransaction(pair.out.id, { db }).data;
    assert.equal(result.deleted.length, 2, 'meia transferência deixaria um saldo errado para sempre');
    assert.equal(listTransactions({}, db).total, 0);
    assert.equal(accountBalance(checking, { db }).availableCents, 100_000);
    assert.equal(accountBalance(savings, { db }).availableCents, 0);
  });

  test('casa duas transações importadas como transferência', () => {
    const out = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-15', amountCents: 30_000, description: 'TED enviada', categoryId: food },
      { db },
    ).data;
    const inbound = createTransaction(
      { accountId: savings, type: 'income', date: '2026-07-15', amountCents: 30_000, description: 'TED recebida', categoryId: salary },
      { db },
    ).data;

    // Antes de casar: uma despesa e uma receita fantasmas no mês.
    const before = cashFlow('2026-07-01', '2026-07-31', { db });
    assert.equal(before.incomeCents, 30_000);
    assert.equal(before.expenseCents, 30_000);

    linkAsTransfer(out.id, inbound.id, { db });

    const after = cashFlow('2026-07-01', '2026-07-31', { db });
    assert.equal(after.incomeCents, 0);
    assert.equal(after.expenseCents, 0);
    assert.equal(checkIntegrity(db).length, 0);
  });

  test('recusa casar valores diferentes ou mesma conta', () => {
    const out = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-15', amountCents: 30_000, description: 'A', categoryId: food },
      { db },
    ).data;
    const wrongAmount = createTransaction(
      { accountId: savings, type: 'income', date: '2026-07-15', amountCents: 25_000, description: 'B', categoryId: salary },
      { db },
    ).data;
    const sameAccount = createTransaction(
      { accountId: checking, type: 'income', date: '2026-07-15', amountCents: 30_000, description: 'C', categoryId: salary },
      { db },
    ).data;

    assert.throws(() => linkAsTransfer(out.id, wrongAmount.id, { db }), AppError);
    assert.throws(() => linkAsTransfer(out.id, sameAccount.id, { db }), AppError);
  });

  test('desfaz o vínculo voltando a despesa e receita', () => {
    const out = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-15', amountCents: 30_000, description: 'A', categoryId: food },
      { db },
    ).data;
    const inbound = createTransaction(
      { accountId: savings, type: 'income', date: '2026-07-15', amountCents: 30_000, description: 'B', categoryId: salary },
      { db },
    ).data;

    const pair = linkAsTransfer(out.id, inbound.id, { db }).data;
    const restored = unlinkTransfer(pair.transferId, { db }).data.transactions;

    assert.deepEqual(restored.map((t) => t.type).sort(), ['expense', 'income']);
    assert.ok(restored.every((t) => t.transferId === null));
  });
});

describe('recategorização em lote', () => {
  test('atualiza as elegíveis e reporta as ignoradas', () => {
    const transport = createCategory({ name: 'Transporte', kind: 'expense' }, { db }).data.id;

    const a = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-01', amountCents: 2000, description: 'Uber', categoryId: food },
      { db },
    ).data;
    const b = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-02', amountCents: 3000, description: 'Uber', categoryId: food },
      { db },
    ).data;
    const income = createTransaction(
      { accountId: checking, type: 'income', date: '2026-07-03', amountCents: 1000, description: 'Reembolso', categoryId: salary },
      { db },
    ).data;
    const pair = createTransfer(
      { fromAccountId: checking, toAccountId: savings, amountCents: 1000, date: '2026-07-04' },
      { db },
    ).data;

    const result = bulkCategorize([a.id, b.id, income.id, pair.out.id, 'INEXISTENTE'], transport, { db }).data;

    assert.equal(result.updated, 2);
    // Receita (tipo incompatível), transferência e ID inválido são ignorados.
    assert.deepEqual(result.skipped.sort(), [income.id, pair.out.id, 'INEXISTENTE'].sort());
    assert.equal(checkIntegrity(db).length, 0);
  });

  test('undo reverte o lote inteiro', () => {
    const transport = createCategory({ name: 'Transporte', kind: 'expense' }, { db }).data.id;
    const ids = [1, 2, 3].map(
      (i) =>
        createTransaction(
          { accountId: checking, type: 'expense', date: `2026-07-0${i}`, amountCents: 1000 * i, description: 'Uber', categoryId: food },
          { db },
        ).data.id,
    );

    const before = snapshot(handle, 'transactions');
    const { changeSetId } = bulkCategorize(ids, transport, { db });
    undoChangeSet(changeSetId, { db });

    assert.deepEqual(snapshot(handle, 'transactions'), before);
  });
});

describe('exclusão com filhos', () => {
  test('remove rateio e tags junto, e o undo restaura tudo', () => {
    const mercado = createCategory({ name: 'Mercado', kind: 'expense', parentId: food }, { db }).data.id;
    const tx = createTransaction(
      {
        accountId: checking,
        type: 'expense',
        date: '2026-07-10',
        amountCents: 10_000,
        description: 'Compra',
        tags: ['viagem'],
        splits: [
          { categoryId: food, amountCents: 6000 },
          { categoryId: mercado, amountCents: 4000 },
        ],
      },
      { db },
    ).data;

    const splitsBefore = snapshot(handle, 'transaction_splits');
    const tagsBefore = snapshot(handle, 'transaction_tags');
    const txBefore = snapshot(handle, 'transactions');

    const { changeSetId } = deleteTransaction(tx.id, { db });

    assert.equal(db.select().from(transactionSplits).all().length, 0);
    assert.equal(db.select().from(transactionTags).all().length, 0);

    // Se o cascade do SQLite tivesse apagado os filhos sem auditar, o undo
    // restauraria a transação mas perderia rateio e tags.
    undoChangeSet(changeSetId, { db });

    assert.deepEqual(snapshot(handle, 'transactions'), txBefore);
    assert.deepEqual(snapshot(handle, 'transaction_splits'), splitsBefore);
    assert.deepEqual(snapshot(handle, 'transaction_tags'), tagsBefore);
  });
});

describe('filtros de listagem', () => {
  beforeEach(() => {
    const mercado = createCategory({ name: 'Mercado', kind: 'expense', parentId: food }, { db }).data.id;
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-05', amountCents: 5000, description: 'Padaria do bairro', categoryId: mercado },
      { db },
    );
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-08-05', amountCents: 8000, description: 'Restaurante', categoryId: food },
      { db },
    );
    createTransaction(
      { accountId: savings, type: 'income', date: '2026-07-20', amountCents: 100_000, description: 'Rendimento', categoryId: salary },
      { db },
    );
  });

  test('filtra por intervalo de datas', () => {
    const page = listTransactions({ dateFrom: '2026-07-01', dateTo: '2026-07-31' }, db);
    assert.equal(page.total, 2);
  });

  test('rollup inclui as subcategorias da categoria mãe', () => {
    const withRollup = listTransactions({ categoryId: food, rollupCategories: true }, db);
    assert.equal(withRollup.total, 2, 'deve pegar Alimentação e sua filha Mercado');

    const withoutRollup = listTransactions({ categoryId: food, rollupCategories: false }, db);
    assert.equal(withoutRollup.total, 1);
  });

  test('busca em descrição, sem diferenciar caixa', () => {
    assert.equal(listTransactions({ search: 'padaria' }, db).total, 1);
    assert.equal(listTransactions({ search: 'PADARIA' }, db).total, 1);
  });

  test('sumCents soma todo o filtro, não apenas a página', () => {
    const page = listTransactions({ type: 'expense', limit: 1 }, db);
    assert.equal(page.items.length, 1);
    assert.equal(page.total, 2);
    assert.equal(page.sumCents, -13_000);
  });

  test('filtra por conta', () => {
    assert.equal(listTransactions({ accountId: savings }, db).total, 1);
  });
});

describe('integridade contábil', () => {
  test('banco com movimento variado não acusa problema', () => {
    const mercado = createCategory({ name: 'Mercado', kind: 'expense', parentId: food }, { db }).data.id;

    createTransaction(
      { accountId: checking, type: 'income', date: '2026-07-05', amountCents: 500_000, description: 'Salário', categoryId: salary },
      { db },
    );
    createTransaction(
      {
        accountId: checking,
        type: 'expense',
        date: '2026-07-10',
        amountCents: 10_000,
        description: 'Compra rateada',
        splits: [
          { categoryId: food, amountCents: 7000 },
          { categoryId: mercado, amountCents: 3000 },
        ],
      },
      { db },
    );
    createTransfer(
      { fromAccountId: checking, toAccountId: savings, amountCents: 200_000, date: '2026-07-15' },
      { db },
    );

    assert.deepEqual(checkIntegrity(db), []);
  });

  test('detecta transferência com uma perna só', () => {
    const pair = createTransfer(
      { fromAccountId: checking, toAccountId: savings, amountCents: 30_000, date: '2026-07-15' },
      { db },
    ).data;

    // Escrita crua, simulando alteração fora do `mutate()` — é exatamente o que
    // o verificador de integridade existe para pegar.
    handle.sqlite.prepare('delete from transactions where id = ?').run(pair.in.id);

    const issues = checkIntegrity(db);
    assert.ok(issues.some((i) => i.check === 'pernas_da_transferencia'));
    assert.ok(issues.some((i) => i.check === 'transferencia_soma_zero'));
  });

  test('detecta sinal incoerente com o tipo', () => {
    const tx = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-10', amountCents: 5000, description: 'x', categoryId: food },
      { db },
    ).data;

    handle.sqlite.prepare('update transactions set amount_cents = 5000 where id = ?').run(tx.id);

    const issues = checkIntegrity(db);
    assert.ok(issues.some((i) => i.check === 'sinal_do_valor'));
  });
});
