/**
 * Operações de cartão que compõem transações: parcelamento e pagamento de fatura.
 *
 * Fica separado de `invoices.ts` porque depende de `transactions.ts` e
 * `transfers.ts` — enquanto `invoices.ts` é chamado *por* eles. Mantendo a
 * dependência numa direção só, não há ciclo de import.
 */

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import {
  cardInvoices,
  installmentPlans,
  transactions,
  type CardInvoice,
  type InstallmentPlan,
  type Transaction,
} from '../db/schema.js';
import { notFound, ruleViolation } from '../core/errors.js';
import { formatMoney, splitEvenly } from '../core/money.js';
import { addMonths, formatDateBr, today, type IsoDate } from '../core/clock.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { getAccount, getCreditCard } from './accounts.js';
import { getCategory } from './categories.js';
import {
  ensureInvoiceIn,
  findInvoice,
  getInvoice,
  invoiceTransactions,
  recalculateInvoiceTotalIn,
  registerInvoicePaymentIn,
  refreshInvoiceStatusesIn,
} from './invoices.js';
import { nextCycles } from './invoice-cycle.js';
import { insertTransactionIn, removeTransactionIn } from './transactions.js';
import { insertTransferIn } from './transfers.js';
import { idSchema, isoDateSchema, isoDateSchema as dateSchema, positiveCentsSchema } from './schemas.js';

// ── Parcelamento ────────────────────────────────────────────────────────────

export const createInstallmentPlanSchema = z.object({
  accountId: idSchema,
  description: z.string().min(1).max(200),
  /** Valor **total** da compra. A soma das parcelas fecha exatamente com ele. */
  totalCents: positiveCentsSchema,
  installments: z.number().int().min(2).max(120),
  purchaseDate: isoDateSchema,
  categoryId: idSchema.optional(),
  payeeId: idSchema.optional(),
  notes: z.string().max(2000).optional(),
  /**
   * Data da primeira cobrança em contas que não são cartão. Ignorado em cartão,
   * onde as parcelas seguem os ciclos de fatura.
   */
  firstChargeDate: isoDateSchema.optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

export type CreateInstallmentPlanInput = z.input<typeof createInstallmentPlanSchema>;

export interface InstallmentPlanDetail extends InstallmentPlan {
  transactions: Transaction[];
  /** Quanto ainda vai ser cobrado (parcelas não efetivadas). */
  remainingCents: number;
  paidCount: number;
}

/**
 * Cria uma compra parcelada.
 *
 * Em cartão de crédito, cada parcela cai num ciclo de fatura consecutivo. Em
 * outras contas, cai de mês em mês a partir de `firstChargeDate`.
 *
 * A primeira parcela usa a data da compra; as seguintes usam o fim do período do
 * respectivo ciclo. Ambas ficam **dentro** do ciclo ao qual a parcela pertence, o
 * que garante uma propriedade importante: recalcular a fatura a partir da data da
 * parcela devolve a mesma fatura à qual ela está vinculada.
 */
export function createInstallmentPlan(
  input: CreateInstallmentPlanInput,
  options: WriteOptions = {},
): WriteResult<InstallmentPlanDetail> {
  const parsed = createInstallmentPlanSchema.parse(input);
  const db = readDb(options);

  const account = getAccount(parsed.accountId, db);
  if (parsed.categoryId) getCategory(parsed.categoryId, db);

  const isCard = account.kind === 'credit_card';
  if (!isCard && !parsed.firstChargeDate) {
    throw ruleViolation(
      'Para parcelar fora de cartão de crédito, informe a data da primeira cobrança (`firstChargeDate`).',
    );
  }

  const amounts = splitEvenly(parsed.totalCents, parsed.installments);

  return withMutate(
    options,
    (result) =>
      `Parcelou "${result.description}" em ${result.installments}x de ${formatMoney(Math.abs(result.transactions[0]?.amountCents ?? 0))}` +
      ` (total ${formatMoney(result.totalCents)})`,
    (ctx) => {
      // Ciclos ou datas de cobrança de cada parcela.
      const cycles = isCard && account.card
        ? nextCycles(
            parsed.purchaseDate,
            { closingDay: account.card.closingDay, dueDay: account.card.dueDay },
            parsed.installments,
          )
        : null;

      const firstChargeDate = cycles ? parsed.purchaseDate : parsed.firstChargeDate!;

      const plan = ctx.insert<InstallmentPlan>('installment_plans', {
        accountId: parsed.accountId,
        description: parsed.description,
        totalCents: parsed.totalCents,
        installments: parsed.installments,
        purchaseDate: parsed.purchaseDate,
        firstChargeDate,
        categoryId: parsed.categoryId ?? null,
        payeeId: parsed.payeeId ?? null,
        notes: parsed.notes ?? null,
      });

      const created: Transaction[] = [];
      const touchedInvoices = new Set<string>();

      for (let index = 0; index < parsed.installments; index += 1) {
        const amountCents = amounts[index]!;
        const installmentNo = index + 1;

        let date: IsoDate;
        let invoice: CardInvoice | null = null;

        if (cycles) {
          const cycle = cycles[index]!;
          // Primeira parcela na data da compra; as demais no fim do período do
          // ciclo — sempre dentro do ciclo correspondente.
          date = index === 0 ? parsed.purchaseDate : cycle.periodEnd;
          invoice = ensureInvoiceIn(ctx, parsed.accountId, cycle);
          touchedInvoices.add(invoice.id);
        } else {
          date = addMonths(firstChargeDate, index);
        }

        const transaction = insertTransactionIn(ctx, {
          accountId: parsed.accountId,
          type: 'expense',
          date,
          amountCents,
          description: `${parsed.description} (${installmentNo}/${parsed.installments})`,
          ...(parsed.categoryId ? { categoryId: parsed.categoryId } : {}),
          ...(parsed.payeeId ? { payeeId: parsed.payeeId } : {}),
          ...(parsed.notes ? { notes: parsed.notes } : {}),
          ...(parsed.tags ? { tags: parsed.tags } : {}),
          // Parcela futura é compromisso previsto, não gasto efetivado; a
          // primeira já aconteceu.
          status: index === 0 ? 'cleared' : 'scheduled',
          links: {
            installmentPlanId: plan.id,
            installmentNo,
            ...(invoice ? { cardInvoiceId: invoice.id } : {}),
          },
        });

        created.push(transaction);
      }

      for (const invoiceId of touchedInvoices) {
        recalculateInvoiceTotalIn(ctx, invoiceId);
      }

      return {
        ...plan,
        transactions: created,
        remainingCents: parsed.totalCents - Math.abs(created[0]?.amountCents ?? 0),
        paidCount: 1,
      };
    },
  );
}

export function findInstallmentPlan(id: string, db: Db = getDb()): InstallmentPlan | undefined {
  return db.select().from(installmentPlans).where(eq(installmentPlans.id, id)).all()[0];
}

export function getInstallmentPlan(id: string, db: Db = getDb()): InstallmentPlanDetail {
  const plan = findInstallmentPlan(id, db);
  if (!plan) throw notFound('Parcelamento', id);

  const rows = db
    .select()
    .from(transactions)
    .where(eq(transactions.installmentPlanId, id))
    .orderBy(asc(transactions.installmentNo))
    .all();

  const settled = rows.filter((t) => t.status === 'cleared' || t.status === 'reconciled');
  const remainingCents = rows
    .filter((t) => t.status === 'scheduled' || t.status === 'pending')
    .reduce((sum, t) => sum + Math.abs(t.amountCents), 0);

  return { ...plan, transactions: rows, remainingCents, paidCount: settled.length };
}

export function listInstallmentPlans(
  options: { accountId?: string; onlyActive?: boolean; db?: Db } = {},
): InstallmentPlanDetail[] {
  const db = options.db ?? getDb();

  const rows = db
    .select()
    .from(installmentPlans)
    .where(options.accountId ? eq(installmentPlans.accountId, options.accountId) : undefined)
    .orderBy(asc(installmentPlans.purchaseDate))
    .all();

  const details = rows.map((plan) => getInstallmentPlan(plan.id, db));
  return options.onlyActive ? details.filter((d) => d.remainingCents > 0) : details;
}

/**
 * Cancela um parcelamento, removendo as parcelas ainda não efetivadas.
 *
 * As já pagas são preservadas: elas aconteceram, e apagá-las reescreveria o
 * histórico e o saldo.
 */
export function cancelInstallmentPlan(
  id: string,
  options: WriteOptions & { removeSettled?: boolean } = {},
): WriteResult<{ removed: number; kept: number }> {
  const db = readDb(options);
  const plan = getInstallmentPlan(id, db);

  return withMutate(
    options,
    (result) =>
      `Cancelou o parcelamento "${plan.description}": removeu ${result.removed} parcela(s), manteve ${result.kept}`,
    (ctx) => {
      const touchedInvoices = new Set<string>();
      let removed = 0;
      let kept = 0;

      for (const installment of plan.transactions) {
        const settled = installment.status === 'cleared' || installment.status === 'reconciled';
        if (settled && !options.removeSettled) {
          kept += 1;
          continue;
        }
        if (installment.cardInvoiceId) touchedInvoices.add(installment.cardInvoiceId);
        removeTransactionIn(ctx, installment.id);
        removed += 1;
      }

      if (kept === 0) {
        ctx.remove('installment_plans', id);
      }

      for (const invoiceId of touchedInvoices) {
        if (findInvoice(invoiceId, ctx.tx)) recalculateInvoiceTotalIn(ctx, invoiceId);
      }

      return { removed, kept };
    },
  );
}

// ── Pagamento de fatura ─────────────────────────────────────────────────────

export const payInvoiceSchema = z.object({
  /** Conta de onde sai o dinheiro. Omitido, usa a conta de pagamento do cartão. */
  fromAccountId: idSchema.optional(),
  /** Valor pago. Omitido, paga o saldo devedor inteiro. */
  amountCents: positiveCentsSchema.optional(),
  date: dateSchema.optional(),
  notes: z.string().max(500).optional(),
});

export type PayInvoiceInput = z.input<typeof payInvoiceSchema>;

export interface InvoicePayment {
  invoice: CardInvoice;
  transferId: string;
  /** Perna que sai da conta corrente. */
  paymentTransaction: Transaction;
}

/**
 * Paga a fatura como uma transferência da conta corrente para a conta-cartão.
 *
 * Modelar como transferência (e não como despesa) é o que evita contar o gasto
 * duas vezes: a despesa já foi registrada quando a compra entrou na fatura. Se o
 * pagamento também fosse despesa, o mês fecharia com o dobro.
 *
 * Pagamento parcial é suportado — a fatura fica com saldo devedor.
 */
export function payInvoice(
  invoiceId: string,
  input: PayInvoiceInput = {},
  options: WriteOptions = {},
): WriteResult<InvoicePayment> {
  const parsed = payInvoiceSchema.parse(input);
  const db = readDb(options);

  const invoice = getInvoice(invoiceId, db);
  const card = getCreditCard(invoice.cardAccountId, db);

  const fromAccountId = parsed.fromAccountId ?? card.card.paymentAccountId;
  if (!fromAccountId) {
    throw ruleViolation(
      `Informe a conta de pagamento: o cartão "${card.name}" não tem uma conta padrão configurada.`,
      { invoiceId },
    );
  }
  if (fromAccountId === invoice.cardAccountId) {
    throw ruleViolation('A fatura não pode ser paga com o próprio cartão.');
  }
  getAccount(fromAccountId, db);

  const amountCents = parsed.amountCents ?? invoice.remainingCents;
  if (amountCents <= 0) {
    throw ruleViolation(
      invoice.totalCents === 0
        ? `A fatura de ${invoice.referenceMonth} está zerada — não há o que pagar.`
        : `A fatura de ${invoice.referenceMonth} já está paga.`,
      { invoiceId, totalCents: invoice.totalCents, paidCents: invoice.paidCents },
    );
  }
  if (amountCents > invoice.remainingCents) {
    throw ruleViolation(
      `O valor (${formatMoney(amountCents)}) é maior que o saldo devedor da fatura (${formatMoney(invoice.remainingCents)}).`,
      { invoiceId, remainingCents: invoice.remainingCents },
    );
  }

  const date = parsed.date ?? today();

  return withMutate(
    options,
    (result) =>
      `Pagou ${formatMoney(amountCents)} da fatura de ${result.invoice.referenceMonth} do cartão "${card.name}"`,
    (ctx) => {
      const pair = insertTransferIn(ctx, {
        fromAccountId,
        toAccountId: invoice.cardAccountId,
        amountCents,
        date,
        description: `Pagamento da fatura ${invoice.referenceMonth} — ${card.name}`,
        ...(parsed.notes ? { notes: parsed.notes } : {}),
        // Só o lado do cartão pertence à fatura. A saída da conta corrente é
        // apenas dinheiro saindo dela — vincular as duas pernas faria o
        // pagamento aparecer duplicado na fatura.
        inLinks: { cardInvoiceId: invoiceId },
      });

      const updated = registerInvoicePaymentIn(ctx, invoiceId, amountCents, pair.out.id);

      return { invoice: updated, transferId: pair.transferId, paymentTransaction: pair.out };
    },
  );
}

/** Detalhe da fatura com as transações que a compõem. */
export function invoiceDetail(invoiceId: string, db: Db = getDb()) {
  const invoice = getInvoice(invoiceId, db);
  const rows = invoiceTransactions(invoiceId, db);

  const purchases = rows.filter((t) => t.type !== 'transfer');
  const payments = rows.filter((t) => t.type === 'transfer');

  return {
    ...invoice,
    purchases,
    payments,
    /** Confere o cache contra a soma real — divergência indica escrita fora do `mutate()`. */
    computedTotalCents: Math.abs(purchases.reduce((sum, t) => sum + t.amountCents, 0)),
  };
}

/** Atualiza o status de todas as faturas. Chamado pelo job diário. */
export function refreshInvoiceStatuses(
  options: WriteOptions & { reference?: IsoDate } = {},
): WriteResult<{ changed: number }> {
  return withMutate(
    options,
    (result) => `Atualizou o status de ${result.changed} fatura(s)`,
    (ctx) => ({ changed: refreshInvoiceStatusesIn(ctx, options.reference ?? today()) }),
  );
}

/**
 * Faturas a vencer nos próximos dias — a resposta para "o que tenho a pagar?".
 */
export function upcomingInvoices(
  options: { withinDays?: number; db?: Db } = {},
): Array<{ invoice: CardInvoice; cardName: string; daysUntilDue: number; remainingCents: number }> {
  const db = options.db ?? getDb();
  const horizon = options.withinDays ?? 45;
  const reference = today();

  const rows = db.select().from(cardInvoices).orderBy(asc(cardInvoices.dueDate)).all();
  const result: Array<{ invoice: CardInvoice; cardName: string; daysUntilDue: number; remainingCents: number }> = [];

  for (const invoice of rows) {
    const remainingCents = invoice.totalCents - invoice.paidCents;
    if (remainingCents <= 0) continue;

    const daysUntilDue = Math.round(
      (Date.parse(`${invoice.dueDate}T00:00:00Z`) - Date.parse(`${reference}T00:00:00Z`)) / 86_400_000,
    );
    if (daysUntilDue > horizon) continue;

    const account = getAccount(invoice.cardAccountId, db);
    result.push({ invoice, cardName: account.name, daysUntilDue, remainingCents });
  }

  return result;
}

export { formatDateBr };
