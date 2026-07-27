/**
 * Transações — o centro do domínio.
 *
 * Três decisões que evitam relatórios errados mais tarde:
 *
 * 1. **O sinal é derivado do tipo, não confiado à entrada.** Você informa o
 *    valor sempre positivo e o tipo (`expense`/`income`); o serviço aplica o
 *    sinal. Sem isso, um `-45` num lançamento de receita viraria um gasto
 *    disfarçado, e o erro só apareceria no fechamento do mês.
 *
 * 2. **Categoria tem que combinar com o tipo.** Despesa não recebe categoria de
 *    receita. Uma única troca dessas contamina o cálculo de taxa de poupança.
 *
 * 3. **Transferência não tem categoria e nunca é receita nem despesa.** Ver
 *    `transfers.ts`.
 */

import { and, asc, desc, eq, gte, inArray, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import {
  attachments,
  categories,
  transactionSplits,
  transactionTags,
  transactions,
  type Tag,
  type Transaction,
  type TransactionSplit,
} from '../db/schema.js';
import { notFound, ruleViolation } from '../core/errors.js';
import { sumCents, formatMoney } from '../core/money.js';
import { formatDateBr } from '../core/clock.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import type { MutateContext } from '../mutate/index.js';
import { getAccount } from './accounts.js';
import { getCategory } from './categories.js';
import { ensureTags, tagsOf } from './payees.js';
import { recalculateInvoiceTotalIn, resolveInvoiceForPurchaseIn } from './invoices.js';
import {
  centsSchema,
  idSchema,
  isoDateSchema,
  paginationSchema,
  positiveCentsSchema,
  transactionStatusSchema,
} from './schemas.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

const splitInputSchema = z.object({
  categoryId: idSchema,
  amountCents: positiveCentsSchema,
  note: z.string().max(200).optional(),
});

export const createTransactionSchema = z.object({
  accountId: idSchema,
  /** `transfer` não é aceito aqui — use `createTransfer`. */
  type: z.enum(['expense', 'income']),
  date: isoDateSchema,
  postedDate: isoDateSchema.optional(),
  /** Sempre positivo. O sinal vem do `type`. */
  amountCents: positiveCentsSchema,
  description: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
  categoryId: idSchema.optional(),
  payeeId: idSchema.optional(),
  status: transactionStatusSchema.default('cleared'),
  /** Rateio entre categorias. A soma tem que fechar com `amountCents`. */
  splits: z.array(splitInputSchema).min(2).optional(),
  /** Nomes de tag; as que não existirem são criadas. */
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

export type CreateTransactionInput = z.input<typeof createTransactionSchema>;

export const updateTransactionSchema = z.object({
  date: isoDateSchema.optional(),
  postedDate: isoDateSchema.nullable().optional(),
  amountCents: positiveCentsSchema.optional(),
  description: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).nullable().optional(),
  categoryId: idSchema.nullable().optional(),
  payeeId: idSchema.nullable().optional(),
  status: transactionStatusSchema.optional(),
  accountId: idSchema.optional(),
  splits: z.array(splitInputSchema).min(2).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

export type UpdateTransactionInput = z.input<typeof updateTransactionSchema>;

export const listTransactionsSchema = paginationSchema.extend({
  accountId: idSchema.optional(),
  accountIds: z.array(idSchema).optional(),
  categoryId: idSchema.optional(),
  categoryIds: z.array(idSchema).optional(),
  /** Inclui as subcategorias das categorias informadas. */
  rollupCategories: z.boolean().default(true),
  type: z.enum(['expense', 'income', 'transfer']).optional(),
  status: transactionStatusSchema.optional(),
  /** Exclui transferências — o padrão em relatórios de receita/despesa. */
  excludeTransfers: z.boolean().default(false),
  dateFrom: isoDateSchema.optional(),
  dateTo: isoDateSchema.optional(),
  payeeId: idSchema.optional(),
  tagId: idSchema.optional(),
  /** Busca em descrição e observações. */
  search: z.string().max(100).optional(),
  minAmountCents: centsSchema.optional(),
  maxAmountCents: centsSchema.optional(),
  cardInvoiceId: idSchema.optional(),
  installmentPlanId: idSchema.optional(),
  recurrenceId: idSchema.optional(),
  createdBy: z.enum(['user', 'ai', 'system']).optional(),
  sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).default('date_desc'),
});

export type ListTransactionsInput = z.input<typeof listTransactionsSchema>;

export interface TransactionDetail extends Transaction {
  splits: TransactionSplit[];
  tags: Tag[];
  attachmentCount: number;
}

export interface TransactionPage {
  items: Transaction[];
  total: number;
  limit: number;
  offset: number;
  /** Soma dos valores de **todas** as linhas do filtro, não só da página. */
  sumCents: number;
}

// ── Leitura ─────────────────────────────────────────────────────────────────

function buildFilters(input: z.infer<typeof listTransactionsSchema>, db: Db): SQL[] {
  const filters: SQL[] = [];

  const accountIds = input.accountIds ?? (input.accountId ? [input.accountId] : undefined);
  if (accountIds?.length) filters.push(inArray(transactions.accountId, accountIds));

  let categoryIds = input.categoryIds ?? (input.categoryId ? [input.categoryId] : undefined);
  if (categoryIds?.length && input.rollupCategories) {
    const children = db
      .select({ id: categories.id })
      .from(categories)
      .where(inArray(categories.parentId, categoryIds))
      .all();
    categoryIds = [...categoryIds, ...children.map((c) => c.id)];
  }
  if (categoryIds?.length) filters.push(inArray(transactions.categoryId, categoryIds));

  if (input.type) filters.push(eq(transactions.type, input.type));
  if (input.excludeTransfers) filters.push(sql`${transactions.type} != 'transfer'`);
  if (input.status) filters.push(eq(transactions.status, input.status));
  if (input.dateFrom) filters.push(gte(transactions.date, input.dateFrom));
  if (input.dateTo) filters.push(lte(transactions.date, input.dateTo));
  if (input.payeeId) filters.push(eq(transactions.payeeId, input.payeeId));
  if (input.cardInvoiceId) filters.push(eq(transactions.cardInvoiceId, input.cardInvoiceId));
  if (input.installmentPlanId) filters.push(eq(transactions.installmentPlanId, input.installmentPlanId));
  if (input.recurrenceId) filters.push(eq(transactions.recurrenceId, input.recurrenceId));
  if (input.createdBy) filters.push(eq(transactions.createdBy, input.createdBy));
  if (input.minAmountCents !== undefined) filters.push(gte(transactions.amountCents, input.minAmountCents));
  if (input.maxAmountCents !== undefined) filters.push(lte(transactions.amountCents, input.maxAmountCents));

  if (input.search) {
    const needle = `%${input.search.toLowerCase()}%`;
    const clause = or(
      like(sql`lower(${transactions.description})`, needle),
      like(sql`lower(coalesce(${transactions.notes}, ''))`, needle),
    );
    if (clause) filters.push(clause);
  }

  if (input.tagId) {
    filters.push(
      sql`${transactions.id} in (select transaction_id from transaction_tags where tag_id = ${input.tagId})`,
    );
  }

  return filters;
}

export function listTransactions(input: ListTransactionsInput = {}, db: Db = getDb()): TransactionPage {
  const parsed = listTransactionsSchema.parse(input);
  const filters = buildFilters(parsed, db);
  const where = filters.length > 0 ? and(...filters) : undefined;

  const orderBy = {
    date_desc: [desc(transactions.date), desc(transactions.id)],
    date_asc: [asc(transactions.date), asc(transactions.id)],
    amount_desc: [desc(transactions.amountCents)],
    amount_asc: [asc(transactions.amountCents)],
  }[parsed.sort];

  const items = db
    .select()
    .from(transactions)
    .where(where)
    .orderBy(...orderBy)
    .limit(parsed.limit)
    .offset(parsed.offset)
    .all();

  const [aggregate] = db
    .select({
      total: sql<number>`count(*)`,
      sum: sql<number>`coalesce(sum(${transactions.amountCents}), 0)`,
    })
    .from(transactions)
    .where(where)
    .all();

  return {
    items,
    total: aggregate?.total ?? 0,
    sumCents: aggregate?.sum ?? 0,
    limit: parsed.limit,
    offset: parsed.offset,
  };
}

export function findTransaction(id: string, db: Db = getDb()): Transaction | undefined {
  return db.select().from(transactions).where(eq(transactions.id, id)).all()[0];
}

export function getTransaction(id: string, db: Db = getDb()): Transaction {
  const tx = findTransaction(id, db);
  if (!tx) throw notFound('Transação', id);
  return tx;
}

export function getTransactionDetail(id: string, db: Db = getDb()): TransactionDetail {
  const tx = getTransaction(id, db);
  const splits = db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all();
  const [count] = db
    .select({ n: sql<number>`count(*)` })
    .from(attachments)
    .where(eq(attachments.transactionId, id))
    .all();

  return { ...tx, splits, tags: tagsOf(id, db), attachmentCount: count?.n ?? 0 };
}

/** Duas pernas de uma transferência, ou a transação sozinha. */
export function transferLegs(transferId: string, db: Db = getDb()): Transaction[] {
  return db.select().from(transactions).where(eq(transactions.transferId, transferId)).orderBy(asc(transactions.amountCents)).all();
}

// ── Validação de domínio ────────────────────────────────────────────────────

/** Converte valor positivo + tipo no valor com sinal gravado no banco. */
export function signedAmount(type: 'expense' | 'income', positiveCents: number): number {
  return type === 'expense' ? -Math.abs(positiveCents) : Math.abs(positiveCents);
}

function assertCategoryMatchesType(categoryId: string, type: 'expense' | 'income', db: Db): void {
  const category = getCategory(categoryId, db);
  if (category.kind !== type) {
    const expected = type === 'expense' ? 'despesa' : 'receita';
    const actual = category.kind === 'expense' ? 'despesa' : 'receita';
    throw ruleViolation(
      `A categoria "${category.name}" é de ${actual} e não pode ser usada num lançamento de ${expected}.`,
      { categoryId, categoryKind: category.kind, transactionType: type },
    );
  }
}

function assertSplitsBalance(splits: readonly { amountCents: number }[], totalCents: number): void {
  const total = sumCents(splits.map((s) => s.amountCents));
  const expected = Math.abs(totalCents);
  if (total !== expected) {
    throw ruleViolation(
      `A soma do rateio (${formatMoney(total)}) tem que ser igual ao valor da transação (${formatMoney(expected)}).`,
      { splitTotalCents: total, transactionCents: expected, differenceCents: total - expected },
    );
  }
}

// ── Escrita ─────────────────────────────────────────────────────────────────

/** Cria a transação participando de um change set em andamento. */
export function insertTransactionIn(
  ctx: MutateContext,
  input: CreateTransactionInput & {
    /** Vínculos internos, preenchidos por parcelamento, recorrência e importação. */
    links?: Partial<
      Pick<
        Transaction,
        | 'installmentPlanId'
        | 'installmentNo'
        | 'recurrenceId'
        | 'recurrenceOccurrence'
        | 'cardInvoiceId'
        | 'goalId'
        | 'debtId'
        | 'importRowId'
        | 'dedupeHash'
        | 'externalId'
        | 'createdBy'
      >
    >;
  },
): Transaction {
  const parsed = createTransactionSchema.parse(input);
  const db = ctx.tx;

  getAccount(parsed.accountId, db);

  if (parsed.splits && parsed.categoryId) {
    throw ruleViolation(
      'Uma transação rateada não tem categoria própria — as categorias ficam nas linhas do rateio.',
    );
  }
  if (parsed.categoryId) {
    assertCategoryMatchesType(parsed.categoryId, parsed.type, db);
  }
  if (parsed.splits) {
    assertSplitsBalance(parsed.splits, parsed.amountCents);
    for (const split of parsed.splits) {
      assertCategoryMatchesType(split.categoryId, parsed.type, db);
    }
  }

  // Compra em cartão de crédito nasce já vinculada à fatura do ciclo correto.
  // Resolver antes do insert evita um update posterior e deixa o audit log com
  // uma única entrada por transação.
  const links = input.links ?? {};
  const cardInvoiceId =
    links.cardInvoiceId ??
    resolveInvoiceForPurchaseIn(ctx, parsed.accountId, parsed.date)?.id ??
    null;

  const transaction = ctx.insert<Transaction>('transactions', {
    accountId: parsed.accountId,
    type: parsed.type,
    date: parsed.date,
    postedDate: parsed.postedDate ?? null,
    amountCents: signedAmount(parsed.type, parsed.amountCents),
    description: parsed.description,
    notes: parsed.notes ?? null,
    categoryId: parsed.categoryId ?? null,
    payeeId: parsed.payeeId ?? null,
    status: parsed.status,
    hasSplits: Boolean(parsed.splits),
    // Quem criou a linha vem do autor do change set. Sem isto, um lançamento feito
    // pela IA ficaria registrado como se você tivesse digitado — e o filtro
    // "o que a IA lançou?" mentiria.
    createdBy: ctx.actor,
    ...links,
    cardInvoiceId,
  });

  if (parsed.splits) {
    const sign = parsed.type === 'expense' ? -1 : 1;
    for (const split of parsed.splits) {
      ctx.insert('transaction_splits', {
        transactionId: transaction.id,
        categoryId: split.categoryId,
        amountCents: sign * split.amountCents,
        note: split.note ?? null,
      });
    }
  }

  if (parsed.tags?.length) {
    for (const tag of ensureTags(parsed.tags, ctx)) {
      ctx.insert('transaction_tags', { transactionId: transaction.id, tagId: tag.id });
    }
  }

  // O total da fatura é derivado das transações: recalcula ao invés de somar
  // incrementalmente, para não acumular divergência ao longo do tempo.
  if (cardInvoiceId) {
    recalculateInvoiceTotalIn(ctx, cardInvoiceId);
  }

  return transaction;
}

export function createTransaction(
  input: CreateTransactionInput,
  options: WriteOptions = {},
): WriteResult<Transaction> {
  return withMutate(
    options,
    (result) =>
      `${result.type === 'expense' ? 'Registrou gasto' : 'Registrou receita'} "${result.description}" de ${formatMoney(Math.abs(result.amountCents))} em ${formatDateBr(result.date)}`,
    (ctx) => insertTransactionIn(ctx, input),
  );
}

export function updateTransaction(
  id: string,
  input: UpdateTransactionInput,
  options: WriteOptions = {},
): WriteResult<Transaction> {
  const parsed = updateTransactionSchema.parse(input);
  const db = readDb(options);
  const current = getTransaction(id, db);

  if (current.type === 'transfer' && (parsed.categoryId || parsed.splits)) {
    throw ruleViolation('Transferência não recebe categoria nem rateio.');
  }
  if (parsed.accountId) getAccount(parsed.accountId, db);

  const effectiveType = current.type === 'transfer' ? 'transfer' : current.type;

  if (parsed.categoryId && effectiveType !== 'transfer') {
    assertCategoryMatchesType(parsed.categoryId, effectiveType, db);
  }

  return withMutate(
    options,
    (result) => `Alterou "${result.description}"`,
    (ctx) => {
      const { splits, tags: tagNames, amountCents, ...rest } = parsed;

      const patch: Record<string, unknown> = { ...rest };

      // Reaplica o sinal ao trocar o valor, respeitando o tipo original.
      if (amountCents !== undefined) {
        patch.amountCents =
          effectiveType === 'transfer'
            ? Math.sign(current.amountCents) * Math.abs(amountCents)
            : signedAmount(effectiveType, amountCents);
      }

      const nextTotal = (patch.amountCents as number | undefined) ?? current.amountCents;

      if (splits !== undefined) {
        // Rateio é substituído por inteiro: remover linha por linha mantém o
        // audit log completo e o undo capaz de reconstruir o estado anterior.
        for (const existing of ctx.tx.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all()) {
          ctx.remove('transaction_splits', existing.id);
        }

        if (splits === null) {
          patch.hasSplits = false;
        } else {
          assertSplitsBalance(splits, nextTotal);
          const sign = nextTotal < 0 ? -1 : 1;
          for (const split of splits) {
            assertCategoryMatchesType(split.categoryId, effectiveType === 'transfer' ? 'expense' : effectiveType, ctx.tx);
            ctx.insert('transaction_splits', {
              transactionId: id,
              categoryId: split.categoryId,
              amountCents: sign * split.amountCents,
              note: split.note ?? null,
            });
          }
          patch.hasSplits = true;
          patch.categoryId = null;
        }
      } else if (amountCents !== undefined && current.hasSplits) {
        // Mudar o valor sem redefinir o rateio deixaria a soma inconsistente.
        throw ruleViolation(
          'Esta transação é rateada. Ao alterar o valor, envie o novo rateio junto.',
          { transactionId: id },
        );
      }

      if (tagNames !== undefined) {
        for (const link of ctx.tx.select().from(transactionTags).where(eq(transactionTags.transactionId, id)).all()) {
          ctx.remove('transaction_tags', `${link.transactionId}::${link.tagId}`);
        }
        for (const tag of ensureTags(tagNames, ctx)) {
          ctx.insert('transaction_tags', { transactionId: id, tagId: tag.id });
        }
      }

      // Mudar data ou conta de uma compra no cartão pode movê-la para outra
      // fatura. Reatribuir aqui evita que o valor fique somado no ciclo errado.
      const movedDate = patch.date !== undefined && patch.date !== current.date;
      const movedAccount = patch.accountId !== undefined && patch.accountId !== current.accountId;

      if ((movedDate || movedAccount) && current.type !== 'transfer') {
        const targetAccountId = (patch.accountId as string | undefined) ?? current.accountId;
        const targetDate = (patch.date as string | undefined) ?? current.date;
        patch.cardInvoiceId = resolveInvoiceForPurchaseIn(ctx, targetAccountId, targetDate)?.id ?? null;
      }

      const updated =
        Object.keys(patch).length > 0
          ? ctx.update<Transaction>('transactions', id, patch)
          : getTransaction(id, ctx.tx);

      // Recalcula a fatura antiga e a nova: uma perde o valor, a outra ganha.
      const affectedInvoices = new Set(
        [current.cardInvoiceId, updated.cardInvoiceId].filter((value): value is string => value !== null),
      );
      for (const invoiceId of affectedInvoices) {
        recalculateInvoiceTotalIn(ctx, invoiceId);
      }

      return updated;
    },
  );
}

/** Remove os filhos de uma transação, auditando cada um. */
export function removeTransactionIn(ctx: MutateContext, id: string): Transaction {
  const db = ctx.tx;

  for (const split of db.select().from(transactionSplits).where(eq(transactionSplits.transactionId, id)).all()) {
    ctx.remove('transaction_splits', split.id);
  }
  for (const link of db.select().from(transactionTags).where(eq(transactionTags.transactionId, id)).all()) {
    ctx.remove('transaction_tags', `${link.transactionId}::${link.tagId}`);
  }
  for (const file of db.select().from(attachments).where(eq(attachments.transactionId, id)).all()) {
    ctx.remove('attachments', file.id);
  }

  const removed = ctx.remove<Transaction>('transactions', id);

  // A fatura precisa encolher junto — do contrário ficaria cobrando uma compra
  // que não existe mais.
  if (removed.cardInvoiceId) {
    recalculateInvoiceTotalIn(ctx, removed.cardInvoiceId);
  }

  return removed;
}

/**
 * Exclui a transação. Se for perna de transferência, exclui a outra também —
 * meia transferência deixaria o saldo de uma das contas errado para sempre.
 */
export function deleteTransaction(
  id: string,
  options: WriteOptions = {},
): WriteResult<{ deleted: string[] }> {
  const db = readDb(options);
  const current = getTransaction(id, db);

  const ids = current.transferId
    ? transferLegs(current.transferId, db).map((leg) => leg.id)
    : [id];

  return withMutate(
    options,
    (result) =>
      result.deleted.length > 1
        ? `Excluiu transferência "${current.description}"`
        : `Excluiu "${current.description}" de ${formatMoney(Math.abs(current.amountCents))}`,
    (ctx) => {
      for (const target of ids) removeTransactionIn(ctx, target);
      return { deleted: ids };
    },
  );
}

/**
 * Recategoriza várias transações de uma vez.
 *
 * É a operação que a IA usa em "coloca todos os lançamentos do Uber em
 * Transporte" — e, por afetar muitas linhas, é classificada como risco
 * `confirm` pela camada de IA.
 */
export function bulkCategorize(
  transactionIds: readonly string[],
  categoryId: string,
  options: WriteOptions = {},
): WriteResult<{ updated: number; skipped: string[] }> {
  const db = readDb(options);
  const category = getCategory(categoryId, db);

  return withMutate(
    options,
    (result) => `Recategorizou ${result.updated} lançamento(s) para "${category.name}"`,
    (ctx) => {
      const skipped: string[] = [];
      let updated = 0;

      for (const id of transactionIds) {
        const tx = findTransaction(id, ctx.tx);
        if (!tx) {
          skipped.push(id);
          continue;
        }
        // Transferência e transação rateada não têm categoria própria.
        if (tx.type === 'transfer' || tx.hasSplits || tx.type !== category.kind) {
          skipped.push(id);
          continue;
        }
        ctx.update('transactions', id, { categoryId });
        updated += 1;
      }

      return { updated, skipped };
    },
  );
}

/** Muda o status de várias transações — usado ao confirmar recorrências. */
export function bulkSetStatus(
  transactionIds: readonly string[],
  status: Transaction['status'],
  options: WriteOptions = {},
): WriteResult<{ updated: number }> {
  return withMutate(
    options,
    (result) => `Alterou o status de ${result.updated} lançamento(s) para "${status}"`,
    (ctx) => {
      let updated = 0;
      for (const id of transactionIds) {
        if (!findTransaction(id, ctx.tx)) continue;
        ctx.update('transactions', id, { status });
        updated += 1;
      }
      return { updated };
    },
  );
}
