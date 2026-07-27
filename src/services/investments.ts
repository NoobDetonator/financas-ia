/**
 * Carteira de investimentos.
 *
 * Duas decisões de precisão que evitam erro acumulado:
 *
 * 1. **Quantidade em `quantityE8`** — inteiro na escala 1e-8. Cripto tem 8 casas
 *    decimais; guardar em float faria a quantidade divergir depois de alguns
 *    aportes.
 * 2. **Preço médio derivado, não armazenado** — guarda-se `totalCostCents` e
 *    divide-se pela quantidade quando preciso. Armazenar o preço médio obrigaria
 *    a recalculá-lo a cada aporte, e o arredondamento se acumularia.
 *
 * Cotação é manual (`position_snapshots`): integrar cotação automática viraria um
 * projeto dentro do projeto, e o encaixe já está pronto para quando fizer sentido.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import {
  holdings,
  investmentTransactions,
  positionSnapshots,
  type Holding,
  type InvestmentTransaction,
  type PositionSnapshot,
} from '../db/schema.js';
import { notFound, ruleViolation } from '../core/errors.js';
import { formatMoney } from '../core/money.js';
import { today, type IsoDate } from '../core/clock.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { getAccount } from './accounts.js';
import { insertTransactionIn } from './transactions.js';
import { idSchema, isoDateSchema, positiveCentsSchema } from './schemas.js';

/** Fator de escala da quantidade: 1 unidade = 100.000.000. */
export const QUANTITY_SCALE = 100_000_000;

/** Converte quantidade humana (`1.5`, `0.00042`) para inteiro escalado. */
export function toQuantityE8(quantity: number): number {
  if (!Number.isFinite(quantity)) throw ruleViolation(`Quantidade inválida: ${quantity}`);
  return Math.round(quantity * QUANTITY_SCALE);
}

export function fromQuantityE8(quantityE8: number): number {
  return quantityE8 / QUANTITY_SCALE;
}

const quantitySchema = z.number().positive().describe('Quantidade em unidades (aceita fração)');

export const createHoldingSchema = z.object({
  name: z.string().min(1).max(120),
  ticker: z.string().max(20).optional(),
  assetClass: z
    .enum(['stock', 'fii', 'etf', 'fixed_income', 'crypto', 'fund', 'pension', 'other'])
    .default('other'),
  accountId: idSchema.optional(),
  currency: z.string().length(3).default('BRL'),
  notes: z.string().max(2000).optional(),
});

export const tradeSchema = z.object({
  op: z.enum(['buy', 'sell', 'dividend', 'interest', 'fee', 'adjust']),
  date: isoDateSchema.optional(),
  /** Obrigatório em compra e venda. */
  quantity: quantitySchema.optional(),
  /** Valor financeiro movimentado, sempre positivo. O sinal vem da operação. */
  amountCents: positiveCentsSchema,
  feeCents: z.number().int().min(0).default(0),
  /** Conta de caixa que financia a compra ou recebe o resgate. */
  cashAccountId: idSchema.optional(),
  note: z.string().max(500).optional(),
});

export interface HoldingPosition extends Holding {
  quantity: number;
  /** Preço médio de compra por unidade, em centavos. `null` sem posição. */
  averageCostCents: number | null;
  /** Valor de mercado do último snapshot. `null` se nunca houve. */
  marketValueCents: number | null;
  lastSnapshotDate: IsoDate | null;
  /** Valorização em relação ao custo. `null` sem snapshot. */
  gainCents: number | null;
  gainPercent: number | null;
  /** Proventos recebidos (dividendos e juros). */
  incomeCents: number;
}

// ── Leitura ─────────────────────────────────────────────────────────────────

export function findHolding(id: string, db: Db = getDb()): Holding | undefined {
  return db.select().from(holdings).where(eq(holdings.id, id)).all()[0];
}

export function holdingPosition(holding: Holding, db: Db = getDb()): HoldingPosition {
  const [snapshot] = db
    .select()
    .from(positionSnapshots)
    .where(eq(positionSnapshots.holdingId, holding.id))
    .orderBy(desc(positionSnapshots.date))
    .limit(1)
    .all();

  const [income] = db
    .select({
      total: sql<number>`coalesce(sum(case when ${investmentTransactions.op} in ('dividend', 'interest') then ${investmentTransactions.amountCents} else 0 end), 0)`,
    })
    .from(investmentTransactions)
    .where(eq(investmentTransactions.holdingId, holding.id))
    .all();

  const marketValueCents = snapshot?.marketValueCents ?? null;
  const gainCents = marketValueCents !== null ? marketValueCents - holding.totalCostCents : null;

  return {
    ...holding,
    quantity: fromQuantityE8(holding.quantityE8),
    averageCostCents:
      holding.quantityE8 > 0
        ? Math.round((holding.totalCostCents / holding.quantityE8) * QUANTITY_SCALE)
        : null,
    marketValueCents,
    lastSnapshotDate: snapshot?.date ?? null,
    gainCents,
    gainPercent:
      gainCents !== null && holding.totalCostCents > 0
        ? Math.round((gainCents / holding.totalCostCents) * 1000) / 10
        : null,
    incomeCents: income?.total ?? 0,
  };
}

export function getHolding(id: string, db: Db = getDb()): HoldingPosition {
  const holding = findHolding(id, db);
  if (!holding) throw notFound('Ativo', id);
  return holdingPosition(holding, db);
}

export function listHoldings(
  options: { includeArchived?: boolean; assetClass?: Holding['assetClass']; db?: Db } = {},
): HoldingPosition[] {
  const db = options.db ?? getDb();
  const filters = [
    options.includeArchived ? undefined : eq(holdings.isArchived, false),
    options.assetClass ? eq(holdings.assetClass, options.assetClass) : undefined,
  ].filter((f) => f !== undefined);

  return db
    .select()
    .from(holdings)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(holdings.name))
    .all()
    .map((holding) => holdingPosition(holding, db));
}

export function holdingTrades(holdingId: string, db: Db = getDb()): InvestmentTransaction[] {
  return db
    .select()
    .from(investmentTransactions)
    .where(eq(investmentTransactions.holdingId, holdingId))
    .orderBy(asc(investmentTransactions.date))
    .all();
}

export interface PortfolioSummary {
  totalCostCents: number;
  /** Valor de mercado, usando o último snapshot de cada ativo. */
  totalMarketValueCents: number;
  totalGainCents: number;
  totalGainPercent: number | null;
  totalIncomeCents: number;
  /** Ativos sem snapshot — o valor de mercado deles não entra no total. */
  withoutSnapshot: string[];
  byAssetClass: Array<{
    assetClass: string;
    costCents: number;
    marketValueCents: number;
    percentOfPortfolio: number;
  }>;
  positions: HoldingPosition[];
}

export function portfolioSummary(db: Db = getDb()): PortfolioSummary {
  const positions = listHoldings({ db });

  const totalCostCents = positions.reduce((sum, p) => sum + p.totalCostCents, 0);
  // Sem snapshot, usa o custo — não inventa valorização.
  const totalMarketValueCents = positions.reduce(
    (sum, p) => sum + (p.marketValueCents ?? p.totalCostCents),
    0,
  );

  const byClass = new Map<string, { costCents: number; marketValueCents: number }>();
  for (const position of positions) {
    const bucket = byClass.get(position.assetClass) ?? { costCents: 0, marketValueCents: 0 };
    bucket.costCents += position.totalCostCents;
    bucket.marketValueCents += position.marketValueCents ?? position.totalCostCents;
    byClass.set(position.assetClass, bucket);
  }

  const totalGainCents = totalMarketValueCents - totalCostCents;

  return {
    totalCostCents,
    totalMarketValueCents,
    totalGainCents,
    totalGainPercent:
      totalCostCents > 0 ? Math.round((totalGainCents / totalCostCents) * 1000) / 10 : null,
    totalIncomeCents: positions.reduce((sum, p) => sum + p.incomeCents, 0),
    withoutSnapshot: positions.filter((p) => p.marketValueCents === null).map((p) => p.name),
    byAssetClass: [...byClass.entries()]
      .map(([assetClass, value]) => ({
        assetClass,
        ...value,
        percentOfPortfolio:
          totalMarketValueCents > 0
            ? Math.round((value.marketValueCents / totalMarketValueCents) * 1000) / 10
            : 0,
      }))
      .sort((a, b) => b.marketValueCents - a.marketValueCents),
    positions,
  };
}

// ── Escrita ─────────────────────────────────────────────────────────────────

export function createHolding(
  input: z.input<typeof createHoldingSchema>,
  options: WriteOptions = {},
): WriteResult<HoldingPosition> {
  const parsed = createHoldingSchema.parse(input);
  const db = readDb(options);

  if (parsed.accountId) getAccount(parsed.accountId, db);

  return withMutate(
    options,
    (result) => `Cadastrou o ativo "${result.name}"`,
    (ctx) => {
      const holding = ctx.insert<Holding>('holdings', {
        name: parsed.name,
        ticker: parsed.ticker ?? null,
        assetClass: parsed.assetClass,
        accountId: parsed.accountId ?? null,
        currency: parsed.currency,
        quantityE8: 0,
        totalCostCents: 0,
        isArchived: false,
        notes: parsed.notes ?? null,
      });
      return holdingPosition(holding, ctx.tx);
    },
  );
}

/**
 * Registra uma operação no ativo.
 *
 * Efeito no custo total, por operação:
 *  • `buy` — soma valor e taxa ao custo, aumenta a quantidade;
 *  • `sell` — reduz a quantidade e o custo **proporcionalmente** (preço médio se
 *    mantém, que é como o custo de aquisição funciona);
 *  • `dividend`/`interest` — não mexem no custo; entram como provento;
 *  • `fee` — soma ao custo;
 *  • `adjust` — corrige a quantidade sem mexer no custo (desdobramento).
 */
export function registerTrade(
  holdingId: string,
  input: z.input<typeof tradeSchema>,
  options: WriteOptions = {},
): WriteResult<{ trade: InvestmentTransaction; position: HoldingPosition; transactionId: string | null }> {
  const parsed = tradeSchema.parse(input);
  const db = readDb(options);
  const holding = findHolding(holdingId, db);
  if (!holding) throw notFound('Ativo', holdingId);

  const needsQuantity = parsed.op === 'buy' || parsed.op === 'sell' || parsed.op === 'adjust';
  if (needsQuantity && parsed.quantity === undefined) {
    throw ruleViolation(`A operação "${parsed.op}" exige a quantidade.`);
  }

  const quantityE8 = parsed.quantity !== undefined ? toQuantityE8(parsed.quantity) : 0;
  const date = parsed.date ?? today();

  if (parsed.op === 'sell' && quantityE8 > holding.quantityE8) {
    throw ruleViolation(
      `Venda de ${parsed.quantity} excede a posição atual de ${fromQuantityE8(holding.quantityE8)}.`,
    );
  }
  if (parsed.cashAccountId) getAccount(parsed.cashAccountId, db);

  return withMutate(
    options,
    () =>
      `${labelForOp(parsed.op)} de ${formatMoney(parsed.amountCents)} em "${holding.name}"`,
    (ctx) => {
      let nextQuantityE8 = holding.quantityE8;
      let nextCostCents = holding.totalCostCents;
      // Sinal do movimento de caixa: compra e taxa saem, venda e provento entram.
      let cashSign = 0;

      switch (parsed.op) {
        case 'buy':
          nextQuantityE8 += quantityE8;
          nextCostCents += parsed.amountCents + parsed.feeCents;
          cashSign = -1;
          break;

        case 'sell': {
          // Reduz o custo na mesma proporção da quantidade vendida, preservando
          // o preço médio das unidades que ficam.
          const proportion = holding.quantityE8 > 0 ? quantityE8 / holding.quantityE8 : 0;
          nextCostCents = Math.round(holding.totalCostCents * (1 - proportion));
          nextQuantityE8 -= quantityE8;
          if (nextQuantityE8 === 0) nextCostCents = 0;
          cashSign = 1;
          break;
        }

        case 'dividend':
        case 'interest':
          cashSign = 1;
          break;

        case 'fee':
          nextCostCents += parsed.amountCents;
          cashSign = -1;
          break;

        case 'adjust':
          nextQuantityE8 = quantityE8;
          break;
      }

      let transactionId: string | null = null;
      if (parsed.cashAccountId && cashSign !== 0) {
        const total = parsed.amountCents + (parsed.op === 'buy' ? parsed.feeCents : 0);
        const transaction = insertTransactionIn(ctx, {
          accountId: parsed.cashAccountId,
          type: cashSign < 0 ? 'expense' : 'income',
          date,
          amountCents: total,
          description: `${labelForOp(parsed.op)} — ${holding.name}`,
        });
        transactionId = transaction.id;
      }

      const trade = ctx.insert<InvestmentTransaction>('investment_transactions', {
        holdingId,
        op: parsed.op,
        date,
        quantityE8,
        amountCents: cashSign === 0 ? parsed.amountCents : cashSign * parsed.amountCents,
        feeCents: parsed.feeCents,
        transactionId,
        note: parsed.note ?? null,
      });

      const updated = ctx.update<Holding>('holdings', holdingId, {
        quantityE8: nextQuantityE8,
        totalCostCents: nextCostCents,
      });

      return { trade, position: holdingPosition(updated, ctx.tx), transactionId };
    },
  );
}

function labelForOp(op: z.infer<typeof tradeSchema>['op']): string {
  const labels: Record<typeof op, string> = {
    buy: 'Compra',
    sell: 'Venda',
    dividend: 'Dividendo',
    interest: 'Juros',
    fee: 'Taxa',
    adjust: 'Ajuste',
  };
  return labels[op];
}

/**
 * Registra o valor de mercado numa data.
 *
 * Único por `(ativo, data)`: informar de novo no mesmo dia substitui, em vez de
 * criar duas verdades para o mesmo instante.
 */
export function recordSnapshot(
  holdingId: string,
  input: { marketValueCents: number; date?: IsoDate; note?: string },
  options: WriteOptions = {},
): WriteResult<PositionSnapshot> {
  const db = readDb(options);
  const holding = findHolding(holdingId, db);
  if (!holding) throw notFound('Ativo', holdingId);
  if (input.marketValueCents < 0) throw ruleViolation('Valor de mercado não pode ser negativo.');

  const date = input.date ?? today();
  const existing = db
    .select()
    .from(positionSnapshots)
    .where(and(eq(positionSnapshots.holdingId, holdingId), eq(positionSnapshots.date, date)))
    .all()[0];

  return withMutate(
    options,
    () => `Atualizou o valor de "${holding.name}" para ${formatMoney(input.marketValueCents)}`,
    (ctx) =>
      existing
        ? ctx.update<PositionSnapshot>('position_snapshots', existing.id, {
            marketValueCents: input.marketValueCents,
            quantityE8: holding.quantityE8,
            note: input.note ?? null,
          })
        : ctx.insert<PositionSnapshot>('position_snapshots', {
            holdingId,
            date,
            marketValueCents: input.marketValueCents,
            quantityE8: holding.quantityE8,
            note: input.note ?? null,
          }),
  );
}

export function deleteHolding(
  id: string,
  options: WriteOptions = {},
): WriteResult<{ removedTrades: number; removedSnapshots: number }> {
  const db = readDb(options);
  const holding = findHolding(id, db);
  if (!holding) throw notFound('Ativo', id);

  const trades = holdingTrades(id, db);
  const snapshots = db.select().from(positionSnapshots).where(eq(positionSnapshots.holdingId, id)).all();

  return withMutate(
    options,
    (result) => `Excluiu o ativo "${holding.name}" (${result.removedTrades} operação(ões))`,
    (ctx) => {
      for (const trade of trades) {
        // A movimentação de caixa permanece: o dinheiro saiu da conta.
        ctx.remove('investment_transactions', trade.id);
      }
      for (const snapshot of snapshots) {
        ctx.remove('position_snapshots', snapshot.id);
      }
      ctx.remove('holdings', id);
      return { removedTrades: trades.length, removedSnapshots: snapshots.length };
    },
  );
}
