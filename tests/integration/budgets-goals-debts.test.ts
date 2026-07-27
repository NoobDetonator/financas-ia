import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setClock, resetClock } from '../../src/core/clock.js';
import { createAccount } from '../../src/services/accounts.js';
import { createCategory } from '../../src/services/categories.js';
import { createTransaction } from '../../src/services/transactions.js';
import { accountBalance, checkIntegrity } from '../../src/services/balances.js';
import {
  budgetStatus,
  budgetSummary,
  categorySpending,
  createBudget,
  getBudget,
  suggestBudgets,
} from '../../src/services/budgets.js';
import { contribute, createGoal, deleteGoal, getGoal, goalsBehindSchedule } from '../../src/services/goals.js';
import {
  createDebt,
  getDebt,
  payInstallment,
  simulateExtra,
  simulatePayoff,
  upcomingDebtPayments,
} from '../../src/services/debts.js';
import { undoChangeSet } from '../../src/mutate/index.js';
import { sumCents } from '../../src/core/money.js';
import { AppError } from '../../src/core/errors.js';
import { testDb, snapshot } from '../helpers/db.js';
import type { DbHandle } from '../../src/db/client.js';

let handle: DbHandle;
let db: DbHandle['db'];
let checking: string;
let savings: string;
let food: string;
let market: string;
let salaryCategory: string;

beforeEach(() => {
  setClock(new Date('2026-07-26T12:00:00Z'));
  handle = testDb();
  db = handle.db;

  checking = createAccount(
    { name: 'Conta Corrente', kind: 'checking', openingBalanceCents: 2_000_000, openingDate: '2026-01-01' },
    { db },
  ).data.id;
  savings = createAccount({ name: 'Poupança', kind: 'savings', openingDate: '2026-01-01' }, { db }).data.id;
  food = createCategory({ name: 'Alimentação', kind: 'expense' }, { db }).data.id;
  market = createCategory({ name: 'Mercado', kind: 'expense', parentId: food }, { db }).data.id;
  salaryCategory = createCategory({ name: 'Salário', kind: 'income' }, { db }).data.id;
});

afterEach(() => {
  handle.close();
  resetClock();
});

function spend(amountCents: number, date: string, categoryId = market): void {
  createTransaction(
    { accountId: checking, type: 'expense', date, amountCents, description: 'Compra', categoryId },
    { db },
  );
}

describe('orçamento: gasto derivado, nunca armazenado', () => {
  test('soma inclui subcategorias', () => {
    spend(30_000, '2026-07-05', market);
    spend(20_000, '2026-07-10', food);

    // Orçamento em Alimentação cobre Mercado também.
    assert.equal(categorySpending(food, '2026-07', db), 50_000);
    assert.equal(categorySpending(market, '2026-07', db), 30_000);
  });

  test('lançamento retroativo reflete na hora', () => {
    const budget = createBudget({ categoryId: food, amountCents: 100_000, startMonth: '2026-07' }, { db }).data;
    assert.equal(budgetStatus(budget, '2026-07', db).spentCents, 0);

    spend(45_000, '2026-07-03');
    assert.equal(budgetStatus(getBudget(budget.id, db), '2026-07', db).spentCents, 45_000);
  });

  test('rateio contribui apenas com a sua parte', () => {
    const home = createCategory({ name: 'Casa', kind: 'expense' }, { db }).data.id;
    createTransaction(
      {
        accountId: checking,
        type: 'expense',
        date: '2026-07-10',
        amountCents: 100_000,
        description: 'Compra dividida',
        splits: [
          { categoryId: market, amountCents: 70_000 },
          { categoryId: home, amountCents: 30_000 },
        ],
      },
      { db },
    );

    assert.equal(categorySpending(market, '2026-07', db), 70_000, 'não o total de R$ 1.000');
    assert.equal(categorySpending(home, '2026-07', db), 30_000);
  });

  test('transferência não conta como gasto', () => {
    spend(30_000, '2026-07-05');
    createTransaction(
      { accountId: checking, type: 'income', date: '2026-07-06', amountCents: 500_000, description: 'Salário', categoryId: salaryCategory },
      { db },
    );

    assert.equal(categorySpending(food, '2026-07', db), 30_000);
  });

  test('status calcula consumo, sobra e projeção', () => {
    const budget = createBudget({ categoryId: food, amountCents: 100_000, startMonth: '2026-07' }, { db }).data;
    spend(70_000, '2026-07-05');

    const status = budgetStatus(getBudget(budget.id, db), '2026-07', db);
    assert.equal(status.limitCents, 100_000);
    assert.equal(status.spentCents, 70_000);
    assert.equal(status.remainingCents, 30_000);
    assert.equal(status.usedPercent, 70);
  });

  test('detecta estouro e risco de estouro', () => {
    const clothes = createCategory({ name: 'Roupas', kind: 'expense' }, { db }).data.id;
    createBudget({ categoryId: food, amountCents: 100_000, startMonth: '2026-07' }, { db });
    createBudget({ categoryId: clothes, amountCents: 50_000, startMonth: '2026-07' }, { db });

    spend(120_000, '2026-07-05', market); // estourou Alimentação
    spend(30_000, '2026-07-05', clothes); // no ritmo, estoura Roupas

    const summary = budgetSummary('2026-07', db);
    assert.equal(summary.exceeded.length, 1);
    assert.equal(summary.exceeded[0]!.categoryName, 'Alimentação');
    assert.ok(summary.exceeded[0]!.remainingCents < 0);
    assert.equal(summary.totalSpentCents, 150_000);
  });

  test('rollover acumula a sobra dos meses anteriores', () => {
    const budget = createBudget(
      { categoryId: food, amountCents: 100_000, startMonth: '2026-05', rollover: true },
      { db },
    ).data;

    spend(60_000, '2026-05-10'); // sobrou 40.000
    spend(80_000, '2026-06-10'); // sobrou 20.000

    const july = budgetStatus(getBudget(budget.id, db), '2026-07', db);
    assert.equal(july.rolloverCents, 60_000, 'sobra de maio + junho');
    assert.equal(july.limitCents, 160_000, 'limite do mês + acúmulo');
  });

  test('rollover também herda o estouro', () => {
    const budget = createBudget(
      { categoryId: food, amountCents: 100_000, startMonth: '2026-06', rollover: true },
      { db },
    ).data;

    spend(150_000, '2026-06-10'); // estourou 50.000

    const july = budgetStatus(getBudget(budget.id, db), '2026-07', db);
    assert.equal(july.rolloverCents, -50_000);
    assert.equal(july.limitCents, 50_000, 'o mês seguinte paga a conta do anterior');
  });

  test('sem rollover, cada mês começa limpo', () => {
    const budget = createBudget(
      { categoryId: food, amountCents: 100_000, startMonth: '2026-06', rollover: false },
      { db },
    ).data;
    spend(150_000, '2026-06-10');

    const july = budgetStatus(getBudget(budget.id, db), '2026-07', db);
    assert.equal(july.rolloverCents, 0);
    assert.equal(july.limitCents, 100_000);
  });

  test('recusa orçamento em categoria de receita', () => {
    assert.throws(
      () => createBudget({ categoryId: salaryCategory, amountCents: 100_000 }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('recusa dois orçamentos sobrepostos na mesma categoria', () => {
    createBudget({ categoryId: food, amountCents: 100_000, startMonth: '2026-07' }, { db });
    assert.throws(
      () => createBudget({ categoryId: food, amountCents: 200_000, startMonth: '2026-09' }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'CONFLICT',
    );
  });

  test('sugere limites a partir da média gasta', () => {
    spend(50_000, '2026-04-10');
    spend(70_000, '2026-05-10');
    spend(60_000, '2026-06-10');

    const suggestions = suggestBudgets({ months: 3, db });
    const marketSuggestion = suggestions.find((s) => s.categoryId === market);

    assert.ok(marketSuggestion, 'deveria sugerir para Mercado');
    assert.equal(marketSuggestion.averageCents, 60_000);
    assert.equal(marketSuggestion.maxCents, 70_000);
    assert.equal(marketSuggestion.months, 3);
  });
});

describe('metas', () => {
  test('caixinha virtual acompanha aportes sem mover dinheiro', () => {
    const goal = createGoal(
      { name: 'Viagem', targetCents: 500_000, targetDate: '2027-01-15' },
      { db },
    ).data;

    contribute(goal.id, { amountCents: 100_000, date: '2026-07-10' }, { db });
    contribute(goal.id, { amountCents: 50_000, date: '2026-07-20' }, { db });

    const progress = getGoal(goal.id, db);
    assert.equal(progress.savedCents, 150_000);
    assert.equal(progress.remainingCents, 350_000);
    assert.equal(progress.progressPercent, 30);
    assert.equal(progress.contributionCount, 2);

    // Nenhuma transação foi criada: é reserva mental.
    assert.equal(accountBalance(checking, { db }).availableCents, 2_000_000);
  });

  test('meta com conta move dinheiro de verdade', () => {
    const goal = createGoal(
      { name: 'Reserva de emergência', targetCents: 1_000_000, accountId: savings },
      { db },
    ).data;

    const result = contribute(
      goal.id,
      { amountCents: 300_000, date: '2026-07-10', fromAccountId: checking },
      { db },
    ).data;

    assert.ok(result.transferId, 'deveria gerar transferência');
    assert.equal(accountBalance(checking, { db }).availableCents, 1_700_000);
    assert.equal(accountBalance(savings, { db }).availableCents, 300_000);
    assert.equal(result.goal.savedCents, 300_000);
  });

  test('calcula quanto guardar por mês para chegar na data', () => {
    const goal = createGoal(
      { name: 'Notebook', targetCents: 600_000, targetDate: '2026-12-26' },
      { db },
    ).data;

    const progress = getGoal(goal.id, db);
    // 5 meses até a data-alvo.
    assert.equal(progress.daysRemaining, 153);
    assert.ok(progress.requiredMonthlyCents !== null && progress.requiredMonthlyCents > 0);
    assert.ok(progress.requiredMonthlyCents! <= 120_000);
  });

  test('conclui sozinha ao atingir o alvo', () => {
    const goal = createGoal({ name: 'Fone', targetCents: 100_000 }, { db }).data;
    assert.equal(goal.status, 'active');

    const result = contribute(goal.id, { amountCents: 100_000 }, { db }).data;
    assert.equal(result.goal.status, 'done');
    assert.equal(result.goal.isComplete, true);
  });

  test('resgate volta a meta para ativa', () => {
    const goal = createGoal({ name: 'Fone', targetCents: 100_000 }, { db }).data;
    contribute(goal.id, { amountCents: 100_000 }, { db });
    const result = contribute(goal.id, { amountCents: -30_000 }, { db }).data;

    assert.equal(result.goal.status, 'active');
    assert.equal(result.goal.savedCents, 70_000);
  });

  test('recusa resgatar mais do que o guardado', () => {
    const goal = createGoal({ name: 'Fone', targetCents: 100_000 }, { db }).data;
    contribute(goal.id, { amountCents: 50_000 }, { db });

    assert.throws(
      () => contribute(goal.id, { amountCents: -80_000 }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('recusa data-alvo no passado', () => {
    assert.throws(
      () => createGoal({ name: 'Atrasada', targetCents: 100_000, targetDate: '2026-01-01' }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('recusa fromAccountId em meta virtual', () => {
    const goal = createGoal({ name: 'Virtual', targetCents: 100_000 }, { db }).data;
    assert.throws(
      () => contribute(goal.id, { amountCents: 10_000, fromAccountId: checking }, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('excluir a meta preserva as transferências', () => {
    const goal = createGoal({ name: 'Reserva', targetCents: 500_000, accountId: savings }, { db }).data;
    contribute(goal.id, { amountCents: 200_000, fromAccountId: checking }, { db });

    const balanceBefore = accountBalance(savings, { db }).availableCents;
    deleteGoal(goal.id, { db });

    // O dinheiro mudou de conta de verdade; apagar quebraria o saldo.
    assert.equal(accountBalance(savings, { db }).availableCents, balanceBefore);
    assert.deepEqual(checkIntegrity(db), []);
  });

  test('detecta meta atrasada em relação ao ritmo', () => {
    const goal = createGoal(
      { name: 'Carro', targetCents: 5_000_000, targetDate: '2026-09-30' },
      { db },
    ).data;

    // Ritmo muito baixo para o prazo.
    contribute(goal.id, { amountCents: 10_000, date: '2026-07-01' }, { db });
    contribute(goal.id, { amountCents: 10_000, date: '2026-07-20' }, { db });

    const behind = goalsBehindSchedule(db);
    assert.ok(behind.some((g) => g.id === goal.id), 'a meta deveria aparecer como atrasada');
  });

  test('undo do aporte reverte a transferência', () => {
    const goal = createGoal({ name: 'Reserva', targetCents: 500_000, accountId: savings }, { db }).data;
    const before = snapshot(handle, 'transactions');

    const { changeSetId } = contribute(goal.id, { amountCents: 200_000, fromAccountId: checking }, { db });
    undoChangeSet(changeSetId, { db });

    assert.deepEqual(snapshot(handle, 'transactions'), before);
    assert.equal(getGoal(goal.id, db).savedCents, 0);
  });
});

describe('dívidas', () => {
  const financing = {
    name: 'Financiamento do carro',
    principalCents: 6_000_000,
    annualRateBps: 1800,
    termMonths: 24,
    firstDueDate: '2026-08-10',
  };

  test('gera o cronograma completo na criação', () => {
    const debt = createDebt({ ...financing, accountId: checking, categoryId: food }, { db }).data;

    assert.equal(debt.remainingCount, 24);
    assert.equal(debt.paidCount, 0);
    assert.equal(debt.outstandingCents, 6_000_000, 'saldo devedor inicial é o principal');
    assert.ok(debt.totalInterestCents > 0);
    assert.equal(debt.nextPayment?.installmentNo, 1);
    assert.equal(debt.nextPayment?.dueDate, '2026-08-10');
  });

  test('soma das amortizações do cronograma é o principal', () => {
    const debt = createDebt({ ...financing, system: 'sac' }, { db }).data;
    const schedule = getDebt(debt.id, db);
    assert.equal(schedule.outstandingCents, financing.principalCents);
  });

  test('pagar parcela cria a despesa e reduz o saldo devedor', () => {
    const debt = createDebt({ ...financing, accountId: checking, categoryId: food }, { db }).data;
    const firstAmount = debt.nextPayment!.amountCents;

    const result = payInstallment(debt.id, 1, { date: '2026-08-10' }, { db }).data;

    assert.equal(result.debt.paidCount, 1);
    assert.ok(result.debt.outstandingCents < 6_000_000);
    assert.ok(result.transactionId, 'deveria lançar a despesa na conta');
    assert.equal(accountBalance(checking, { db }).availableCents, 2_000_000 - firstAmount);
  });

  test('recusa pagar a mesma parcela duas vezes', () => {
    const debt = createDebt({ ...financing, accountId: checking }, { db }).data;
    payInstallment(debt.id, 1, {}, { db });

    assert.throws(
      () => payInstallment(debt.id, 1, {}, { db }),
      (e: unknown) => e instanceof AppError && e.code === 'RULE_VIOLATION',
    );
  });

  test('quitar a última parcela encerra a dívida', () => {
    const debt = createDebt(
      { ...financing, termMonths: 2, accountId: checking },
      { db },
    ).data;

    payInstallment(debt.id, 1, {}, { db });
    assert.equal(getDebt(debt.id, db).isSettled, false);

    const result = payInstallment(debt.id, 2, {}, { db }).data;
    assert.equal(result.debt.isSettled, true);
    assert.equal(result.debt.outstandingCents, 0);
  });

  test('detecta parcelas vencidas', () => {
    const debt = createDebt(
      { ...financing, firstDueDate: '2026-05-10', accountId: checking },
      { db },
    ).data;

    // Hoje é 26/07: maio, junho e julho já venceram.
    assert.equal(getDebt(debt.id, db).overdueCount, 3);
  });

  test('simula quitação antecipada', () => {
    const debt = createDebt({ ...financing, accountId: checking }, { db }).data;
    for (let n = 1; n <= 6; n += 1) payInstallment(debt.id, n, {}, { db });

    const simulation = simulatePayoff(debt.id, db);

    assert.equal(simulation.fromInstallmentNo, 7);
    assert.equal(simulation.installmentsRemoved, 18);
    assert.ok(simulation.payoffCents < simulation.originalRemainingCents);
    assert.ok(simulation.interestSavedCents > 0);
  });

  test('simula amortização extra encurtando o prazo', () => {
    const debt = createDebt({ ...financing, accountId: checking }, { db }).data;
    const simulation = simulateExtra(debt.id, 1_500_000, db);

    assert.ok(simulation.monthsSaved > 0, 'o prazo deveria encurtar');
    assert.ok(simulation.interestSavedCents > 0);
  });

  test('lista parcelas a vencer', () => {
    createDebt({ ...financing, name: 'Carro', accountId: checking }, { db });
    createDebt(
      { ...financing, name: 'Empréstimo', firstDueDate: '2026-08-05', accountId: checking },
      { db },
    );

    const upcoming = upcomingDebtPayments({ withinDays: 30, db });
    assert.equal(upcoming.length, 2);
    assert.equal(upcoming[0]!.debtName, 'Empréstimo', 'ordenado por vencimento');
    assert.equal(upcoming[0]!.daysUntil, 10);
  });

  test('undo da criação remove o cronograma inteiro', () => {
    const { changeSetId } = createDebt({ ...financing, accountId: checking }, { db });
    undoChangeSet(changeSetId, { db });

    assert.deepEqual(snapshot(handle, 'debts'), []);
    assert.deepEqual(snapshot(handle, 'debt_payments'), []);
  });

  test('SAC começa com parcela maior e paga menos juros que Price', () => {
    const sac = createDebt({ ...financing, name: 'SAC', system: 'sac' }, { db }).data;
    const price = createDebt({ ...financing, name: 'Price', system: 'price' }, { db }).data;

    assert.ok(sac.nextPayment!.amountCents > price.nextPayment!.amountCents);
    assert.ok(sac.totalInterestCents < price.totalInterestCents);
  });
});

describe('integridade da fase 4', () => {
  test('cenário completo não acusa problema', () => {
    createBudget({ categoryId: food, amountCents: 100_000, startMonth: '2026-07', rollover: true }, { db });
    spend(45_000, '2026-07-10');

    const goal = createGoal({ name: 'Reserva', targetCents: 500_000, accountId: savings }, { db }).data;
    contribute(goal.id, { amountCents: 200_000, fromAccountId: checking }, { db });

    const debt = createDebt(
      { name: 'Empréstimo', principalCents: 1_000_000, annualRateBps: 2400, termMonths: 12, firstDueDate: '2026-08-05', accountId: checking, categoryId: food },
      { db },
    ).data;
    payInstallment(debt.id, 1, { date: '2026-08-05' }, { db });

    assert.deepEqual(checkIntegrity(db), []);
  });

  test('a soma das parcelas pagas de uma dívida bate com as despesas lançadas', () => {
    const debt = createDebt(
      { name: 'Empréstimo', principalCents: 1_000_000, annualRateBps: 2400, termMonths: 6, firstDueDate: '2026-08-05', accountId: checking, categoryId: food },
      { db },
    ).data;

    const paid: number[] = [];
    for (let n = 1; n <= 3; n += 1) {
      const result = payInstallment(debt.id, n, {}, { db }).data;
      paid.push(result.payment.amountCents);
    }

    const expenses = 2_000_000 - accountBalance(checking, { db }).availableCents;
    assert.equal(expenses, sumCents(paid));
  });
});
