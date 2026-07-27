/**
 * Orçamentos mensais por categoria.
 *
 * O gasto **nunca** é armazenado — é sempre somado das transações no momento da
 * consulta. Guardar um "gasto do mês" como campo criaria duas fontes de verdade
 * que divergem no primeiro lançamento retroativo.
 *
 * O `rollover` acumula a sobra (ou o estouro) mês a mês desde o início da
 * vigência, que é o comportamento de envelope: economizou R$ 100 em julho? Agosto
 * tem R$ 100 a mais.
 */

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import { budgets, categories, transactionSplits, transactions, type Budget } from '../db/schema.js';
import { conflict, notFound, ruleViolation } from '../core/errors.js';
import {
  addMonthKey,
  currentMonth,
  diffMonthKeys,
  monthRange,
  monthsBetween,
  type MonthKey,
} from '../core/clock.js';
import { formatMoney } from '../core/money.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { categoryWithDescendants, getCategory } from './categories.js';
import { idSchema, monthKeySchema, positiveCentsSchema } from './schemas.js';

export const createBudgetSchema = z.object({
  categoryId: idSchema,
  amountCents: positiveCentsSchema,
  startMonth: monthKeySchema.optional(),
  endMonth: monthKeySchema.optional(),
  /** Acumula a sobra do mês para o mês seguinte. */
  rollover: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});

export type CreateBudgetInput = z.input<typeof createBudgetSchema>;

export const updateBudgetSchema = z.object({
  amountCents: positiveCentsSchema.optional(),
  endMonth: monthKeySchema.nullable().optional(),
  rollover: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export interface BudgetStatus {
  budgetId: string;
  categoryId: string;
  categoryName: string;
  month: MonthKey;
  /** Limite do mês, já com o acúmulo do rollover se houver. */
  limitCents: number;
  /** Limite nominal, sem rollover. */
  baseLimitCents: number;
  /** Sobra acumulada dos meses anteriores. Negativo = estouro herdado. */
  rolloverCents: number;
  spentCents: number;
  remainingCents: number;
  /** Percentual consumido. Acima de 100 indica estouro. */
  usedPercent: number;
  /** Projeção do gasto até o fim do mês, no ritmo atual. */
  projectedSpentCents: number;
  /** `true` quando o ritmo atual leva a estourar antes do fim do mês. */
  willExceed: boolean;
}

// ── Leitura ─────────────────────────────────────────────────────────────────

export function findBudget(id: string, db: Db = getDb()): Budget | undefined {
  return db.select().from(budgets).where(eq(budgets.id, id)).all()[0];
}

export function getBudget(id: string, db: Db = getDb()): Budget {
  const budget = findBudget(id, db);
  if (!budget) throw notFound('Orçamento', id);
  return budget;
}

/** Orçamentos vigentes num mês. */
export function budgetsForMonth(month: MonthKey, db: Db = getDb()): Budget[] {
  return db
    .select()
    .from(budgets)
    .where(and(lte(budgets.startMonth, month), sql`(${budgets.endMonth} is null or ${budgets.endMonth} >= ${month})`))
    .all();
}

/**
 * Gasto de uma categoria (e suas filhas) num mês.
 *
 * Conta rateios: uma compra dividida entre Mercado e Casa contribui para os dois
 * orçamentos com a sua parte, não com o total.
 */
export function categorySpending(
  categoryId: string,
  month: MonthKey,
  db: Db = getDb(),
): number {
  const ids = categoryWithDescendants(categoryId, db);
  const { start, end } = monthRange(month);

  // Transações sem rateio, com categoria direta.
  const [direct] = db
    .select({ total: sql<number>`coalesce(sum(${transactions.amountCents}), 0)` })
    .from(transactions)
    .where(
      and(
        inArray(transactions.categoryId, ids),
        eq(transactions.hasSplits, false),
        gte(transactions.date, start),
        lte(transactions.date, end),
        sql`${transactions.type} != 'transfer'`,
        sql`${transactions.status} in ('cleared', 'reconciled', 'pending')`,
      ),
    )
    .all();

  // Linhas de rateio, juntando pela transação para respeitar data e status.
  const [split] = db
    .select({ total: sql<number>`coalesce(sum(${transactionSplits.amountCents}), 0)` })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .where(
      and(
        inArray(transactionSplits.categoryId, ids),
        gte(transactions.date, start),
        lte(transactions.date, end),
        sql`${transactions.type} != 'transfer'`,
        sql`${transactions.status} in ('cleared', 'reconciled', 'pending')`,
      ),
    )
    .all();

  // Despesas são negativas; o gasto é o módulo.
  return Math.abs((direct?.total ?? 0) + (split?.total ?? 0));
}

/**
 * Sobra acumulada dos meses anteriores, para orçamentos com rollover.
 *
 * Percorre desde o início da vigência: cada mês contribui com `limite − gasto`.
 */
function accumulatedRollover(budget: Budget, month: MonthKey, db: Db): number {
  if (!budget.rollover) return 0;

  const monthsElapsed = diffMonthKeys(budget.startMonth, month);
  if (monthsElapsed <= 0) return 0;

  let accumulated = 0;
  for (const past of monthsBetween(budget.startMonth, addMonthKey(month, -1))) {
    accumulated += budget.amountCents - categorySpending(budget.categoryId, past, db);
  }
  return accumulated;
}

/** Situação de um orçamento num mês. */
export function budgetStatus(
  budget: Budget,
  month: MonthKey = currentMonth(),
  db: Db = getDb(),
): BudgetStatus {
  const category = getCategory(budget.categoryId, db);
  const spentCents = categorySpending(budget.categoryId, month, db);
  const rolloverCents = accumulatedRollover(budget, month, db);
  const limitCents = budget.amountCents + rolloverCents;

  // Projeção linear pelo ritmo do mês. Só faz sentido no mês corrente.
  const { start, end } = monthRange(month);
  const daysInMonth = Number(end.slice(-2));
  const isCurrentMonth = month === currentMonth();
  const dayOfMonth = isCurrentMonth ? Number(new Date().toISOString().slice(8, 10)) : daysInMonth;
  const elapsed = Math.max(1, Math.min(dayOfMonth, daysInMonth));
  const projectedSpentCents = isCurrentMonth
    ? Math.round((spentCents / elapsed) * daysInMonth)
    : spentCents;

  return {
    budgetId: budget.id,
    categoryId: budget.categoryId,
    categoryName: category.name,
    month,
    limitCents,
    baseLimitCents: budget.amountCents,
    rolloverCents,
    spentCents,
    remainingCents: limitCents - spentCents,
    usedPercent: limitCents > 0 ? Math.round((spentCents / limitCents) * 1000) / 10 : 0,
    projectedSpentCents,
    willExceed: projectedSpentCents > limitCents,
    ...(start ? {} : {}),
  };
}

/** Situação de todos os orçamentos de um mês, do mais estourado ao mais folgado. */
export function monthBudgetStatus(
  month: MonthKey = currentMonth(),
  db: Db = getDb(),
): BudgetStatus[] {
  return budgetsForMonth(month, db)
    .map((budget) => budgetStatus(budget, month, db))
    .sort((a, b) => b.usedPercent - a.usedPercent);
}

export interface BudgetSummary {
  month: MonthKey;
  totalLimitCents: number;
  totalSpentCents: number;
  totalRemainingCents: number
  /** Orçamentos já estourados. */
  exceeded: BudgetStatus[];
  /** Orçamentos no caminho de estourar antes do fim do mês. */
  atRisk: BudgetStatus[];
  items: BudgetStatus[];
}

export function budgetSummary(month: MonthKey = currentMonth(), db: Db = getDb()): BudgetSummary {
  const items = monthBudgetStatus(month, db);

  return {
    month,
    totalLimitCents: items.reduce((sum, i) => sum + i.limitCents, 0),
    totalSpentCents: items.reduce((sum, i) => sum + i.spentCents, 0),
    totalRemainingCents: items.reduce((sum, i) => sum + i.remainingCents, 0),
    exceeded: items.filter((i) => i.remainingCents < 0),
    atRisk: items.filter((i) => i.remainingCents >= 0 && i.willExceed),
    items,
  };
}

// ── Escrita ─────────────────────────────────────────────────────────────────

export function createBudget(
  input: CreateBudgetInput,
  options: WriteOptions = {},
): WriteResult<Budget> {
  const parsed = createBudgetSchema.parse(input);
  const db = readDb(options);

  const category = getCategory(parsed.categoryId, db);
  if (category.kind !== 'expense') {
    throw ruleViolation(
      `"${category.name}" é categoria de receita. Orçamento só se aplica a despesas.`,
    );
  }

  const startMonth = parsed.startMonth ?? currentMonth();
  if (parsed.endMonth && diffMonthKeys(startMonth, parsed.endMonth) < 0) {
    throw ruleViolation('O mês final do orçamento é anterior ao inicial.');
  }

  // Dois orçamentos vigentes para a mesma categoria tornariam ambíguo qual limite vale.
  const overlapping = db
    .select()
    .from(budgets)
    .where(eq(budgets.categoryId, parsed.categoryId))
    .all()
    .filter((existing) => {
      const existingEnd = existing.endMonth ?? '9999-12';
      const newEnd = parsed.endMonth ?? '9999-12';
      return existing.startMonth <= newEnd && startMonth <= existingEnd;
    });

  if (overlapping.length > 0) {
    throw conflict(
      `Já existe orçamento vigente para "${category.name}" neste período. Altere o existente ou encerre-o antes.`,
      { categoryId: parsed.categoryId, conflictingBudgetId: overlapping[0]!.id },
    );
  }

  return withMutate(
    options,
    () => `Definiu orçamento de ${formatMoney(parsed.amountCents)} para "${category.name}"`,
    (ctx) =>
      ctx.insert<Budget>('budgets', {
        categoryId: parsed.categoryId,
        amountCents: parsed.amountCents,
        startMonth,
        endMonth: parsed.endMonth ?? null,
        rollover: parsed.rollover,
        notes: parsed.notes ?? null,
      }),
  );
}

export function updateBudget(
  id: string,
  input: z.input<typeof updateBudgetSchema>,
  options: WriteOptions = {},
): WriteResult<Budget> {
  const parsed = updateBudgetSchema.parse(input);
  const db = readDb(options);
  const current = getBudget(id, db);
  const category = getCategory(current.categoryId, db);

  if (parsed.endMonth && diffMonthKeys(current.startMonth, parsed.endMonth) < 0) {
    throw ruleViolation('O mês final do orçamento é anterior ao inicial.');
  }

  return withMutate(
    options,
    () => `Alterou orçamento de "${category.name}"`,
    (ctx) => ctx.update<Budget>('budgets', id, parsed),
  );
}

export function deleteBudget(id: string, options: WriteOptions = {}): WriteResult<{ id: string }> {
  const db = readDb(options);
  const current = getBudget(id, db);
  const category = getCategory(current.categoryId, db);

  return withMutate(
    options,
    `Excluiu o orçamento de "${category.name}"`,
    (ctx) => {
      ctx.remove('budgets', id);
      return { id };
    },
  );
}

/**
 * Sugere limites a partir da média gasta nos últimos meses.
 *
 * É o que resolve o problema de "não sei quanto colocar": em vez de inventar um
 * número, parte do que você realmente gasta.
 */
export function suggestBudgets(
  options: { months?: number; db?: Db } = {},
): Array<{ categoryId: string; categoryName: string; averageCents: number; maxCents: number; months: number }> {
  const db = options.db ?? getDb();
  const lookback = options.months ?? 3;
  const months = monthsBetween(addMonthKey(currentMonth(), -lookback), addMonthKey(currentMonth(), -1));

  const expenseCategories = db
    .select()
    .from(categories)
    .where(and(eq(categories.kind, 'expense'), eq(categories.isArchived, false)))
    .all();

  const existing = new Set(db.select({ id: budgets.categoryId }).from(budgets).all().map((b) => b.id));

  const suggestions: Array<{ categoryId: string; categoryName: string; averageCents: number; maxCents: number; months: number }> = [];

  for (const category of expenseCategories) {
    if (existing.has(category.id)) continue;

    const spends = months.map((month) => categorySpending(category.id, month, db));
    const active = spends.filter((value) => value > 0);
    if (active.length === 0) continue;

    suggestions.push({
      categoryId: category.id,
      categoryName: category.name,
      averageCents: Math.round(active.reduce((a, b) => a + b, 0) / active.length),
      maxCents: Math.max(...active),
      months: active.length,
    });
  }

  return suggestions.sort((a, b) => b.averageCents - a.averageCents);
}
