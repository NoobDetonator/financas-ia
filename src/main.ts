/**
 * Ponto de entrada do servidor.
 *
 * Migrations e bootstrap rodam antes de aceitar a primeira requisição: num app
 * pessoal não existe pipeline de deploy para lembrar de rodá-los, e um banco
 * desatualizado falharia de forma confusa na primeira consulta.
 */

import { buildApp } from './api/app.js';
import { authConfig, env, databaseFile } from './config/env.js';
import { getDb, closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { bootstrap } from './db/bootstrap.js';
import { startScheduler, stopScheduler } from './jobs/index.js';

async function main(): Promise<void> {
  const db = getDb();
  runMigrations(db);

  const seeded = bootstrap(db);

  const app = await buildApp();

  const auth = authConfig();
  if (auth.reason) {
    app.log.warn(auth.reason);
  }
  if (!auth.enabled) {
    app.log.warn('Autenticação desligada — servidor acessível apenas em 127.0.0.1.');
  }

  if (seeded.categoriesCreated > 0) {
    app.log.info(`Banco novo preparado com ${seeded.categoriesCreated} categorias padrão.`);
  }
  app.log.info(`Banco: ${databaseFile}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Recebido ${signal}, encerrando.`);
    stopScheduler();
    await app.close();
    closeDb();
    process.exit(0);
  };

  startScheduler(app.log);

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Documentação da API em http://${env.HOST}:${env.PORT}/docs`);
}

main().catch((error: unknown) => {
  console.error('Falha ao iniciar o servidor:');
  console.error(error);
  process.exit(1);
});
