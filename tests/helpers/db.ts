/**
 * Banco de teste: SQLite em memória com as migrations aplicadas.
 *
 * Usar as migrations de verdade (e não um `CREATE TABLE` paralelo) garante que o
 * teste roda contra o mesmo schema que a aplicação — inclusive índices únicos e
 * foreign keys, que é justamente onde os bugs de domínio aparecem.
 */

import { createDb, type Db, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { accounts, categories } from '../../src/db/schema.js';

export function testDb(): DbHandle {
  const handle = createDb({ file: ':memory:' });
  runMigrations(handle.db);
  return handle;
}

/** Conta corrente pronta para uso nos testes. */
export function seedAccount(
  db: Db,
  overrides: Partial<typeof accounts.$inferInsert> = {},
): typeof accounts.$inferSelect {
  const rows = db
    .insert(accounts)
    .values({
      name: overrides.name ?? 'Conta Teste',
      kind: overrides.kind ?? 'checking',
      openingDate: overrides.openingDate ?? '2026-01-01',
      openingBalanceCents: overrides.openingBalanceCents ?? 0,
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (!row) throw new Error('Falha ao criar conta de teste.');
  return row;
}

export function seedCategory(
  db: Db,
  overrides: Partial<typeof categories.$inferInsert> = {},
): typeof categories.$inferSelect {
  const rows = db
    .insert(categories)
    .values({
      name: overrides.name ?? 'Mercado',
      kind: overrides.kind ?? 'expense',
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (!row) throw new Error('Falha ao criar categoria de teste.');
  return row;
}

/**
 * Fotografia do **conteúdo** de uma tabela, para comparar estados.
 *
 * Ordena pelo JSON de cada linha em vez de por `rowid` de propósito: o `undo`
 * reinsere as linhas na ordem inversa, então elas recebem `rowid` novos. Comparar
 * ordem física acusaria diferença onde o conteúdo é idêntico — que é exatamente o
 * que interessa verificar.
 */
export function snapshot(handle: DbHandle, table: string): string[] {
  return handle.sqlite
    .prepare(`select * from "${table}"`)
    .all()
    .map((row) => JSON.stringify(row))
    .sort();
}
