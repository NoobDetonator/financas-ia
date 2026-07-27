import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Precisa espelhar o `casing` do client em src/db/client.ts, senão as
  // migrations geram colunas com nome diferente do que o runtime consulta.
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/finance.db',
  },
  strict: true,
  verbose: true,
});
