import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, resetClock } from '../../src/core/clock.js';
import { createAccount } from '../../src/services/accounts.js';
import { createCategory } from '../../src/services/categories.js';
import { createTransaction, deleteTransaction, updateTransaction } from '../../src/services/transactions.js';
import { accountBalance, cashFlow, checkIntegrity } from '../../src/services/balances.js';
import {
  createInstallmentPlan,
  cancelInstallmentPlan,
  getInstallmentPlan,
  invoiceDetail,
  payInvoice,
  upcomingInvoices,
  refreshInvoiceStatuses,
} from '../../src/services/cards.js';
import {
  computeInvoiceStatus,
  findInvoiceByMonth,
  listInvoices,
  openInvoices,
} from '../../src/services/invoices.js';
import { resolveInvoiceCycle } from '../../src/services/invoice-cycle.js';
import { undoChangeSet } from '../../src/mutate/index.js';
import { sumCents } from '../../src/core/money.js';
import { AppError } from '../../src/core/errors.js';
import { testDb, snapshot } from '../helpers/db.js';
import type { DbHandle } from '../../src/db/client.js';

let handle: DbHandle;
let db: DbHandle['db'];
let checking: string;
let card: string;
let food: string;
let electronics: string;

beforeEach(() => {
  // Relógio fixo: status de fatura e "hoje" dependem dele.
  setClock(new Date('2026-07-26T12:00:00Z'));

  handle = testDb();
  db = handle.db;

  checking = createAccount(
    { name: 'Conta Corrente', kind: 'checking', openingBalanceCents: 1_000_000, openingDate: '2026-01-01' },
    { db },
  ).data.id;

  card = createAccount(
    {
      name: 'Cartão Nubank',
      kind: 'credit_card',
      openingDate: '2026-01-01',
      card: { limitCents: 800_000, closingDay: 20, dueDay: 28, paymentAccountId: checking },
    },
    { db },
  ).data.id;

  food = createCategory({ name: 'Alimentação', kind: 'expense' }, { db }).data.id;
  electronics = createCategory({ name: 'Eletrônicos', kind: 'expense' }, { db }).data.id;
});

afterEach(() => {
  handle.close();
  resetClock();
});

describe('compra no cartão vai para a fatura certa', () => {
  test('compra antes do fechamento entra na fatura do mês', () => {
    const tx = createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-15', amountCents: 25_000, description: 'Mercado', categoryId: food },
      { db },
    ).data;

    assert.ok(tx.cardInvoiceId, 'compra no cartão deve nascer vinculada a uma fatura');

    const invoice = findInvoiceByMonth(card, '2026-07', db);
    assert.ok(invoice);
    assert.equal(tx.cardInvoiceId, invoice.id);
    assert.equal(invoice.totalCents, 25_000, 'total da fatura é positivo (é o que se deve)');
    assert.equal(invoice.dueDate, '2026-07-28');
  });

  test('compra no dia do fechamento cai na fatura seguinte', () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-20', amountCents: 10_000, description: 'No fechamento', categoryId: food },
      { db },
    );

    assert.equal(findInvoiceByMonth(card, '2026-07', db), undefined);
    assert.equal(findInvoiceByMonth(card, '2026-08', db)?.totalCents, 10_000);
  });

  test('duas compras no mesmo ciclo somam numa única fatura', () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-05', amountCents: 15_000, description: 'A', categoryId: food },
      { db },
    );
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-12', amountCents: 8_000, description: 'B', categoryId: food },
      { db },
    );

    assert.equal(listInvoices({ cardAccountId: card, db }).length, 1, 'índice único impede fatura duplicada');
    assert.equal(findInvoiceByMonth(card, '2026-07', db)?.totalCents, 23_000);
  });

  test('compra em conta comum não gera fatura', () => {
    const tx = createTransaction(
      { accountId: checking, type: 'expense', date: '2026-07-15', amountCents: 5_000, description: 'Padaria', categoryId: food },
      { db },
    ).data;

    assert.equal(tx.cardInvoiceId, null);
    assert.equal(listInvoices({ db }).length, 0);
  });

  test('excluir a compra encolhe a fatura', () => {
    const tx = createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-15', amountCents: 25_000, description: 'Mercado', categoryId: food },
      { db },
    ).data;
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-16', amountCents: 5_000, description: 'Outra', categoryId: food },
      { db },
    );

    assert.equal(findInvoiceByMonth(card, '2026-07', db)?.totalCents, 30_000);
    deleteTransaction(tx.id, { db });
    assert.equal(findInvoiceByMonth(card, '2026-07', db)?.totalCents, 5_000);
  });

  test('mudar a data move a compra entre faturas e ajusta os dois totais', () => {
    const tx = createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-15', amountCents: 25_000, description: 'Mercado', categoryId: food },
      { db },
    ).data;

    assert.equal(findInvoiceByMonth(card, '2026-07', db)?.totalCents, 25_000);

    // Move para depois do fechamento: a compra passa para a fatura de agosto.
    updateTransaction(tx.id, { date: '2026-07-25' }, { db });

    assert.equal(findInvoiceByMonth(card, '2026-07', db)?.totalCents, 0, 'fatura antiga tem que esvaziar');
    assert.equal(findInvoiceByMonth(card, '2026-08', db)?.totalCents, 25_000);
  });

  test('mudar o valor atualiza o total da fatura', () => {
    const tx = createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-15', amountCents: 25_000, description: 'Mercado', categoryId: food },
      { db },
    ).data;

    updateTransaction(tx.id, { amountCents: 40_000 }, { db });
    assert.equal(findInvoiceByMonth(card, '2026-07', db)?.totalCents, 40_000);
  });

  test('o total gravado sempre bate com a soma das compras', () => {
    for (const day of ['05', '10', '15', '18']) {
      createTransaction(
        { accountId: card, type: 'expense', date: `2026-07-${day}`, amountCents: 1_234, description: `Compra ${day}`, categoryId: food },
        { db },
      );
    }

    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    const detail = invoiceDetail(invoice.id, db);
    assert.equal(detail.totalCents, detail.computedTotalCents);
    assert.equal(detail.totalCents, 4 * 1_234);
  });
});

describe('parcelamento', () => {
  test('distribui em ciclos consecutivos e a soma fecha exatamente', () => {
    const plan = createInstallmentPlan(
      {
        accountId: card,
        description: 'Notebook',
        totalCents: 300_010, // não divide por 3 — sobra 1 centavo
        installments: 3,
        purchaseDate: '2026-07-15',
        categoryId: electronics,
      },
      { db },
    ).data;

    assert.equal(plan.transactions.length, 3);

    // A soma das parcelas é exatamente o total: nunca R$ 0,01 a mais ou a menos.
    const total = sumCents(plan.transactions.map((t) => Math.abs(t.amountCents)));
    assert.equal(total, 300_010);
    assert.deepEqual(
      plan.transactions.map((t) => Math.abs(t.amountCents)),
      [100_004, 100_003, 100_003],
    );

    // Uma parcela por fatura, em meses consecutivos.
    const months = plan.transactions.map(
      (t) => listInvoices({ cardAccountId: card, db }).find((i) => i.id === t.cardInvoiceId)!.referenceMonth,
    );
    assert.deepEqual(months, ['2026-07', '2026-08', '2026-09']);
  });

  test('a data de cada parcela pertence ao ciclo da sua fatura', () => {
    // Propriedade importante: recalcular a fatura a partir da data da parcela
    // devolve a mesma fatura à qual ela está vinculada.
    const plan = createInstallmentPlan(
      { accountId: card, description: 'TV', totalCents: 240_000, installments: 6, purchaseDate: '2026-07-15', categoryId: electronics },
      { db },
    ).data;

    const invoices = listInvoices({ cardAccountId: card, db });

    for (const installment of plan.transactions) {
      const invoice = invoices.find((i) => i.id === installment.cardInvoiceId)!;
      const recomputed = resolveInvoiceCycle(installment.date, { closingDay: 20, dueDay: 28 });
      assert.equal(
        recomputed.referenceMonth,
        invoice.referenceMonth,
        `parcela ${installment.installmentNo} datada em ${installment.date} deveria pertencer ao ciclo ${invoice.referenceMonth}`,
      );
    }
  });

  test('primeira parcela é efetivada, as futuras ficam agendadas', () => {
    const plan = createInstallmentPlan(
      { accountId: card, description: 'Celular', totalCents: 120_000, installments: 4, purchaseDate: '2026-07-15', categoryId: electronics },
      { db },
    ).data;

    assert.equal(plan.transactions[0]!.status, 'cleared');
    assert.deepEqual(plan.transactions.slice(1).map((t) => t.status), ['scheduled', 'scheduled', 'scheduled']);

    // Só a primeira entra no saldo disponível; todas entram no projetado.
    const balance = accountBalance(card, { db });
    assert.equal(balance.availableCents, -30_000);
    assert.equal(balance.projectedCents, -120_000);
  });

  test('parcela numerada na descrição', () => {
    const plan = createInstallmentPlan(
      { accountId: card, description: 'Geladeira', totalCents: 90_000, installments: 3, purchaseDate: '2026-07-15' },
      { db },
    ).data;

    assert.deepEqual(
      plan.transactions.map((t) => t.description),
      ['Geladeira (1/3)', 'Geladeira (2/3)', 'Geladeira (3/3)'],
    );
    assert.deepEqual(plan.transactions.map((t) => t.installmentNo), [1, 2, 3]);
  });

  test('parcelamento fora de cartão exige data da primeira cobrança', () => {
    assert.throws(
      () =>
        createInstallmentPlan(
          { accountId: checking, description: 'Curso', totalCents: 60_000, installments: 3, purchaseDate: '2026-07-15' },
          { db },
        ),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('parcelamento em conta comum cai de mês em mês', () => {
    const plan = createInstallmentPlan(
      {
        accountId: checking,
        description: 'Curso',
        totalCents: 60_000,
        installments: 3,
        purchaseDate: '2026-07-15',
        firstChargeDate: '2026-08-10',
      },
      { db },
    ).data;

    assert.deepEqual(plan.transactions.map((t) => t.date), ['2026-08-10', '2026-09-10', '2026-10-10']);
    assert.ok(plan.transactions.every((t) => t.cardInvoiceId === null));
  });

  test('cancelar remove as futuras e preserva as já pagas', () => {
    const plan = createInstallmentPlan(
      { accountId: card, description: 'Sofá', totalCents: 120_000, installments: 4, purchaseDate: '2026-07-15', categoryId: electronics },
      { db },
    ).data;

    const result = cancelInstallmentPlan(plan.id, { db }).data;

    assert.equal(result.removed, 3, 'as três parcelas futuras saem');
    assert.equal(result.kept, 1, 'a parcela já paga permanece — ela aconteceu');

    const remaining = getInstallmentPlan(plan.id, db);
    assert.equal(remaining.transactions.length, 1);
    assert.equal(findInvoiceByMonth(card, '2026-08', db)?.totalCents, 0);
  });

  test('undo desfaz o parcelamento inteiro num só passo', () => {
    const before = snapshot(handle, 'transactions');
    const beforeInvoices = snapshot(handle, 'card_invoices');

    const { changeSetId } = createInstallmentPlan(
      { accountId: card, description: 'Bicicleta', totalCents: 180_000, installments: 6, purchaseDate: '2026-07-15', categoryId: electronics },
      { db },
    );

    undoChangeSet(changeSetId, { db });

    // Um change set único cobrindo plano + 6 parcelas + 6 faturas.
    assert.deepEqual(snapshot(handle, 'transactions'), before);
    assert.deepEqual(snapshot(handle, 'card_invoices'), beforeInvoices);
    assert.deepEqual(snapshot(handle, 'installment_plans'), []);
  });

  test('mínimo de 2 parcelas', () => {
    assert.throws(() =>
      createInstallmentPlan(
        { accountId: card, description: 'x', totalCents: 1000, installments: 1, purchaseDate: '2026-07-15' },
        { db },
      ),
    );
  });
});

describe('pagamento de fatura', () => {
  beforeEach(() => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-10', amountCents: 150_000, description: 'Compras', categoryId: food },
      { db },
    );
  });

  test('é transferência, não despesa — o gasto não conta duas vezes', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;

    // Antes de pagar: a despesa é a compra, R$ 1.500.
    const before = cashFlow('2026-07-01', '2026-07-31', { db });
    assert.equal(before.expenseCents, 150_000);

    payInvoice(invoice.id, { date: '2026-07-28' }, { db });

    // Depois de pagar: continua R$ 1.500. Se o pagamento fosse despesa, viraria R$ 3.000.
    const after = cashFlow('2026-07-01', '2026-07-31', { db });
    assert.equal(after.expenseCents, 150_000, 'pagar a fatura não é um gasto novo');
  });

  test('quita a dívida do cartão e debita a conta corrente', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    assert.equal(accountBalance(card, { db }).availableCents, -150_000);

    payInvoice(invoice.id, { date: '2026-07-28' }, { db });

    assert.equal(accountBalance(card, { db }).availableCents, 0, 'dívida do cartão zerada');
    assert.equal(accountBalance(checking, { db }).availableCents, 1_000_000 - 150_000);
  });

  test('marca a fatura como paga e usa a conta padrão do cartão', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    const payment = payInvoice(invoice.id, { date: '2026-07-28' }, { db }).data;

    assert.equal(payment.invoice.paidCents, 150_000);
    assert.equal(payment.invoice.status, 'paid');
    assert.ok(payment.invoice.paidAt);
    assert.equal(payment.paymentTransaction.accountId, checking, 'usou a conta de pagamento configurada');
  });

  test('o pagamento não infla o total da fatura', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    payInvoice(invoice.id, { date: '2026-07-28' }, { db });

    const detail = invoiceDetail(invoice.id, db);
    assert.equal(detail.totalCents, 150_000, 'total continua sendo o das compras');
    assert.equal(detail.purchases.length, 1);
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.computedTotalCents, 150_000);
  });

  test('pagamento parcial deixa saldo devedor', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    const payment = payInvoice(invoice.id, { amountCents: 50_000, date: '2026-07-28' }, { db }).data;

    assert.equal(payment.invoice.paidCents, 50_000);
    assert.notEqual(payment.invoice.status, 'paid');
    assert.equal(payment.invoice.paidAt, null);

    // O restante ainda aparece como conta a pagar.
    const pending = openInvoices(db);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.remainingCents, 100_000);

    // E é possível quitar o resto depois.
    const rest = payInvoice(invoice.id, { date: '2026-07-29' }, { db }).data;
    assert.equal(rest.invoice.paidCents, 150_000);
    assert.equal(rest.invoice.status, 'paid');
    assert.equal(openInvoices(db).length, 0);
  });

  test('recusa pagar mais que o saldo devedor', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    assert.throws(
      () => payInvoice(invoice.id, { amountCents: 200_000 }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('recusa pagar fatura já quitada', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    payInvoice(invoice.id, { date: '2026-07-28' }, { db });

    assert.throws(
      () => payInvoice(invoice.id, {}, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('recusa pagar a fatura com o próprio cartão', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    assert.throws(
      () => payInvoice(invoice.id, { fromAccountId: card }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('undo do pagamento restaura a dívida', () => {
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    const beforeTx = snapshot(handle, 'transactions');
    const beforeInvoices = snapshot(handle, 'card_invoices');

    const { changeSetId } = payInvoice(invoice.id, { date: '2026-07-28' }, { db });
    assert.equal(accountBalance(card, { db }).availableCents, 0);

    undoChangeSet(changeSetId, { db });

    assert.deepEqual(snapshot(handle, 'transactions'), beforeTx);
    assert.deepEqual(snapshot(handle, 'card_invoices'), beforeInvoices);
    assert.equal(accountBalance(card, { db }).availableCents, -150_000);
  });
});

describe('status da fatura', () => {
  test('calculado a partir das datas e do pago', () => {
    const base = { closingDate: '2026-07-20', dueDate: '2026-07-28', totalCents: 100_000, paidCents: 0 };

    assert.equal(computeInvoiceStatus(base, '2026-07-10'), 'open');
    assert.equal(computeInvoiceStatus(base, '2026-07-20'), 'closed', 'no dia do fechamento já está fechada');
    assert.equal(computeInvoiceStatus(base, '2026-07-25'), 'closed');
    assert.equal(computeInvoiceStatus(base, '2026-07-29'), 'overdue', 'passou do vencimento sem pagar');
    assert.equal(computeInvoiceStatus({ ...base, paidCents: 100_000 }, '2026-08-15'), 'paid');
    assert.equal(computeInvoiceStatus({ ...base, paidCents: 40_000 }, '2026-08-15'), 'overdue', 'pagamento parcial vencido');
  });

  test('fatura sem compras não é "paga" — não havia o que pagar', () => {
    // Uma compra depois do fechamento cria a fatura do ciclo seguinte com total
    // zero. Marcá-la como paga daria a impressão de um pagamento que não houve.
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-05-25', amountCents: 10_000, description: 'Compra', categoryId: food },
      { db },
    );

    const emptyPast = computeInvoiceStatus(
      { closingDate: '2026-05-20', dueDate: '2026-05-28', totalCents: 0, paidCents: 0 },
      '2026-07-26',
    );
    assert.equal(emptyPast, 'closed');
  });

  test('a leitura recalcula, então status obsoleto no banco não engana', () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-05-10', amountCents: 50_000, description: 'Antiga', categoryId: food },
      { db },
    );
    const invoice = findInvoiceByMonth(card, '2026-05', db)!;

    // O serviço mantém o status gravado em dia a cada recálculo. Para exercitar o
    // caminho do valor obsoleto, força-se a divergência por fora — é o que
    // aconteceria se o processo ficasse dias sem rodar.
    handle.sqlite.prepare("update card_invoices set status = 'open' where id = ?").run(invoice.id);
    assert.equal(findInvoiceByMonth(card, '2026-05', db)?.status, 'open');

    const view = listInvoices({ cardAccountId: card, db }).find((i) => i.id === invoice.id)!;
    assert.equal(view.effectiveStatus, 'overdue', 'hoje é 26/07 e venceu em 28/05');
  });

  test('o job corrige o status gravado', () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-05-10', amountCents: 50_000, description: 'Antiga', categoryId: food },
      { db },
    );
    const invoice = findInvoiceByMonth(card, '2026-05', db)!;
    handle.sqlite.prepare("update card_invoices set status = 'open' where id = ?").run(invoice.id);

    const changed = refreshInvoiceStatuses({ db }).data.changed;
    assert.equal(changed, 1);
    assert.equal(findInvoiceByMonth(card, '2026-05', db)?.status, 'overdue');
  });

  test('status gravado já nasce correto no fluxo normal', () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-05-10', amountCents: 50_000, description: 'Antiga', categoryId: food },
      { db },
    );

    // Sem intervenção externa, o recálculo do total já deixou o status certo —
    // o job é rede de segurança, não a única fonte de atualização.
    assert.equal(findInvoiceByMonth(card, '2026-05', db)?.status, 'overdue');
    assert.equal(refreshInvoiceStatuses({ db }).data.changed, 0);
  });
});

describe('faturas a vencer', () => {
  test('lista o que está por pagar, com dias até o vencimento', () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-10', amountCents: 90_000, description: 'Compras de julho', categoryId: food },
      { db },
    );

    const upcoming = upcomingInvoices({ db });
    assert.equal(upcoming.length, 1);
    assert.equal(upcoming[0]!.cardName, 'Cartão Nubank');
    assert.equal(upcoming[0]!.remainingCents, 90_000);
    // Hoje é 26/07, vence 28/07.
    assert.equal(upcoming[0]!.daysUntilDue, 2);
  });

  test('fatura paga sai da lista', () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-10', amountCents: 90_000, description: 'Compras', categoryId: food },
      { db },
    );
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    payInvoice(invoice.id, { date: '2026-07-28' }, { db });

    assert.equal(upcomingInvoices({ db }).length, 0);
  });
});

describe('integridade com cartão', () => {
  test('cenário completo não acusa problema', () => {
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-07-05', amountCents: 45_000, description: 'Mercado', categoryId: food },
      { db },
    );
    createInstallmentPlan(
      { accountId: card, description: 'Notebook', totalCents: 300_010, installments: 6, purchaseDate: '2026-07-10', categoryId: electronics },
      { db },
    );
    const invoice = findInvoiceByMonth(card, '2026-07', db)!;
    payInvoice(invoice.id, { amountCents: 30_000, date: '2026-07-28' }, { db });

    assert.deepEqual(checkIntegrity(db), []);
  });

  test('o total de toda fatura bate com a soma das suas compras', () => {
    createInstallmentPlan(
      { accountId: card, description: 'Móveis', totalCents: 555_555, installments: 7, purchaseDate: '2026-07-10', categoryId: electronics },
      { db },
    );
    createTransaction(
      { accountId: card, type: 'expense', date: '2026-08-15', amountCents: 12_345, description: 'Extra', categoryId: food },
      { db },
    );

    for (const invoice of listInvoices({ cardAccountId: card, db })) {
      const detail = invoiceDetail(invoice.id, db);
      assert.equal(
        detail.totalCents,
        detail.computedTotalCents,
        `fatura ${invoice.referenceMonth}: cache ${detail.totalCents} ≠ soma ${detail.computedTotalCents}`,
      );
    }
  });

  test('a soma das faturas de um parcelamento é o total da compra', () => {
    const plan = createInstallmentPlan(
      { accountId: card, description: 'Reforma', totalCents: 1_000_001, installments: 12, purchaseDate: '2026-07-10', categoryId: electronics },
      { db },
    ).data;

    const invoiceIds = new Set(plan.transactions.map((t) => t.cardInvoiceId));
    const invoices = listInvoices({ cardAccountId: card, db }).filter((i) => invoiceIds.has(i.id));

    assert.equal(invoices.length, 12, 'uma fatura por parcela');
    assert.equal(sumCents(invoices.map((i) => i.totalCents)), 1_000_001);
  });
});
