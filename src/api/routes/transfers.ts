import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createTransfer,
  createTransferSchema,
  getTransfer,
  linkAsTransfer,
  listTransfers,
  moveTransfer,
  unlinkTransfer,
  updateTransfer,
  updateTransferSchema,
} from '../../services/transfers.js';
import { idSchema, isoDateSchema } from '../../services/schemas.js';
import { errorResponseDto, transactionDto, writeResponse } from '../dto.js';

const transferPairDto = z.object({
  transferId: z.string(),
  out: transactionDto.describe('Perna negativa, na conta de origem'),
  in: transactionDto.describe('Perna positiva, na conta de destino'),
});

export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/transfers',
    {
      schema: {
        tags: ['transferências'],
        summary: 'Lista as transferências',
        querystring: z.object({
          dateFrom: isoDateSchema.optional(),
          dateTo: isoDateSchema.optional(),
          accountId: idSchema.optional(),
        }),
        response: { 200: z.array(transferPairDto) },
      },
    },
    (request) => listTransfers(request.query),
  );

  route.get(
    '/transfers/:transferId',
    {
      schema: {
        tags: ['transferências'],
        summary: 'Detalha uma transferência',
        params: z.object({ transferId: idSchema }),
        response: { 200: transferPairDto, 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => getTransfer(request.params.transferId),
  );

  route.post(
    '/transfers',
    {
      schema: {
        tags: ['transferências'],
        summary: 'Transfere entre contas próprias',
        description:
          'Cria duas transações ligadas: saída na origem e entrada no destino. Como ambas têm ' +
          '`type=transfer`, nunca aparecem como receita ou despesa nos relatórios. ' +
          'Informe `amountCents` positivo. Pagar fatura de cartão é uma transferência da conta ' +
          'corrente para a conta-cartão.',
        body: createTransferSchema,
        response: { 200: writeResponse(transferPairDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => createTransfer(request.body, { requestId: request.id }),
  );

  route.patch(
    '/transfers/:transferId',
    {
      schema: {
        tags: ['transferências'],
        summary: 'Altera uma transferência',
        description: 'As duas pernas são atualizadas juntas, mantendo a soma zero.',
        params: z.object({ transferId: idSchema }),
        body: updateTransferSchema,
        response: { 200: writeResponse(transferPairDto), 404: errorResponseDto },
      },
    },
    (request) => updateTransfer(request.params.transferId, request.body, { requestId: request.id }),
  );

  route.post(
    '/transfers/:transferId/move',
    {
      schema: {
        tags: ['transferências'],
        summary: 'Troca as contas de origem e destino',
        params: z.object({ transferId: idSchema }),
        body: z.object({
          fromAccountId: idSchema.optional(),
          toAccountId: idSchema.optional(),
        }),
        response: { 200: writeResponse(transferPairDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => moveTransfer(request.params.transferId, request.body, { requestId: request.id }),
  );

  route.post(
    '/transfers/link',
    {
      schema: {
        tags: ['transferências'],
        summary: 'Casa duas transações existentes como transferência',
        description:
          'Cenário: você importou o extrato de duas contas e a mesma movimentação apareceu como saída ' +
          'numa e entrada na outra. Sem casar as duas, o mês fecha com uma despesa e uma receita ' +
          'fantasmas. Informe primeiro a saída (valor negativo).',
        body: z.object({
          outTransactionId: idSchema.describe('Transação de valor negativo'),
          inTransactionId: idSchema.describe('Transação de valor positivo, em outra conta'),
        }),
        response: { 200: writeResponse(transferPairDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) =>
      linkAsTransfer(request.body.outTransactionId, request.body.inTransactionId, { requestId: request.id }),
  );

  route.post(
    '/transfers/:transferId/unlink',
    {
      schema: {
        tags: ['transferências'],
        summary: 'Desfaz o vínculo, voltando a despesa e receita comuns',
        params: z.object({ transferId: idSchema }),
        response: {
          200: writeResponse(z.object({ transactions: z.array(transactionDto) })),
          404: errorResponseDto,
        },
      },
    },
    (request) => unlinkTransfer(request.params.transferId, { requestId: request.id }),
  );
}
