/**
 * Ponte entre serviços e `mutate()`.
 *
 * Todo serviço de escrita existe em duas formas:
 *
 *  • **pública** (`createTransaction`) — abre o próprio change set e devolve o
 *    `changeSetId`, para quem chamou poder oferecer "desfazer";
 *  • **composta** (`insertTransactionIn(ctx, …)`) — participa do change set de
 *    quem chamou, para que uma operação lógica ("comprar em 6x") vire **um**
 *    change set com 6 linhas, e não 6 change sets soltos.
 *
 * `withMutate` implementa essa escolha: recebendo um `ctx`, participa dele;
 * sem `ctx`, abre um novo.
 */

import { getDb, type Db } from '../db/client.js';
import type { Actor, ChangeSetSource } from '../db/schema.js';
import { mutate, type MutateContext } from './index.js';

export interface WriteOptions {
  /** Change set em andamento. Quando presente, a operação participa dele. */
  ctx?: MutateContext;
  source?: ChangeSetSource;
  actor?: Actor;
  /** Ferramenta da IA que originou a escrita. */
  tool?: string;
  conversationId?: string;
  requestId?: string;
  db?: Db;
}

export interface WriteResult<T> {
  data: T;
  /** Change set desta operação — passe para `undoChangeSet` para reverter. */
  changeSetId: string;
  /** Linhas inseridas, alteradas ou removidas. */
  touched: number;
}

/**
 * Executa `fn` dentro de um change set — novo ou herdado.
 *
 * O `summary` é uma função e não uma string porque, na maioria dos casos, o
 * resumo bom ("Criou 6 parcelas de R$ 83,33") só é conhecido depois da operação.
 */
export function withMutate<T>(
  options: WriteOptions,
  summary: string | ((result: T) => string),
  fn: (ctx: MutateContext) => T,
): WriteResult<T> {
  const resolve = (result: T): string => (typeof summary === 'function' ? summary(result) : summary);

  // Participa do change set do chamador.
  if (options.ctx) {
    const ctx = options.ctx;
    const result = fn(ctx);
    return { data: result, changeSetId: ctx.changeSetId, touched: ctx.touched };
  }

  const outcome = mutate(
    {
      source: options.source ?? 'api',
      summary: typeof summary === 'string' ? summary : '(em andamento)',
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.db ? { db: options.db } : {}),
    },
    (ctx) => {
      const result = fn(ctx);
      ctx.setSummary(resolve(result));
      return result;
    },
  );

  return { data: outcome.result, changeSetId: outcome.changeSetId, touched: outcome.touched };
}

/**
 * Conexão a usar para leitura, respeitando um change set em andamento.
 *
 * O fallback para `getDb()` acontece **aqui dentro**, e não como argumento do
 * chamador: `readDb(options, getDb())` avaliaria `getDb()` sempre, abrindo a
 * conexão de produção mesmo quando um banco de teste foi informado — e um teste
 * passaria a criar o arquivo real sem ninguém notar.
 */
export function readDb(options: WriteOptions): Db {
  return options.ctx?.tx ?? options.db ?? getDb();
}
