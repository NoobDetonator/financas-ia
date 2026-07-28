/**
 * Faturas de cartão de crédito.
 *
 * A fatura é uma **agregação derivada**, não a fonte da verdade: o total é sempre
 * recalculado a partir das transações vinculadas. Guardar o total como cache
 * acelera a leitura, mas qualquer divergência é resolvida pelo recálculo — nunca
 * pelo valor gravado.
 *
 * O pagamento da fatura é uma transferência (conta corrente → conta-cartão), e
 * por isso **não** entra no total: o total da fatura são as compras. Ver
 * `recalculateInvoiceTotal`.
 *
 * Este módulo não importa `transactions.ts` de propósito — é `transactions.ts`
 * que chama aqui para descobrir a fatura de uma compra. A dependência precisa
 * apontar numa única direção.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { cardInvoices, transactions, type CardInvoice, type InvoiceStatus } from '../db/schema.js';
import { notFound } from '../core/errors.js';
import { isAfter, isSameOrAfter, nowIso, today, type IsoDate, type MonthKey } from '../core/clock.js';
import type { MutateContext } from '../mutate/index.js';
import { getAccount, getCreditCard } from './accounts.js';
import { cycleForReferenceMonth, resolveInvoiceCycle, type InvoiceCycle } from './invoice-cycle.js';

export interface InvoiceView extends CardInvoice {
  /** Status recalculado na leitura — o gravado pode estar velho entre execuções do job. */
  effectiveStatus: InvoiceStatus;
  /** Quanto falta pagar. */
  remainingCents: number;
}

/**
 * Status a partir das datas e do quanto foi pago.
 *
 * Calculado em vez de apenas lido para que a fatura nunca apareça como "aberta"
 * um mês depois de vencida só porque o job diário não rodou.
 */
export function computeInvoiceStatus(
  invoice: Pick<CardInvoice, 'closingDate' | 'dueDate' | 'totalCents' | 'paidCents'>,
  reference: IsoDate = today(),
): InvoiceStatus {
  const remaining = invoice.totalCents - invoice.paidCents;

  // `paid` exige que houvesse algo a pagar. Uma fatura sem compras não está
  // "paga" — ela só não tem movimento, e chamá-la de paga seria enganoso.
  if (invoice.totalCents > 0 && remaining <= 0) return 'paid';

  if (isAfter(reference, invoice.dueDate)) {
    return remaining > 0 ? 'overdue' : 'closed';
  }
  if (isSameOrAfter(reference, invoice.closingDate)) return 'closed';
  return 'open';
}

function toView(invoice: CardInvoice, reference?: IsoDate): InvoiceView {
  return {
    ...invoice,
    effectiveStatus: computeInvoiceStatus(invoice, reference),
    remainingCents: invoice.totalCents - invoice.paidCents,
  };
}

// ── Leitura ─────────────────────────────────────────────────────────────────

export function findInvoice(id: string, db: Db = getDb()): CardInvoice | undefined {
  return db.select().from(cardInvoices).where(eq(cardInvoices.id, id)).all()[0];
}

export function getInvoice(id: string, db: Db = getDb()): InvoiceView {
  const invoice = findInvoice(id, db);
  if (!invoice) throw notFound('Fatura', id);
  return toView(invoice);
}

export function findInvoiceByMonth(
  cardAccountId: string,
  referenceMonth: MonthKey,
  db: Db = getDb(),
): CardInvoice | undefined {
  return db
    .select()
    .from(cardInvoices)
    .where(and(eq(cardInvoices.cardAccountId, cardAccountId), eq(cardInvoices.referenceMonth, referenceMonth)))
    .all()[0];
}

export function listInvoices(
  options: { cardAccountId?: string; status?: InvoiceStatus; limit?: number; db?: Db } = {},
): InvoiceView[] {
  const db = options.db ?? getDb();

  const filters = [
    options.cardAccountId ? eq(cardInvoices.cardAccountId, options.cardAccountId) : undefined,
  ].filter((f) => f !== undefined);

  const rows = db
    .select()
    .from(cardInvoices)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(cardInvoices.dueDate))
    .limit(options.limit ?? 60)
    .all();

  const views = rows.map((row) => toView(row));
  return options.status ? views.filter((v) => v.effectiveStatus === options.status) : views;
}

/** Transações que compõem a fatura. */
export function invoiceTransactions(invoiceId: string, db: Db = getDb()) {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.cardInvoiceId, invoiceId))
    .orderBy(transactions.date, transactions.id)
    .all();
}

// ── Escrita ─────────────────────────────────────────────────────────────────

/**
 * Devolve a fatura do mês, criando-a se ainda não existir.
 *
 * Idempotente por `(cartão, mês de referência)`, que tem índice único — duas
 * compras no mesmo ciclo não podem gerar duas faturas.
 */
export function ensureInvoiceIn(
  ctx: MutateContext,
  cardAccountId: string,
  cycle: InvoiceCycle,
): CardInvoice {
  const existing = findInvoiceByMonth(cardAccountId, cycle.referenceMonth, ctx.tx);
  if (existing) return existing;

  return ctx.insert<CardInvoice>('card_invoices', {
    cardAccountId,
    referenceMonth: cycle.referenceMonth,
    closingDate: cycle.closingDate,
    dueDate: cycle.dueDate,
    status: computeInvoiceStatus({
      closingDate: cycle.closingDate,
      dueDate: cycle.dueDate,
      totalCents: 0,
      paidCents: 0,
    }),
    totalCents: 0,
    paidCents: 0,
  });
}

/**
 * Descobre (criando se preciso) a fatura de uma compra num cartão.
 *
 * Chamada por `transactions.ts` antes de inserir, para que o vínculo já nasça na
 * linha em vez de virar um update posterior.
 *
 * Devolve `null` quando a conta não é cartão de crédito.
 */
export function resolveInvoiceForPurchaseIn(
  ctx: MutateContext,
  accountId: string,
  purchaseDate: IsoDate,
): CardInvoice | null {
  const account = getAccount(accountId, ctx.tx);
  if (account.kind !== 'credit_card' || !account.card) return null;

  const cycle = resolveInvoiceCycle(purchaseDate, {
    closingDay: account.card.closingDay,
    dueDay: account.card.dueDay,
  });

  return ensureInvoiceIn(ctx, accountId, cycle);
}

/**
 * Recalcula o total da fatura a partir das transações vinculadas.
 *
 * Transferências ficam fora: o pagamento da fatura é uma transferência da conta
 * corrente para o cartão, e somá-la ao total zeraria a fatura em vez de quitá-la.
 * O total é sempre positivo (é quanto se deve).
 */
export function recalculateInvoiceTotalIn(ctx: MutateContext, invoiceId: string): CardInvoice {
  const invoice = findInvoice(invoiceId, ctx.tx);
  if (!invoice) throw notFound('Fatura', invoiceId);

  const [purchases] = ctx.tx
    .select({ total: sql<number>`coalesce(sum(${transactions.amountCents}), 0)` })
    .from(transactions)
    .where(and(eq(transactions.cardInvoiceId, invoiceId), sql`${transactions.type} != 'transfer'`))
    .all();

  // Compras no cartão são negativas; o total da fatura é o módulo disso.
  const totalCents = Math.abs(purchases?.total ?? 0);

  if (totalCents === invoice.totalCents) {
    return invoice;
  }

  return ctx.update<CardInvoice>('card_invoices', invoiceId, {
    totalCents,
    status: computeInvoiceStatus({ ...invoice, totalCents }),
  });
}

/** Atualiza o status gravado de todas as faturas — chamado pelo job diário. */
export function refreshInvoiceStatusesIn(ctx: MutateContext, reference: IsoDate = today()): number {
  let changed = 0;

  for (const invoice of ctx.tx.select().from(cardInvoices).all()) {
    const status = computeInvoiceStatus(invoice, reference);
    if (status === invoice.status) continue;

    ctx.update('card_invoices', invoice.id, {
      status,
      ...(status === 'closed' && !invoice.closedAt ? { closedAt: nowIso() } : {}),
    });
    changed += 1;
  }

  return changed;
}

/**
 * Registra o pagamento de uma fatura.
 *
 * O `paidCents` é acumulativo, então pagamento parcial funciona: pagar o mínimo
 * deixa a fatura com saldo devedor, que é o comportamento real do cartão.
 */
export function registerInvoicePaymentIn(
  ctx: MutateContext,
  invoiceId: string,
  amountCents: number,
  paymentTransactionId: string,
): CardInvoice {
  const invoice = findInvoice(invoiceId, ctx.tx);
  if (!invoice) throw notFound('Fatura', invoiceId);

  const paidCents = invoice.paidCents + amountCents;

  return ctx.update<CardInvoice>('card_invoices', invoiceId, {
    paidCents,
    paymentTransactionId,
    paidAt: paidCents >= invoice.totalCents ? nowIso() : null,
    status: computeInvoiceStatus({ ...invoice, paidCents }),
  });
}

/**
 * Fatura aberta de um cartão — a que está recebendo compras agora.
 */
export function currentInvoice(cardAccountId: string, db: Db = getDb()): InvoiceView | undefined {
  const card = getCreditCard(cardAccountId, db);
  const cycle = resolveInvoiceCycle(today(), {
    closingDay: card.card.closingDay,
    dueDay: card.card.dueDay,
  });

  const invoice = findInvoiceByMonth(cardAccountId, cycle.referenceMonth, db);
  return invoice ? toView(invoice) : undefined;
}

/** Faturas com saldo devedor, ordenadas por vencimento — "o que tenho a pagar". */
export function openInvoices(db: Db = getDb()): InvoiceView[] {
  return db
    .select()
    .from(cardInvoices)
    .orderBy(cardInvoices.dueDate)
    .all()
    .map((row) => toView(row))
    .filter((view) => view.remainingCents > 0);
}

/** Projeção de uma fatura futura por mês de referência, mesmo sem linha no banco. */
export function projectInvoice(
  cardAccountId: string,
  referenceMonth: MonthKey,
  db: Db = getDb(),
): { referenceMonth: MonthKey; cycle: InvoiceCycle; totalCents: number; invoiceId: string | null } {
  const card = getCreditCard(cardAccountId, db);
  const cycle = cycleForReferenceMonth(referenceMonth, {
    closingDay: card.card.closingDay,
    dueDay: card.card.dueDay,
  });

  const invoice = findInvoiceByMonth(cardAccountId, referenceMonth, db);

  return {
    referenceMonth,
    cycle,
    totalCents: invoice?.totalCents ?? 0,
    invoiceId: invoice?.id ?? null,
  };
}
