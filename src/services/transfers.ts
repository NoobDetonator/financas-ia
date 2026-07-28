/**
 * Transferências entre contas.
 *
 * Modeladas como **duas transações ligadas** por um `transferId`: uma saída na
 * conta de origem e uma entrada na de destino. Alternativa descartada: uma linha
 * só com `fromAccount`/`toAccount`.
 *
 * Por que duas linhas: o saldo de qualquer conta passa a ser uma soma simples de
 * suas transações, sem precisar checar "sou origem ou destino desta linha?" em
 * cada consulta. E como as duas pernas têm `type='transfer'`, todo relatório de
 * receita/despesa as exclui com um único filtro — que é o que impede o erro
 * clássico de inflar a renda com dinheiro que só trocou de bolso.
 *
 * Invariante: as duas pernas sempre existem e somam zero. Ver os testes.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import { transactions, type Transaction } from '../db/schema.js';
import { notFound, ruleViolation } from '../core/errors.js';
import { formatMoney } from '../core/money.js';
import { newId } from '../core/ids.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import type { MutateContext } from '../mutate/index.js';
import { getAccount } from './accounts.js';
import { ensureTags } from './payees.js';
import { getTransaction, transferLegs } from './transactions.js';
import { idSchema, isoDateSchema, positiveCentsSchema, transactionStatusSchema } from './schemas.js';

export const createTransferSchema = z.object({
  fromAccountId: idSchema,
  toAccountId: idSchema,
  /** Sempre positivo: sai da origem, entra no destino. */
  amountCents: positiveCentsSchema,
  date: isoDateSchema,
  description: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
  status: transactionStatusSchema.default('cleared'),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

export type CreateTransferInput = z.input<typeof createTransferSchema>;

export interface TransferPair {
  transferId: string;
  /** Perna negativa, na conta de origem. */
  out: Transaction;
  /** Perna positiva, na conta de destino. */
  in: Transaction;
}

export const updateTransferSchema = z.object({
  amountCents: positiveCentsSchema.optional(),
  date: isoDateSchema.optional(),
  description: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: transactionStatusSchema.optional(),
});

export type UpdateTransferInput = z.input<typeof updateTransferSchema>;

// ── Leitura ─────────────────────────────────────────────────────────────────

export function getTransfer(transferId: string, db: Db = getDb()): TransferPair {
  const legs = transferLegs(transferId, db);
  if (legs.length === 0) throw notFound('Transferência', transferId);
  if (legs.length !== 2) {
    // Só acontece se algo escreveu fora do `mutate()`. Falhar alto é melhor que
    // devolver um saldo silenciosamente errado.
    throw ruleViolation(
      `Transferência ${transferId} está inconsistente: ${legs.length} perna(s) em vez de 2.`,
      { transferId, legs: legs.length },
    );
  }

  const outLeg = legs.find((l) => l.amountCents < 0);
  const inLeg = legs.find((l) => l.amountCents > 0);
  if (!outLeg || !inLeg) {
    throw ruleViolation(`Transferência ${transferId} não tem uma saída e uma entrada.`, { transferId });
  }

  return { transferId, out: outLeg, in: inLeg };
}

// ── Escrita ─────────────────────────────────────────────────────────────────

type TransferLinks = Partial<Pick<Transaction, 'cardInvoiceId' | 'goalId' | 'debtId' | 'createdBy'>>;

export function insertTransferIn(
  ctx: MutateContext,
  input: CreateTransferInput & {
    /** Vínculos aplicados às duas pernas. */
    links?: TransferLinks;
    /** Vínculos só da perna de saída (conta de origem). */
    outLinks?: TransferLinks;
    /**
     * Vínculos só da perna de entrada (conta de destino).
     *
     * As pernas são assimétricas: no pagamento de fatura, só o lado do cartão
     * pertence à fatura. Vincular os dois faria o pagamento aparecer duas vezes
     * na fatura.
     */
    inLinks?: TransferLinks;
  },
): TransferPair {
  const parsed = createTransferSchema.parse(input);
  const db = ctx.tx;

  if (parsed.fromAccountId === parsed.toAccountId) {
    throw ruleViolation('Origem e destino da transferência são a mesma conta.');
  }

  const from = getAccount(parsed.fromAccountId, db);
  const to = getAccount(parsed.toAccountId, db);

  if (from.currency !== to.currency) {
    throw ruleViolation(
      `Transferência entre moedas diferentes (${from.currency} → ${to.currency}) ainda não é suportada.`,
    );
  }

  const transferId = newId();
  const description = parsed.description ?? `Transferência: ${from.name} → ${to.name}`;
  const shared = {
    type: 'transfer' as const,
    date: parsed.date,
    description,
    notes: parsed.notes ?? null,
    status: parsed.status,
    transferId,
    // Transferência nunca tem categoria: não é receita nem despesa.
    categoryId: null,
    currency: from.currency,
    ...(input.links ?? {}),
  };

  const outLeg = ctx.insert<Transaction>('transactions', {
    ...shared,
    accountId: parsed.fromAccountId,
    amountCents: -parsed.amountCents,
    ...(input.outLinks ?? {}),
  });

  const inLeg = ctx.insert<Transaction>('transactions', {
    ...shared,
    accountId: parsed.toAccountId,
    amountCents: parsed.amountCents,
    ...(input.inLinks ?? {}),
  });

  if (parsed.tags?.length) {
    for (const tag of ensureTags(parsed.tags, ctx)) {
      ctx.insert('transaction_tags', { transactionId: outLeg.id, tagId: tag.id });
      ctx.insert('transaction_tags', { transactionId: inLeg.id, tagId: tag.id });
    }
  }

  return { transferId, out: outLeg, in: inLeg };
}

export function createTransfer(
  input: CreateTransferInput,
  options: WriteOptions = {},
): WriteResult<TransferPair> {
  return withMutate(
    options,
    (result) =>
      `Transferiu ${formatMoney(Math.abs(result.out.amountCents))}: ${result.out.description}`,
    (ctx) => insertTransferIn(ctx, input),
  );
}

/**
 * Altera a transferência mantendo as duas pernas coerentes.
 *
 * Editar apenas uma perna direto pela API de transações é bloqueado para valor
 * e data — a inconsistência resultante quebraria o saldo de uma das contas.
 */
export function updateTransfer(
  transferId: string,
  input: UpdateTransferInput,
  options: WriteOptions = {},
): WriteResult<TransferPair> {
  const parsed = updateTransferSchema.parse(input);
  const db = readDb(options);
  const pair = getTransfer(transferId, db);

  return withMutate(
    options,
    `Alterou transferência "${pair.out.description}"`,
    (ctx) => {
      const shared: Record<string, unknown> = {};
      if (parsed.date !== undefined) shared.date = parsed.date;
      if (parsed.description !== undefined) shared.description = parsed.description;
      if (parsed.notes !== undefined) shared.notes = parsed.notes;
      if (parsed.status !== undefined) shared.status = parsed.status;

      const outPatch = { ...shared };
      const inPatch = { ...shared };

      if (parsed.amountCents !== undefined) {
        outPatch.amountCents = -parsed.amountCents;
        inPatch.amountCents = parsed.amountCents;
      }

      const out = ctx.update<Transaction>('transactions', pair.out.id, outPatch);
      const inLeg = ctx.update<Transaction>('transactions', pair.in.id, inPatch);

      return { transferId, out, in: inLeg };
    },
  );
}

/** Troca as contas de origem e/ou destino, preservando o par. */
export function moveTransfer(
  transferId: string,
  input: { fromAccountId?: string; toAccountId?: string },
  options: WriteOptions = {},
): WriteResult<TransferPair> {
  const db = readDb(options);
  const pair = getTransfer(transferId, db);

  const nextFrom = input.fromAccountId ?? pair.out.accountId;
  const nextTo = input.toAccountId ?? pair.in.accountId;

  if (nextFrom === nextTo) {
    throw ruleViolation('Origem e destino da transferência são a mesma conta.');
  }
  getAccount(nextFrom, db);
  getAccount(nextTo, db);

  return withMutate(
    options,
    `Alterou as contas da transferência "${pair.out.description}"`,
    (ctx) => ({
      transferId,
      out: ctx.update<Transaction>('transactions', pair.out.id, { accountId: nextFrom }),
      in: ctx.update<Transaction>('transactions', pair.in.id, { accountId: nextTo }),
    }),
  );
}

/**
 * Converte uma transação comum em perna de transferência, casando com outra.
 *
 * Cenário real: você importou o extrato de duas contas e a mesma movimentação
 * apareceu como saída numa e entrada na outra. Sem casar as duas, o mês fecha
 * com uma despesa e uma receita fantasmas.
 */
export function linkAsTransfer(
  outTransactionId: string,
  inTransactionId: string,
  options: WriteOptions = {},
): WriteResult<TransferPair> {
  const db = readDb(options);
  const first = getTransaction(outTransactionId, db);
  const second = getTransaction(inTransactionId, db);

  if (first.transferId || second.transferId) {
    throw ruleViolation('Uma das transações já faz parte de uma transferência.');
  }
  if (first.accountId === second.accountId) {
    throw ruleViolation('As duas transações estão na mesma conta.');
  }
  if (first.amountCents >= 0 || second.amountCents <= 0) {
    throw ruleViolation('Informe primeiro a saída (valor negativo) e depois a entrada (valor positivo).');
  }
  if (Math.abs(first.amountCents) !== Math.abs(second.amountCents)) {
    throw ruleViolation(
      `Os valores não coincidem: ${formatMoney(Math.abs(first.amountCents))} e ${formatMoney(Math.abs(second.amountCents))}.`,
    );
  }
  if (first.hasSplits || second.hasSplits) {
    throw ruleViolation('Transação rateada não pode virar transferência.');
  }

  const transferId = newId();

  return withMutate(
    options,
    `Casou duas transações como transferência de ${formatMoney(Math.abs(first.amountCents))}`,
    (ctx) => {
      // Remove o rateio de categoria: transferência não é receita nem despesa.
      const patch = { transferId, type: 'transfer' as const, categoryId: null };
      const out = ctx.update<Transaction>('transactions', first.id, patch);
      const inLeg = ctx.update<Transaction>('transactions', second.id, patch);
      return { transferId, out, in: inLeg };
    },
  );
}

/** Desfaz o vínculo, devolvendo as pernas a despesa e receita comuns. */
export function unlinkTransfer(
  transferId: string,
  options: WriteOptions = {},
): WriteResult<{ transactions: Transaction[] }> {
  const db = readDb(options);
  const pair = getTransfer(transferId, db);

  return withMutate(
    options,
    `Desfez o vínculo da transferência "${pair.out.description}"`,
    (ctx) => ({
      transactions: [
        ctx.update<Transaction>('transactions', pair.out.id, { transferId: null, type: 'expense' }),
        ctx.update<Transaction>('transactions', pair.in.id, { transferId: null, type: 'income' }),
      ],
    }),
  );
}

/** Todas as transferências num intervalo, agrupadas em pares. */
export function listTransfers(
  options: { dateFrom?: string; dateTo?: string; accountId?: string; db?: Db } = {},
): TransferPair[] {
  const db = options.db ?? getDb();

  const legs = db.select().from(transactions).where(eq(transactions.type, 'transfer')).all();

  const byTransfer = new Map<string, Transaction[]>();
  for (const leg of legs) {
    if (!leg.transferId) continue;
    if (options.dateFrom && leg.date < options.dateFrom) continue;
    if (options.dateTo && leg.date > options.dateTo) continue;
    const bucket = byTransfer.get(leg.transferId) ?? [];
    bucket.push(leg);
    byTransfer.set(leg.transferId, bucket);
  }

  const pairs: TransferPair[] = [];
  for (const [transferId, group] of byTransfer) {
    const outLeg = group.find((l) => l.amountCents < 0);
    const inLeg = group.find((l) => l.amountCents > 0);
    if (!outLeg || !inLeg) continue;
    if (options.accountId && outLeg.accountId !== options.accountId && inLeg.accountId !== options.accountId) {
      continue;
    }
    pairs.push({ transferId, out: outLeg, in: inLeg });
  }

  return pairs.sort((a, b) => (a.out.date < b.out.date ? 1 : -1));
}
