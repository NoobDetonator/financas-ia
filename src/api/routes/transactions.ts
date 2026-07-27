import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  bulkCategorize,
  bulkSetStatus,
  createTransaction,
  createTransactionSchema,
  deleteTransaction,
  getTransactionDetail,
  listTransactions,
  listTransactionsSchema,
  updateTransaction,
  updateTransactionSchema,
} from '../../services/transactions.js';
import { cashFlow } from '../../services/balances.js';
import { idSchema, isoDateSchema, transactionStatusSchema } from '../../services/schemas.js';
import {
  errorResponseDto,
  idParamDto,
  transactionDetailDto,
  transactionDto,
  writeResponse,
} from '../dto.js';

export async function registerTransactionRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/transactions',
    {
      schema: {
        tags: ['transações'],
        summary: 'Lista lançamentos com filtros',
        description:
          'Use `excludeTransfers=true` em qualquer análise de receita/despesa — transferência entre ' +
          'contas próprias não é nem uma nem outra. `sumCents` é a soma de **todas** as linhas do ' +
          'filtro, não apenas da página atual.',
        querystring: listTransactionsSchema.omit({ accountIds: true, categoryIds: true }).extend({
          rollupCategories: z.coerce.boolean().default(true),
          excludeTransfers: z.coerce.boolean().default(false),
        }),
        response: {
          200: z.object({
            items: z.array(transactionDto),
            total: z.number().int(),
            limit: z.number().int(),
            offset: z.number().int(),
            sumCents: z.number().int(),
          }),
        },
      },
    },
    (request) => listTransactions(request.query),
  );

  route.get(
    '/transactions/:id',
    {
      schema: {
        tags: ['transações'],
        summary: 'Detalha um lançamento, com rateio e tags',
        params: idParamDto,
        response: { 200: transactionDetailDto, 404: errorResponseDto },
      },
    },
    (request) => getTransactionDetail(request.params.id),
  );

  route.post(
    '/transactions',
    {
      schema: {
        tags: ['transações'],
        summary: 'Registra um lançamento',
        description:
          'Informe `amountCents` **sempre positivo**: o sinal vem do `type`. A categoria precisa ser ' +
          'do mesmo tipo do lançamento (despesa com categoria de despesa). Para rateio, envie ' +
          '`splits` sem `categoryId` — a soma do rateio precisa fechar com o valor.',
        body: createTransactionSchema,
        response: { 200: writeResponse(transactionDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => createTransaction(request.body, { requestId: request.id }),
  );

  route.patch(
    '/transactions/:id',
    {
      schema: {
        tags: ['transações'],
        summary: 'Altera um lançamento',
        description:
          'Ao alterar o valor de um lançamento rateado, envie o novo `splits` na mesma chamada — ' +
          'do contrário o rateio ficaria inconsistente e a alteração é recusada.',
        params: idParamDto,
        body: updateTransactionSchema,
        response: { 200: writeResponse(transactionDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => updateTransaction(request.params.id, request.body, { requestId: request.id }),
  );

  route.delete(
    '/transactions/:id',
    {
      schema: {
        tags: ['transações'],
        summary: 'Exclui um lançamento',
        description:
          'Se for perna de transferência, a outra perna é excluída junto — meia transferência ' +
          'deixaria o saldo de uma das contas errado permanentemente.',
        params: idParamDto,
        response: {
          200: writeResponse(z.object({ deleted: z.array(z.string()) })),
          404: errorResponseDto,
        },
      },
    },
    (request) => deleteTransaction(request.params.id, { requestId: request.id }),
  );

  route.post(
    '/transactions/bulk-categorize',
    {
      schema: {
        tags: ['transações'],
        summary: 'Recategoriza vários lançamentos',
        description:
          'Transferências e lançamentos rateados são ignorados (voltam em `skipped`), assim como ' +
          'categorias de tipo incompatível.',
        body: z.object({
          transactionIds: z.array(idSchema).min(1).max(1000),
          categoryId: idSchema,
        }),
        response: {
          200: writeResponse(
            z.object({ updated: z.number().int(), skipped: z.array(z.string()) }),
          ),
          404: errorResponseDto,
        },
      },
    },
    (request) =>
      bulkCategorize(request.body.transactionIds, request.body.categoryId, { requestId: request.id }),
  );

  route.post(
    '/transactions/bulk-status',
    {
      schema: {
        tags: ['transações'],
        summary: 'Altera o status de vários lançamentos',
        description:
          'Usado para confirmar recorrências: `scheduled` → `cleared` quando a conta efetivamente caiu.',
        body: z.object({
          transactionIds: z.array(idSchema).min(1).max(1000),
          status: transactionStatusSchema,
        }),
        response: { 200: writeResponse(z.object({ updated: z.number().int() })) },
      },
    },
    (request) => bulkSetStatus(request.body.transactionIds, request.body.status, { requestId: request.id }),
  );

  route.get(
    '/cash-flow',
    {
      schema: {
        tags: ['transações'],
        summary: 'Fluxo de caixa de um intervalo',
        description: 'Transferências ficam fora por construção.',
        querystring: z.object({
          from: isoDateSchema,
          to: isoDateSchema,
          includeForecast: z.coerce.boolean().default(false),
        }),
        response: {
          200: z.object({
            incomeCents: z.number().int(),
            expenseCents: z.number().int(),
            netCents: z.number().int(),
            savingsRatePercent: z.number().nullable(),
          }),
        },
      },
    },
    (request) =>
      cashFlow(request.query.from, request.query.to, { includeForecast: request.query.includeForecast }),
  );
}
