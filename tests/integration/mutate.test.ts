import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { mutate, undoChangeSet } from '../../src/mutate/index.js';
import {
  transactions,
  tags,
  transactionTags,
  changeSets,
  auditLog,
  type Transaction,
} from '../../src/db/schema.js';
import { AppError } from '../../src/core/errors.js';
import { testDb, seedAccount, seedCategory, snapshot } from '../helpers/db.js';
import type { DbHandle } from '../../src/db/client.js';

let handle: DbHandle;
let accountId: string;
let categoryId: string;

beforeEach(() => {
  handle = testDb();
  accountId = seedAccount(handle.db).id;
  categoryId = seedCategory(handle.db).id;
});

afterEach(() => handle.close());

function newTransaction(description = 'Mercado', amountCents = -4590): Transaction {
  const { result } = mutate({ source: 'api', summary: 'teste', db: handle.db }, (ctx) =>
    ctx.insert<Transaction>('transactions', {
      accountId,
      categoryId,
      type: 'expense',
      date: '2026-07-26',
      amountCents,
      description,
    }),
  );
  return result;
}

describe('mutate: auditoria automática', () => {
  test('insert registra a linha criada', () => {
    const tx = newTransaction();

    const entries = handle.db.select().from(auditLog).all();
    assert.equal(entries.length, 1);

    const entry = entries[0]!;
    assert.equal(entry.action, 'insert');
    assert.equal(entry.entity, 'transactions');
    assert.equal(entry.entityId, tx.id);
    assert.equal(entry.before, null);
    assert.equal((entry.after as Record<string, unknown>).description, 'Mercado');
    assert.equal(entry.seq, 1);
  });

  test('update registra antes e depois', () => {
    const tx = newTransaction();

    mutate({ source: 'api', summary: 'recategorizar', db: handle.db }, (ctx) =>
      ctx.update('transactions', tx.id, { description: 'Supermercado', amountCents: -5000 }),
    );

    const entry = handle.db.select().from(auditLog).where(eq(auditLog.action, 'update')).all()[0]!;
    assert.equal((entry.before as Record<string, unknown>).description, 'Mercado');
    assert.equal((entry.before as Record<string, unknown>).amountCents, -4590);
    assert.equal((entry.after as Record<string, unknown>).description, 'Supermercado');
    assert.equal((entry.after as Record<string, unknown>).amountCents, -5000);
  });

  test('remove guarda o estado anterior', () => {
    const tx = newTransaction();

    mutate({ source: 'api', summary: 'excluir', db: handle.db }, (ctx) =>
      ctx.remove('transactions', tx.id),
    );

    assert.equal(handle.db.select().from(transactions).all().length, 0);
    const entry = handle.db.select().from(auditLog).where(eq(auditLog.action, 'delete')).all()[0]!;
    assert.equal((entry.before as Record<string, unknown>).description, 'Mercado');
    assert.equal(entry.after, null);
  });

  test('atribui autor: IA é distinguível de você', () => {
    mutate({ source: 'ai', summary: 'IA lançou', tool: 'create_transaction', db: handle.db }, (ctx) =>
      ctx.insert('transactions', {
        accountId,
        type: 'expense',
        date: '2026-07-26',
        amountCents: -1000,
        description: 'Uber',
      }),
    );

    const cs = handle.db.select().from(changeSets).all()[0]!;
    assert.equal(cs.actor, 'ai');
    assert.equal(cs.source, 'ai');
    assert.equal(cs.tool, 'create_transaction');

    const entry = handle.db.select().from(auditLog).all()[0]!;
    assert.equal(entry.actor, 'ai');
  });

  test('setSummary refina o resumo no fim da operação', () => {
    const { changeSetId } = mutate(
      { source: 'api', summary: 'provisório', db: handle.db },
      (ctx) => {
        ctx.insert('transactions', {
          accountId,
          type: 'expense',
          date: '2026-07-26',
          amountCents: -1000,
          description: 'Uber',
        });
        ctx.setSummary(`Criou 1 transação (${ctx.touched} linha)`);
        return null;
      },
    );

    const cs = handle.db.select().from(changeSets).where(eq(changeSets.id, changeSetId)).all()[0]!;
    assert.equal(cs.summary, 'Criou 1 transação (1 linha)');
  });

  test('erro no meio da operação desfaz tudo, inclusive o change set', () => {
    assert.throws(() => {
      mutate({ source: 'api', summary: 'vai falhar', db: handle.db }, (ctx) => {
        ctx.insert('transactions', {
          accountId,
          type: 'expense',
          date: '2026-07-26',
          amountCents: -1000,
          description: 'Primeira',
        });
        throw new Error('falha simulada');
      });
    }, /falha simulada/);

    // Atomicidade: nem a transação, nem o change set, nem o audit sobrevivem.
    assert.equal(handle.db.select().from(transactions).all().length, 0);
    assert.equal(handle.db.select().from(changeSets).all().length, 0);
    assert.equal(handle.db.select().from(auditLog).all().length, 0);
  });

  test('update em linha inexistente lança NOT_FOUND', () => {
    assert.throws(
      () =>
        mutate({ source: 'api', summary: 'x', db: handle.db }, (ctx) =>
          ctx.update('transactions', 'NAO_EXISTE', { description: 'y' }),
        ),
      (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND',
    );
  });
});

describe('undo', () => {
  test('desfaz criação', () => {
    const { changeSetId } = mutate({ source: 'ai', summary: 'IA criou', db: handle.db }, (ctx) =>
      ctx.insert('transactions', {
        accountId,
        type: 'expense',
        date: '2026-07-26',
        amountCents: -1000,
        description: 'Errado',
      }),
    );

    assert.equal(handle.db.select().from(transactions).all().length, 1);

    undoChangeSet(changeSetId, { db: handle.db });

    assert.equal(handle.db.select().from(transactions).all().length, 0);
    const original = handle.db.select().from(changeSets).where(eq(changeSets.id, changeSetId)).all()[0]!;
    assert.equal(original.status, 'reverted');
    assert.ok(original.revertedAt);
  });

  test('desfaz exclusão restaurando a linha idêntica', () => {
    const tx = newTransaction();
    const before = snapshot(handle, 'transactions');

    const { changeSetId } = mutate({ source: 'api', summary: 'excluir', db: handle.db }, (ctx) =>
      ctx.remove('transactions', tx.id),
    );
    assert.equal(handle.db.select().from(transactions).all().length, 0);

    undoChangeSet(changeSetId, { db: handle.db });

    // Restauração fiel: todas as colunas voltam ao valor original.
    assert.deepEqual(snapshot(handle, 'transactions'), before);
  });

  test('desfaz alteração restaurando todos os campos, inclusive updated_at', () => {
    const tx = newTransaction();
    const before = snapshot(handle, 'transactions');

    const { changeSetId } = mutate({ source: 'ai', summary: 'IA alterou', db: handle.db }, (ctx) =>
      ctx.update('transactions', tx.id, {
        description: 'Trocado pela IA',
        amountCents: -99_999,
        categoryId: null,
        status: 'pending',
      }),
    );

    undoChangeSet(changeSetId, { db: handle.db });

    // Se `updated_at` não fosse restaurado, este deepEqual falharia — é o teste
    // que garante que o undo é fiel e não "quase igual".
    assert.deepEqual(snapshot(handle, 'transactions'), before);
  });

  test('desfaz operação em lote na ordem inversa', () => {
    const empty = snapshot(handle, 'transactions');

    const { changeSetId, touched } = mutate(
      { source: 'ai', summary: 'IA criou 10', db: handle.db },
      (ctx) => {
        for (let i = 1; i <= 10; i += 1) {
          ctx.insert('transactions', {
            accountId,
            categoryId,
            type: 'expense',
            date: '2026-07-26',
            amountCents: -100 * i,
            description: `Lançamento ${i}`,
          });
        }
        return null;
      },
    );

    assert.equal(touched, 10);
    assert.equal(handle.db.select().from(transactions).all().length, 10);

    undoChangeSet(changeSetId, { db: handle.db });
    assert.deepEqual(snapshot(handle, 'transactions'), empty);
  });

  test('desfazer o undo refaz a mudança (redo)', () => {
    const tx = newTransaction();
    const withOriginal = snapshot(handle, 'transactions');

    const { changeSetId } = mutate({ source: 'api', summary: 'alterar', db: handle.db }, (ctx) =>
      ctx.update('transactions', tx.id, { description: 'Novo nome' }),
    );
    const withChange = snapshot(handle, 'transactions');

    const undo = undoChangeSet(changeSetId, { db: handle.db });
    assert.deepEqual(snapshot(handle, 'transactions'), withOriginal);

    // Desfazer o change set de reversão volta ao estado alterado.
    undoChangeSet(undo.changeSetId, { db: handle.db });
    assert.deepEqual(snapshot(handle, 'transactions'), withChange);
  });

  test('registra a reversão como change set encadeado', () => {
    const { changeSetId } = mutate({ source: 'ai', summary: 'IA criou', db: handle.db }, (ctx) =>
      ctx.insert('transactions', {
        accountId,
        type: 'expense',
        date: '2026-07-26',
        amountCents: -1000,
        description: 'x',
      }),
    );

    const undo = undoChangeSet(changeSetId, { db: handle.db });
    const revertSet = handle.db.select().from(changeSets).where(eq(changeSets.id, undo.changeSetId)).all()[0]!;

    assert.equal(revertSet.revertOf, changeSetId);
    assert.equal(revertSet.summary, 'Desfez: IA criou');
    assert.equal(revertSet.status, 'applied');
  });

  test('recusa desfazer duas vezes o mesmo change set', () => {
    const { changeSetId } = mutate({ source: 'api', summary: 'criar', db: handle.db }, (ctx) =>
      ctx.insert('transactions', {
        accountId,
        type: 'expense',
        date: '2026-07-26',
        amountCents: -1000,
        description: 'x',
      }),
    );

    undoChangeSet(changeSetId, { db: handle.db });
    assert.throws(
      () => undoChangeSet(changeSetId, { db: handle.db }),
      (e: unknown) => e instanceof AppError && e.code === 'CONFLICT',
    );
  });

  test('change set inexistente lança NOT_FOUND', () => {
    assert.throws(
      () => undoChangeSet('NAO_EXISTE', { db: handle.db }),
      (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND',
    );
  });
});

describe('undo com chave composta', () => {
  test('desfaz vínculo de tag (PK composta transaction_id + tag_id)', () => {
    const tx = newTransaction();
    const tag = handle.db.insert(tags).values({ name: 'Viagem', normalizedName: 'viagem' }).returning().all()[0]!;
    const empty = snapshot(handle, 'transaction_tags');

    const { changeSetId } = mutate({ source: 'api', summary: 'marcar tag', db: handle.db }, (ctx) =>
      ctx.insert('transaction_tags', { transactionId: tx.id, tagId: tag.id }),
    );

    const linked = handle.db.select().from(transactionTags).all();
    assert.equal(linked.length, 1);

    // A chave no audit log é composta, com separador `::`.
    const entry = handle.db.select().from(auditLog).where(eq(auditLog.entity, 'transaction_tags')).all()[0]!;
    assert.equal(entry.entityId, `${tx.id}::${tag.id}`);

    undoChangeSet(changeSetId, { db: handle.db });
    assert.deepEqual(snapshot(handle, 'transaction_tags'), empty);
  });

  test('remove apenas o vínculo da chave, não os demais', () => {
    const tx1 = newTransaction('Um');
    const tx2 = newTransaction('Dois');
    const tag = handle.db.insert(tags).values({ name: 'Viagem', normalizedName: 'viagem' }).returning().all()[0]!;

    mutate({ source: 'api', summary: 'tag em tx2', db: handle.db }, (ctx) =>
      ctx.insert('transaction_tags', { transactionId: tx2.id, tagId: tag.id }),
    );
    const { changeSetId } = mutate({ source: 'api', summary: 'tag em tx1', db: handle.db }, (ctx) =>
      ctx.insert('transaction_tags', { transactionId: tx1.id, tagId: tag.id }),
    );

    undoChangeSet(changeSetId, { db: handle.db });

    // O WHERE composto tem que isolar a linha certa; um bug aqui apagaria os dois.
    const remaining = handle.db.select().from(transactionTags).all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.transactionId, tx2.id);
  });
});

describe('sequência do audit log', () => {
  test('seq é único e crescente dentro do change set', () => {
    const { changeSetId } = mutate({ source: 'api', summary: 'várias', db: handle.db }, (ctx) => {
      const a = ctx.insert<Transaction>('transactions', {
        accountId,
        type: 'expense',
        date: '2026-07-26',
        amountCents: -100,
        description: 'A',
      });
      ctx.update('transactions', a.id, { description: 'A editado' });
      ctx.remove('transactions', a.id);
      return null;
    });

    const entries = handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.changeSetId, changeSetId))
      .orderBy(sql`seq`)
      .all();

    assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(entries.map((e) => e.action), ['insert', 'update', 'delete']);
  });
});
