/**
 * Favorecidos (mercado, posto, streaming) e tags.
 *
 * Favorecido é o eixo que faz auto-categorização e detecção de assinatura
 * funcionarem: descrições de extrato variam ("UBER *TRIP 8H2K", "UBER TRIP"),
 * mas apontam para o mesmo favorecido. O `normalizedName` é a chave de casamento.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import { payees, tags, transactionTags, transactions, type Payee, type Tag } from '../db/schema.js';
import { conflict, notFound } from '../core/errors.js';
import { slugify } from '../core/ids.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { colorSchema, idSchema } from './schemas.js';

// ── Favorecidos ─────────────────────────────────────────────────────────────

export const createPayeeSchema = z.object({
  name: z.string().min(1).max(80),
  defaultCategoryId: idSchema.optional(),
  notes: z.string().max(500).optional(),
});

export type CreatePayeeInput = z.input<typeof createPayeeSchema>;

export function listPayees(db: Db = getDb()): Payee[] {
  return db.select().from(payees).orderBy(payees.name).all();
}

export function findPayee(id: string, db: Db = getDb()): Payee | undefined {
  return db.select().from(payees).where(eq(payees.id, id)).all()[0];
}

export function getPayee(id: string, db: Db = getDb()): Payee {
  const payee = findPayee(id, db);
  if (!payee) throw notFound('Favorecido', id);
  return payee;
}

export function findPayeeByName(name: string, db: Db = getDb()): Payee | undefined {
  return db.select().from(payees).where(eq(payees.normalizedName, slugify(name))).all()[0];
}

export function createPayee(input: CreatePayeeInput, options: WriteOptions = {}): WriteResult<Payee> {
  const parsed = createPayeeSchema.parse(input);
  const db = readDb(options);

  const normalizedName = slugify(parsed.name);
  if (findPayeeByName(parsed.name, db)) {
    throw conflict(`Já existe o favorecido "${parsed.name}".`, { name: parsed.name });
  }

  return withMutate(
    options,
    (result) => `Criou favorecido "${result.name}"`,
    (ctx) =>
      ctx.insert<Payee>('payees', {
        name: parsed.name,
        normalizedName,
        defaultCategoryId: parsed.defaultCategoryId ?? null,
        notes: parsed.notes ?? null,
      }),
  );
}

export function updatePayee(
  id: string,
  input: Partial<CreatePayeeInput>,
  options: WriteOptions = {},
): WriteResult<Payee> {
  const db = readDb(options);
  getPayee(id, db);

  const patch: Record<string, unknown> = { ...input };
  if (input.name) {
    const clash = findPayeeByName(input.name, db);
    if (clash && clash.id !== id) throw conflict(`Já existe o favorecido "${input.name}".`);
    patch.normalizedName = slugify(input.name);
  }

  return withMutate(
    options,
    (result) => `Alterou favorecido "${result.name}"`,
    (ctx) => ctx.update<Payee>('payees', id, patch),
  );
}

export function deletePayee(id: string, options: WriteOptions = {}): WriteResult<{ id: string }> {
  const db = readDb(options);
  const current = getPayee(id, db);

  // A FK é `set null`, então as transações sobrevivem sem o vínculo. Ainda assim
  // os desvínculos passam pelo audit log para o undo conseguir restaurá-los.
  const linked = db.select({ id: transactions.id }).from(transactions).where(eq(transactions.payeeId, id)).all();

  return withMutate(
    options,
    `Excluiu favorecido "${current.name}"`,
    (ctx) => {
      for (const row of linked) {
        ctx.update('transactions', row.id, { payeeId: null });
      }
      ctx.remove('payees', id);
      return { id };
    },
  );
}

// ── Tags ────────────────────────────────────────────────────────────────────

export const createTagSchema = z.object({
  name: z.string().min(1).max(40),
  color: colorSchema,
});

export type CreateTagInput = z.input<typeof createTagSchema>;

export function listTags(db: Db = getDb()): Tag[] {
  return db.select().from(tags).orderBy(tags.name).all();
}

export function findTag(id: string, db: Db = getDb()): Tag | undefined {
  return db.select().from(tags).where(eq(tags.id, id)).all()[0];
}

export function getTag(id: string, db: Db = getDb()): Tag {
  const tag = findTag(id, db);
  if (!tag) throw notFound('Tag', id);
  return tag;
}

export function findTagByName(name: string, db: Db = getDb()): Tag | undefined {
  return db.select().from(tags).where(eq(tags.normalizedName, slugify(name))).all()[0];
}

export function createTag(input: CreateTagInput, options: WriteOptions = {}): WriteResult<Tag> {
  const parsed = createTagSchema.parse(input);
  const db = readDb(options);

  if (findTagByName(parsed.name, db)) {
    throw conflict(`Já existe a tag "${parsed.name}".`, { name: parsed.name });
  }

  return withMutate(
    options,
    (result) => `Criou tag "${result.name}"`,
    (ctx) =>
      ctx.insert<Tag>('tags', {
        name: parsed.name,
        normalizedName: slugify(parsed.name),
        color: parsed.color ?? null,
      }),
  );
}

/** Resolve nomes de tag em IDs, criando as que faltarem. */
export function ensureTags(names: readonly string[], ctx: NonNullable<WriteOptions['ctx']>): Tag[] {
  const result: Tag[] = [];
  for (const name of names) {
    const existing = findTagByName(name, ctx.tx);
    if (existing) {
      result.push(existing);
      continue;
    }
    result.push(
      ctx.insert<Tag>('tags', {
        name,
        normalizedName: slugify(name),
        color: null,
      }),
    );
  }
  return result;
}

export function deleteTag(id: string, options: WriteOptions = {}): WriteResult<{ id: string }> {
  const db = readDb(options);
  const current = getTag(id, db);

  const links = db.select().from(transactionTags).where(eq(transactionTags.tagId, id)).all();

  return withMutate(
    options,
    `Excluiu tag "${current.name}"`,
    (ctx) => {
      for (const link of links) {
        ctx.remove('transaction_tags', `${link.transactionId}::${link.tagId}`);
      }
      ctx.remove('tags', id);
      return { id };
    },
  );
}

/** Tags de uma transação. */
export function tagsOf(transactionId: string, db: Db = getDb()): Tag[] {
  return db
    .select({ tag: tags })
    .from(transactionTags)
    .innerJoin(tags, eq(tags.id, transactionTags.tagId))
    .where(eq(transactionTags.transactionId, transactionId))
    .all()
    .map((row) => row.tag);
}
