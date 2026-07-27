import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createAccountSchema,
  updateAccountSchema,
  createAccount,
  updateAccount,
  archiveAccount,
  unarchiveAccount,
  deleteAccount,
  getAccount,
  listAccounts,
} from '../../services/accounts.js';
import { accountBalance, allBalances, netWorth } from '../../services/balances.js';
import { accountKindSchema, isoDateSchema } from '../../services/schemas.js';
import {
  accountWithCardDto,
  errorResponseDto,
  idParamDto,
  writeResponse,
} from '../dto.js';

const balanceDto = z.object({
  accountId: z.string(),
  name: z.string(),
  kind: accountKindSchema,
  currency: z.string(),
  openingBalanceCents: z.number().int(),
  availableCents: z.number().int().describe('Saldo efetivado — bate com o extrato do banco'),
  projectedCents: z.number().int().describe('Efetivado + pendente + agendado'),
  forecastCents: z.number().int(),
  cardUsage: z
    .object({
      limitCents: z.number().int(),
      usedCents: z.number().int(),
      availableCents: z.number().int(),
      usedPercent: z.number(),
    })
    .optional(),
});

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/accounts',
    {
      schema: {
        tags: ['contas'],
        summary: 'Lista as contas',
        querystring: z.object({
          includeArchived: z.coerce.boolean().default(false),
          kind: accountKindSchema.optional(),
        }),
        response: { 200: z.array(accountWithCardDto) },
      },
    },
    (request) => listAccounts(request.query),
  );

  route.get(
    '/accounts/:id',
    {
      schema: {
        tags: ['contas'],
        summary: 'Detalha uma conta',
        params: idParamDto,
        response: { 200: accountWithCardDto, 404: errorResponseDto },
      },
    },
    (request) => getAccount(request.params.id),
  );

  route.post(
    '/accounts',
    {
      schema: {
        tags: ['contas'],
        summary: 'Cria uma conta',
        description:
          'Cartão de crédito exige o objeto `card` com dia de fechamento e de vencimento. ' +
          'O saldo de uma conta-cartão é a dívida atual (negativo).',
        body: createAccountSchema,
        response: {
          200: writeResponse(accountWithCardDto),
          409: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => createAccount(request.body, { requestId: request.id }),
  );

  route.patch(
    '/accounts/:id',
    {
      schema: {
        tags: ['contas'],
        summary: 'Altera uma conta',
        params: idParamDto,
        body: updateAccountSchema,
        response: { 200: writeResponse(accountWithCardDto), 404: errorResponseDto, 409: errorResponseDto },
      },
    },
    (request) => updateAccount(request.params.id, request.body, { requestId: request.id }),
  );

  route.post(
    '/accounts/:id/archive',
    {
      schema: {
        tags: ['contas'],
        summary: 'Arquiva uma conta',
        description: 'Preferido a excluir: o histórico permanece íntegro e a conta sai das listagens.',
        params: idParamDto,
        response: { 200: writeResponse(accountWithCardDto.omit({ card: true })), 404: errorResponseDto },
      },
    },
    (request) => archiveAccount(request.params.id, { requestId: request.id }),
  );

  route.post(
    '/accounts/:id/unarchive',
    {
      schema: {
        tags: ['contas'],
        summary: 'Reativa uma conta arquivada',
        params: idParamDto,
        response: { 200: writeResponse(accountWithCardDto.omit({ card: true })), 404: errorResponseDto },
      },
    },
    (request) => unarchiveAccount(request.params.id, { requestId: request.id }),
  );

  route.delete(
    '/accounts/:id',
    {
      schema: {
        tags: ['contas'],
        summary: 'Exclui uma conta sem movimento',
        description: 'Recusa a exclusão se a conta tiver qualquer transação. Use `/archive` nesse caso.',
        params: idParamDto,
        response: {
          200: writeResponse(z.object({ id: z.string() })),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => deleteAccount(request.params.id, { requestId: request.id }),
  );

  // ── Saldos ────────────────────────────────────────────────────────────────

  route.get(
    '/balances',
    {
      schema: {
        tags: ['contas'],
        summary: 'Saldo de todas as contas',
        querystring: z.object({
          upTo: isoDateSchema.optional().describe('Reconstrói o saldo nesta data'),
          includeArchived: z.coerce.boolean().default(false),
        }),
        response: { 200: z.array(balanceDto) },
      },
    },
    (request) => allBalances(request.query),
  );

  route.get(
    '/accounts/:id/balance',
    {
      schema: {
        tags: ['contas'],
        summary: 'Saldo de uma conta',
        params: idParamDto,
        querystring: z.object({ upTo: isoDateSchema.optional() }),
        response: { 200: balanceDto, 404: errorResponseDto },
      },
    },
    (request) => accountBalance(request.params.id, request.query),
  );

  route.get(
    '/net-worth',
    {
      schema: {
        tags: ['contas'],
        summary: 'Patrimônio líquido',
        description: 'Usa o saldo disponível, não o projetado: patrimônio é o que existe, não o previsto.',
        querystring: z.object({ upTo: isoDateSchema.optional() }),
        response: {
          200: z.object({
            date: z.string(),
            assetsCents: z.number().int(),
            liabilitiesCents: z.number().int(),
            netCents: z.number().int(),
            byAccount: z.array(balanceDto),
          }),
        },
      },
    },
    (request) => netWorth(request.query),
  );
}
