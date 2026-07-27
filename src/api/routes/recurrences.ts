import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  confirmOccurrence,
  createRecurrence,
  createRecurrenceSchema,
  deactivateRecurrence,
  deleteRecurrence,
  getRecurrence,
  listRecurrences,
  materializeAll,
  pendingOccurrences,
  promoteDueOccurrences,
  recurrenceTransactions,
  updateRecurrence,
  updateRecurrenceSchema,
  upcomingBills,
} from '../../services/recurrences.js';
import { futureCommitments, netWorthHistory, projectBalance } from '../../services/projection.js';
import { idSchema, isoDateSchema, positiveCentsSchema } from '../../services/schemas.js';
import {
  errorResponseDto,
  idParamDto,
  recurrenceDto,
  transactionDto,
  writeResponse,
} from '../dto.js';

const recurrenceViewDto = recurrenceDto.extend({
  description: z.string().describe('Regra em português: "todo mês no dia 10"'),
  nextDate: z.string().nullable(),
  effectiveCents: z.number().int().describe('Valor fixo, ou a estimativa quando variável'),
});

const projectionDto = z.object({
  accountId: z.string().nullable(),
  accountName: z.string(),
  from: z.string(),
  to: z.string(),
  startingCents: z.number().int(),
  endingCents: z.number().int(),
  lowestCents: z.number().int().describe('Menor saldo do período — revela aperto de caixa'),
  lowestDate: z.string().nullable(),
  firstNegativeDate: z.string().nullable(),
  points: z.array(
    z.object({
      date: z.string(),
      balanceCents: z.number().int(),
      changeCents: z.number().int(),
      items: z.array(
        z.object({
          id: z.string(),
          description: z.string(),
          amountCents: z.number().int(),
          status: z.enum(['scheduled', 'pending', 'cleared', 'reconciled']),
        }),
      ),
    }),
  ),
});

export async function registerRecurrenceRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/recurrences',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Lista contas fixas e assinaturas',
        querystring: z.object({
          accountId: idSchema.optional(),
          onlyActive: z.coerce.boolean().default(false),
        }),
        response: { 200: z.array(recurrenceViewDto) },
      },
    },
    (request) => listRecurrences(request.query),
  );

  route.get(
    '/recurrences/:id',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Detalha uma recorrência e suas ocorrências',
        params: idParamDto,
        response: {
          200: recurrenceViewDto.extend({ occurrences: z.array(transactionDto) }),
          404: errorResponseDto,
        },
      },
    },
    (request) => ({
      ...getRecurrence(request.params.id),
      occurrences: recurrenceTransactions(request.params.id),
    }),
  );

  route.post(
    '/recurrences',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Cria uma recorrência',
        description:
          'As ocorrências futuras são criadas imediatamente como transações `scheduled`, até o ' +
          'horizonte configurado. Ocorrências passadas **não** são criadas retroativamente.\n\n' +
          'Use `amountCents` para valor fixo (aluguel) ou `estimatedCents` para variável (conta de luz). ' +
          '`autoPost: true` efetiva na data; `false` deixa pendente para você conferir o valor real.',
        body: createRecurrenceSchema,
        response: {
          200: writeResponse(
            z.object({ recurrence: recurrenceViewDto, materialized: z.number().int() }),
          ),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => createRecurrence(request.body, { requestId: request.id }),
  );

  route.patch(
    '/recurrences/:id',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Altera uma recorrência',
        description:
          'Regenera apenas as ocorrências futuras não confirmadas. O que já foi efetivado é ' +
          'preservado com o valor antigo — reescrever falsificaria o histórico.',
        params: idParamDto,
        body: updateRecurrenceSchema,
        response: {
          200: writeResponse(
            z.object({
              recurrence: recurrenceViewDto,
              regenerated: z.number().int(),
              removed: z.number().int(),
            }),
          ),
          404: errorResponseDto,
        },
      },
    },
    (request) => updateRecurrence(request.params.id, request.body, { requestId: request.id }),
  );

  route.post(
    '/recurrences/:id/deactivate',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Desativa e remove as ocorrências futuras',
        params: idParamDto,
        response: { 200: writeResponse(z.object({ removed: z.number().int() })), 404: errorResponseDto },
      },
    },
    (request) => deactivateRecurrence(request.params.id, { requestId: request.id }),
  );

  route.delete(
    '/recurrences/:id',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Exclui uma recorrência',
        description: 'Lançamentos já efetivados são mantidos, apenas perdem o vínculo.',
        params: idParamDto,
        response: {
          200: writeResponse(z.object({ removed: z.number().int(), unlinked: z.number().int() })),
          404: errorResponseDto,
        },
      },
    },
    (request) => deleteRecurrence(request.params.id, { requestId: request.id }),
  );

  route.post(
    '/recurrences/materialize',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Gera as ocorrências futuras que faltam',
        description: 'Idempotente. Roda automaticamente na partida do servidor e no job diário.',
        response: {
          200: writeResponse(z.object({ created: z.number().int(), recurrences: z.number().int() })),
        },
      },
    },
    (request) => materializeAll({ requestId: request.id }),
  );

  route.post(
    '/recurrences/promote-due',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Promove ocorrências cuja data chegou',
        description:
          '`autoPost: true` vira `cleared`; `false` vira `pending` para você confirmar o valor real.',
        response: {
          200: writeResponse(z.object({ cleared: z.number().int(), pending: z.number().int() })),
        },
      },
    },
    (request) => promoteDueOccurrences({ requestId: request.id }),
  );

  route.get(
    '/occurrences/pending',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Ocorrências aguardando sua confirmação',
        response: { 200: z.array(transactionDto.extend({ recurrenceName: z.string() })) },
      },
    },
    () => pendingOccurrences(),
  );

  route.post(
    '/occurrences/:id/confirm',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Confirma uma ocorrência, ajustando o valor real',
        description:
          'O fluxo da conta de luz: veio R$ 187,43 em vez dos R$ 180 estimados. A estimativa da ' +
          'recorrência é atualizada para a próxima projeção ficar mais próxima da realidade.',
        params: idParamDto,
        body: z.object({
          amountCents: positiveCentsSchema.optional(),
          date: isoDateSchema.optional(),
        }),
        response: { 200: writeResponse(transactionDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => confirmOccurrence(request.params.id, request.body, { requestId: request.id }),
  );

  route.get(
    '/bills/upcoming',
    {
      schema: {
        tags: ['recorrências'],
        summary: 'Contas a vencer',
        querystring: z.object({ withinDays: z.coerce.number().int().min(1).max(365).default(30) }),
        response: {
          200: z.array(
            z.object({
              transaction: transactionDto,
              recurrenceName: z.string(),
              daysUntil: z.number().int(),
            }),
          ),
        },
      },
    },
    (request) => upcomingBills(request.query),
  );

  // ── Projeção ──────────────────────────────────────────────────────────────

  route.get(
    '/projection',
    {
      schema: {
        tags: ['projeção'],
        summary: 'Projeta o saldo dia a dia',
        description:
          'Responde "posso gastar isso?". Sem `accountId`, consolida as contas de caixa — o cartão ' +
          'fica fora porque somar dívida a dinheiro disponível distorceria o número.\n\n' +
          '`firstNegativeDate` é o alerta de aperto de caixa.',
        querystring: z.object({
          accountId: idSchema.optional(),
          days: z.coerce.number().int().min(1).max(730).optional(),
          includeCards: z.coerce.boolean().default(false),
        }),
        response: { 200: projectionDto, 404: errorResponseDto },
      },
    },
    (request) => projectBalance(request.query),
  );

  route.get(
    '/commitments',
    {
      schema: {
        tags: ['projeção'],
        summary: 'Quanto da renda futura já está comprometido',
        description:
          'O número que explica "ganho bem e não sobra nada": parcelas e contas fixas consomem o ' +
          'salário antes de ele chegar. Acima de 100% significa que o previsto não cabe no que vai entrar.',
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
        response: {
          200: z.object({
            committedCents: z.number().int(),
            installmentsCents: z.number().int(),
            recurringCents: z.number().int(),
            cardInvoicesCents: z.number().int(),
            expectedIncomeCents: z.number().int(),
            committedPercent: z.number().nullable(),
          }),
        },
      },
    },
    (request) => futureCommitments(request.query),
  );

  route.get(
    '/net-worth/history',
    {
      schema: {
        tags: ['projeção'],
        summary: 'Evolução do patrimônio, mês a mês',
        description: 'Reconstrói o saldo com o que estava efetivado em cada data — o passado como ele foi.',
        querystring: z.object({ months: z.coerce.number().int().min(1).max(120).default(12) }),
        response: {
          200: z.array(
            z.object({
              date: z.string(),
              assetsCents: z.number().int(),
              liabilitiesCents: z.number().int(),
              netCents: z.number().int(),
            }),
          ),
        },
      },
    },
    (request) => netWorthHistory(request.query),
  );
}
