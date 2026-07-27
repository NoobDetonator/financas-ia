/**
 * O agente: laço de conversa com ferramentas.
 *
 * A conversa é persistida (`ai_conversations`, `ai_messages`) e cada execução de
 * ferramenta é registrada em `ai_actions` — então dá para auditar exatamente o que
 * a IA fez e quando, e ligar cada escrita ao seu `change_set` revertível.
 */

import { generateText, streamText, stepCountIs, type ModelMessage } from 'ai';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { aiActions, aiConversations, aiMessages, type AiConversation } from '../db/schema.js';
import type { JsonValue } from '../db/schema.js';
import { notFound } from '../core/errors.js';
import { env } from '../config/env.js';
import { getModel, modelInfo } from './provider.js';
import { buildSnapshot, systemPrompt } from './context.js';
import { buildTools, type ToolContext } from './tools.js';

/** Passos máximos por turno: leituras + escrita + resposta cabem folgados. */
const MAX_STEPS = 12;

export interface ChatOptions {
  conversationId?: string;
  /** Tokens de confirmação que o usuário aprovou nesta mensagem. */
  approvedTokens?: string[];
  db?: Db;
  model?: string;
}

export interface ChatResult {
  conversationId: string;
  text: string;
  /** Ferramentas chamadas neste turno. */
  toolCalls: Array<{ tool: string; args: unknown; result: unknown }>;
  /** Operações que ficaram esperando sua confirmação. */
  pendingConfirmations: Array<{ tool: string; summary: string; reason: string; token: string }>;
  /** Change sets criados — cada um revertível. */
  changeSetIds: string[];
  /** Ferramentas de escrita que de fato executaram neste turno. */
  executedTools: string[];
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
}

// ── Persistência da conversa ────────────────────────────────────────────────

export function createConversation(options: { title?: string; db?: Db } = {}): AiConversation {
  const db = options.db ?? getDb();
  const rows = db
    .insert(aiConversations)
    .values({ title: options.title ?? null, model: env.AI_MODEL })
    .returning()
    .all();
  const row = rows[0];
  if (!row) throw new Error('Falha ao criar a conversa.');
  return row;
}

export function getConversation(id: string, db: Db = getDb()): AiConversation {
  const row = db.select().from(aiConversations).where(eq(aiConversations.id, id)).all()[0];
  if (!row) throw notFound('Conversa', id);
  return row;
}

export function listConversations(db: Db = getDb()): AiConversation[] {
  return db.select().from(aiConversations).orderBy(sql`updated_at desc`).limit(50).all();
}

/** Mensagens no formato do AI SDK, para reenviar como histórico. */
export function conversationMessages(conversationId: string, db: Db = getDb()): ModelMessage[] {
  return db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.seq))
    .all()
    .map((row) => row.content as unknown as ModelMessage);
}

function nextSeq(conversationId: string, db: Db): number {
  const [row] = db
    .select({ max: sql<number | null>`max(seq)` })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .all();
  return (row?.max ?? 0) + 1;
}

function appendMessage(
  conversationId: string,
  message: ModelMessage,
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined },
  db: Db,
): void {
  db.insert(aiMessages)
    .values({
      conversationId,
      seq: nextSeq(conversationId, db),
      role: message.role as 'user' | 'assistant' | 'system' | 'tool',
      content: message as unknown as JsonValue,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    })
    .run();

  db.update(aiConversations)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(aiConversations.id, conversationId))
    .run();
}

/**
 * Monta o contexto de ferramentas, ligando o registro de ações à conversa.
 */
function toolContextFor(
  conversationId: string,
  options: ChatOptions,
  collected: {
    pending: ChatResult['pendingConfirmations'];
    changeSetIds: string[];
    executedTools: string[];
  },
): ToolContext {
  const db = options.db ?? getDb();

  return {
    ...(options.db ? { db: options.db } : {}),
    conversationId,
    approved: new Set(options.approvedTokens ?? []),
    onAction: (action) => {
      db.insert(aiActions)
        .values({
          conversationId,
          tool: action.tool,
          args: action.args as JsonValue,
          risk: action.risk.level,
          status: action.status,
          changeSetId: action.changeSetId ?? null,
        })
        .run();

      if (action.changeSetId) collected.changeSetIds.push(action.changeSetId);
      if (action.status === 'executed') collected.executedTools.push(action.tool);
      if (action.status === 'pending' && action.pending) {
        const token = action.pending.token;
        if (!collected.pending.some((p) => p.token === token)) {
          collected.pending.push({
            tool: action.tool,
            summary: action.pending.summary,
            reason: action.pending.reason,
            token,
          });
        }
      }
    },
  };
}

/**
 * Um turno de conversa.
 *
 * `maxSteps` permite ao modelo encadear leitura → análise → escrita → resposta num
 * único turno, que é o que faz "gastei 45 no mercado" virar um lançamento sem
 * ida e volta.
 */
export async function chat(userMessage: string, options: ChatOptions = {}): Promise<ChatResult> {
  const db = options.db ?? getDb();

  const conversationId =
    options.conversationId ??
    createConversation({ title: userMessage.slice(0, 60), ...(options.db ? { db: options.db } : {}) }).id;

  getConversation(conversationId, db);

  const collected = { pending: [] as ChatResult['pendingConfirmations'], changeSetIds: [] as string[], executedTools: [] as string[] };
  const context = toolContextFor(conversationId, options, collected);
  const tools = buildTools(context);

  const history = conversationMessages(conversationId, db);
  const userTurn: ModelMessage = { role: 'user', content: userMessage };

  const result = await generateText({
    model: getModel(options.model),
    system: systemPrompt(buildSnapshot({ ...(options.db ? { db: options.db } : {}) })),
    messages: [...history, userTurn],
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  appendMessage(conversationId, userTurn, {}, db);
  appendMessage(
    conversationId,
    { role: 'assistant', content: result.text },
    { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    db,
  );

  // Extrai as confirmações pendentes dos resultados das ferramentas.
  const toolCalls: ChatResult['toolCalls'] = [];
  for (const step of result.steps) {
    for (const call of step.toolResults) {
      const output = call.output as Record<string, unknown> | undefined;
      toolCalls.push({ tool: call.toolName, args: call.input, result: output });

      if (output?.needsConfirmation === true) {
        collected.pending.push({
          tool: call.toolName,
          summary: String(output.summary ?? ''),
          reason: String(output.reason ?? ''),
          token: String(output.confirmationToken ?? ''),
        });
      }
    }
  }

  return {
    conversationId,
    text: result.text,
    toolCalls,
    pendingConfirmations: collected.pending,
    changeSetIds: collected.changeSetIds,
    executedTools: collected.executedTools,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };
}

/**
 * Versão com streaming, para a interface e o REPL.
 *
 * Devolve o stream de texto e uma promessa com o resultado final, para o chamador
 * poder mostrar o texto conforme chega e depois tratar as confirmações.
 */
export async function chatStream(userMessage: string, options: ChatOptions = {}) {
  const db = options.db ?? getDb();

  const conversationId =
    options.conversationId ??
    createConversation({ title: userMessage.slice(0, 60), ...(options.db ? { db: options.db } : {}) }).id;

  getConversation(conversationId, db);

  const collected = { pending: [] as ChatResult['pendingConfirmations'], changeSetIds: [] as string[], executedTools: [] as string[] };
  const context = toolContextFor(conversationId, options, collected);
  const tools = buildTools(context);
  const history = conversationMessages(conversationId, db);
  const userTurn: ModelMessage = { role: 'user', content: userMessage };

  const stream = streamText({
    model: getModel(options.model),
    system: systemPrompt(buildSnapshot({ ...(options.db ? { db: options.db } : {}) })),
    messages: [...history, userTurn],
    tools,
    stopWhen: stepCountIs(MAX_STEPS),

    // As confirmações pendentes têm que ser coletadas passo a passo.
    //
    // Sem isto, o token de aprovação nunca chega a quem chamou: o modelo avisa que
    // precisa de confirmação, mas a interface não tem como confirmar — e o usuário
    // entra num laço, pedindo uma aprovação que o sistema não sabe receber.
    onStepFinish: (step) => {
      for (const call of step.toolResults) {
        const output = call.output as Record<string, unknown> | undefined;
        if (output?.needsConfirmation !== true) continue;

        collected.pending.push({
          tool: call.toolName,
          summary: String(output.summary ?? ''),
          reason: String(output.reason ?? ''),
          token: String(output.confirmationToken ?? ''),
        });
      }
    },

    onFinish: (event) => {
      appendMessage(conversationId, userTurn, {}, db);
      appendMessage(
        conversationId,
        { role: 'assistant', content: event.text },
        { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens },
        db,
      );
    },
  });

  return { conversationId, stream, collected };
}

/** Estado da IA, para diagnóstico. */
export function aiStatus(db: Db = getDb()): {
  provider: string;
  model: string;
  configured: boolean;
  toolCount: number;
  conversationCount: number;
  actionCount: number;
} {
  const info = modelInfo();
  const [conversations] = db.select({ n: sql<number>`count(*)` }).from(aiConversations).all();
  const [actions] = db.select({ n: sql<number>`count(*)` }).from(aiActions).all();

  return {
    ...info,
    toolCount: Object.keys(buildTools()).length,
    conversationCount: conversations?.n ?? 0,
    actionCount: actions?.n ?? 0,
  };
}

/** Histórico de ações da IA — o que ela fez, com o change set de cada escrita. */
export function aiActionHistory(
  options: { conversationId?: string; limit?: number; db?: Db } = {},
) {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(aiActions)
    .where(options.conversationId ? eq(aiActions.conversationId, options.conversationId) : undefined)
    .orderBy(sql`created_at desc`)
    .limit(options.limit ?? 50)
    .all();
}
