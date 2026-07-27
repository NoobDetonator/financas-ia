/**
 * Conexão com o SQLite.
 *
 * O driver `better-sqlite3` é **síncrono**, e isso é uma escolha de arquitetura,
 * não um acidente: toda a camada de serviços do projeto é síncrona. Transação
 * síncrona não pode vazar por um `await` esquecido no meio, o que elimina de
 * saída a classe de bug mais traiçoeira num sistema financeiro. O código
 * assíncrono fica restrito às bordas de IO — HTTP, chamadas de LLM e arquivos.
 */

import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { databaseFile, dataDir, env } from '../config/env.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;
export type SqliteConnection = Database.Database;

/** Pragmas aplicados a toda conexão. */
function applyPragmas(sqlite: SqliteConnection): void {
  // WAL permite ler enquanto escreve — o job de recorrência não trava a API.
  sqlite.pragma('journal_mode = WAL');
  // FULL faz fsync a cada commit. O volume de escrita aqui é ínfimo e o custo
  // de perder o último lançamento num desligamento abrupto não vale a economia.
  sqlite.pragma('synchronous = FULL');
  // Precisa ser ligado por conexão; sem isso o SQLite ignora as foreign keys.
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
}

export interface CreateDbOptions {
  /** Caminho do arquivo, ou `':memory:'`. Padrão: `DATABASE_PATH` do ambiente. */
  file?: string;
  /** Loga cada SQL executado. */
  debug?: boolean;
}

export interface DbHandle {
  db: Db;
  sqlite: SqliteConnection;
  close(): void;
}

/**
 * Cria uma conexão nova. Usada pelos testes (arquivo temporário ou memória) e
 * pelo singleton da aplicação.
 */
export function createDb(options: CreateDbOptions = {}): DbHandle {
  const file = options.file ?? databaseFile;

  if (file !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
  }

  const sqlite = new Database(file);
  applyPragmas(sqlite);

  const db = drizzle(sqlite, {
    schema,
    // Converte `createdAt` → `created_at` sem repetir o nome em cada coluna.
    casing: 'snake_case',
    logger: options.debug ?? env.LOG_LEVEL === 'trace',
  });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

let handle: DbHandle | undefined;

/** Conexão compartilhada da aplicação, criada na primeira chamada. */
export function getDb(): Db {
  handle ??= createDb();
  return handle.db;
}

/** Conexão SQLite crua — para pragmas, backup e SQL analítico pesado. */
export function getSqlite(): SqliteConnection {
  handle ??= createDb();
  return handle.sqlite;
}

export function closeDb(): void {
  handle?.close();
  handle = undefined;
}

export { schema };
