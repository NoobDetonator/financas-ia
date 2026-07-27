/**
 * Schemas de resposta da API.
 *
 * Gerados por `drizzle-zod` a partir do schema do banco, em vez de escritos à
 * mão: uma coluna nova aparece na documentação e na serialização sem que ninguém
 * precise lembrar de atualizar dois lugares. É o mesmo motivo pelo qual o schema
 * Drizzle é a fonte única de verdade.
 */

import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';
import {
  accounts,
  attachments,
  auditLog,
  budgets,
  cardInvoices,
  categories,
  changeSets,
  creditCards,
  debtPayments,
  debts,
  goalContributions,
  goals,
  holdings,
  importBatches,
  importRows,
  insights,
  installmentPlans,
  investmentTransactions,
  payees,
  positionSnapshots,
  recurrences,
  reports,
  rules,
  settings,
  tags,
  transactionSplits,
  transactions,
} from '../db/schema.js';

export const accountDto = createSelectSchema(accounts);
export const creditCardDto = createSelectSchema(creditCards);
export const accountWithCardDto = accountDto.extend({ card: creditCardDto.nullable() });

export const categoryDto = createSelectSchema(categories);
export const categoryTreeDto = categoryDto.extend({ children: z.array(categoryDto) });

export const payeeDto = createSelectSchema(payees);
export const tagDto = createSelectSchema(tags);

export const transactionDto = createSelectSchema(transactions);
export const transactionSplitDto = createSelectSchema(transactionSplits);
export const transactionDetailDto = transactionDto.extend({
  splits: z.array(transactionSplitDto),
  tags: z.array(tagDto),
  attachmentCount: z.number().int(),
});

export const cardInvoiceDto = createSelectSchema(cardInvoices);
export const installmentPlanDto = createSelectSchema(installmentPlans);
export const recurrenceDto = createSelectSchema(recurrences);
export const budgetDto = createSelectSchema(budgets);
export const goalDto = createSelectSchema(goals);
export const goalContributionDto = createSelectSchema(goalContributions);
export const debtDto = createSelectSchema(debts);
export const debtPaymentDto = createSelectSchema(debtPayments);
export const holdingDto = createSelectSchema(holdings);
export const investmentTransactionDto = createSelectSchema(investmentTransactions);
export const positionSnapshotDto = createSelectSchema(positionSnapshots);
export const ruleDto = createSelectSchema(rules);
export const importBatchDto = createSelectSchema(importBatches);
export const importRowDto = createSelectSchema(importRows);
export const attachmentDto = createSelectSchema(attachments);
export const changeSetDto = createSelectSchema(changeSets);
export const auditEntryDto = createSelectSchema(auditLog);
export const insightDto = createSelectSchema(insights);
export const reportDto = createSelectSchema(reports);
export const settingsDto = createSelectSchema(settings);

// ── Envelopes ───────────────────────────────────────────────────────────────

/**
 * Resposta de escrita. Carrega o `changeSetId` para que qualquer cliente —
 * inclusive a IA — possa oferecer "desfazer" sem consultar mais nada.
 */
export function writeResponse<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    changeSetId: z.string().describe('Passe para POST /change-sets/{id}/undo'),
    touched: z.number().int().describe('Linhas afetadas'),
  });
}

export function pageResponse<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  });
}

export const errorResponseDto = z.object({
  error: z.string().describe('Código do erro: NOT_FOUND, VALIDATION, RULE_VIOLATION…'),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const idParamDto = z.object({ id: z.string().min(1) });

export const okDto = z.object({ ok: z.literal(true) });
