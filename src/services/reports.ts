/**
 * Relatórios analíticos.
 *
 * Toda função aqui devolve **números prontos**, com os IDs que os sustentam. É a
 * camada que a IA consome: ela nunca faz conta, apenas chama estas funções e
 * narra o resultado. Ver a regra nº 3 em `docs/DECISIONS.md`.
 *
 * Transferências ficam fora de tudo o que é receita ou despesa, por construção.
 */

import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { categories, payees, transactionSplits, transactions } from '../db/schema.js';
import {
  addMonthKey,
  currentMonth,
  monthRange,
  monthsBetween,
  type IsoDate,
  type MonthKey,
} from '../core/clock.js';
import { cashFlow } from './balances.js';

/** Status que representam dinheiro que efetivamente se moveu ou vai se mover já. */
const REALIZED = sql`status in ('cleared', 'reconciled', 'pending')`;
const NOT_TRANSFER = sql`type != 'transfer'`;

export interface CategoryBreakdownItem {
  categoryId: string | null;
  categoryName: string;
  parentId: string | null;
  parentName: string | null;
  amountCents: number;
  transactionCount: number;
  percentOfTotal: number;
}

/**
 * Gasto por categoria num período.
 *
 * Considera rateios: uma compra dividida contribui para cada categoria com a sua
 * parte. Sem isso, uma compra de mercado rateada apareceria inteira numa só
 * categoria e o relatório mentiria.
 */
export function spendByCategory(
  from: IsoDate,
  to: IsoDate,
  options: { kind?: 'expense' | 'income'; accountIds?: string[]; db?: Db } = {},
): { items: CategoryBreakdownItem[]; totalCents: number } {
  const db = options.db ?? getDb();
  const kind = options.kind ?? 'expense';
  const sign = kind === 'expense' ? sql`amount_cents < 0` : sql`amount_cents > 0`;

  const accountFilter = options.accountIds?.length
    ? sql` and t.account_id in (${sql.join(options.accountIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;

  // Duas fontes somadas: transações sem rateio (categoria direta) e linhas de
  // rateio. A união em SQL evita trazer todas as linhas para a memória.
  const rows = db
    .all<{ category_id: string | null; total: number; n: number }>(sql`
      select category_id, sum(total) as total, sum(n) as n from (
        select t.category_id as category_id, sum(t.amount_cents) as total, count(*) as n
          from transactions t
         where t.has_splits = 0
           and t.date between ${from} and ${to}
           and t.type != 'transfer'
           and t.status in ('cleared', 'reconciled', 'pending')
           and ${sign}
           ${accountFilter}
         group by t.category_id
        union all
        select s.category_id as category_id, sum(s.amount_cents) as total, count(*) as n
          from transaction_splits s
          join transactions t on t.id = s.transaction_id
         where t.date between ${from} and ${to}
           and t.type != 'transfer'
           and t.status in ('cleared', 'reconciled', 'pending')
           and s.${sql.raw(kind === 'expense' ? 'amount_cents < 0' : 'amount_cents > 0')}
           ${accountFilter}
         group by s.category_id
      ) group by category_id
    `);

  const categoryRows = db.select().from(categories).all();
  const byId = new Map(categoryRows.map((c) => [c.id, c]));

  const totalCents = rows.reduce((sum, row) => sum + Math.abs(row.total), 0);

  const items: CategoryBreakdownItem[] = rows
    .map((row) => {
      const category = row.category_id ? byId.get(row.category_id) : undefined;
      const parent = category?.parentId ? byId.get(category.parentId) : undefined;
      const amountCents = Math.abs(row.total);

      return {
        categoryId: row.category_id,
        categoryName: category?.name ?? 'Sem categoria',
        parentId: category?.parentId ?? null,
        parentName: parent?.name ?? null,
        amountCents,
        transactionCount: row.n,
        percentOfTotal: totalCents > 0 ? Math.round((amountCents / totalCents) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.amountCents - a.amountCents);

  return { items, totalCents };
}

/** Mesmo relatório, agrupado na categoria mãe (rollup). */
export function spendByParentCategory(
  from: IsoDate,
  to: IsoDate,
  options: { kind?: 'expense' | 'income'; db?: Db } = {},
): { items: CategoryBreakdownItem[]; totalCents: number } {
  const detailed = spendByCategory(from, to, options);
  const grouped = new Map<string, CategoryBreakdownItem>();

  for (const item of detailed.items) {
    const key = item.parentId ?? item.categoryId ?? 'none';
    const name = item.parentName ?? item.categoryName;

    const bucket = grouped.get(key) ?? {
      categoryId: item.parentId ?? item.categoryId,
      categoryName: name,
      parentId: null,
      parentName: null,
      amountCents: 0,
      transactionCount: 0,
      percentOfTotal: 0,
    };

    bucket.amountCents += item.amountCents;
    bucket.transactionCount += item.transactionCount;
    grouped.set(key, bucket);
  }

  const items = [...grouped.values()]
    .map((item) => ({
      ...item,
      percentOfTotal:
        detailed.totalCents > 0 ? Math.round((item.amountCents / detailed.totalCents) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);

  return { items, totalCents: detailed.totalCents };
}

export interface MonthlyFlow {
  month: MonthKey;
  incomeCents: number;
  expenseCents: number;
  netCents: number
  savingsRatePercent: number | null;
}

/** Fluxo de caixa mês a mês. A série que alimenta o gráfico principal. */
export function monthlyFlow(
  fromMonth: MonthKey,
  toMonth: MonthKey,
  options: { db?: Db } = {},
): MonthlyFlow[] {
  const db = options.db ?? getDb();

  return monthsBetween(fromMonth, toMonth).map((month) => {
    const { start, end } = monthRange(month);
    const flow = cashFlow(start, end, { db });
    return { month, ...flow };
  });
}

export interface PeriodComparison {
  current: { from: IsoDate; to: IsoDate; incomeCents: number; expenseCents: number; netCents: number };
  previous: { from: IsoDate; to: IsoDate; incomeCents: number; expenseCents: number; netCents: number };
  expenseChangeCents: number;
  expenseChangePercent: number | null;
  incomeChangeCents: number;
  /** Categorias que mais variaram, em valor absoluto. */
  byCategory: Array<{
    categoryName: string;
    currentCents: number;
    previousCents: number;
    changeCents: number;
    changePercent: number | null;
  }>;
}

/** Compara dois meses, destacando onde a diferença aconteceu. */
export function compareMonths(
  month: MonthKey,
  against: MonthKey = addMonthKey(month, -1),
  options: { db?: Db } = {},
): PeriodComparison {
  const db = options.db ?? getDb();
  const currentRange = monthRange(month);
  const previousRange = monthRange(against);

  const currentFlow = cashFlow(currentRange.start, currentRange.end, { db });
  const previousFlow = cashFlow(previousRange.start, previousRange.end, { db });

  const currentByCategory = spendByCategory(currentRange.start, currentRange.end, { db });
  const previousByCategory = spendByCategory(previousRange.start, previousRange.end, { db });

  const previousMap = new Map(previousByCategory.items.map((i) => [i.categoryName, i.amountCents]));
  const names = new Set([
    ...currentByCategory.items.map((i) => i.categoryName),
    ...previousByCategory.items.map((i) => i.categoryName),
  ]);

  const byCategory = [...names]
    .map((categoryName) => {
      const currentCents =
        currentByCategory.items.find((i) => i.categoryName === categoryName)?.amountCents ?? 0;
      const previousCents = previousMap.get(categoryName) ?? 0;
      const changeCents = currentCents - previousCents;

      return {
        categoryName,
        currentCents,
        previousCents,
        changeCents,
        changePercent:
          previousCents > 0 ? Math.round((changeCents / previousCents) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => Math.abs(b.changeCents) - Math.abs(a.changeCents));

  return {
    current: { from: currentRange.start, to: currentRange.end, ...currentFlow },
    previous: { from: previousRange.start, to: previousRange.end, ...previousFlow },
    expenseChangeCents: currentFlow.expenseCents - previousFlow.expenseCents,
    expenseChangePercent:
      previousFlow.expenseCents > 0
        ? Math.round(
            ((currentFlow.expenseCents - previousFlow.expenseCents) / previousFlow.expenseCents) * 1000,
          ) / 10
        : null,
    incomeChangeCents: currentFlow.incomeCents - previousFlow.incomeCents,
    byCategory,
  };
}

export interface TopPayee {
  payeeId: string | null;
  payeeName: string;
  amountCents: number;
  transactionCount: number;
  averageCents: number;
}

/** Onde o dinheiro foi, por favorecido. */
export function topPayees(
  from: IsoDate,
  to: IsoDate,
  options: { limit?: number; db?: Db } = {},
): TopPayee[] {
  const db = options.db ?? getDb();

  const rows = db
    .select({
      payeeId: transactions.payeeId,
      payeeName: payees.name,
      total: sql<number>`sum(${transactions.amountCents})`,
      n: sql<number>`count(*)`,
    })
    .from(transactions)
    .leftJoin(payees, eq(payees.id, transactions.payeeId))
    .where(
      and(
        gte(transactions.date, from),
        lte(transactions.date, to),
        NOT_TRANSFER,
        REALIZED,
        sql`${transactions.amountCents} < 0`,
      ),
    )
    .groupBy(transactions.payeeId)
    .orderBy(sql`sum(${transactions.amountCents}) asc`)
    .limit(options.limit ?? 10)
    .all();

  return rows.map((row) => ({
    payeeId: row.payeeId,
    payeeName: row.payeeName ?? 'Sem favorecido',
    amountCents: Math.abs(row.total),
    transactionCount: row.n,
    averageCents: Math.round(Math.abs(row.total) / Math.max(1, row.n)),
  }));
}

/** Maiores lançamentos de um período — onde o dinheiro realmente foi. */
export function largestTransactions(
  from: IsoDate,
  to: IsoDate,
  options: { limit?: number; db?: Db } = {},
) {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(transactions)
    .where(
      and(
        gte(transactions.date, from),
        lte(transactions.date, to),
        NOT_TRANSFER,
        REALIZED,
        sql`${transactions.amountCents} < 0`,
      ),
    )
    .orderBy(transactions.amountCents)
    .limit(options.limit ?? 10)
    .all();
}

export interface CategoryTrend {
  categoryId: string;
  categoryName: string;
  /** Valor gasto em cada mês da série. */
  series: Array<{ month: MonthKey; amountCents: number }>;
  averageCents: number;
  /** Mediana — mais robusta que a média para detectar gasto fora do padrão. */
  medianCents: number;
  currentCents: number;
  /** Quanto o mês atual desvia da mediana, em percentual. */
  deviationPercent: number | null;
}

/**
 * Histórico por categoria, com mediana.
 *
 * A mediana é o que permite detectar gasto anormal: a média é puxada por um único
 * mês atípico e passaria a considerar o próprio pico como normal.
 */
export function categoryTrends(
  options: { months?: number; referenceMonth?: MonthKey; db?: Db } = {},
): CategoryTrend[] {
  const db = options.db ?? getDb();
  const reference = options.referenceMonth ?? currentMonth();
  const lookback = options.months ?? 4;
  const months = monthsBetween(addMonthKey(reference, -(lookback - 1)), reference);

  const expenseCategories = db
    .select()
    .from(categories)
    .where(eq(categories.kind, 'expense'))
    .all();

  const trends: CategoryTrend[] = [];

  for (const category of expenseCategories) {
    const series = months.map((month) => {
      const { start, end } = monthRange(month);
      const [row] = db
        .select({ total: sql<number>`coalesce(sum(${transactions.amountCents}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.categoryId, category.id),
            eq(transactions.hasSplits, false),
            gte(transactions.date, start),
            lte(transactions.date, end),
            NOT_TRANSFER,
            REALIZED,
          ),
        )
        .all();

      const [splitRow] = db
        .select({ total: sql<number>`coalesce(sum(${transactionSplits.amountCents}), 0)` })
        .from(transactionSplits)
        .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
        .where(
          and(
            eq(transactionSplits.categoryId, category.id),
            gte(transactions.date, start),
            lte(transactions.date, end),
            NOT_TRANSFER,
            REALIZED,
          ),
        )
        .all();

      return { month, amountCents: Math.abs((row?.total ?? 0) + (splitRow?.total ?? 0)) };
    });

    const values = series.map((s) => s.amountCents);
    if (values.every((v) => v === 0)) continue;

    const past = values.slice(0, -1).filter((v) => v > 0);
    const currentCents = values.at(-1) ?? 0;
    const medianCents = median(past);

    trends.push({
      categoryId: category.id,
      categoryName: category.name,
      series,
      averageCents: past.length > 0 ? Math.round(past.reduce((a, b) => a + b, 0) / past.length) : 0,
      medianCents,
      currentCents,
      deviationPercent:
        medianCents > 0 ? Math.round(((currentCents - medianCents) / medianCents) * 1000) / 10 : null,
    });
  }

  return trends.sort((a, b) => b.currentCents - a.currentCents);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}

export interface MonthOverview {
  month: MonthKey;
  from: IsoDate;
  to: IsoDate;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  savingsRatePercent: number | null;
  transactionCount: number;
  topCategories: CategoryBreakdownItem[];
  topPayees: TopPayee[];
  largestExpenses: Array<{ id: string; description: string; amountCents: number; date: IsoDate }>;
  comparedToPreviousMonth: {
    expenseChangeCents: number;
    expenseChangePercent: number | null;
  };
}

/**
 * Panorama de um mês num único objeto.
 *
 * Existe para a IA conseguir o essencial numa chamada só, em vez de fazer seis —
 * o que economiza tokens e mantém a resposta rápida.
 */
export function monthOverview(
  month: MonthKey = currentMonth(),
  options: { db?: Db } = {},
): MonthOverview {
  const db = options.db ?? getDb();
  const { start, end } = monthRange(month);

  const flow = cashFlow(start, end, { db });
  const byCategory = spendByParentCategory(start, end, { db });
  const comparison = compareMonths(month, addMonthKey(month, -1), { db });

  const [count] = db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(and(gte(transactions.date, start), lte(transactions.date, end), NOT_TRANSFER, REALIZED))
    .all();

  return {
    month,
    from: start,
    to: end,
    ...flow,
    transactionCount: count?.n ?? 0,
    topCategories: byCategory.items.slice(0, 8),
    topPayees: topPayees(start, end, { limit: 5, db }),
    largestExpenses: largestTransactions(start, end, { limit: 5, db }).map((t) => ({
      id: t.id,
      description: t.description,
      amountCents: Math.abs(t.amountCents),
      date: t.date,
    })),
    comparedToPreviousMonth: {
      expenseChangeCents: comparison.expenseChangeCents,
      expenseChangePercent: comparison.expenseChangePercent,
    },
  };
}

/** Detecta cobranças possivelmente duplicadas: mesmo valor, mesma descrição, dias próximos. */
export function findDuplicates(
  options: { withinDays?: number; db?: Db } = {},
): Array<{ description: string; amountCents: number; dates: IsoDate[]; ids: string[] }> {
  const db = options.db ?? getDb();
  const window = options.withinDays ?? 3;

  const rows = db
    .select()
    .from(transactions)
    .where(and(NOT_TRANSFER, REALIZED))
    .orderBy(desc(transactions.date))
    .limit(2000)
    .all();

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.amountCents}|${row.description.toLowerCase().trim()}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const duplicates: Array<{ description: string; amountCents: number; dates: IsoDate[]; ids: string[] }> = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      const gap =
        (Date.parse(`${current.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`)) /
        86_400_000;

      // Parcelamento repete valor de propósito — não é duplicata.
      if (gap <= window && !current.installmentPlanId && !current.recurrenceId) {
        duplicates.push({
          description: current.description,
          amountCents: Math.abs(current.amountCents),
          dates: [previous.date, current.date],
          ids: [previous.id, current.id],
        });
      }
    }
  }

  return duplicates;
}

export { inArray };
