import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { setClock, resetClock } from '../../src/core/clock.js';
import { createAccount } from '../../src/services/accounts.js';
import { createCategory } from '../../src/services/categories.js';
import { createTransaction } from '../../src/services/transactions.js';
import { accountBalance, checkIntegrity } from '../../src/services/balances.js';
import {
  confirmOccurrence,
  createRecurrence,
  deactivateRecurrence,
  deleteRecurrence,
  materializeAll,
  pendingOccurrences,
  promoteDueOccurrences,
  recurrenceTransactions,
  updateRecurrence,
  upcomingBills,
} from '../../src/services/recurrences.js';
import { futureCommitments, projectBalance } from '../../src/services/projection.js';
import { createInstallmentPlan } from '../../src/services/cards.js';
import { undoChangeSet } from '../../src/mutate/index.js';
import { transactions } from '../../src/db/schema.js';
import { AppError } from '../../src/core/errors.js';
import { testDb, snapshot } from '../helpers/db.js';
import type { DbHandle } from '../../src/db/client.js';

let handle: DbHandle;
let db: DbHandle['db'];
let checking: string;
let housing: string;
let salaryCategory: string;

beforeEach(() => {
  setClock(new Date('2026-07-26T12:00:00Z'));
  handle = testDb();
  db = handle.db;

  checking = createAccount(
    { name: 'Conta Corrente', kind: 'checking', openingBalanceCents: 500_000, openingDate: '2026-01-01' },
    { db },
  ).data.id;
  housing = createCategory({ name: 'Moradia', kind: 'expense' }, { db }).data.id;
  salaryCategory = createCategory({ name: 'Salário', kind: 'income' }, { db }).data.id;
});

afterEach(() => {
  handle.close();
  resetClock();
});

describe('materialização', () => {
  test('cria ocorrências futuras dentro do horizonte', () => {
    const result = createRecurrence(
      {
        name: 'Aluguel',
        accountId: checking,
        type: 'expense',
        amountCents: 180_000,
        categoryId: housing,
        freq: 'monthly',
        dayOfMonth: 5,
        startDate: '2026-07-01',
        autoPost: true,
      },
      { db },
    ).data;

    // Horizonte padrão de 120 dias a partir de 26/07: agosto, setembro, outubro,
    // novembro.
    assert.equal(result.materialized, 4);

    const created = recurrenceTransactions(result.recurrence.id, db);
    assert.deepEqual(created.map((t) => t.date), ['2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05']);
    assert.ok(created.every((t) => t.status === 'scheduled'));
    assert.ok(created.every((t) => t.amountCents === -180_000));
    assert.ok(created.every((t) => t.createdBy === 'system'));
  });

  test('não retroage: ocorrências passadas não são inventadas', () => {
    const result = createRecurrence(
      {
        name: 'Internet',
        accountId: checking,
        type: 'expense',
        amountCents: 12_000,
        categoryId: housing,
        freq: 'monthly',
        dayOfMonth: 10,
        startDate: '2026-01-10',
        autoPost: true,
      },
      { db },
    ).data;

    const created = recurrenceTransactions(result.recurrence.id, db);
    // Se a conta de março não foi lançada, quem sabe se foi paga é você.
    assert.ok(created.every((t) => t.date >= '2026-07-26'), 'nada antes de hoje');
    assert.equal(created[0]!.date, '2026-08-10');
  });

  test('rodar o materializador duas vezes não duplica', () => {
    const result = createRecurrence(
      {
        name: 'Aluguel',
        accountId: checking,
        type: 'expense',
        amountCents: 180_000,
        categoryId: housing,
        freq: 'monthly',
        dayOfMonth: 5,
        startDate: '2026-07-01',
      },
      { db },
    ).data;

    const before = recurrenceTransactions(result.recurrence.id, db).length;

    // O materializador roda na partida do servidor e no job diário.
    materializeAll({ db });
    materializeAll({ db });

    assert.equal(recurrenceTransactions(result.recurrence.id, db).length, before);
  });

  test('o índice único é a última linha de defesa contra duplicação', () => {
    const result = createRecurrence(
      { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01' },
      { db },
    ).data;

    const existing = recurrenceTransactions(result.recurrence.id, db)[0]!;

    assert.throws(
      () =>
        handle.sqlite
          .prepare(
            `insert into transactions (id, account_id, type, date, amount_cents, currency, description, status, recurrence_id, recurrence_occurrence, has_splits, created_by, created_at, updated_at)
             values ('DUPLICADA', ?, 'expense', ?, -180000, 'BRL', 'Aluguel', 'scheduled', ?, ?, 0, 'system', '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z')`,
          )
          .run(checking, existing.date, result.recurrence.id, existing.recurrenceOccurrence),
      /UNIQUE/,
    );
  });

  test('recorrência de valor variável usa a estimativa', () => {
    const result = createRecurrence(
      {
        name: 'Conta de luz',
        accountId: checking,
        type: 'expense',
        estimatedCents: 18_000,
        categoryId: housing,
        freq: 'monthly',
        dayOfMonth: 15,
        startDate: '2026-07-01',
      },
      { db },
    ).data;

    assert.equal(result.recurrence.amountCents, null);
    assert.equal(result.recurrence.effectiveCents, 18_000);
    assert.ok(recurrenceTransactions(result.recurrence.id, db).every((t) => t.amountCents === -18_000));
  });

  test('exige valor fixo ou estimativa', () => {
    assert.throws(() =>
      createRecurrence(
        { name: 'Sem valor', accountId: checking, type: 'expense', freq: 'monthly', startDate: '2026-07-01' },
        { db },
      ),
    );
  });

  test('categoria tem que combinar com o tipo', () => {
    assert.throws(
      () =>
        createRecurrence(
          {
            name: 'Errada',
            accountId: checking,
            type: 'expense',
            amountCents: 1000,
            categoryId: salaryCategory,
            freq: 'monthly',
            startDate: '2026-07-01',
          },
          { db },
        ),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('respeita maxOccurrences', () => {
    const result = createRecurrence(
      {
        name: 'Parcelado',
        accountId: checking,
        type: 'expense',
        amountCents: 50_000,
        categoryId: housing,
        freq: 'monthly',
        dayOfMonth: 10,
        startDate: '2026-08-01',
        maxOccurrences: 2,
      },
      { db },
    ).data;

    assert.equal(result.materialized, 2);
    materializeAll({ db });
    assert.equal(recurrenceTransactions(result.recurrence.id, db).length, 2, 'não renova ao rematerializar');
  });
});

describe('promoção e confirmação', () => {
  test('autoPost efetiva, sem autoPost fica pendente', () => {
    const auto = createRecurrence(
      { name: 'Aluguel (débito automático)', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01', autoPost: true },
      { db },
    ).data;
    const manual = createRecurrence(
      { name: 'Conta de luz', accountId: checking, type: 'expense', estimatedCents: 18_000, categoryId: housing, freq: 'monthly', dayOfMonth: 15, startDate: '2026-07-01', autoPost: false },
      { db },
    ).data;

    // Avança o relógio para depois de 15/08 e roda o job.
    setClock(new Date('2026-08-16T12:00:00Z'));
    const promoted = promoteDueOccurrences({ db }).data;

    assert.equal(promoted.cleared, 1, 'o aluguel entra direto');
    assert.equal(promoted.pending, 1, 'a luz espera conferência');

    assert.equal(
      recurrenceTransactions(auto.recurrence.id, db).find((t) => t.date === '2026-08-05')?.status,
      'cleared',
    );
    assert.equal(
      recurrenceTransactions(manual.recurrence.id, db).find((t) => t.date === '2026-08-15')?.status,
      'pending',
    );
  });

  test('confirmar com valor real corrige o lançamento e a estimativa', () => {
    const result = createRecurrence(
      { name: 'Conta de luz', accountId: checking, type: 'expense', estimatedCents: 18_000, categoryId: housing, freq: 'monthly', dayOfMonth: 15, startDate: '2026-07-01' },
      { db },
    ).data;

    setClock(new Date('2026-08-16T12:00:00Z'));
    promoteDueOccurrences({ db });

    const pending = pendingOccurrences(db);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.recurrenceName, 'Conta de luz');

    // Veio R$ 187,43 em vez dos R$ 180 estimados.
    const confirmed = confirmOccurrence(pending[0]!.id, { amountCents: 18_743 }, { db }).data;

    assert.equal(confirmed.status, 'cleared');
    assert.equal(confirmed.amountCents, -18_743);
    assert.equal(pendingOccurrences(db).length, 0);

    // A estimativa é atualizada para a próxima projeção ficar mais realista.
    const updated = handle.db.select().from(transactions).where(eq(transactions.id, confirmed.id)).all()[0]!;
    assert.equal(updated.amountCents, -18_743);
    assert.equal(result.recurrence.id, updated.recurrenceId);
  });

  test('recusa confirmar duas vezes', () => {
    createRecurrence(
      { name: 'Luz', accountId: checking, type: 'expense', estimatedCents: 18_000, categoryId: housing, freq: 'monthly', dayOfMonth: 15, startDate: '2026-07-01' },
      { db },
    );
    setClock(new Date('2026-08-16T12:00:00Z'));
    promoteDueOccurrences({ db });

    const pending = pendingOccurrences(db)[0]!;
    confirmOccurrence(pending.id, {}, { db });

    assert.throws(
      () => confirmOccurrence(pending.id, {}, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });
});

describe('alteração e exclusão', () => {
  test('alterar o valor regenera só o futuro não confirmado', () => {
    const result = createRecurrence(
      { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01', autoPost: true },
      { db },
    ).data;

    // Efetiva a ocorrência de agosto.
    setClock(new Date('2026-08-06T12:00:00Z'));
    promoteDueOccurrences({ db });
    setClock(new Date('2026-07-26T12:00:00Z'));

    // Reajuste do aluguel.
    const updated = updateRecurrence(result.recurrence.id, { amountCents: 195_000 }, { db }).data;

    const all = recurrenceTransactions(result.recurrence.id, db);
    const august = all.find((t) => t.date === '2026-08-05')!;
    const september = all.find((t) => t.date === '2026-09-05')!;

    assert.equal(august.amountCents, -180_000, 'agosto já foi pago com o valor antigo');
    assert.equal(september.amountCents, -195_000, 'setembro em diante usa o novo valor');
    assert.ok(updated.regenerated >= 1);
  });

  test('desativar remove o futuro e preserva o passado', () => {
    const result = createRecurrence(
      { name: 'Assinatura', accountId: checking, type: 'expense', amountCents: 5_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01', autoPost: true },
      { db },
    ).data;

    setClock(new Date('2026-08-06T12:00:00Z'));
    promoteDueOccurrences({ db });
    setClock(new Date('2026-07-26T12:00:00Z'));

    const removed = deactivateRecurrence(result.recurrence.id, { db }).data.removed;
    assert.ok(removed >= 1);

    const remaining = recurrenceTransactions(result.recurrence.id, db);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.status, 'cleared');
  });

  test('excluir desvincula o que já aconteceu', () => {
    const result = createRecurrence(
      { name: 'Assinatura', accountId: checking, type: 'expense', amountCents: 5_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01', autoPost: true },
      { db },
    ).data;

    setClock(new Date('2026-08-06T12:00:00Z'));
    promoteDueOccurrences({ db });
    setClock(new Date('2026-07-26T12:00:00Z'));

    const outcome = deleteRecurrence(result.recurrence.id, { db }).data;

    assert.equal(outcome.unlinked, 1, 'o lançamento efetivado permanece');
    assert.ok(outcome.removed >= 1);

    // A transação sobrevive sem o vínculo — o gasto aconteceu.
    const orphan = db.select().from(transactions).all();
    assert.equal(orphan.length, 1);
    assert.equal(orphan[0]!.recurrenceId, null);
    assert.equal(orphan[0]!.status, 'cleared');
  });

  test('undo da criação remove a recorrência e todas as ocorrências', () => {
    const before = snapshot(handle, 'transactions');

    const { changeSetId } = createRecurrence(
      { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01' },
      { db },
    );

    undoChangeSet(changeSetId, { db });

    assert.deepEqual(snapshot(handle, 'transactions'), before);
    assert.deepEqual(snapshot(handle, 'recurrences'), []);
  });
});

describe('saldo e projeção', () => {
  test('agendado não entra no disponível, mas entra no projetado', () => {
    createRecurrence(
      { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01' },
      { db },
    );

    const balance = accountBalance(checking, { db });
    assert.equal(balance.availableCents, 500_000, 'nada efetivou ainda');
    assert.equal(balance.projectedCents, 500_000 - 4 * 180_000);
  });

  test('projeção encontra o dia em que o saldo fica negativo', () => {
    createRecurrence(
      { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01' },
      { db },
    );

    const projection = projectBalance({ accountId: checking, days: 120, db });

    assert.equal(projection.startingCents, 500_000);
    // 500.000 − 3×180.000 = −40.000 na terceira ocorrência (05/10).
    assert.equal(projection.firstNegativeDate, '2026-10-05');
    assert.equal(projection.lowestDate, '2026-11-05');
    assert.equal(projection.lowestCents, 500_000 - 4 * 180_000);
  });

  test('projeção inclui receita e mostra o saldo subindo', () => {
    createRecurrence(
      { name: 'Salário', accountId: checking, type: 'income', amountCents: 600_000, categoryId: salaryCategory, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01', autoPost: true },
      { db },
    );
    createRecurrence(
      { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 10, startDate: '2026-07-01', autoPost: true },
      { db },
    );

    const projection = projectBalance({ accountId: checking, days: 120, db });

    assert.equal(projection.firstNegativeDate, null, 'com salário entrando, não fica negativo');
    assert.ok(projection.endingCents > projection.startingCents);

    // Cada dia da projeção lista o que compõe o movimento.
    const august5 = projection.points.find((p) => p.date === '2026-08-05')!;
    assert.equal(august5.changeCents, 600_000);
    assert.equal(august5.items[0]!.description, 'Salário');
  });

  test('previsão atrasada entra no primeiro dia da projeção', () => {
    // Uma conta que era para 20/07 e ninguém confirmou: ela ainda vai sair.
    createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-20', amountCents: 30_000, description: 'Atrasada', categoryId: housing, status: 'pending' },
      { db },
    );

    const projection = projectBalance({ accountId: checking, days: 30, db });
    const firstPoint = projection.points[0]!;

    assert.equal(firstPoint.date, '2026-07-26', 'hoje, não a data vencida');
    assert.equal(firstPoint.changeCents, -30_000);
  });

  test('comprometimento futuro soma parcelas, recorrências e faturas', () => {
    const card = createAccount(
      { name: 'Cartão', kind: 'credit_card', openingDate: '2026-01-01', card: { limitCents: 500_000, closingDay: 20, dueDay: 28, paymentAccountId: checking } },
      { db },
    ).data.id;

    createRecurrence(
      { name: 'Salário', accountId: checking, type: 'income', amountCents: 600_000, categoryId: salaryCategory, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01' },
      { db },
    );
    createRecurrence(
      { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 10, startDate: '2026-07-01' },
      { db },
    );
    createInstallmentPlan(
      { accountId: card, description: 'Notebook', totalCents: 300_000, installments: 6, purchaseDate: '2026-07-10', categoryId: housing },
      { db },
    );

    const commitments = futureCommitments({ days: 40, db });

    assert.ok(commitments.recurringCents >= 180_000, 'aluguel de agosto');
    assert.ok(commitments.installmentsCents > 0, 'parcelas futuras do notebook');
    assert.ok(commitments.cardInvoicesCents > 0, 'fatura de julho a vencer');
    assert.equal(commitments.expectedIncomeCents, 600_000);
    assert.ok(commitments.committedPercent !== null && commitments.committedPercent > 0);
  });
});

describe('contas a vencer', () => {
  test('lista o que vence nos próximos dias', () => {
    createRecurrence(
      { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 180_000, categoryId: housing, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01' },
      { db },
    );
    createRecurrence(
      { name: 'Internet', accountId: checking, type: 'expense', amountCents: 12_000, categoryId: housing, freq: 'monthly', dayOfMonth: 20, startDate: '2026-07-01' },
      { db },
    );

    const bills = upcomingBills({ withinDays: 30, db });

    assert.deepEqual(bills.map((b) => b.recurrenceName), ['Aluguel', 'Internet']);
    assert.equal(bills[0]!.transaction.date, '2026-08-05');
    assert.equal(bills[0]!.daysUntil, 10);
  });

  test('horizonte curto filtra o que está longe', () => {
    createRecurrence(
      { name: 'Anual', accountId: checking, type: 'expense', amountCents: 50_000, categoryId: housing, freq: 'yearly', startDate: '2026-12-01' },
      { db },
    );

    assert.equal(upcomingBills({ withinDays: 7, db }).length, 0);
  });
});

describe('integridade com recorrências', () => {
  test('cenário completo não acusa problema', () => {
    createRecurrence(
      { name: 'Salário', accountId: checking, type: 'income', amountCents: 600_000, categoryId: salaryCategory, freq: 'monthly', dayOfMonth: 5, startDate: '2026-07-01', autoPost: true },
      { db },
    );
    createRecurrence(
      { name: 'Luz', accountId: checking, type: 'expense', estimatedCents: 18_000, categoryId: housing, freq: 'monthly', dayOfMonth: 15, startDate: '2026-07-01' },
      { db },
    );

    setClock(new Date('2026-09-20T12:00:00Z'));
    promoteDueOccurrences({ db });
    materializeAll({ db });

    const pending = pendingOccurrences(db);
    for (const occurrence of pending) {
      confirmOccurrence(occurrence.id, { amountCents: 19_500 }, { db });
    }

    assert.deepEqual(checkIntegrity(db), []);
  });
});
