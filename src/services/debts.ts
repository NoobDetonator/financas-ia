/**
 * Dívidas e financiamentos.
 *
 * O cronograma inteiro é gerado na criação (`debt_payments`), não calculado a
 * cada consulta. Isso permite registrar o pagamento real de cada parcela — que
 * pode diferir do previsto — e ainda comparar com o planejado. Um cronograma
 * calculado na hora não teria onde guardar "esta parcela foi paga em 12/08 com
 * R$ 3 de multa".
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import { debtPayments, debts, type Debt, type DebtPayment } from '../db/schema.js';
import { notFound, ruleViolation } from '../core/errors.js';
import { formatMoney } from '../core/money.js';
import { addDays, diffDays, today, type IsoDate } from '../core/clock.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { getAccount } from './accounts.js';
import { getCategory } from './categories.js';
import { insertTransactionIn } from './transactions.js';
import {
  buildSchedule,
  simulateEarlyPayoff,
  simulateExtraPayment,
  type AmortizationSchedule,
} from './amortization.js';
import { idSchema, isoDateSchema, positiveCentsSchema } from './schemas.js';

export const createDebtSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['loan', 'financing', 'installment_debt', 'other']).default('loan'),
  principalCents: positiveCentsSchema,
  /** Taxa **anual** em basis points: 1250 = 12,50% a.a. */
  annualRateBps: z.number().int().min(0).max(1_000_000).default(0),
  termMonths: z.number().int().min(1).max(600),
  system: z.enum(['sac', 'price']).default('price'),
  startDate: isoDateSchema.optional(),
  firstDueDate: isoDateSchema,
  /** Conta de onde saem as parcelas. */
  accountId: idSchema.optional(),
  categoryId: idSchema.optional(),
  notes: z.string().max(2000).optional(),
});

export type CreateDebtInput = z.input<typeof createDebtSchema>;

export interface DebtStatus extends Debt {
  /** Saldo devedor atual, pelas parcelas ainda não pagas. */
  outstandingCents: number;
  paidPrincipalCents: number;
  paidInterestCents: number;
  paidCount: number;
  remainingCount: number;
  /** Total de juros previsto para o contrato inteiro. */
  totalInterestCents: number;
  nextPayment: DebtPayment | null;
  /** Parcelas vencidas e não pagas. */
  overdueCount: number;
  progressPercent: number;
}

// ── Leitura ─────────────────────────────────────────────────────────────────

export function findDebt(id: string, db: Db = getDb()): Debt | undefined {
  return db.select().from(debts).where(eq(debts.id, id)).all()[0];
}

export function debtSchedule(debtId: string, db: Db = getDb()): DebtPayment[] {
  return db
    .select()
    .from(debtPayments)
    .where(eq(debtPayments.debtId, debtId))
    .orderBy(asc(debtPayments.installmentNo))
    .all();
}

export function debtStatus(debt: Debt, db: Db = getDb()): DebtStatus {
  const schedule = debtSchedule(debt.id, db);
  const reference = today();

  const paid = schedule.filter((p) => p.paidDate !== null);
  const unpaid = schedule.filter((p) => p.paidDate === null);

  const nextPayment = unpaid[0] ?? null;
  const outstandingCents = unpaid.reduce((sum, p) => sum + p.principalCents, 0);

  return {
    ...debt,
    outstandingCents,
    paidPrincipalCents: paid.reduce((sum, p) => sum + p.principalCents, 0),
    paidInterestCents: paid.reduce((sum, p) => sum + p.interestCents, 0),
    paidCount: paid.length,
    remainingCount: unpaid.length,
    totalInterestCents: schedule.reduce((sum, p) => sum + p.interestCents, 0),
    nextPayment,
    overdueCount: unpaid.filter((p) => p.dueDate < reference).length,
    progressPercent:
      debt.principalCents > 0
        ? Math.round(((debt.principalCents - outstandingCents) / debt.principalCents) * 1000) / 10
        : 0,
  };
}

export function getDebt(id: string, db: Db = getDb()): DebtStatus {
  const debt = findDebt(id, db);
  if (!debt) throw notFound('Dívida', id);
  return debtStatus(debt, db);
}

export function listDebts(options: { includeSettled?: boolean; db?: Db } = {}): DebtStatus[] {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(debts)
    .where(options.includeSettled ? undefined : eq(debts.isSettled, false))
    .orderBy(asc(debts.name))
    .all()
    .map((debt) => debtStatus(debt, db));
}

// ── Escrita ─────────────────────────────────────────────────────────────────

export function createDebt(
  input: CreateDebtInput,
  options: WriteOptions = {},
): WriteResult<DebtStatus> {
  const parsed = createDebtSchema.parse(input);
  const db = readDb(options);

  if (parsed.accountId) getAccount(parsed.accountId, db);
  if (parsed.categoryId) {
    const category = getCategory(parsed.categoryId, db);
    if (category.kind !== 'expense') {
      throw ruleViolation(`"${category.name}" é categoria de receita e não serve para pagar dívida.`);
    }
  }

  const schedule = buildSchedule({
    principalCents: parsed.principalCents,
    annualRateBps: parsed.annualRateBps,
    termMonths: parsed.termMonths,
    system: parsed.system,
    firstDueDate: parsed.firstDueDate,
  });

  return withMutate(
    options,
    (result) =>
      `Registrou a dívida "${result.name}": ${formatMoney(result.principalCents)} em ${result.termMonths}x` +
      ` (${result.system.toUpperCase()}, juros previstos ${formatMoney(result.totalInterestCents)})`,
    (ctx) => {
      const debt = ctx.insert<Debt>('debts', {
        name: parsed.name,
        kind: parsed.kind,
        principalCents: parsed.principalCents,
        annualRateBps: parsed.annualRateBps,
        termMonths: parsed.termMonths,
        system: parsed.system,
        startDate: parsed.startDate ?? parsed.firstDueDate,
        firstDueDate: parsed.firstDueDate,
        accountId: parsed.accountId ?? null,
        categoryId: parsed.categoryId ?? null,
        isSettled: false,
        notes: parsed.notes ?? null,
      });

      for (const row of schedule.rows) {
        ctx.insert('debt_payments', {
          debtId: debt.id,
          installmentNo: row.installmentNo,
          dueDate: row.dueDate,
          amountCents: row.amountCents,
          principalCents: row.principalCents,
          interestCents: row.interestCents,
          balanceAfterCents: row.balanceAfterCents,
        });
      }

      return debtStatus(debt, ctx.tx);
    },
  );
}

/**
 * Registra o pagamento de uma parcela.
 *
 * Cria a transação de despesa na conta configurada, e só então marca a parcela
 * como paga — para que o saldo da conta e a dívida andem juntos.
 */
export function payInstallment(
  debtId: string,
  installmentNo: number,
  input: { date?: IsoDate; amountCents?: number; accountId?: string } = {},
  options: WriteOptions = {},
): WriteResult<{ payment: DebtPayment; debt: DebtStatus; transactionId: string | null }> {
  const db = readDb(options);
  const debt = findDebt(debtId, db);
  if (!debt) throw notFound('Dívida', debtId);

  const payment = db
    .select()
    .from(debtPayments)
    .where(and(eq(debtPayments.debtId, debtId), eq(debtPayments.installmentNo, installmentNo)))
    .all()[0];

  if (!payment) throw notFound(`Parcela ${installmentNo} da dívida`, debtId);
  if (payment.paidDate) {
    throw ruleViolation(`A parcela ${installmentNo} já foi paga em ${payment.paidDate}.`);
  }

  const accountId = input.accountId ?? debt.accountId;
  const date = input.date ?? today();
  const amountCents = input.amountCents ?? payment.amountCents;

  return withMutate(
    options,
    () =>
      `Pagou a parcela ${installmentNo}/${debt.termMonths} de "${debt.name}" (${formatMoney(amountCents)})`,
    (ctx) => {
      let transactionId: string | null = null;

      if (accountId) {
        const transaction = insertTransactionIn(ctx, {
          accountId,
          type: 'expense',
          date,
          amountCents,
          description: `${debt.name} — parcela ${installmentNo}/${debt.termMonths}`,
          ...(debt.categoryId ? { categoryId: debt.categoryId } : {}),
          links: { debtId },
        });
        transactionId = transaction.id;
      }

      const updated = ctx.update<DebtPayment>('debt_payments', payment.id, {
        paidDate: date,
        transactionId,
        ...(input.amountCents !== undefined ? { amountCents } : {}),
      });

      // Última parcela paga: a dívida se encerra sozinha.
      const remaining = ctx.tx
        .select({ n: sql<number>`count(*)` })
        .from(debtPayments)
        .where(and(eq(debtPayments.debtId, debtId), isNull(debtPayments.paidDate)))
        .all()[0];

      if ((remaining?.n ?? 0) === 0) {
        ctx.update('debts', debtId, { isSettled: true });
      }

      const current = findDebt(debtId, ctx.tx)!;
      return { payment: updated, debt: debtStatus(current, ctx.tx), transactionId };
    },
  );
}

export function deleteDebt(
  id: string,
  options: WriteOptions = {},
): WriteResult<{ removedPayments: number; unlinkedTransactions: number }> {
  const db = readDb(options);
  const debt = findDebt(id, db);
  if (!debt) throw notFound('Dívida', id);

  const schedule = debtSchedule(id, db);

  return withMutate(
    options,
    (result) =>
      `Excluiu a dívida "${debt.name}" e ${result.removedPayments} parcela(s) do cronograma`,
    (ctx) => {
      let unlinkedTransactions = 0;

      for (const payment of schedule) {
        // Pagamentos reais permanecem: o dinheiro saiu da conta.
        if (payment.transactionId) {
          ctx.update('transactions', payment.transactionId, { debtId: null });
          unlinkedTransactions += 1;
        }
        ctx.remove('debt_payments', payment.id);
      }

      ctx.remove('debts', id);
      return { removedPayments: schedule.length, unlinkedTransactions };
    },
  );
}

// ── Simulações ──────────────────────────────────────────────────────────────

function scheduleFromDebt(debt: Debt): AmortizationSchedule {
  return buildSchedule({
    principalCents: debt.principalCents,
    annualRateBps: debt.annualRateBps,
    termMonths: debt.termMonths,
    system: debt.system,
    firstDueDate: debt.firstDueDate,
  });
}

/** Vale a pena quitar agora? Compara o saldo devedor com as parcelas restantes. */
export function simulatePayoff(debtId: string, db: Db = getDb()) {
  const debt = findDebt(debtId, db);
  if (!debt) throw notFound('Dívida', debtId);

  const status = debtStatus(debt, db);
  const nextNo = status.nextPayment?.installmentNo ?? debt.termMonths;

  return {
    debtName: debt.name,
    ...simulateEarlyPayoff(scheduleFromDebt(debt), nextNo),
  };
}

/** E se eu jogar um valor extra na dívida? */
export function simulateExtra(debtId: string, extraCents: number, db: Db = getDb()) {
  const debt = findDebt(debtId, db);
  if (!debt) throw notFound('Dívida', debtId);

  const status = debtStatus(debt, db);
  const nextNo = status.nextPayment?.installmentNo ?? debt.termMonths;

  const result = simulateExtraPayment(
    {
      principalCents: debt.principalCents,
      annualRateBps: debt.annualRateBps,
      termMonths: debt.termMonths,
      system: debt.system,
      firstDueDate: debt.firstDueDate,
    },
    extraCents,
    nextNo,
  );

  return {
    debtName: debt.name,
    extraCents,
    monthsSaved: debt.termMonths - result.newTermMonths,
    ...result,
  };
}

/** Parcelas a vencer nos próximos dias, de todas as dívidas. */
export function upcomingDebtPayments(
  options: { withinDays?: number; db?: Db } = {},
): Array<{ debtName: string; payment: DebtPayment; daysUntil: number }> {
  const db = options.db ?? getDb();
  const reference = today();
  const limit = addDays(reference, options.withinDays ?? 30);

  return db
    .select({ debt: debts, payment: debtPayments })
    .from(debtPayments)
    .innerJoin(debts, eq(debts.id, debtPayments.debtId))
    .where(
      and(
        isNull(debtPayments.paidDate),
        sql`${debtPayments.dueDate} <= ${limit}`,
        eq(debts.isSettled, false),
      ),
    )
    .orderBy(asc(debtPayments.dueDate))
    .all()
    .map((row) => ({
      debtName: row.debt.name,
      payment: row.payment,
      daysUntil: diffDays(reference, row.payment.dueDate),
    }));
}
