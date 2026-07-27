/**
 * Categorias, em dois níveis (mãe → filha).
 *
 * Dois níveis é decisão consciente: com hierarquia arbitrária, todo relatório
 * precisa de query recursiva e a interface fica confusa. Com dois níveis, o
 * rollup "gasto de Alimentação" = a própria categoria + suas filhas, o que
 * resolve com um `IN`.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import { budgets, categories, transactionSplits, transactions, type Category } from '../db/schema.js';
import { conflict, notFound, ruleViolation } from '../core/errors.js';
import { slugify } from '../core/ids.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { categoryKindSchema, colorSchema, idSchema } from './schemas.js';

export const createCategorySchema = z.object({
  name: z.string().min(1).max(60),
  kind: categoryKindSchema,
  parentId: idSchema.optional(),
  color: colorSchema,
  icon: z.string().max(40).optional(),
});

export type CreateCategoryInput = z.input<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(60).optional(),
  parentId: idSchema.nullable().optional(),
  color: colorSchema,
  icon: z.string().max(40).optional(),
  isArchived: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export type UpdateCategoryInput = z.input<typeof updateCategorySchema>;

export interface CategoryNode extends Category {
  children: Category[];
}

// ── Leitura ─────────────────────────────────────────────────────────────────

export function listCategories(
  options: { kind?: Category['kind']; includeArchived?: boolean; db?: Db } = {},
): Category[] {
  const db = options.db ?? getDb();
  const filters = [
    options.kind ? eq(categories.kind, options.kind) : undefined,
    options.includeArchived ? undefined : eq(categories.isArchived, false),
  ].filter((f) => f !== undefined);

  return db
    .select()
    .from(categories)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(categories.sortOrder, categories.name)
    .all();
}

/** Árvore de duas camadas, na ordem de exibição. */
export function categoryTree(
  options: { kind?: Category['kind']; includeArchived?: boolean; db?: Db } = {},
): CategoryNode[] {
  const all = listCategories(options);
  const roots = all.filter((c) => c.parentId === null);
  return roots.map((root) => ({
    ...root,
    children: all.filter((c) => c.parentId === root.id),
  }));
}

export function findCategory(id: string, db: Db = getDb()): Category | undefined {
  return db.select().from(categories).where(eq(categories.id, id)).all()[0];
}

export function getCategory(id: string, db: Db = getDb()): Category {
  const category = findCategory(id, db);
  if (!category) throw notFound('Categoria', id);
  return category;
}

/** IDs da categoria e de suas filhas — base do rollup nos relatórios. */
export function categoryWithDescendants(id: string, db: Db = getDb()): string[] {
  const children = db.select({ id: categories.id }).from(categories).where(eq(categories.parentId, id)).all();
  return [id, ...children.map((c) => c.id)];
}

/**
 * Resolve categoria por ID, nome ("Mercado") ou caminho ("Alimentação > Mercado").
 * Usado pela IA e pela importação.
 */
export function resolveCategory(reference: string, db: Db = getDb()): Category {
  const direct = findCategory(reference, db);
  if (direct) return direct;

  const all = listCategories({ includeArchived: true, db });

  // Caminho completo "Mãe > Filha".
  if (reference.includes('>')) {
    const parts = reference.split('>').map((p) => slugify(p.trim()));
    const [parentSlug, childSlug] = parts;
    const parent = all.find((c) => c.parentId === null && slugify(c.name) === parentSlug);
    if (parent) {
      const child = all.find((c) => c.parentId === parent.id && slugify(c.name) === childSlug);
      if (child) return child;
    }
  }

  const needle = slugify(reference);
  const exact = all.filter((c) => slugify(c.name) === needle);
  if (exact.length === 1) return exact[0]!;
  // Empate entre mãe e filha com o mesmo nome (ex. "Salário"): prefere a filha,
  // que é a mais específica e a que a pessoa costuma querer usar.
  if (exact.length > 1) {
    const leaf = exact.find((c) => c.parentId !== null);
    if (leaf) return leaf;
    return exact[0]!;
  }

  const partial = all.filter((c) => slugify(c.name).includes(needle));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw conflict(`"${reference}" é ambíguo — pode ser: ${partial.map((c) => c.name).join(', ')}.`, {
      candidates: partial.map((c) => ({ id: c.id, name: c.name })),
    });
  }

  throw notFound('Categoria', reference);
}

// ── Escrita ─────────────────────────────────────────────────────────────────

function assertNameAvailable(db: Db, name: string, kind: Category['kind'], parentId: string | null, exceptId?: string): void {
  const siblings = db
    .select()
    .from(categories)
    .where(
      and(
        eq(categories.kind, kind),
        parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId),
      ),
    )
    .all();

  const clash = siblings.find((c) => c.id !== exceptId && slugify(c.name) === slugify(name));
  if (clash) {
    throw conflict(`Já existe a categoria "${clash.name}" neste mesmo nível.`, { name });
  }
}

export function createCategory(
  input: CreateCategoryInput,
  options: WriteOptions = {},
): WriteResult<Category> {
  const parsed = createCategorySchema.parse(input);
  const db = readDb(options);

  if (parsed.parentId) {
    const parent = getCategory(parsed.parentId, db);
    if (parent.parentId !== null) {
      throw ruleViolation(
        `"${parent.name}" já é uma subcategoria. A hierarquia tem no máximo dois níveis.`,
      );
    }
    if (parent.kind !== parsed.kind) {
      throw ruleViolation(
        `Não é possível criar categoria de ${parsed.kind === 'expense' ? 'despesa' : 'receita'} dentro de "${parent.name}".`,
      );
    }
  }

  assertNameAvailable(db, parsed.name, parsed.kind, parsed.parentId ?? null);

  return withMutate(
    options,
    (result) => `Criou categoria "${result.name}"`,
    (ctx) =>
      ctx.insert<Category>('categories', {
        name: parsed.name,
        kind: parsed.kind,
        parentId: parsed.parentId ?? null,
        color: parsed.color ?? null,
        icon: parsed.icon ?? null,
      }),
  );
}

export function updateCategory(
  id: string,
  input: UpdateCategoryInput,
  options: WriteOptions = {},
): WriteResult<Category> {
  const parsed = updateCategorySchema.parse(input);
  const db = readDb(options);
  const current = getCategory(id, db);

  const nextParentId = parsed.parentId === undefined ? current.parentId : parsed.parentId;

  if (nextParentId === id) {
    throw ruleViolation('Uma categoria não pode ser mãe de si mesma.');
  }
  if (nextParentId) {
    const parent = getCategory(nextParentId, db);
    if (parent.parentId !== null) {
      throw ruleViolation(`"${parent.name}" já é uma subcategoria; não pode receber filhas.`);
    }
    if (parent.kind !== current.kind) {
      throw ruleViolation('Categoria de despesa e de receita não podem se misturar.');
    }
    // Mover uma mãe que tem filhas para dentro de outra criaria três níveis.
    const hasChildren = db.select().from(categories).where(eq(categories.parentId, id)).all().length > 0;
    if (hasChildren) {
      throw ruleViolation(
        `"${current.name}" tem subcategorias e não pode virar subcategoria (limite de dois níveis).`,
      );
    }
  }

  if (parsed.name || parsed.parentId !== undefined) {
    assertNameAvailable(db, parsed.name ?? current.name, current.kind, nextParentId, id);
  }

  return withMutate(
    options,
    (result) => `Alterou categoria "${result.name}"`,
    (ctx) => ctx.update<Category>('categories', id, parsed),
  );
}

/**
 * Exclui uma categoria. Recusa se estiver em uso ou tiver filhas — apagar
 * deixaria transações sem categoria e distorceria todo relatório histórico.
 */
export function deleteCategory(id: string, options: WriteOptions = {}): WriteResult<{ id: string }> {
  const db = readDb(options);
  const current = getCategory(id, db);

  if (current.isSystem) {
    throw ruleViolation(
      `"${current.name}" é uma categoria do sistema. Você pode renomeá-la ou arquivá-la, mas não excluir.`,
    );
  }

  const children = db.select().from(categories).where(eq(categories.parentId, id)).all();
  if (children.length > 0) {
    throw ruleViolation(
      `"${current.name}" tem ${children.length} subcategoria(s). Exclua ou mova as filhas primeiro.`,
    );
  }

  const usage = countCategoryUsage(id, db);
  if (usage > 0) {
    throw ruleViolation(
      `"${current.name}" está em uso por ${usage} lançamento(s). Recategorize-os antes de excluir.`,
      { categoryId: id, usage },
    );
  }

  const budgetCount = db.select().from(budgets).where(eq(budgets.categoryId, id)).all().length;

  return withMutate(
    options,
    `Excluiu categoria "${current.name}"`,
    (ctx) => {
      // Orçamentos são filhos diretos: removidos explicitamente para auditar.
      if (budgetCount > 0) {
        for (const budget of ctx.tx.select().from(budgets).where(eq(budgets.categoryId, id)).all()) {
          ctx.remove('budgets', budget.id);
        }
      }
      ctx.remove('categories', id);
      return { id };
    },
  );
}

/** Quantos lançamentos usam a categoria, contando rateios. */
export function countCategoryUsage(id: string, db: Db = getDb()): number {
  const [direct] = db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.categoryId, id))
    .all();

  const [inSplits] = db
    .select({ count: sql<number>`count(*)` })
    .from(transactionSplits)
    .where(eq(transactionSplits.categoryId, id))
    .all();

  return (direct?.count ?? 0) + (inSplits?.count ?? 0);
}

/** Move todos os lançamentos de uma categoria para outra. */
export function recategorize(
  fromId: string,
  toId: string,
  options: WriteOptions = {},
): WriteResult<{ moved: number }> {
  const db = readDb(options);
  const from = getCategory(fromId, db);
  const to = getCategory(toId, db);

  if (fromId === toId) throw ruleViolation('Origem e destino são a mesma categoria.');
  if (from.kind !== to.kind) {
    throw ruleViolation('Não é possível mover lançamentos entre categorias de despesa e de receita.');
  }

  const affected = db.select({ id: transactions.id }).from(transactions).where(eq(transactions.categoryId, fromId)).all();
  const affectedSplits = db
    .select({ id: transactionSplits.id })
    .from(transactionSplits)
    .where(eq(transactionSplits.categoryId, fromId))
    .all();

  return withMutate(
    options,
    (result) => `Moveu ${result.moved} lançamento(s) de "${from.name}" para "${to.name}"`,
    (ctx) => {
      for (const row of affected) {
        ctx.update('transactions', row.id, { categoryId: toId });
      }
      for (const row of affectedSplits) {
        ctx.update('transaction_splits', row.id, { categoryId: toId });
      }
      return { moved: affected.length + affectedSplits.length };
    },
  );
}

export { inArray };
