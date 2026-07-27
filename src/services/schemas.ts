/**
 * Schemas zod compartilhados.
 *
 * Um schema serve três consumidores: validação da rota HTTP, geração do OpenAPI
 * e definição de parâmetro das ferramentas da IA. Sem isso a validação divergiria
 * entre "o que a API aceita" e "o que a IA consegue mandar".
 *
 * **Convenção de dinheiro na fronteira:** a API e os serviços falam
 * exclusivamente em `...Cents` (inteiro). Texto humano ("R$ 45,90", "1.500") é
 * convertido por `parseMoney` na camada de IA, antes de chegar aqui. Assim não
 * existe ambiguidade entre "45" significando R$ 45,00 ou 45 centavos.
 */

import { z } from 'zod';
import { isIsoDate, isMonthKeyLike } from '../core/clock.js';
import {
  ACCOUNT_KINDS,
  CATEGORY_KINDS,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
} from '../db/schema.js';

export const idSchema = z.string().min(1, 'ID obrigatório').max(64);

export const isoDateSchema = z
  .string()
  .refine(isIsoDate, 'Data inválida. Use o formato AAAA-MM-DD.')
  .describe('Data no formato AAAA-MM-DD');

export const monthKeySchema = z
  .string()
  .refine(isMonthKeyLike, 'Mês inválido. Use o formato AAAA-MM.')
  .describe('Mês de referência no formato AAAA-MM');

/** Valor monetário em centavos inteiros. */
export const centsSchema = z
  .number()
  .int('Valores monetários são inteiros em centavos.')
  .describe('Valor em centavos (4590 = R$ 45,90)');

/** Valor positivo em centavos — o serviço aplica o sinal conforme o tipo. */
export const positiveCentsSchema = centsSchema.refine((v) => v > 0, 'O valor deve ser maior que zero.');

export const accountKindSchema = z.enum(ACCOUNT_KINDS);
export const categoryKindSchema = z.enum(CATEGORY_KINDS);
export const transactionTypeSchema = z.enum(TRANSACTION_TYPES);
export const transactionStatusSchema = z.enum(TRANSACTION_STATUS);

/** Dia do mês, aceitando -1 como "último dia". */
export const dayOfMonthSchema = z
  .number()
  .int()
  .refine((v) => v === -1 || (v >= 1 && v <= 31), 'Dia deve estar entre 1 e 31, ou -1 para o último dia do mês.');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** Metadados de listagem paginada. */
export const pageMetaSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

/** Envelope devolvido por rotas de escrita — permite oferecer "desfazer". */
export const writeMetaSchema = z.object({
  changeSetId: z.string().describe('Use em POST /change-sets/{id}/undo para reverter'),
  touched: z.number().int().describe('Linhas afetadas'),
});

export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato #RRGGBB')
  .optional();
