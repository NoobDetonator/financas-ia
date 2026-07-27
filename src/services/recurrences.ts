/**
 * Recorrências: contas fixas, assinaturas e salário.
 *
 * O modelo é **materialização antecipada**: as ocorrências futuras existem como
 * transações reais com status `scheduled`, dentro de um horizonte configurável.
 *
 * Por que materializar em vez de calcular na hora: com as linhas no banco, saldo
 * projetado, previsão de fatura e "contas a vencer" são a mesma consulta simples
 * usada em todo o resto do sistema. Calculando sob demanda, cada relatório teria
 * que reimplementar a expansão da regra — e divergir.
 *
 * A idempotência vem do índice único `(recurrence_id, recurrence_occurrence)`:
 * rodar o materializador duas vezes não duplica nada, o que importa porque ele
 * roda na partida do servidor **e** no job diário.
 */

import { and, asc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import {
  recurrences,
  settings,
  transactions,
  type Recurrence,
  type Transaction,
} from '../db/schema.js';
import { notFound, ruleViolation } from '../core/errors.js';
import { formatMoney } from '../core/money.js';
import { addDays, isAfter, isSameOrBefore, today, type IsoDate } from '../core/clock.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import type { MutateContext } from '../mutate/index.js';
import { getAccount } from './accounts.js';
import { getCategory } from './categories.js';
import { insertTransactionIn, removeTransactionIn } from './transactions.js';
import { describeRule, nextOccurrence, occurrencesBetween, type RecurrenceRule } from './recurrence-rule.js';
import {
  dayOfMonthSchema,
  idSchema,
  isoDateSchema,
  positiveCentsSchema,
  transactionTypeSchema,
} from './schemas.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

export const createRecurrenceSchema = z
  .object({
    name: z.string().min(1).max(120),
    accountId: idSchema,
    type: transactionTypeSchema.exclude(['transfer']),
    /** Omitido = valor variável (conta de luz). Nesse caso informe `estimatedCents`. */
    amountCents: positiveCentsSchema.optional(),
    /** Estimativa usada na projeção quando o valor é variável. */
    estimatedCents: positiveCentsSchema.optional(),
    categoryId: idSchema.optional(),
    payeeId: idSchema.optional(),

    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).max(60).default(1),
    dayOfMonth: dayOfMonthSchema.optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    month: z.number().int().min(1).max(12).optional(),

    startDate: isoDateSchema,
    endDate: isoDateSchema.optional(),
    maxOccurrences: z.number().int().min(1).max(600).optional(),

    /** `true` = já nasce efetivada na data. `false` = fica pendente de confirmação. */
    autoPost: z.boolean().default(false),
    notes: z.string().max(2000).optional(),
  })
  .refine((data) => data.amountCents !== undefined || data.estimatedCents !== undefined, {
    message: 'Informe `amountCents` (valor fixo) ou `estimatedCents` (valor variável).',
  });

export type CreateRecurrenceInput = z.input<typeof createRecurrenceSchema>;

export const updateRecurrenceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  amountCents: positiveCentsSchema.nullable().optional(),
  estimatedCents: positiveCentsSchema.nullable().optional(),
  categoryId: idSchema.nullable().optional(),
  payeeId: idSchema.nullable().optional(),
  interval: z.number().int().min(1).max(60).optional(),
  dayOfMonth: dayOfMonthSchema.nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  endDate: isoDateSchema.nullable().optional(),
  maxOccurrences: z.number().int().min(1).max(600).nullable().optional(),
  autoPost: z.boolean().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export type UpdateRecurrenceInput = z.input<typeof updateRecurrenceSchema>;

export interface RecurrenceView extends Recurrence {
  /** Regra em português: "todo mês no dia 10". */
  description: string;
  /** Próxima data prevista, ou `null` se a série terminou. */
  nextDate: IsoDate | null;
  /** Valor usado na projeção: o fixo, ou a estimativa. */
  effectiveCents: number;
}

// ── Leitura ─────────────────────────────────────────────────────────────────

function toRule(recurrence: Recurrence): RecurrenceRule {
  return {
    freq: recurrence.freq,
    interval: recurrence.interval,
    startDate: recurrence.startDate,
    endDate: recurrence.endDate,
    maxOccurrences: recurrence.maxOccurrences,
    dayOfMonth: recurrence.dayOfMonth,
    weekday: recurrence.weekday,
    month: recurrence.month,
  };
}

function toView(recurrence: Recurrence, reference: IsoDate = today()): RecurrenceView {
  const rule = toRule(recurrence);
  return {
    ...recurrence,
    description: describeRule(rule),
    nextDate: recurrence.isActive ? nextOccurrence(rule, reference) : null,
    effectiveCents: recurrence.amountCents ?? recurrence.estimatedCents ?? 0,
  };
}

export function listRecurrences(
  options: { accountId?: string; onlyActive?: boolean; db?: Db } = {},
): RecurrenceView[] {
  const db = options.db ?? getDb();

  const filters = [
    options.accountId ? eq(recurrences.accountId, options.accountId) : undefined,
    options.onlyActive ? eq(recurrences.isActive, true) : undefined,
  ].filter((f) => f !== undefined);

  return db
    .select()
    .from(recurrences)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(recurrences.name))
    .all()
    .map((row) => toView(row));
}

export function findRecurrence(id: string, db: Db = getDb()): Recurrence | undefined {
  return db.select().from(recurrences).where(eq(recurrences.id, id)).all()[0];
}

export function getRecurrence(id: string, db: Db = getDb()): RecurrenceView {
  const recurrence = findRecurrence(id, db);
  if (!recurrence) throw notFound('Recorrência', id);
  return toView(recurrence);
}

/** Ocorrências já materializadas de uma recorrência. */
export function recurrenceTransactions(id: string, db: Db = getDb()): Transaction[] {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.recurrenceId, id))
    .orderBy(asc(transactions.date))
    .all();
}

function horizonDays(db: Db): number {
  const row = db.select().from(settings).where(eq(settings.id, 'singleton')).all()[0];
  return row?.materializeHorizonDays ?? 120;
}

// ── Escrita ─────────────────────────────────────────────────────────────────

export function createRecurrence(
  input: CreateRecurrenceInput,
  options: WriteOptions = {},
): WriteResult<{ recurrence: RecurrenceView; materialized: number }> {
  const parsed = createRecurrenceSchema.parse(input);
  const db = readDb(options);

  const account = getAccount(parsed.accountId, db);
  if (parsed.categoryId) {
    const category = getCategory(parsed.categoryId, db);
    if (category.kind !== parsed.type) {
      throw ruleViolation(
        `A categoria "${category.name}" é de ${category.kind === 'expense' ? 'despesa' : 'receita'} e não combina com esta recorrência.`,
      );
    }
  }
  if (account.kind === 'credit_card' && parsed.type === 'income') {
    throw ruleViolation('Cartão de crédito não recebe recorrência de receita.');
  }

  return withMutate(
    options,
    (result) =>
      `Criou recorrência "${result.recurrence.name}" (${result.recurrence.description}, ${formatMoney(result.recurrence.effectiveCents)})`,
    (ctx) => {
      const recurrence = ctx.insert<Recurrence>('recurrences', {
        name: parsed.name,
        accountId: parsed.accountId,
        type: parsed.type,
        amountCents: parsed.amountCents ?? null,
        estimatedCents: parsed.estimatedCents ?? null,
        categoryId: parsed.categoryId ?? null,
        payeeId: parsed.payeeId ?? null,
        freq: parsed.freq,
        interval: parsed.interval,
        dayOfMonth: parsed.dayOfMonth ?? null,
        weekday: parsed.weekday ?? null,
        month: parsed.month ?? null,
        startDate: parsed.startDate,
        endDate: parsed.endDate ?? null,
        maxOccurrences: parsed.maxOccurrences ?? null,
        autoPost: parsed.autoPost,
        isActive: true,
        notes: parsed.notes ?? null,
      });

      const materialized = materializeRecurrenceIn(ctx, recurrence);
      return { recurrence: toView(recurrence), materialized };
    },
  );
}

/**
 * Cria as transações futuras que faltam, até o horizonte.
 *
 * Idempotente: consulta o que já existe antes de inserir, e o índice único em
 * `(recurrence_id, recurrence_occurrence)` é a última linha de defesa.
 *
 * Só materializa o **futuro**. Ocorrências passadas não são inventadas
 * retroativamente — se a conta de luz de março não foi lançada, quem sabe se ela
 * foi paga é você, não o sistema.
 */
export function materializeRecurrenceIn(
  ctx: MutateContext,
  recurrence: Recurrence,
  options: { through?: IsoDate; from?: IsoDate } = {},
): number {
  if (!recurrence.isActive) return 0;

  const db = ctx.tx;
  const reference = options.from ?? today();
  const through = options.through ?? addDays(reference, horizonDays(db));

  const amountCents = recurrence.amountCents ?? recurrence.estimatedCents;
  if (amountCents == null) return 0;

  // Não retroage: começa da data de referência ou do início da regra, o que for depois.
  const from = isAfter(recurrence.startDate, reference) ? recurrence.startDate : reference;
  const dates = occurrencesBetween(toRule(recurrence), from, through);
  if (dates.length === 0) return 0;

  const existing = new Set(
    db
      .select({ occurrence: transactions.recurrenceOccurrence })
      .from(transactions)
      .where(and(eq(transactions.recurrenceId, recurrence.id), isNotNull(transactions.recurrenceOccurrence)))
      .all()
      .map((row) => row.occurrence),
  );

  let created = 0;
  for (const date of dates) {
    if (existing.has(date)) continue;

    insertTransactionIn(ctx, {
      accountId: recurrence.accountId,
      type: recurrence.type === 'income' ? 'income' : 'expense',
      date,
      amountCents,
      description: recurrence.name,
      ...(recurrence.categoryId ? { categoryId: recurrence.categoryId } : {}),
      ...(recurrence.payeeId ? { payeeId: recurrence.payeeId } : {}),
      ...(recurrence.notes ? { notes: recurrence.notes } : {}),
      status: 'scheduled',
      links: { recurrenceId: recurrence.id, recurrenceOccurrence: date, createdBy: 'system' },
    });
    created += 1;
  }

  if (created > 0) {
    ctx.update('recurrences', recurrence.id, { materializedThrough: through });
  }

  return created;
}

/** Materializa todas as recorrências ativas. Chamado na partida e no job diário. */
export function materializeAll(
  options: WriteOptions & { through?: IsoDate } = {},
): WriteResult<{ created: number; recurrences: number }> {
  const db = readDb(options);
  const active = db.select().from(recurrences).where(eq(recurrences.isActive, true)).all();

  return withMutate(
    options,
    (result) => `Materializou ${result.created} ocorrência(s) de ${result.recurrences} recorrência(s)`,
    (ctx) => {
      let created = 0;
      for (const recurrence of active) {
        created += materializeRecurrenceIn(ctx, recurrence, options.through ? { through: options.through } : {});
      }
      return { created, recurrences: active.length };
    },
  );
}

/**
 * Altera a recorrência e regenera apenas as ocorrências **futuras não confirmadas**.
 *
 * Ocorrências passadas e já efetivadas são preservadas: elas aconteceram com o
 * valor antigo, e reescrevê-las falsificaria o histórico.
 */
export function updateRecurrence(
  id: string,
  input: UpdateRecurrenceInput,
  options: WriteOptions = {},
): WriteResult<{ recurrence: RecurrenceView; regenerated: number; removed: number }> {
  const parsed = updateRecurrenceSchema.parse(input);
  const db = readDb(options);
  const current = findRecurrence(id, db);
  if (!current) throw notFound('Recorrência', id);

  if (parsed.categoryId) {
    const category = getCategory(parsed.categoryId, db);
    if (category.kind !== current.type) {
      throw ruleViolation(`A categoria "${category.name}" não combina com o tipo da recorrência.`);
    }
  }

  const reference = today();

  return withMutate(
    options,
    (result) =>
      `Alterou recorrência "${result.recurrence.name}"` +
      (result.removed > 0 ? ` e regerou ${result.regenerated} ocorrência(s) futura(s)` : ''),
    (ctx) => {
      const updated = ctx.update<Recurrence>('recurrences', id, parsed);

      // Remove somente o que ainda não aconteceu nem foi confirmado.
      const stale = ctx.tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.recurrenceId, id),
            eq(transactions.status, 'scheduled'),
            gte(transactions.date, reference),
          ),
        )
        .all();

      for (const row of stale) {
        removeTransactionIn(ctx, row.id);
      }

      const regenerated = materializeRecurrenceIn(ctx, updated);

      return { recurrence: toView(updated), regenerated, removed: stale.length };
    },
  );
}

/** Desativa a recorrência e remove as ocorrências futuras não confirmadas. */
export function deactivateRecurrence(
  id: string,
  options: WriteOptions = {},
): WriteResult<{ removed: number }> {
  const db = readDb(options);
  const current = findRecurrence(id, db);
  if (!current) throw notFound('Recorrência', id);

  const reference = today();

  return withMutate(
    options,
    (result) => `Desativou "${current.name}" e removeu ${result.removed} ocorrência(s) futura(s)`,
    (ctx) => {
      const future = ctx.tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.recurrenceId, id),
            eq(transactions.status, 'scheduled'),
            gte(transactions.date, reference),
          ),
        )
        .all();

      for (const row of future) removeTransactionIn(ctx, row.id);
      ctx.update('recurrences', id, { isActive: false });

      return { removed: future.length };
    },
  );
}

export function deleteRecurrence(
  id: string,
  options: WriteOptions = {},
): WriteResult<{ removed: number; unlinked: number }> {
  const db = readDb(options);
  const current = findRecurrence(id, db);
  if (!current) throw notFound('Recorrência', id);

  return withMutate(
    options,
    (result) =>
      `Excluiu a recorrência "${current.name}": removeu ${result.removed} agendamento(s), manteve ${result.unlinked} lançamento(s) já efetivado(s)`,
    (ctx) => {
      let removed = 0;
      let unlinked = 0;

      for (const row of recurrenceTransactions(id, ctx.tx)) {
        if (row.status === 'scheduled') {
          removeTransactionIn(ctx, row.id);
          removed += 1;
        } else {
          // O que já aconteceu permanece, apenas sem o vínculo.
          ctx.update('transactions', row.id, { recurrenceId: null, recurrenceOccurrence: null });
          unlinked += 1;
        }
      }

      ctx.remove('recurrences', id);
      return { removed, unlinked };
    },
  );
}

/**
 * Promove ocorrências cuja data chegou.
 *
 * `autoPost` decide o destino: `cleared` para o que é certo (aluguel em débito
 * automático) e `pending` para o que precisa da sua conferência (conta de luz,
 * cujo valor real só se sabe quando chega).
 */
export function promoteDueOccurrences(
  options: WriteOptions & { reference?: IsoDate } = {},
): WriteResult<{ cleared: number; pending: number }> {
  const db = readDb(options);
  const reference = options.reference ?? today();

  const due = db
    .select({ transaction: transactions, autoPost: recurrences.autoPost })
    .from(transactions)
    .innerJoin(recurrences, eq(recurrences.id, transactions.recurrenceId))
    .where(and(eq(transactions.status, 'scheduled'), lte(transactions.date, reference)))
    .all();

  return withMutate(
    options,
    (result) =>
      `Promoveu ${result.cleared} lançamento(s) automático(s) e ${result.pending} para confirmação`,
    (ctx) => {
      let cleared = 0;
      let pending = 0;

      for (const row of due) {
        const status = row.autoPost ? 'cleared' : 'pending';
        ctx.update('transactions', row.transaction.id, { status });
        if (row.autoPost) cleared += 1;
        else pending += 1;
      }

      return { cleared, pending };
    },
  );
}

/**
 * Confirma uma ocorrência pendente, permitindo corrigir o valor real.
 *
 * É o fluxo da conta de luz: veio R$ 187,43 em vez dos R$ 180 estimados.
 */
export function confirmOccurrence(
  transactionId: string,
  input: { amountCents?: number; date?: IsoDate } = {},
  options: WriteOptions = {},
): WriteResult<Transaction> {
  const db = readDb(options);
  const transaction = db.select().from(transactions).where(eq(transactions.id, transactionId)).all()[0];
  if (!transaction) throw notFound('Transação', transactionId);
  if (!transaction.recurrenceId) {
    throw ruleViolation('Esta transação não vem de uma recorrência.');
  }
  if (transaction.status === 'cleared' || transaction.status === 'reconciled') {
    throw ruleViolation('Esta ocorrência já foi confirmada.');
  }

  return withMutate(
    options,
    (result) => `Confirmou "${result.description}" de ${formatMoney(Math.abs(result.amountCents))}`,
    (ctx) => {
      const patch: Record<string, unknown> = { status: 'cleared' };
      if (input.amountCents !== undefined) {
        const sign = transaction.type === 'expense' ? -1 : 1;
        patch.amountCents = sign * Math.abs(input.amountCents);
      }
      if (input.date !== undefined) patch.date = input.date;

      const updated = ctx.update<Transaction>('transactions', transactionId, patch);

      // Atualiza a estimativa da recorrência com o valor real, para a próxima
      // projeção ser mais próxima da realidade.
      if (input.amountCents !== undefined) {
        const recurrence = findRecurrence(transaction.recurrenceId!, ctx.tx);
        if (recurrence && recurrence.amountCents == null) {
          ctx.update('recurrences', recurrence.id, { estimatedCents: Math.abs(input.amountCents) });
        }
      }

      return updated;
    },
  );
}

/** Ocorrências aguardando confirmação — "o que caiu e eu preciso conferir". */
export function pendingOccurrences(db: Db = getDb()): Array<Transaction & { recurrenceName: string }> {
  return db
    .select({ transaction: transactions, name: recurrences.name })
    .from(transactions)
    .innerJoin(recurrences, eq(recurrences.id, transactions.recurrenceId))
    .where(eq(transactions.status, 'pending'))
    .orderBy(asc(transactions.date))
    .all()
    .map((row) => ({ ...row.transaction, recurrenceName: row.name }));
}

/**
 * Contas a vencer nos próximos dias, vindas de recorrências.
 */
export function upcomingBills(
  options: { withinDays?: number; db?: Db } = {},
): Array<{ transaction: Transaction; recurrenceName: string; daysUntil: number }> {
  const db = options.db ?? getDb();
  const reference = today();
  const limit = addDays(reference, options.withinDays ?? 30);

  return db
    .select({ transaction: transactions, name: recurrences.name })
    .from(transactions)
    .innerJoin(recurrences, eq(recurrences.id, transactions.recurrenceId))
    .where(
      and(
        sql`${transactions.status} in ('scheduled', 'pending')`,
        gte(transactions.date, reference),
        lte(transactions.date, limit),
      ),
    )
    .orderBy(asc(transactions.date))
    .all()
    .map((row) => ({
      transaction: row.transaction,
      recurrenceName: row.name,
      daysUntil: Math.round(
        (Date.parse(`${row.transaction.date}T00:00:00Z`) - Date.parse(`${reference}T00:00:00Z`)) / 86_400_000,
      ),
    }));
}

export { isSameOrBefore };
