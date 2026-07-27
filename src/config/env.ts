/**
 * Configuração vinda do ambiente, validada na partida.
 *
 * O processo falha imediatamente se algo essencial estiver ausente ou
 * malformado — melhor não subir do que subir e falhar na primeira requisição
 * com um `undefined` no meio de uma transação de banco.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import 'dotenv/config';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'sim'].includes(v.toLowerCase())));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3333),
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_PATH: z.string().min(1).default('./data/finance.db'),

  APP_PASSWORD: z.string().default(''),
  SESSION_SECRET: z.string().default(''),
  AUTH_DISABLED: booleanish.default(false),

  AI_PROVIDER: z.enum(['deepseek', 'anthropic', 'openai']).default('deepseek'),
  AI_MODEL: z.string().min(1).default('deepseek-chat'),
  DEEPSEEK_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),

  TZ: z.string().min(1).default('America/Sao_Paulo'),
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${issues}\n\nVeja .env.example.`);
  }
  return parsed.data;
}

export const env = load();

/** Caminho absoluto do arquivo SQLite. */
export const databaseFile = resolve(projectRoot, env.DATABASE_PATH);
/** Pasta de dados: banco, backups e anexos. */
export const dataDir = dirname(databaseFile);
export const backupsDir = resolve(dataDir, 'backups');
export const attachmentsDir = resolve(dataDir, 'attachments');
export const migrationsDir = resolve(projectRoot, 'drizzle');

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Autenticação só pode ser desligada quando o servidor está preso ao loopback.
 * Expor a rede local sem senha deixaria as finanças abertas para qualquer
 * dispositivo no Wi-Fi — inclusive o da visita.
 */
export function authConfig(): { enabled: boolean; reason?: string } {
  const boundToLoopback = env.HOST === '127.0.0.1' || env.HOST === 'localhost' || env.HOST === '::1';

  if (!env.AUTH_DISABLED) return { enabled: true };
  if (!boundToLoopback) {
    return {
      enabled: true,
      reason: `AUTH_DISABLED=true foi ignorado porque HOST="${env.HOST}" expõe o servidor na rede. Defina uma APP_PASSWORD.`,
    };
  }
  return { enabled: false };
}

/** Chave da IA (DeepSeek). */
export function aiApiKey(): string {
  return env.DEEPSEEK_API_KEY;
}

export function hasAiKey(): boolean {
  return aiApiKey().trim().length > 0;
}
