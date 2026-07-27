/**
 * O único caminho de escrita do sistema.
 *
 * Regra de arquitetura nº 2 do projeto: **nenhum serviço escreve no banco fora
 * de um `mutate()`**. Em troca de usar `ctx.insert/update/remove` em vez do
 * Drizzle direto, todo write ganha de graça:
 *
 *  • transação atômica (nada fica pela metade);
 *  • registro em `audit_log` com a linha inteira antes e depois;
 *  • agrupamento em `change_set`, que é a unidade de `undo`;
 *  • rastreio de autor — se foi você ou a IA que mexeu.
 *
 * Isso não é burocracia: é o que permite dar autonomia de escrita à IA sem
 * medo, porque qualquer coisa que ela faça é inspecionável e reversível.
 *
 * ⚠️ Ao apagar uma linha que tem filhos com `onDelete: 'cascade'`, apague os
 * filhos explicitamente via `ctx.remove()` **antes** do pai. O cascade do SQLite
 * não passa pelo audit log e o `undo` não teria como restaurar os filhos.
 */

import { sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { auditLog, changeSets } from '../db/schema.js';
import type { Actor, ChangeSetSource, RiskLevel } from '../db/schema.js';
import { nowIso } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { entityConfig, type EntityName } from './registry.js';

type Row = Record<string, unknown>;

export interface MutateOptions {
  source: ChangeSetSource;
  /** Resumo legível. Pode ser refinado depois com `ctx.setSummary()`. */
  summary: string;
  actor?: Actor;
  risk?: RiskLevel;
  /** Ferramenta da IA que originou a mudança. */
  tool?: string;
  conversationId?: string;
  requestId?: string;
  /** Marca este change set como reversão de outro. */
  revertOf?: string;
  /** Conexão alternativa — usada pelos testes. */
  db?: Db;
}

export interface MutateContext {
  readonly changeSetId: string;
  readonly actor: Actor;
  /**
   * Conexão dentro da transação. Use para **leituras**. Escrever por aqui
   * ignora a auditoria e quebra o `undo`.
   */
  readonly tx: Db;

  /** Insere uma linha e audita. Devolve a linha gravada. */
  insert<T extends Row>(entity: EntityName, values: Row): T;
  /** Aplica um patch parcial e audita o antes/depois. Devolve a linha atualizada. */
  update<T extends Row>(entity: EntityName, key: string, patch: Row): T;
  /** Remove uma linha e audita. Devolve a linha removida. */
  remove<T extends Row>(entity: EntityName, key: string): T;

  /** Ajusta o resumo do change set quando ele só é conhecido no fim. */
  setSummary(summary: string): void;
  /** Quantas linhas foram tocadas até agora. */
  readonly touched: number;
}

export interface MutateResult<T> {
  result: T;
  changeSetId: string;
  /** Número de linhas inseridas, alteradas ou removidas. */
  touched: number;
}

/**
 * Executa `fn` numa transação auditada.
 *
 * Síncrono de propósito — ver a nota de arquitetura em `db/client.ts`. Não
 * chame `mutate()` dentro de outro `mutate()`: passe o `ctx` adiante.
 */
export function mutate<T>(options: MutateOptions, fn: (ctx: MutateContext) => T): MutateResult<T> {
  const db = options.db ?? getDb();
  const actor: Actor = options.actor ?? (options.source === 'ai' ? 'ai' : 'user');

  return db.transaction((tx): MutateResult<T> => {
    const inserted = tx
      .insert(changeSets)
      .values({
        source: options.source,
        actor,
        summary: options.summary,
        status: 'applied',
        risk: options.risk ?? 'auto',
        tool: options.tool ?? null,
        conversationId: options.conversationId ?? null,
        requestId: options.requestId ?? null,
        revertOf: options.revertOf ?? null,
        appliedAt: nowIso(),
      })
      .returning()
      .all();

    const changeSet = inserted[0];
    if (!changeSet) throw new Error('Falha ao abrir o change set.');
    const changeSetId = changeSet.id;

    let seq = 0;
    let summary = options.summary;

    const record = (
      action: 'insert' | 'update' | 'delete',
      entity: EntityName,
      entityId: string,
      before: Row | null,
      after: Row | null,
    ): void => {
      seq += 1;
      tx.insert(auditLog)
        .values({ changeSetId, seq, actor, action, entity, entityId, before, after })
        .run();
    };

    const ctx: MutateContext = {
      changeSetId,
      actor,
      tx: tx as unknown as Db,

      insert<R extends Row>(entity: EntityName, values: Row): R {
        const config = entityConfig(entity);
        const rows = tx
          .insert(config.table)
          .values(values as never)
          .returning()
          .all() as Row[];
        const row = rows[0];
        if (!row) throw new Error(`Insert em "${entity}" não retornou linha.`);
        record('insert', entity, config.key(row), null, row);
        return row as R;
      },

      update<R extends Row>(entity: EntityName, key: string, patch: Row): R {
        const config = entityConfig(entity);
        const where = config.where(key);

        const existing = (tx.select().from(config.table).where(where).all() as Row[])[0];
        if (!existing) {
          throw new AppError('NOT_FOUND', `${entity} "${key}" não encontrado.`);
        }

        const rows = tx
          .update(config.table)
          .set(patch as never)
          .where(where)
          .returning()
          .all() as Row[];
        const row = rows[0];
        if (!row) throw new Error(`Update em "${entity}" não retornou linha.`);

        record('update', entity, config.key(row), existing, row);
        return row as R;
      },

      remove<R extends Row>(entity: EntityName, key: string): R {
        const config = entityConfig(entity);
        const where = config.where(key);

        const existing = (tx.select().from(config.table).where(where).all() as Row[])[0];
        if (!existing) {
          throw new AppError('NOT_FOUND', `${entity} "${key}" não encontrado.`);
        }

        tx.delete(config.table).where(where).run();
        record('delete', entity, key, existing, null);
        return existing as R;
      },

      setSummary(next: string): void {
        summary = next;
      },

      get touched(): number {
        return seq;
      },
    };

    const result = fn(ctx);

    if (summary !== options.summary) {
      tx.update(changeSets).set({ summary }).where(sql`id = ${changeSetId}`).run();
    }

    return { result, changeSetId, touched: seq };
  });
}

/**
 * Desfaz um change set, reaplicando os estados anteriores na ordem inversa.
 *
 * A reversão é ela mesma um change set (com `revertOf` apontando para o
 * original), então desfazer um undo — refazer — funciona sem código extra.
 */
export function undoChangeSet(
  changeSetId: string,
  options: { actor?: Actor; source?: ChangeSetSource; db?: Db } = {},
): MutateResult<{ reverted: number }> {
  const db = options.db ?? getDb();

  const original = db.select().from(changeSets).where(sql`id = ${changeSetId}`).all()[0];
  if (!original) {
    throw new AppError('NOT_FOUND', `Change set "${changeSetId}" não encontrado.`);
  }
  if (original.status === 'reverted') {
    throw new AppError('CONFLICT', `Este change set já foi desfeito.`);
  }
  if (original.status === 'pending') {
    throw new AppError('CONFLICT', `Change set pendente de confirmação não tem o que desfazer.`);
  }

  const entries = db
    .select()
    .from(auditLog)
    .where(sql`change_set_id = ${changeSetId}`)
    .orderBy(sql`seq desc`)
    .all();

  if (entries.length === 0) {
    throw new AppError('CONFLICT', 'Change set não registrou nenhuma alteração.');
  }

  return mutate(
    {
      source: options.source ?? 'api',
      actor: options.actor ?? 'user',
      summary: `Desfez: ${original.summary}`,
      revertOf: changeSetId,
      ...(options.db ? { db: options.db } : {}),
    },
    (ctx) => {
      for (const entry of entries) {
        const entity = entry.entity as EntityName;

        switch (entry.action) {
          case 'insert':
            // Foi criado: remover.
            ctx.remove(entity, entry.entityId);
            break;

          case 'delete': {
            // Foi removido: recriar exatamente como estava.
            const before = entry.before;
            if (!before) throw new Error(`Audit ${entry.id} sem estado anterior para restaurar.`);
            ctx.insert(entity, before);
            break;
          }

          case 'update': {
            // Foi alterado: voltar ao estado anterior, campo por campo.
            const before = entry.before;
            if (!before) throw new Error(`Audit ${entry.id} sem estado anterior para restaurar.`);
            // Passa a linha inteira, inclusive `updated_at`: um valor explícito
            // vence o `$onUpdateFn`, então a restauração é fiel ao original.
            ctx.update(entity, entry.entityId, before);
            break;
          }
        }
      }

      ctx.tx
        .update(changeSets)
        .set({ status: 'reverted', revertedAt: nowIso() })
        .where(sql`id = ${changeSetId}`)
        .run();

      return { reverted: entries.length };
    },
  );
}

export { type EntityName } from './registry.js';
