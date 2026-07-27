/**
 * Auditoria e desfazer.
 *
 * Estas rotas são o que torna a autonomia da IA aceitável: dá para ver
 * exatamente o que ela mudou, campo por campo, e reverter com uma chamada.
 */

import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getDb } from '../../db/client.js';
import { auditLog, changeSets } from '../../db/schema.js';
import { undoChangeSet } from '../../mutate/index.js';
import { notFound } from '../../core/errors.js';
import { auditEntryDto, changeSetDto, errorResponseDto, idParamDto, writeResponse } from '../dto.js';

export async function registerChangeSetRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/change-sets',
    {
      schema: {
        tags: ['auditoria'],
        summary: 'Histórico de alterações',
        description: 'Ordenado do mais recente para o mais antigo. Filtre por `actor=ai` para ver o que a IA fez.',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
          actor: z.enum(['user', 'ai', 'system']).optional(),
          source: z.enum(['api', 'ai', 'import', 'job', 'cli', 'seed']).optional(),
          status: z.enum(['applied', 'pending', 'reverted', 'rejected']).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(changeSetDto.extend({ entryCount: z.number().int() })),
            total: z.number().int(),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    (request) => {
      const db = getDb();
      const { limit, offset, actor, source, status } = request.query;

      const filters = [
        actor ? eq(changeSets.actor, actor) : undefined,
        source ? eq(changeSets.source, source) : undefined,
        status ? eq(changeSets.status, status) : undefined,
      ].filter((f) => f !== undefined);

      const where = filters.length > 0 ? sql.join(filters, sql` and `) : undefined;

      const items = db
        .select()
        .from(changeSets)
        .where(where)
        .orderBy(desc(changeSets.createdAt), desc(changeSets.id))
        .limit(limit)
        .offset(offset)
        .all();

      const [aggregate] = db
        .select({ total: sql<number>`count(*)` })
        .from(changeSets)
        .where(where)
        .all();

      const withCounts = items.map((item) => {
        const [count] = db
          .select({ n: sql<number>`count(*)` })
          .from(auditLog)
          .where(eq(auditLog.changeSetId, item.id))
          .all();
        return { ...item, entryCount: count?.n ?? 0 };
      });

      return { items: withCounts, total: aggregate?.total ?? 0, limit, offset };
    },
  );

  route.get(
    '/change-sets/:id',
    {
      schema: {
        tags: ['auditoria'],
        summary: 'Detalha um change set com o diff completo',
        description: 'Cada entrada traz a linha inteira antes e depois da alteração.',
        params: idParamDto,
        response: {
          200: changeSetDto.extend({ entries: z.array(auditEntryDto) }),
          404: errorResponseDto,
        },
      },
    },
    (request) => {
      const db = getDb();
      const changeSet = db.select().from(changeSets).where(eq(changeSets.id, request.params.id)).all()[0];
      if (!changeSet) throw notFound('Change set', request.params.id);

      const entries = db
        .select()
        .from(auditLog)
        .where(eq(auditLog.changeSetId, changeSet.id))
        .orderBy(auditLog.seq)
        .all();

      return { ...changeSet, entries };
    },
  );

  route.post(
    '/change-sets/:id/undo',
    {
      schema: {
        tags: ['auditoria'],
        summary: 'Desfaz um change set',
        description:
          'Reaplica os estados anteriores na ordem inversa. A reversão é ela mesma um change set, ' +
          'então desfazer o undo refaz a mudança original.',
        params: idParamDto,
        response: {
          200: writeResponse(z.object({ reverted: z.number().int() })),
          404: errorResponseDto,
          409: errorResponseDto,
        },
      },
    },
    (request) => {
      const outcome = undoChangeSet(request.params.id, { actor: 'user', source: 'api' });
      return { data: outcome.result, changeSetId: outcome.changeSetId, touched: outcome.touched };
    },
  );
}
