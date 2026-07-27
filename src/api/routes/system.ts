import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getDb } from '../../db/client.js';
import { settings, type Settings } from '../../db/schema.js';
import { checkIntegrity } from '../../services/balances.js';
import { env, hasAiKey, authConfig } from '../../config/env.js';
import { today, nowIso } from '../../core/clock.js';
import { notFound } from '../../core/errors.js';
import { mutate } from '../../mutate/index.js';
import { errorResponseDto, settingsDto, writeResponse } from '../dto.js';

const updateSettingsSchema = z.object({
  aiModel: z.string().min(1).optional(),
  aiConfirmAmountCents: z.number().int().min(0).optional(),
  aiConfirmBulkRows: z.number().int().min(1).optional(),
  projectionHorizonDays: z.number().int().min(7).max(730).optional(),
  materializeHorizonDays: z.number().int().min(7).max(730).optional(),
  locale: z.string().min(2).max(10).optional(),
  timezone: z.string().min(3).max(60).optional(),
});

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/health',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Verifica se o servidor e o banco respondem',
        response: {
          200: z.object({
            ok: z.literal(true),
            now: z.string(),
            today: z.string(),
            environment: z.string(),
            aiConfigured: z.boolean(),
            authEnabled: z.boolean(),
          }),
        },
      },
    },
    () => {
      // Toca o banco de verdade: um health check que não consulta nada mente.
      getDb().select().from(settings).all();
      return {
        ok: true as const,
        now: nowIso(),
        today: today(),
        environment: env.NODE_ENV,
        aiConfigured: hasAiKey(),
        authEnabled: authConfig().enabled,
      };
    },
  );

  route.get(
    '/settings',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Lê a configuração',
        response: { 200: settingsDto, 404: errorResponseDto },
      },
    },
    () => {
      const row = getDb().select().from(settings).where(eq(settings.id, 'singleton')).all()[0];
      if (!row) throw notFound('Configuração');
      return row;
    },
  );

  route.patch(
    '/settings',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Altera a configuração',
        description:
          '`aiConfirmAmountCents` e `aiConfirmBulkRows` definem quando a IA precisa pedir sua ' +
          'confirmação antes de escrever.',
        body: updateSettingsSchema,
        response: { 200: writeResponse(settingsDto) },
      },
    },
    (request) => {
      const outcome = mutate(
        { source: 'api', summary: 'Alterou a configuração', requestId: request.id },
        (ctx) => ctx.update<Settings>('settings', 'singleton', request.body),
      );
      return { data: outcome.result, changeSetId: outcome.changeSetId, touched: outcome.touched };
    },
  );

  route.get(
    '/integrity',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Verifica as invariantes contábeis',
        description:
          'Confere que o saldo de cada conta bate com a soma das transações, que toda transferência ' +
          'tem duas pernas somando zero, que todo rateio fecha com o valor da transação e que o sinal ' +
          'do valor combina com o tipo. Se algo aparecer aqui, existe escrita acontecendo fora do ' +
          '`mutate()`.',
        response: {
          200: z.object({
            ok: z.boolean(),
            issues: z.array(
              z.object({
                check: z.string(),
                detail: z.string(),
                ids: z.array(z.string()).optional(),
              }),
            ),
          }),
        },
      },
    },
    () => {
      const issues = checkIntegrity();
      return { ok: issues.length === 0, issues };
    },
  );
}
