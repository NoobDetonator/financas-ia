/**
 * Rotas de planejamento: orçamentos, metas e dívidas.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  budgetSummary,
  createBudget,
  createBudgetSchema,
  deleteBudget,
  monthBudgetStatus,
  suggestBudgets,
  updateBudget,
  updateBudgetSchema,
} from '../../services/budgets.js';
import {
  contribute,
  contributeSchema,
  createGoal,
  createGoalSchema,
  deleteGoal,
  getGoal,
  goalContributionList,
  goalsBehindSchedule,
  listGoals,
  updateGoal,
} from '../../services/goals.js';
import {
  createDebt,
  createDebtSchema,
  debtSchedule,
  deleteDebt,
  getDebt,
  listDebts,
  payInstallment,
  simulateExtra,
  simulatePayoff,
  upcomingDebtPayments,
} from '../../services/debts.js';
import { idSchema, isoDateSchema, monthKeySchema, positiveCentsSchema } from '../../services/schemas.js';
import {
  budgetDto,
  debtDto,
  debtPaymentDto,
  errorResponseDto,
  goalContributionDto,
  goalDto,
  idParamDto,
  writeResponse,
} from '../dto.js';

const budgetStatusDto = z.object({
  budgetId: z.string(),
  categoryId: z.string(),
  categoryName: z.string(),
  month: z.string(),
  limitCents: z.number().int().describe('Limite do mês, já com o rollover acumulado'),
  baseLimitCents: z.number().int(),
  rolloverCents: z.number().int().describe('Sobra herdada; negativo = estouro herdado'),
  spentCents: z.number().int(),
  remainingCents: z.number().int(),
  usedPercent: z.number(),
  projectedSpentCents: z.number().int().describe('Gasto previsto até o fim do mês, no ritmo atual'),
  willExceed: z.boolean(),
});

const goalProgressDto = goalDto.extend({
  savedCents: z.number().int(),
  remainingCents: z.number().int(),
  progressPercent: z.number(),
  contributionCount: z.number().int(),
  lastContributionDate: z.string().nullable(),
  requiredMonthlyCents: z.number().int().nullable(),
  daysRemaining: z.number().int().nullable(),
  projectedCompletionDate: z.string().nullable(),
  isComplete: z.boolean(),
});

const debtStatusDto = debtDto.extend({
  outstandingCents: z.number().int(),
  paidPrincipalCents: z.number().int(),
  paidInterestCents: z.number().int(),
  paidCount: z.number().int(),
  remainingCount: z.number().int(),
  totalInterestCents: z.number().int(),
  nextPayment: debtPaymentDto.nullable(),
  overdueCount: z.number().int(),
  progressPercent: z.number(),
});

export async function registerPlanningRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  // ── Orçamentos ────────────────────────────────────────────────────────────

  route.get(
    '/budgets',
    {
      schema: {
        tags: ['orçamentos'],
        summary: 'Situação dos orçamentos num mês',
        description:
          'O gasto nunca é armazenado — é somado das transações na hora, incluindo subcategorias e ' +
          'a parte proporcional dos rateios. Ordenado do mais estourado ao mais folgado.',
        querystring: z.object({ month: monthKeySchema.optional() }),
        response: { 200: z.array(budgetStatusDto) },
      },
    },
    (request) => monthBudgetStatus(request.query.month),
  );

  route.get(
    '/budgets/summary',
    {
      schema: {
        tags: ['orçamentos'],
        summary: 'Resumo do mês, com estourados e em risco',
        querystring: z.object({ month: monthKeySchema.optional() }),
        response: {
          200: z.object({
            month: z.string(),
            totalLimitCents: z.number().int(),
            totalSpentCents: z.number().int(),
            totalRemainingCents: z.number().int(),
            exceeded: z.array(budgetStatusDto),
            atRisk: z.array(budgetStatusDto).describe('No ritmo atual, estouram antes do fim do mês'),
            items: z.array(budgetStatusDto),
          }),
        },
      },
    },
    (request) => budgetSummary(request.query.month),
  );

  route.get(
    '/budgets/suggestions',
    {
      schema: {
        tags: ['orçamentos'],
        summary: 'Sugere limites a partir da média gasta',
        description: 'Resolve o "não sei quanto colocar": parte do que você realmente gasta.',
        querystring: z.object({ months: z.coerce.number().int().min(1).max(24).default(3) }),
        response: {
          200: z.array(
            z.object({
              categoryId: z.string(),
              categoryName: z.string(),
              averageCents: z.number().int(),
              maxCents: z.number().int(),
              months: z.number().int(),
            }),
          ),
        },
      },
    },
    (request) => suggestBudgets(request.query),
  );

  route.post(
    '/budgets',
    {
      schema: {
        tags: ['orçamentos'],
        summary: 'Define um orçamento',
        description:
          '`rollover: true` acumula a sobra (ou o estouro) para o mês seguinte, no estilo envelope.',
        body: createBudgetSchema,
        response: { 200: writeResponse(budgetDto), 409: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => createBudget(request.body, { requestId: request.id }),
  );

  route.patch(
    '/budgets/:id',
    {
      schema: {
        tags: ['orçamentos'],
        summary: 'Altera um orçamento',
        params: idParamDto,
        body: updateBudgetSchema,
        response: { 200: writeResponse(budgetDto), 404: errorResponseDto },
      },
    },
    (request) => updateBudget(request.params.id, request.body, { requestId: request.id }),
  );

  route.delete(
    '/budgets/:id',
    {
      schema: {
        tags: ['orçamentos'],
        summary: 'Exclui um orçamento',
        params: idParamDto,
        response: { 200: writeResponse(z.object({ id: z.string() })), 404: errorResponseDto },
      },
    },
    (request) => deleteBudget(request.params.id, { requestId: request.id }),
  );

  // ── Metas ─────────────────────────────────────────────────────────────────

  route.get(
    '/goals',
    {
      schema: {
        tags: ['metas'],
        summary: 'Lista as metas com progresso',
        querystring: z.object({ status: z.enum(['active', 'done', 'archived']).optional() }),
        response: { 200: z.array(goalProgressDto) },
      },
    },
    (request) => listGoals(request.query),
  );

  route.get(
    '/goals/behind',
    {
      schema: {
        tags: ['metas'],
        summary: 'Metas atrasadas em relação ao ritmo necessário',
        response: { 200: z.array(goalProgressDto) },
      },
    },
    () => goalsBehindSchedule(),
  );

  route.get(
    '/goals/:id',
    {
      schema: {
        tags: ['metas'],
        summary: 'Detalha uma meta e seus aportes',
        params: idParamDto,
        response: {
          200: goalProgressDto.extend({ contributions: z.array(goalContributionDto) }),
          404: errorResponseDto,
        },
      },
    },
    (request) => ({
      ...getGoal(request.params.id),
      contributions: goalContributionList(request.params.id),
    }),
  );

  route.post(
    '/goals',
    {
      schema: {
        tags: ['metas'],
        summary: 'Cria uma meta',
        description:
          'Com `accountId`, o dinheiro fica de fato numa conta. Sem, a meta é uma **caixinha ' +
          'virtual** — parte do saldo reservada mentalmente, sem precisar criar conta fictícia.',
        body: createGoalSchema,
        response: { 200: writeResponse(goalProgressDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => createGoal(request.body, { requestId: request.id }),
  );

  route.post(
    '/goals/:id/contribute',
    {
      schema: {
        tags: ['metas'],
        summary: 'Aporta ou resgata',
        description:
          'Valor positivo é aporte, negativo é resgate. Com `fromAccountId` numa meta que tem conta ' +
          'própria, cria a transferência real. A meta muda para `done` sozinha ao atingir o alvo.',
        params: idParamDto,
        body: contributeSchema,
        response: {
          200: writeResponse(
            z.object({
              goal: goalProgressDto,
              contribution: goalContributionDto,
              transferId: z.string().nullable(),
            }),
          ),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => contribute(request.params.id, request.body, { requestId: request.id }),
  );

  route.patch(
    '/goals/:id',
    {
      schema: {
        tags: ['metas'],
        summary: 'Altera uma meta',
        params: idParamDto,
        body: createGoalSchema.partial().extend({
          status: z.enum(['active', 'done', 'archived']).optional(),
        }),
        response: { 200: writeResponse(goalProgressDto), 404: errorResponseDto },
      },
    },
    (request) => updateGoal(request.params.id, request.body, { requestId: request.id }),
  );

  route.delete(
    '/goals/:id',
    {
      schema: {
        tags: ['metas'],
        summary: 'Exclui uma meta',
        description: 'As transferências dos aportes permanecem — o dinheiro realmente mudou de conta.',
        params: idParamDto,
        response: {
          200: writeResponse(z.object({ removedContributions: z.number().int() })),
          404: errorResponseDto,
        },
      },
    },
    (request) => deleteGoal(request.params.id, { requestId: request.id }),
  );

  // ── Dívidas ───────────────────────────────────────────────────────────────

  route.get(
    '/debts',
    {
      schema: {
        tags: ['dívidas'],
        summary: 'Lista dívidas e financiamentos',
        querystring: z.object({ includeSettled: z.coerce.boolean().default(false) }),
        response: { 200: z.array(debtStatusDto) },
      },
    },
    (request) => listDebts(request.query),
  );

  route.get(
    '/debts/upcoming',
    {
      schema: {
        tags: ['dívidas'],
        summary: 'Parcelas a vencer',
        querystring: z.object({ withinDays: z.coerce.number().int().min(1).max(365).default(30) }),
        response: {
          200: z.array(
            z.object({
              debtName: z.string(),
              payment: debtPaymentDto,
              daysUntil: z.number().int().describe('Negativo quando já venceu'),
            }),
          ),
        },
      },
    },
    (request) => upcomingDebtPayments(request.query),
  );

  route.get(
    '/debts/:id',
    {
      schema: {
        tags: ['dívidas'],
        summary: 'Detalha uma dívida com o cronograma completo',
        params: idParamDto,
        response: {
          200: debtStatusDto.extend({ schedule: z.array(debtPaymentDto) }),
          404: errorResponseDto,
        },
      },
    },
    (request) => ({
      ...getDebt(request.params.id),
      schedule: debtSchedule(request.params.id),
    }),
  );

  route.post(
    '/debts',
    {
      schema: {
        tags: ['dívidas'],
        summary: 'Registra uma dívida',
        description:
          'O cronograma inteiro é gerado na criação. `annualRateBps` é a taxa **anual** em basis ' +
          'points (1250 = 12,50% a.a.), convertida para mensal equivalente por juros compostos — ' +
          'não dividida por 12.\n\n' +
          '**SAC**: amortização constante, parcela decrescente, menos juros no total. ' +
          '**Price**: parcela fixa, mais juros no total.',
        body: createDebtSchema,
        response: { 200: writeResponse(debtStatusDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => createDebt(request.body, { requestId: request.id }),
  );

  route.post(
    '/debts/:id/pay/:installmentNo',
    {
      schema: {
        tags: ['dívidas'],
        summary: 'Registra o pagamento de uma parcela',
        description: 'Lança a despesa na conta configurada. A dívida se encerra ao pagar a última parcela.',
        params: z.object({ id: idSchema, installmentNo: z.coerce.number().int().min(1) }),
        body: z.object({
          date: isoDateSchema.optional(),
          amountCents: positiveCentsSchema.optional().describe('Informe se pagou valor diferente do previsto'),
          accountId: idSchema.optional(),
        }),
        response: {
          200: writeResponse(
            z.object({
              payment: debtPaymentDto,
              debt: debtStatusDto,
              transactionId: z.string().nullable(),
            }),
          ),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) =>
      payInstallment(request.params.id, request.params.installmentNo, request.body, {
        requestId: request.id,
      }),
  );

  route.get(
    '/debts/:id/simulate-payoff',
    {
      schema: {
        tags: ['dívidas'],
        summary: 'Vale a pena quitar agora?',
        description: 'Compara o saldo devedor com a soma das parcelas restantes. A diferença são os juros economizados.',
        params: idParamDto,
        response: {
          200: z.object({
            debtName: z.string(),
            fromInstallmentNo: z.number().int(),
            payoffCents: z.number().int(),
            interestSavedCents: z.number().int(),
            installmentsRemoved: z.number().int(),
            originalRemainingCents: z.number().int(),
          }),
          404: errorResponseDto,
        },
      },
    },
    (request) => simulatePayoff(request.params.id),
  );

  route.get(
    '/debts/:id/simulate-extra',
    {
      schema: {
        tags: ['dívidas'],
        summary: 'E se eu amortizar um valor extra?',
        description: 'Mantém a parcela e encurta o prazo — a estratégia que economiza mais juros.',
        params: idParamDto,
        querystring: z.object({ extraCents: z.coerce.number().int().min(1) }),
        response: {
          200: z.object({
            debtName: z.string(),
            extraCents: z.number().int(),
            monthsSaved: z.number().int(),
            newTermMonths: z.number().int(),
            interestSavedCents: z.number().int(),
            originalInterestCents: z.number().int(),
          }),
          404: errorResponseDto,
        },
      },
    },
    (request) => simulateExtra(request.params.id, request.query.extraCents),
  );

  route.delete(
    '/debts/:id',
    {
      schema: {
        tags: ['dívidas'],
        summary: 'Exclui uma dívida',
        description: 'Os pagamentos já lançados permanecem — o dinheiro saiu da conta de verdade.',
        params: idParamDto,
        response: {
          200: writeResponse(
            z.object({
              removedPayments: z.number().int(),
              unlinkedTransactions: z.number().int(),
            }),
          ),
          404: errorResponseDto,
        },
      },
    },
    (request) => deleteDebt(request.params.id, { requestId: request.id }),
  );
}
