import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  cancelInstallmentPlan,
  createInstallmentPlan,
  createInstallmentPlanSchema,
  getInstallmentPlan,
  invoiceDetail,
  listInstallmentPlans,
  payInvoice,
  payInvoiceSchema,
  refreshInvoiceStatuses,
  upcomingInvoices,
} from '../../services/cards.js';
import { currentInvoice, listInvoices, openInvoices, projectInvoice } from '../../services/invoices.js';
import { resolveInvoiceCycle } from '../../services/invoice-cycle.js';
import { dayOfMonthSchema, idSchema, isoDateSchema, monthKeySchema } from '../../services/schemas.js';
import {
  cardInvoiceDto,
  errorResponseDto,
  idParamDto,
  installmentPlanDto,
  transactionDto,
  writeResponse,
} from '../dto.js';

const invoiceViewDto = cardInvoiceDto.extend({
  effectiveStatus: z.enum(['open', 'closed', 'paid', 'overdue']),
  remainingCents: z.number().int(),
});

const cycleDto = z.object({
  referenceMonth: z.string(),
  closingDate: z.string(),
  dueDate: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
});

const planDetailDto = installmentPlanDto.extend({
  transactions: z.array(transactionDto),
  remainingCents: z.number().int(),
  paidCount: z.number().int(),
});

export async function registerCardRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  // ── Faturas ───────────────────────────────────────────────────────────────

  route.get(
    '/invoices',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Lista faturas',
        description:
          '`status` filtra pelo status **recalculado** (`effectiveStatus`), não pelo gravado — ' +
          'uma fatura vencida nunca aparece como aberta só porque o job diário não rodou.',
        querystring: z.object({
          cardAccountId: idSchema.optional(),
          status: z.enum(['open', 'closed', 'paid', 'overdue']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(60),
        }),
        response: { 200: z.array(invoiceViewDto) },
      },
    },
    (request) => listInvoices(request.query),
  );

  route.get(
    '/invoices/open',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Faturas com saldo devedor',
        description: 'A resposta para "o que eu tenho a pagar", ordenada por vencimento.',
        response: { 200: z.array(invoiceViewDto) },
      },
    },
    () => openInvoices(),
  );

  route.get(
    '/invoices/upcoming',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Faturas a vencer, com dias restantes',
        querystring: z.object({ withinDays: z.coerce.number().int().min(1).max(365).default(45) }),
        response: {
          200: z.array(
            z.object({
              invoice: cardInvoiceDto,
              cardName: z.string(),
              daysUntilDue: z.number().int().describe('Negativo quando já venceu'),
              remainingCents: z.number().int(),
            }),
          ),
        },
      },
    },
    (request) => upcomingInvoices(request.query),
  );

  route.get(
    '/invoices/:id',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Detalha uma fatura, com compras e pagamentos',
        description:
          '`computedTotalCents` recalcula o total a partir das compras. Divergir de `totalCents` ' +
          'indica escrita fora do `mutate()`.',
        params: idParamDto,
        response: {
          200: invoiceViewDto.extend({
            purchases: z.array(transactionDto),
            payments: z.array(transactionDto),
            computedTotalCents: z.number().int(),
          }),
          404: errorResponseDto,
        },
      },
    },
    (request) => invoiceDetail(request.params.id),
  );

  route.post(
    '/invoices/:id/pay',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Paga uma fatura',
        description:
          'Registrado como **transferência** da conta corrente para a conta-cartão, não como despesa: ' +
          'o gasto já foi contabilizado quando a compra entrou na fatura. Se o pagamento também fosse ' +
          'despesa, o mês fecharia com o dobro.\n\n' +
          'Sem `amountCents`, paga o saldo devedor inteiro. Pagamento parcial é aceito.',
        params: idParamDto,
        body: payInvoiceSchema,
        response: {
          200: writeResponse(
            z.object({
              invoice: cardInvoiceDto,
              transferId: z.string(),
              paymentTransaction: transactionDto,
            }),
          ),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => payInvoice(request.params.id, request.body, { requestId: request.id }),
  );

  route.post(
    '/invoices/refresh-status',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Reavalia o status gravado de todas as faturas',
        description: 'Rede de segurança para o job diário. O status já é atualizado a cada recálculo de total.',
        response: { 200: writeResponse(z.object({ changed: z.number().int() })) },
      },
    },
    (request) => refreshInvoiceStatuses({ requestId: request.id }),
  );

  route.get(
    '/cards/:id/current-invoice',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Fatura que está recebendo compras agora',
        params: idParamDto,
        response: { 200: invoiceViewDto.nullable(), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => currentInvoice(request.params.id) ?? null,
  );

  route.get(
    '/cards/:id/invoices/:referenceMonth',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Projeta a fatura de um mês, mesmo que ainda não exista',
        params: z.object({ id: idSchema, referenceMonth: monthKeySchema }),
        response: {
          200: z.object({
            referenceMonth: z.string(),
            cycle: cycleDto,
            totalCents: z.number().int(),
            invoiceId: z.string().nullable(),
          }),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => projectInvoice(request.params.id, request.params.referenceMonth),
  );

  route.get(
    '/cards/cycle-preview',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Simula em qual fatura uma compra cairia',
        description:
          'Útil para conferir a configuração do cartão. Uma compra **no** dia do fechamento já ' +
          'entra na fatura seguinte.',
        querystring: z.object({
          purchaseDate: isoDateSchema,
          closingDay: z.coerce.number().pipe(dayOfMonthSchema),
          dueDay: z.coerce.number().pipe(dayOfMonthSchema),
        }),
        response: { 200: cycleDto, 400: errorResponseDto },
      },
    },
    (request) =>
      resolveInvoiceCycle(request.query.purchaseDate, {
        closingDay: request.query.closingDay,
        dueDay: request.query.dueDay,
      }),
  );

  // ── Parcelamentos ─────────────────────────────────────────────────────────

  route.get(
    '/installment-plans',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Lista compras parceladas',
        querystring: z.object({
          accountId: idSchema.optional(),
          onlyActive: z.coerce.boolean().default(false).describe('Só as que ainda têm parcelas a vencer'),
        }),
        response: { 200: z.array(planDetailDto) },
      },
    },
    (request) => listInstallmentPlans(request.query),
  );

  route.get(
    '/installment-plans/:id',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Detalha um parcelamento',
        params: idParamDto,
        response: { 200: planDetailDto, 404: errorResponseDto },
      },
    },
    (request) => getInstallmentPlan(request.params.id),
  );

  route.post(
    '/installment-plans',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Registra uma compra parcelada',
        description:
          'Em cartão de crédito, cada parcela cai num ciclo de fatura consecutivo. Em outras contas, ' +
          'de mês em mês a partir de `firstChargeDate` (obrigatório nesse caso).\n\n' +
          'A soma das parcelas é **exatamente** o total: R$ 100 em 3x gera 33,34 + 33,33 + 33,33. ' +
          'A primeira parcela nasce efetivada; as futuras ficam `scheduled`.',
        body: createInstallmentPlanSchema,
        response: { 200: writeResponse(planDetailDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => createInstallmentPlan(request.body, { requestId: request.id }),
  );

  route.delete(
    '/installment-plans/:id',
    {
      schema: {
        tags: ['cartão'],
        summary: 'Cancela um parcelamento',
        description:
          'Remove as parcelas ainda não efetivadas. As já pagas são preservadas — elas aconteceram, ' +
          'e apagá-las reescreveria o histórico e o saldo. Use `removeSettled=true` para remover tudo.',
        params: idParamDto,
        querystring: z.object({ removeSettled: z.coerce.boolean().default(false) }),
        response: {
          200: writeResponse(z.object({ removed: z.number().int(), kept: z.number().int() })),
          404: errorResponseDto,
        },
      },
    },
    (request) =>
      cancelInstallmentPlan(request.params.id, {
        requestId: request.id,
        removeSettled: request.query.removeSettled,
      }),
  );
}
