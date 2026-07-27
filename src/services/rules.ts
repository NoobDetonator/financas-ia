/**
 * Motor de auto-categorização.
 *
 * Aplicado na importação e sob demanda. Elimina a maior parte da digitação: o
 * extrato traz "UBER *TRIP 8H2K" e a regra transforma em Transporte / Uber sem
 * intervenção.
 *
 * As regras são avaliadas por prioridade crescente; `stopOnMatch` (padrão) para na
 * primeira que casar, o que torna o resultado previsível — sem isso, duas regras
 * concorrentes deixariam a categorização dependente da ordem de inserção no banco.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import {
  rules,
  transactions,
  type Rule,
  type RuleActions,
  type RuleConditions,
  type Transaction,
} from '../db/schema.js';
import { notFound, validation } from '../core/errors.js';
import { nowIso } from '../core/clock.js';
import { slugify } from '../core/ids.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import type { MutateContext } from '../mutate/index.js';
import { getCategory } from './categories.js';
import { findPayee } from './payees.js';
import { centsSchema, idSchema } from './schemas.js';

export const ruleConditionsSchema = z
  .object({
    descriptionContains: z.string().min(1).max(120).optional(),
    descriptionRegex: z.string().min(1).max(200).optional(),
    payeeId: idSchema.optional(),
    accountId: idSchema.optional(),
    type: z.enum(['expense', 'income', 'transfer']).optional(),
    minAmountCents: centsSchema.optional(),
    maxAmountCents: centsSchema.optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'Informe ao menos uma condição.');

export const ruleActionsSchema = z
  .object({
    categoryId: idSchema.optional(),
    payeeId: idSchema.optional(),
    addTagIds: z.array(idSchema).max(10).optional(),
    setDescription: z.string().min(1).max(200).optional(),
    setNotes: z.string().max(500).optional(),
  })
  .refine((a) => Object.keys(a).length > 0, 'Informe ao menos uma ação.');

export const createRuleSchema = z.object({
  name: z.string().min(1).max(120),
  priority: z.number().int().min(0).max(10_000).default(100),
  isEnabled: z.boolean().default(true),
  stopOnMatch: z.boolean().default(true),
  conditions: ruleConditionsSchema,
  actions: ruleActionsSchema,
});

export type CreateRuleInput = z.input<typeof createRuleSchema>;

/** Campos que uma regra consegue avaliar — funciona tanto com transação gravada quanto com linha de importação. */
export interface RuleCandidate {
  description: string;
  amountCents: number;
  accountId: string;
  type?: 'expense' | 'income' | 'transfer';
  payeeId?: string | null;
}

// ── Avaliação ───────────────────────────────────────────────────────────────

/**
 * A regra casa com o candidato?
 *
 * Regex inválida não derruba a importação: a regra apenas não casa. Uma regra mal
 * escrita não pode impedir o resto do extrato de entrar.
 */
export function ruleMatches(rule: Rule, candidate: RuleCandidate): boolean {
  const conditions = rule.conditions;
  const description = candidate.description.toLowerCase();

  if (conditions.descriptionContains) {
    // Comparação sem acento e sem caixa: "Café" casa com "CAFE".
    if (!slugify(description).includes(slugify(conditions.descriptionContains))) return false;
  }

  if (conditions.descriptionRegex) {
    try {
      if (!new RegExp(conditions.descriptionRegex, 'i').test(candidate.description)) return false;
    } catch {
      return false;
    }
  }

  if (conditions.accountId && conditions.accountId !== candidate.accountId) return false;
  if (conditions.type && candidate.type && conditions.type !== candidate.type) return false;
  if (conditions.payeeId && conditions.payeeId !== candidate.payeeId) return false;

  // Faixa de valor em módulo: a pessoa pensa em "acima de R$ 100", não em "-10000".
  const magnitude = Math.abs(candidate.amountCents);
  if (conditions.minAmountCents !== undefined && magnitude < Math.abs(conditions.minAmountCents)) {
    return false;
  }
  if (conditions.maxAmountCents !== undefined && magnitude > Math.abs(conditions.maxAmountCents)) {
    return false;
  }

  return true;
}

export interface RuleMatch {
  rule: Rule;
  actions: RuleActions;
}

/** Regras que casam, na ordem de prioridade, respeitando `stopOnMatch`. */
export function matchRules(candidate: RuleCandidate, db: Db = getDb()): RuleMatch[] {
  const enabled = db
    .select()
    .from(rules)
    .where(eq(rules.isEnabled, true))
    .orderBy(asc(rules.priority), asc(rules.id))
    .all();

  const matches: RuleMatch[] = [];
  for (const rule of enabled) {
    if (!ruleMatches(rule, candidate)) continue;
    matches.push({ rule, actions: rule.actions });
    if (rule.stopOnMatch) break;
  }
  return matches;
}

/** Ações consolidadas para um candidato. Regras de menor prioridade não sobrescrevem. */
export function resolveActions(candidate: RuleCandidate, db: Db = getDb()): RuleActions & { ruleIds: string[] } {
  const resolved: RuleActions & { ruleIds: string[] } = { ruleIds: [] };

  for (const match of matchRules(candidate, db)) {
    resolved.ruleIds.push(match.rule.id);
    // Primeira regra que definir um campo ganha.
    resolved.categoryId ??= match.actions.categoryId;
    resolved.payeeId ??= match.actions.payeeId;
    resolved.setDescription ??= match.actions.setDescription;
    resolved.setNotes ??= match.actions.setNotes;
    if (match.actions.addTagIds?.length) {
      resolved.addTagIds = [...new Set([...(resolved.addTagIds ?? []), ...match.actions.addTagIds])];
    }
  }

  return resolved;
}

/** Registra o uso da regra — permite ver quais valem a pena e quais nunca casam. */
export function recordRuleHitsIn(ctx: MutateContext, ruleIds: readonly string[]): void {
  const counts = new Map<string, number>();
  for (const id of ruleIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  for (const [id, hits] of counts) {
    const rule = ctx.tx.select().from(rules).where(eq(rules.id, id)).all()[0];
    if (!rule) continue;
    ctx.update('rules', id, { matchCount: rule.matchCount + hits, lastMatchedAt: nowIso() });
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function listRules(db: Db = getDb()): Rule[] {
  return db.select().from(rules).orderBy(asc(rules.priority), asc(rules.name)).all();
}

export function findRule(id: string, db: Db = getDb()): Rule | undefined {
  return db.select().from(rules).where(eq(rules.id, id)).all()[0];
}

export function getRule(id: string, db: Db = getDb()): Rule {
  const rule = findRule(id, db);
  if (!rule) throw notFound('Regra', id);
  return rule;
}

export function createRule(input: CreateRuleInput, options: WriteOptions = {}): WriteResult<Rule> {
  const parsed = createRuleSchema.parse(input);
  const db = readDb(options);

  if (parsed.actions.categoryId) getCategory(parsed.actions.categoryId, db);
  if (parsed.actions.payeeId && !findPayee(parsed.actions.payeeId, db)) {
    throw notFound('Favorecido', parsed.actions.payeeId);
  }
  if (parsed.conditions.descriptionRegex) {
    try {
      new RegExp(parsed.conditions.descriptionRegex, 'i');
    } catch (error) {
      throw validation(
        `Expressão regular inválida: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return withMutate(
    options,
    (result) => `Criou a regra "${result.name}"`,
    (ctx) =>
      ctx.insert<Rule>('rules', {
        name: parsed.name,
        priority: parsed.priority,
        isEnabled: parsed.isEnabled,
        stopOnMatch: parsed.stopOnMatch,
        conditions: parsed.conditions as RuleConditions,
        actions: parsed.actions as RuleActions,
        matchCount: 0,
      }),
  );
}

export function updateRule(
  id: string,
  input: Partial<CreateRuleInput>,
  options: WriteOptions = {},
): WriteResult<Rule> {
  const db = readDb(options);
  getRule(id, db);

  return withMutate(
    options,
    (result) => `Alterou a regra "${result.name}"`,
    (ctx) => ctx.update<Rule>('rules', id, input),
  );
}

export function deleteRule(id: string, options: WriteOptions = {}): WriteResult<{ id: string }> {
  const db = readDb(options);
  const rule = getRule(id, db);

  return withMutate(
    options,
    `Excluiu a regra "${rule.name}"`,
    (ctx) => {
      ctx.remove('rules', id);
      return { id };
    },
  );
}

// ── Aplicação em massa ──────────────────────────────────────────────────────

export interface ApplyRulesPreview {
  transactionId: string;
  description: string;
  currentCategoryId: string | null;
  newCategoryId: string | null;
  ruleNames: string[];
}

/**
 * Simula a aplicação das regras sobre transações sem categoria.
 *
 * Devolve o diff antes de escrever — é o preview que a IA mostra quando a
 * operação é classificada como risco `confirm`.
 */
export function previewApplyRules(
  options: { onlyUncategorized?: boolean; limit?: number; db?: Db } = {},
): ApplyRulesPreview[] {
  const db = options.db ?? getDb();
  const onlyUncategorized = options.onlyUncategorized ?? true;

  const candidates = db
    .select()
    .from(transactions)
    .where(
      and(
        sql`${transactions.type} != 'transfer'`,
        eq(transactions.hasSplits, false),
        onlyUncategorized ? sql`${transactions.categoryId} is null` : undefined,
      ),
    )
    .orderBy(desc(transactions.date))
    .limit(options.limit ?? 500)
    .all();

  const ruleList = listRules(db);
  const byId = new Map(ruleList.map((r) => [r.id, r]));
  const preview: ApplyRulesPreview[] = [];

  for (const transaction of candidates) {
    const resolved = resolveActions(toCandidate(transaction), db);
    if (resolved.ruleIds.length === 0) continue;
    if (!resolved.categoryId && !resolved.payeeId) continue;

    preview.push({
      transactionId: transaction.id,
      description: transaction.description,
      currentCategoryId: transaction.categoryId,
      newCategoryId: resolved.categoryId ?? transaction.categoryId,
      ruleNames: resolved.ruleIds.map((id) => byId.get(id)?.name ?? id),
    });
  }

  return preview;
}

function toCandidate(transaction: Transaction): RuleCandidate {
  return {
    description: transaction.description,
    amountCents: transaction.amountCents,
    accountId: transaction.accountId,
    type: transaction.type,
    payeeId: transaction.payeeId,
  };
}

/** Aplica as regras, gravando. Reversível como qualquer change set. */
export function applyRules(
  options: WriteOptions & { onlyUncategorized?: boolean; limit?: number } = {},
): WriteResult<{ updated: number }> {
  const db = readDb(options);
  const preview = previewApplyRules({
    ...(options.onlyUncategorized !== undefined ? { onlyUncategorized: options.onlyUncategorized } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    db,
  });

  return withMutate(
    options,
    (result) => `Aplicou as regras em ${result.updated} lançamento(s)`,
    (ctx) => {
      let updated = 0;
      const hits: string[] = [];

      for (const item of preview) {
        const transaction = ctx.tx.select().from(transactions).where(eq(transactions.id, item.transactionId)).all()[0];
        if (!transaction) continue;

        const resolved = resolveActions(toCandidate(transaction), ctx.tx);
        const patch: Record<string, unknown> = {};

        if (resolved.categoryId) {
          // A categoria precisa ser do mesmo tipo do lançamento.
          const category = getCategory(resolved.categoryId, ctx.tx);
          if (category.kind === transaction.type) patch.categoryId = resolved.categoryId;
        }
        if (resolved.payeeId && !transaction.payeeId) patch.payeeId = resolved.payeeId;
        if (resolved.setNotes && !transaction.notes) patch.notes = resolved.setNotes;

        if (Object.keys(patch).length === 0) continue;

        ctx.update('transactions', item.transactionId, patch);
        hits.push(...resolved.ruleIds);
        updated += 1;
      }

      recordRuleHitsIn(ctx, hits);
      return { updated };
    },
  );
}

export interface RuleSuggestion {
  descriptionPattern: string;
  categoryId: string;
  categoryName: string;
  occurrences: number;
  /** Percentual das ocorrências que usam esta categoria. */
  confidencePercent: number;
  sampleDescriptions: string[];
}

/**
 * Sugere regras a partir do histórico.
 *
 * Procura padrões de descrição que você categorizou consistentemente na mesma
 * categoria. É como o sistema aprende sem precisar de modelo treinado: a
 * evidência já está nos seus lançamentos.
 */
export function suggestRules(
  options: { minOccurrences?: number; minConfidence?: number; db?: Db } = {},
): RuleSuggestion[] {
  const db = options.db ?? getDb();
  const minOccurrences = options.minOccurrences ?? 3;
  const minConfidence = options.minConfidence ?? 80;

  const categorized = db
    .select()
    .from(transactions)
    .where(
      and(
        sql`${transactions.categoryId} is not null`,
        sql`${transactions.type} != 'transfer'`,
        eq(transactions.hasSplits, false),
      ),
    )
    .orderBy(desc(transactions.date))
    .limit(3000)
    .all();

  // Agrupa pelo primeiro token significativo da descrição: "UBER *TRIP 8H2K" e
  // "UBER TRIP" caem no mesmo grupo "uber".
  const groups = new Map<string, Map<string, number>>();
  const samples = new Map<string, Set<string>>();

  for (const transaction of categorized) {
    const token = firstToken(transaction.description);
    if (!token || token.length < 3) continue;

    const byCategory = groups.get(token) ?? new Map<string, number>();
    const key = transaction.categoryId!;
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
    groups.set(token, byCategory);

    const sample = samples.get(token) ?? new Set<string>();
    if (sample.size < 3) sample.add(transaction.description);
    samples.set(token, sample);
  }

  const existing = new Set(
    listRules(db)
      .map((rule) => rule.conditions.descriptionContains)
      .filter((value): value is string => Boolean(value))
      .map((value) => slugify(value)),
  );

  const suggestions: RuleSuggestion[] = [];

  for (const [token, byCategory] of groups) {
    if (existing.has(token)) continue;

    const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
    if (total < minOccurrences) continue;

    const [topCategoryId, topCount] = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const confidencePercent = Math.round((topCount / total) * 1000) / 10;
    if (confidencePercent < minConfidence) continue;

    const category = getCategory(topCategoryId, db);
    suggestions.push({
      descriptionPattern: token,
      categoryId: topCategoryId,
      categoryName: category.name,
      occurrences: total,
      confidencePercent,
      sampleDescriptions: [...(samples.get(token) ?? [])],
    });
  }

  return suggestions.sort((a, b) => b.occurrences - a.occurrences);
}

/** Primeiro token relevante da descrição, normalizado. */
function firstToken(description: string): string {
  const cleaned = slugify(description).replace(/^(compra|pagamento|debito|credito|pix|ted|doc)-/, '');
  return cleaned.split('-')[0] ?? '';
}
