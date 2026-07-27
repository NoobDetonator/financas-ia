/**
 * Metas de economia e reservas.
 *
 * Uma meta pode estar vinculada a uma conta (o dinheiro está de fato na poupança)
 * ou ser uma **caixinha virtual** — parte do saldo de uma conta reservada
 * mentalmente para um objetivo. A caixinha virtual é o caso mais comum e o que os
 * apps costumam não modelar, forçando a pessoa a criar contas fictícias.
 *
 * O progresso vem sempre da soma dos aportes, nunca de um campo acumulado: um
 * aporte corrigido retroativamente precisa refletir no progresso na hora.
 */

import { asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import { goalContributions, goals, type Goal, type GoalContribution } from '../db/schema.js';
import { notFound, ruleViolation } from '../core/errors.js';
import { formatMoney } from '../core/money.js';
import { diffDays, today, type IsoDate } from '../core/clock.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { getAccount } from './accounts.js';
import { insertTransferIn } from './transfers.js';
import { colorSchema, idSchema, isoDateSchema, positiveCentsSchema } from './schemas.js';

export const createGoalSchema = z.object({
  name: z.string().min(1).max(120),
  targetCents: positiveCentsSchema,
  targetDate: isoDateSchema.optional(),
  /** Conta onde o dinheiro fica. Omitido = caixinha virtual. */
  accountId: idSchema.optional(),
  color: colorSchema,
  icon: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
});

export type CreateGoalInput = z.input<typeof createGoalSchema>;

export const contributeSchema = z.object({
  /** Positivo = aporte, negativo = resgate. */
  amountCents: z.number().int().refine((v) => v !== 0, 'O valor do aporte não pode ser zero.'),
  date: isoDateSchema.optional(),
  note: z.string().max(500).optional(),
  /**
   * Conta de onde o dinheiro sai. Informada junto com uma meta que tem conta
   * própria, gera a transferência de verdade.
   */
  fromAccountId: idSchema.optional(),
});

export interface GoalProgress extends Goal {
  savedCents: number;
  remainingCents: number
  progressPercent: number;
  contributionCount: number;
  lastContributionDate: IsoDate | null;
  /** Quanto guardar por mês para chegar na data-alvo. `null` sem data. */
  requiredMonthlyCents: number | null;
  /** Dias restantes até a data-alvo. Negativo = atrasada. */
  daysRemaining: number | null;
  /** Projeção de conclusão no ritmo dos aportes até agora. */
  projectedCompletionDate: IsoDate | null;
  isComplete: boolean;
}

// ── Leitura ─────────────────────────────────────────────────────────────────

function savedAmount(goalId: string, db: Db): { savedCents: number; count: number; last: IsoDate | null } {
  const [row] = db
    .select({
      total: sql<number>`coalesce(sum(${goalContributions.amountCents}), 0)`,
      count: sql<number>`count(*)`,
      last: sql<string | null>`max(${goalContributions.date})`,
    })
    .from(goalContributions)
    .where(eq(goalContributions.goalId, goalId))
    .all();

  return { savedCents: row?.total ?? 0, count: row?.count ?? 0, last: row?.last ?? null };
}

export function goalProgress(goal: Goal, db: Db = getDb()): GoalProgress {
  const { savedCents, count, last } = savedAmount(goal.id, db);
  const remainingCents = Math.max(0, goal.targetCents - savedCents);
  const reference = today();

  let requiredMonthlyCents: number | null = null;
  let daysRemaining: number | null = null;

  if (goal.targetDate) {
    daysRemaining = diffDays(reference, goal.targetDate);
    const monthsLeft = Math.max(1, Math.ceil(daysRemaining / 30));
    requiredMonthlyCents = remainingCents > 0 ? Math.ceil(remainingCents / monthsLeft) : 0;
  }

  // Projeção pelo ritmo real: total guardado dividido pelo tempo desde o primeiro
  // aporte. Sem histórico suficiente, não há o que projetar.
  let projectedCompletionDate: IsoDate | null = null;
  if (savedCents > 0 && remainingCents > 0 && count >= 2) {
    const [first] = db
      .select({ date: goalContributions.date })
      .from(goalContributions)
      .where(eq(goalContributions.goalId, goal.id))
      .orderBy(asc(goalContributions.date))
      .limit(1)
      .all();

    if (first) {
      const elapsedDays = Math.max(1, diffDays(first.date, reference));
      const perDay = savedCents / elapsedDays;
      if (perDay > 0) {
        const daysNeeded = Math.ceil(remainingCents / perDay);
        // Projeções absurdamente longas não informam nada útil.
        if (daysNeeded < 365 * 20) {
          const target = new Date(Date.parse(`${reference}T00:00:00Z`) + daysNeeded * 86_400_000);
          projectedCompletionDate = target.toISOString().slice(0, 10);
        }
      }
    }
  }

  return {
    ...goal,
    savedCents,
    remainingCents,
    progressPercent: goal.targetCents > 0 ? Math.round((savedCents / goal.targetCents) * 1000) / 10 : 0,
    contributionCount: count,
    lastContributionDate: last,
    requiredMonthlyCents,
    daysRemaining,
    projectedCompletionDate,
    isComplete: savedCents >= goal.targetCents,
  };
}

export function listGoals(
  options: { status?: Goal['status']; db?: Db } = {},
): GoalProgress[] {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(goals)
    .where(options.status ? eq(goals.status, options.status) : undefined)
    .orderBy(asc(goals.targetDate), asc(goals.name))
    .all()
    .map((goal) => goalProgress(goal, db));
}

export function findGoal(id: string, db: Db = getDb()): Goal | undefined {
  return db.select().from(goals).where(eq(goals.id, id)).all()[0];
}

export function getGoal(id: string, db: Db = getDb()): GoalProgress {
  const goal = findGoal(id, db);
  if (!goal) throw notFound('Meta', id);
  return goalProgress(goal, db);
}

export function goalContributionList(goalId: string, db: Db = getDb()): GoalContribution[] {
  return db
    .select()
    .from(goalContributions)
    .where(eq(goalContributions.goalId, goalId))
    .orderBy(desc(goalContributions.date))
    .all();
}

// ── Escrita ─────────────────────────────────────────────────────────────────

export function createGoal(input: CreateGoalInput, options: WriteOptions = {}): WriteResult<GoalProgress> {
  const parsed = createGoalSchema.parse(input);
  const db = readDb(options);

  if (parsed.accountId) getAccount(parsed.accountId, db);
  if (parsed.targetDate && parsed.targetDate < today()) {
    throw ruleViolation('A data-alvo da meta está no passado.');
  }

  return withMutate(
    options,
    (result) => `Criou a meta "${result.name}" de ${formatMoney(result.targetCents)}`,
    (ctx) => {
      const goal = ctx.insert<Goal>('goals', {
        name: parsed.name,
        targetCents: parsed.targetCents,
        targetDate: parsed.targetDate ?? null,
        accountId: parsed.accountId ?? null,
        color: parsed.color ?? null,
        icon: parsed.icon ?? null,
        status: 'active',
        notes: parsed.notes ?? null,
      });
      return goalProgress(goal, ctx.tx);
    },
  );
}

/**
 * Registra um aporte.
 *
 * Com `fromAccountId` e uma meta que tem conta própria, cria também a
 * transferência real — o dinheiro sai da conta corrente e entra na poupança. Sem
 * isso, o aporte é apenas contábil (caixinha virtual).
 */
export function contribute(
  goalId: string,
  input: z.input<typeof contributeSchema>,
  options: WriteOptions = {},
): WriteResult<{ goal: GoalProgress; contribution: GoalContribution; transferId: string | null }> {
  const parsed = contributeSchema.parse(input);
  const db = readDb(options);
  const goal = findGoal(goalId, db);
  if (!goal) throw notFound('Meta', goalId);

  if (goal.status === 'archived') {
    throw ruleViolation(`A meta "${goal.name}" está arquivada.`);
  }

  const date = parsed.date ?? today();

  if (parsed.fromAccountId) {
    if (!goal.accountId) {
      throw ruleViolation(
        `A meta "${goal.name}" é uma reserva virtual e não tem conta de destino. Remova \`fromAccountId\` ou vincule uma conta à meta.`,
      );
    }
    if (parsed.fromAccountId === goal.accountId) {
      throw ruleViolation('A conta de origem do aporte é a mesma conta da meta.');
    }
    getAccount(parsed.fromAccountId, db);
  }

  // Resgate não pode deixar a meta com saldo negativo.
  if (parsed.amountCents < 0) {
    const { savedCents } = savedAmount(goalId, db);
    if (savedCents + parsed.amountCents < 0) {
      throw ruleViolation(
        `Resgate de ${formatMoney(Math.abs(parsed.amountCents))} excede o guardado (${formatMoney(savedCents)}).`,
      );
    }
  }

  return withMutate(
    options,
    (result) =>
      parsed.amountCents > 0
        ? `Aportou ${formatMoney(parsed.amountCents)} na meta "${goal.name}" (${result.goal.progressPercent}%)`
        : `Resgatou ${formatMoney(Math.abs(parsed.amountCents))} da meta "${goal.name}"`,
    (ctx) => {
      let transferId: string | null = null;
      let transactionId: string | null = null;

      if (parsed.fromAccountId && goal.accountId) {
        // Aporte move dinheiro para a conta da meta; resgate move de volta.
        const isDeposit = parsed.amountCents > 0;
        const pair = insertTransferIn(ctx, {
          fromAccountId: isDeposit ? parsed.fromAccountId : goal.accountId,
          toAccountId: isDeposit ? goal.accountId : parsed.fromAccountId,
          amountCents: Math.abs(parsed.amountCents),
          date,
          description: `${isDeposit ? 'Aporte' : 'Resgate'} — ${goal.name}`,
          inLinks: { goalId },
          outLinks: { goalId },
        });
        transferId = pair.transferId;
        transactionId = isDeposit ? pair.in.id : pair.out.id;
      }

      const contribution = ctx.insert<GoalContribution>('goal_contributions', {
        goalId,
        transactionId,
        amountCents: parsed.amountCents,
        date,
        note: parsed.note ?? null,
      });

      // Conclusão automática: a meta atingida muda de status sozinha.
      const progress = goalProgress(goal, ctx.tx);
      if (progress.isComplete && goal.status === 'active') {
        ctx.update('goals', goalId, { status: 'done' });
      } else if (!progress.isComplete && goal.status === 'done') {
        ctx.update('goals', goalId, { status: 'active' });
      }

      const updated = findGoal(goalId, ctx.tx)!;
      return { goal: goalProgress(updated, ctx.tx), contribution, transferId };
    },
  );
}

export function updateGoal(
  id: string,
  input: Partial<CreateGoalInput> & { status?: Goal['status'] },
  options: WriteOptions = {},
): WriteResult<GoalProgress> {
  const db = readDb(options);
  const current = findGoal(id, db);
  if (!current) throw notFound('Meta', id);
  if (input.accountId) getAccount(input.accountId, db);

  return withMutate(
    options,
    (result) => `Alterou a meta "${result.name}"`,
    (ctx) => {
      const updated = ctx.update<Goal>('goals', id, input);
      return goalProgress(updated, ctx.tx);
    },
  );
}

/**
 * Exclui a meta e seus aportes.
 *
 * As transferências ficam: o dinheiro realmente mudou de conta, e apagá-las
 * quebraria o saldo. Elas apenas perdem o vínculo com a meta.
 */
export function deleteGoal(
  id: string,
  options: WriteOptions = {},
): WriteResult<{ removedContributions: number }> {
  const db = readDb(options);
  const current = findGoal(id, db);
  if (!current) throw notFound('Meta', id);

  const contributions = goalContributionList(id, db);

  return withMutate(
    options,
    (result) => `Excluiu a meta "${current.name}" e ${result.removedContributions} aporte(s)`,
    (ctx) => {
      for (const contribution of contributions) {
        // A transferência sobrevive: o dinheiro mudou de conta de verdade.
        if (contribution.transactionId) {
          ctx.update('transactions', contribution.transactionId, { goalId: null });
        }
        ctx.remove('goal_contributions', contribution.id);
      }
      ctx.remove('goals', id);
      return { removedContributions: contributions.length };
    },
  );
}

/** Metas que estão atrasadas em relação ao ritmo necessário. */
export function goalsBehindSchedule(db: Db = getDb()): GoalProgress[] {
  return listGoals({ status: 'active', db }).filter((goal) => {
    if (!goal.targetDate || goal.daysRemaining === null) return false;
    if (goal.daysRemaining < 0) return goal.remainingCents > 0;
    if (!goal.projectedCompletionDate) return false;
    return goal.projectedCompletionDate > goal.targetDate;
  });
}
