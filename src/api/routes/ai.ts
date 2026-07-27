import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  aiActionHistory,
  aiStatus,
  chat,
  chatStream,
  conversationMessages,
  createConversation,
  listConversations,
} from '../../ai/agent.js';
import { buildSnapshot } from '../../ai/context.js';
import { riskOverview, loadThresholds } from '../../ai/risk.js';
import { toolNames } from '../../ai/tools.js';
import { resolveDatePhrase } from '../../ai/date-phrases.js';
import { errorResponseDto, idParamDto } from '../dto.js';

const pendingDto = z.object({
  tool: z.string(),
  summary: z.string().describe('O que será feito, em português'),
  reason: z.string().describe('Por que precisa de confirmação'),
  token: z.string().describe('Passe em approvedTokens para autorizar'),
});

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/ai/status',
    {
      schema: {
        tags: ['ia'],
        summary: 'Estado da IA e limites de autonomia',
        response: {
          200: z.object({
            provider: z.string(),
            model: z.string(),
            configured: z.boolean().describe('false quando falta a chave de API'),
            toolCount: z.number().int(),
            conversationCount: z.number().int(),
            actionCount: z.number().int(),
            tools: z.array(z.string()),
            thresholds: z.object({
              amountCents: z.number().int(),
              bulkRows: z.number().int(),
            }),
            risk: z.object({
              alwaysAuto: z.array(z.string()),
              conditional: z.array(z.string()),
              alwaysConfirm: z.array(z.string()),
            }),
          }),
        },
      },
    },
    () => ({
      ...aiStatus(),
      tools: toolNames(),
      thresholds: loadThresholds(),
      risk: riskOverview(),
    }),
  );

  route.get(
    '/ai/snapshot',
    {
      schema: {
        tags: ['ia'],
        summary: 'O retrato financeiro que a IA recebe',
        description:
          'Útil para entender o que a IA "sabe" antes de responder. É agregado de propósito — ' +
          'transações cruas não entram no prompt.',
        response: { 200: z.object({ snapshot: z.string() }) },
      },
    },
    () => ({ snapshot: buildSnapshot() }),
  );

  route.post(
    '/ai/chat',
    {
      schema: {
        tags: ['ia'],
        summary: 'Conversa com o assistente',
        description:
          'Quando uma operação passa dos limites de autonomia, ela **não é executada**: volta em ' +
          '`pendingConfirmations` com um `token`. Reenvie a mensagem com o token em `approvedTokens` ' +
          'para autorizar.\n\n' +
          'Cada escrita devolve um `changeSetId` revertível em `POST /change-sets/{id}/undo`.',
        body: z.object({
          message: z.string().min(1).max(4000),
          conversationId: z.string().optional().describe('Omitido, inicia uma conversa nova'),
          approvedTokens: z.array(z.string()).max(20).optional(),
        }),
        response: {
          200: z.object({
            conversationId: z.string(),
            text: z.string(),
            toolCalls: z.array(z.object({ tool: z.string(), args: z.any(), result: z.any() })),
            pendingConfirmations: z.array(pendingDto),
            changeSetIds: z.array(z.string()),
            usage: z.object({
              inputTokens: z.number().optional(),
              outputTokens: z.number().optional(),
            }),
          }),
          400: errorResponseDto,
        },
      },
    },
    async (request) => {
      const { message, conversationId, approvedTokens } = request.body;
      return chat(message, {
        ...(conversationId ? { conversationId } : {}),
        ...(approvedTokens ? { approvedTokens } : {}),
      });
    },
  );

  route.post(
    '/ai/chat/stream',
    {
      schema: {
        tags: ['ia'],
        summary: 'Conversa com resposta em streaming (SSE)',
        description:
          'Devolve `text/event-stream`. Eventos: `text` com os pedaços da resposta, `done` com o ' +
          'resultado final (confirmações pendentes e change sets).',
        body: z.object({
          message: z.string().min(1).max(4000),
          conversationId: z.string().optional(),
          approvedTokens: z.array(z.string()).max(20).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { message, conversationId, approvedTokens } = request.body;

      const { conversationId: id, stream, collected } = await chatStream(message, {
        ...(conversationId ? { conversationId } : {}),
        ...(approvedTokens ? { approvedTokens } : {}),
      });

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const send = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('start', { conversationId: id });

      try {
        for await (const chunk of stream.textStream) {
          send('text', { chunk });
        }
        await stream.finishReason;

        send('done', {
          conversationId: id,
          pendingConfirmations: collected.pending,
          changeSetIds: collected.changeSetIds,
        });
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : String(error) });
      } finally {
        reply.raw.end();
      }

      return reply;
    },
  );

  route.get(
    '/ai/conversations',
    {
      schema: {
        tags: ['ia'],
        summary: 'Lista as conversas',
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              title: z.string().nullable(),
              model: z.string(),
              createdAt: z.string(),
              updatedAt: z.string(),
            }),
          ),
        },
      },
    },
    () => listConversations(),
  );

  route.post(
    '/ai/conversations',
    {
      schema: {
        tags: ['ia'],
        summary: 'Cria uma conversa vazia',
        body: z.object({ title: z.string().max(120).optional() }),
        response: { 200: z.object({ id: z.string(), title: z.string().nullable() }) },
      },
    },
    (request) => {
      const conversation = createConversation(request.body);
      return { id: conversation.id, title: conversation.title };
    },
  );

  route.get(
    '/ai/conversations/:id/messages',
    {
      schema: {
        tags: ['ia'],
        summary: 'Mensagens de uma conversa',
        params: idParamDto,
        response: { 200: z.object({ messages: z.array(z.any()) }), 404: errorResponseDto },
      },
    },
    (request) => ({ messages: conversationMessages(request.params.id) }),
  );

  route.get(
    '/ai/actions',
    {
      schema: {
        tags: ['ia'],
        summary: 'Histórico do que a IA fez',
        description:
          'Cada escrita traz o `changeSetId`, então dá para inspecionar o diff completo em ' +
          '`GET /change-sets/{id}` e reverter se necessário.',
        querystring: z.object({
          conversationId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.array(z.any()) },
      },
    },
    (request) => aiActionHistory(request.query),
  );

  route.get(
    '/ai/resolve-date',
    {
      schema: {
        tags: ['ia'],
        summary: 'Converte expressão de data em português',
        description:
          'Determinístico, não passa pelo modelo — "ontem", "sexta passada", "dia 5", "15/03". ' +
          'O modelo erraria aritmética de calendário de forma plausível, que é o pior tipo de erro aqui.',
        querystring: z.object({ phrase: z.string().min(1).max(80) }),
        response: {
          200: z.object({
            recognized: z.boolean(),
            date: z.string().optional(),
            interpretation: z.string().optional(),
          }),
        },
      },
    },
    (request) => {
      const resolved = resolveDatePhrase(request.query.phrase);
      return resolved
        ? { recognized: true, date: resolved.date, interpretation: resolved.interpretation }
        : { recognized: false };
    },
  );
}
