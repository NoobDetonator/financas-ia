/**
 * Aplicação das migrations.
 *
 * Roda automaticamente na partida do servidor: um banco desatualizado é um erro
 * de operação silencioso, e num app pessoal não existe pipeline de deploy para
 * lembrar de rodar migration na mão.
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { migrationsDir } from '../config/env.js';
import { createDb, type Db } from './client.js';

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: migrationsDir });
}

// Executado por `npm run db:migrate`.
if (import.meta.filename === process.argv[1]) {
  const handle = createDb();
  try {
    runMigrations(handle.db);
    console.log('Migrations aplicadas.');
  } finally {
    handle.close();
  }
}
