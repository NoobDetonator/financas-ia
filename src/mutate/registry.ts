/**
 * Registro das entidades auditáveis.
 *
 * O `undo` é genérico: ele lê `before`/`after` do `audit_log` e reaplica sem
 * saber de qual tabela se trata. Para isso precisa, por entidade, saber (a) qual
 * é a tabela Drizzle, (b) como extrair a chave de uma linha e (c) como montar o
 * `WHERE` a partir dessa chave — o que cobre tanto PK simples quanto composta.
 *
 * `change_sets` e `audit_log` **não** entram aqui de propósito: auditar a
 * auditoria seria regresso infinito. Essas duas tabelas são escritas
 * diretamente pelo `mutate()`.
 */

import { and, eq, type SQL } from 'drizzle-orm';
import type { SQLiteTable, AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
  accounts,
  creditCards,
  categories,
  payees,
  tags,
  transactions,
  transactionSplits,
  transactionTags,
  cardInvoices,
  installmentPlans,
  recurrences,
  budgets,
  goals,
  goalContributions,
  debts,
  debtPayments,
  holdings,
  investmentTransactions,
  positionSnapshots,
  rules,
  importBatches,
  importRows,
  attachments,
  settings,
} from '../db/schema.js';

type Row = Record<string, unknown>;

/**
 * Separador da chave composta em `audit_log.entity_id`. ULIDs são alfanuméricos
 * maiúsculos, então `::` nunca aparece dentro de um componente da chave.
 */
const KEY_SEPARATOR = '::';

export interface EntityConfig {
  table: SQLiteTable;
  /** Colunas que formam a chave primária. */
  keyFields: readonly string[];
  /** Chave da linha, como gravada em `audit_log.entity_id`. */
  key(row: Row): string;
  /** Predicado que seleciona exatamente a linha da chave. */
  where(key: string): SQL;
}

/**
 * Descreve uma entidade auditável.
 *
 * Valida os nomes de coluna já na carga do módulo: um campo de chave escrito
 * errado viraria `undefined` num `WHERE` e apagaria a tabela toda no undo.
 */
function entity(table: SQLiteTable, keyFields: readonly string[] = ['id']): EntityConfig {
  const columns = table as unknown as Record<string, AnySQLiteColumn | undefined>;

  for (const field of keyFields) {
    if (!columns[field]) {
      const available = Object.keys(table).join(', ');
      throw new Error(
        `Registro de auditoria inválido: coluna "${field}" não existe na tabela. Disponíveis: ${available}`,
      );
    }
  }

  return {
    table,
    keyFields,
    key: (row) => keyFields.map((field) => String(row[field])).join(KEY_SEPARATOR),
    where: (key) => {
      const parts = key.split(KEY_SEPARATOR);
      if (parts.length !== keyFields.length) {
        throw new Error(
          `Chave "${key}" tem ${parts.length} parte(s), esperado ${keyFields.length}.`,
        );
      }
      const predicates = keyFields.map((field, i) => eq(columns[field]!, parts[i]!));
      // `and` de um único predicado devolve ele mesmo; nunca é undefined aqui
      // porque `keyFields` tem ao menos um elemento.
      return and(...predicates)!;
    },
  };
}

export const ENTITIES = {
  accounts: entity(accounts),
  // Cartão estende a conta 1:1; a PK é a própria conta.
  credit_cards: entity(creditCards, ['accountId']),
  categories: entity(categories),
  payees: entity(payees),
  tags: entity(tags),
  transactions: entity(transactions),
  transaction_splits: entity(transactionSplits),
  transaction_tags: entity(transactionTags, ['transactionId', 'tagId']),
  card_invoices: entity(cardInvoices),
  installment_plans: entity(installmentPlans),
  recurrences: entity(recurrences),
  budgets: entity(budgets),
  goals: entity(goals),
  goal_contributions: entity(goalContributions),
  debts: entity(debts),
  debt_payments: entity(debtPayments),
  holdings: entity(holdings),
  investment_transactions: entity(investmentTransactions),
  position_snapshots: entity(positionSnapshots),
  rules: entity(rules),
  import_batches: entity(importBatches),
  import_rows: entity(importRows),
  attachments: entity(attachments),
  settings: entity(settings),
} as const satisfies Record<string, EntityConfig>;

export type EntityName = keyof typeof ENTITIES;

export function entityConfig(name: EntityName): EntityConfig {
  const config: EntityConfig | undefined = ENTITIES[name];
  if (!config) {
    throw new Error(`Entidade desconhecida no registro de auditoria: "${String(name)}"`);
  }
  return config;
}
