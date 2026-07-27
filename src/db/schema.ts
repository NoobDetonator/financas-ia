/**
 * Schema do banco — fonte única de verdade do domínio.
 *
 * Convenções aplicadas em todas as tabelas:
 *  • IDs são ULID (`text`), ordenáveis por criação. Ver `core/ids.ts`.
 *  • Dinheiro é **sempre** `integer` em centavos, com sufixo `Cents`. Ver `core/money.ts`.
 *  • Datas civis são `text` `YYYY-MM-DD`; timestamps são `text` ISO UTC. Ver `core/clock.ts`.
 *  • Booleanos são `integer` com `mode: 'boolean'`.
 *  • Nomes de coluna vão para snake_case automaticamente (`casing: 'snake_case'` no client).
 *
 * Sobre `onDelete`: o padrão é `restrict`, para o banco recusar apagar algo
 * ainda referenciado em vez de destruir histórico em silêncio. `cascade` só
 * aparece onde a linha filha não tem existência própria (rateios, vínculos de
 * tag, linhas de importação).
 *
 * ⚠️ Mesmo onde há `cascade`, os serviços devem apagar os filhos
 * explicitamente, um a um, para que cada remoção entre no `audit_log`. Um
 * cascade silencioso do SQLite não é auditado e, por consequência, não é
 * desfeito pelo `undo`.
 */

import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { newId } from '../core/ids.js';
import { nowIso } from '../core/clock.js';

/**
 * Valor JSON arbitrário. Usado nas colunas `mode: 'json'` que guardam estrutura
 * livre (diff de preview, partes de mensagem da IA, argumentos de ferramenta).
 *
 * Precisa ser este tipo e não `unknown`: o `drizzle-zod` deriva os schemas de
 * resposta da API a partir daqui, e `unknown` não descreve algo serializável.
 */
export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

// ── Vocabulário do domínio ──────────────────────────────────────────────────

export const ACCOUNT_KINDS = [
  'checking', // conta corrente
  'savings', // poupança
  'cash', // dinheiro em espécie
  'wallet', // carteira digital (PicPay, Mercado Pago…)
  'investment', // conta de investimento
  'credit_card', // cartão de crédito (saldo = dívida atual)
] as const;

export const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;

/**
 * Ciclo de vida da transação:
 * `scheduled` (futura, gerada por recorrência) → `pending` (ocorreu, a confirmar)
 * → `cleared` (efetivada) → `reconciled` (conferida contra o extrato).
 *
 * Saldo *disponível* soma apenas `cleared`/`reconciled`.
 * Saldo *projetado* soma também `pending` e `scheduled`.
 */
export const TRANSACTION_STATUS = ['scheduled', 'pending', 'cleared', 'reconciled'] as const;

export const CATEGORY_KINDS = ['expense', 'income'] as const;
export const INVOICE_STATUS = ['open', 'closed', 'paid', 'overdue'] as const;
export const RECURRENCE_FREQ = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export const ACTORS = ['user', 'ai', 'system'] as const;
export const CHANGE_SET_SOURCES = ['api', 'ai', 'import', 'job', 'cli', 'seed'] as const;
export const CHANGE_SET_STATUS = ['applied', 'pending', 'reverted', 'rejected'] as const;
export const RISK_LEVELS = ['auto', 'confirm'] as const;
export const AUDIT_ACTIONS = ['insert', 'update', 'delete'] as const;
export const DEBT_KINDS = ['loan', 'financing', 'installment_debt', 'other'] as const;
export const AMORTIZATION_SYSTEMS = ['sac', 'price'] as const;
export const ASSET_CLASSES = [
  'stock', 'fii', 'etf', 'fixed_income', 'crypto', 'fund', 'pension', 'other',
] as const;
export const INVESTMENT_OPS = ['buy', 'sell', 'dividend', 'interest', 'fee', 'adjust'] as const;
export const GOAL_STATUS = ['active', 'done', 'archived'] as const;
export const IMPORT_SOURCES = ['csv', 'ofx', 'manual'] as const;
export const IMPORT_BATCH_STATUS = ['parsed', 'applied', 'reverted'] as const;
export const IMPORT_ROW_STATUS = ['new', 'duplicate', 'imported', 'skipped', 'failed'] as const;
export const INSIGHT_SEVERITY = ['info', 'warn', 'critical'] as const;
export const INSIGHT_STATUS = ['new', 'seen', 'dismissed'] as const;
export const AI_ACTION_STATUS = ['executed', 'pending', 'rejected', 'failed'] as const;

// ── Builders reutilizados ───────────────────────────────────────────────────

const pk = () => text().primaryKey().$defaultFn(newId);
const createdAt = () => text().notNull().$defaultFn(nowIso);
const updatedAt = () =>
  text()
    .notNull()
    .$defaultFn(nowIso)
    .$onUpdateFn(nowIso);

// ── Contas ──────────────────────────────────────────────────────────────────

export const accounts = sqliteTable(
  'accounts',
  {
    id: pk(),
    name: text().notNull(),
    kind: text({ enum: ACCOUNT_KINDS }).notNull(),
    institution: text(),
    currency: text().notNull().default('BRL'),
    /** Saldo antes da primeira transação registrada no sistema. */
    openingBalanceCents: integer().notNull().default(0),
    openingDate: text().notNull(),
    color: text(),
    icon: text(),
    notes: text(),
    /** Apelidos usados pela IA para reconhecer a conta ("nubank", "conta do bradesco"). */
    aliases: text({ mode: 'json' }).$type<string[]>(),
    isArchived: integer({ mode: 'boolean' }).notNull().default(false),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('accounts_kind_idx').on(t.kind), index('accounts_archived_idx').on(t.isArchived)],
);

/** Dados exclusivos de cartão de crédito. Estende 1:1 uma conta `kind='credit_card'`. */
export const creditCards = sqliteTable('credit_cards', {
  accountId: text()
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  limitCents: integer().notNull().default(0),
  /** Dia do fechamento da fatura (1-31, ou -1 para último dia do mês). */
  closingDay: integer().notNull(),
  /** Dia do vencimento (1-31, ou -1). Se menor que o fechamento, vence no mês seguinte. */
  dueDay: integer().notNull(),
  /** Conta usada por padrão para pagar a fatura. */
  paymentAccountId: text().references(() => accounts.id, { onDelete: 'set null' }),
  notes: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Categorias, favorecidos e tags ──────────────────────────────────────────

export const categories = sqliteTable(
  'categories',
  {
    id: pk(),
    name: text().notNull(),
    kind: text({ enum: CATEGORY_KINDS }).notNull(),
    /** Categoria mãe. `null` = categoria raiz. */
    parentId: text().references((): any => categories.id, { onDelete: 'restrict' }),
    color: text(),
    icon: text(),
    /** Criada pelo sistema no bootstrap; não pode ser apagada. */
    isSystem: integer({ mode: 'boolean' }).notNull().default(false),
    isArchived: integer({ mode: 'boolean' }).notNull().default(false),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('categories_parent_idx').on(t.parentId),
    index('categories_kind_idx').on(t.kind),
  ],
);

export const payees = sqliteTable(
  'payees',
  {
    id: pk(),
    name: text().notNull(),
    /** Nome sem acento/caixa, para casar descrições de extrato. */
    normalizedName: text().notNull(),
    defaultCategoryId: text().references(() => categories.id, { onDelete: 'set null' }),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('payees_normalized_unique').on(t.normalizedName)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: pk(),
    name: text().notNull(),
    normalizedName: text().notNull(),
    color: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tags_normalized_unique').on(t.normalizedName)],
);

// ── Transações ──────────────────────────────────────────────────────────────

export const transactions = sqliteTable(
  'transactions',
  {
    id: pk(),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    type: text({ enum: TRANSACTION_TYPES }).notNull(),
    /** Data de competência — quando o gasto aconteceu. */
    date: text().notNull(),
    /** Data de efetivação no extrato, quando difere da competência. */
    postedDate: text(),
    /** Negativo = saída, positivo = entrada. */
    amountCents: integer().notNull(),
    currency: text().notNull().default('BRL'),
    description: text().notNull(),
    notes: text(),
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    payeeId: text().references(() => payees.id, { onDelete: 'set null' }),
    status: text({ enum: TRANSACTION_STATUS }).notNull().default('cleared'),

    /** Une as duas pernas de uma transferência. Ver `services/transfers`. */
    transferId: text(),
    /** `true` quando o valor está rateado em `transaction_splits`. */
    hasSplits: integer({ mode: 'boolean' }).notNull().default(false),

    installmentPlanId: text().references(() => installmentPlans.id, { onDelete: 'cascade' }),
    /** Número desta parcela (1-based). */
    installmentNo: integer(),

    recurrenceId: text().references(() => recurrences.id, { onDelete: 'set null' }),
    /** Data da ocorrência que gerou esta linha — garante idempotência do materializador. */
    recurrenceOccurrence: text(),

    cardInvoiceId: text().references((): any => cardInvoices.id, { onDelete: 'set null' }),
    goalId: text().references((): any => goals.id, { onDelete: 'set null' }),
    debtId: text().references((): any => debts.id, { onDelete: 'set null' }),
    importRowId: text(),

    /** Hash usado para não importar a mesma linha de extrato duas vezes. */
    dedupeHash: text(),
    /** Identificador do lado do banco (FITID do OFX, por exemplo). */
    externalId: text(),

    createdBy: text({ enum: ACTORS }).notNull().default('user'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tx_account_date_idx').on(t.accountId, t.date),
    index('tx_date_idx').on(t.date),
    index('tx_category_idx').on(t.categoryId),
    index('tx_payee_idx').on(t.payeeId),
    index('tx_status_idx').on(t.status),
    index('tx_transfer_idx').on(t.transferId),
    index('tx_invoice_idx').on(t.cardInvoiceId),
    index('tx_plan_idx').on(t.installmentPlanId),
    index('tx_dedupe_idx').on(t.dedupeHash),
    // Impede a recorrência de gerar duas vezes a mesma ocorrência.
    uniqueIndex('tx_recurrence_occurrence_unique').on(t.recurrenceId, t.recurrenceOccurrence),
  ],
);

/** Rateio de uma transação entre várias categorias. Soma = valor da transação. */
export const transactionSplits = sqliteTable(
  'transaction_splits',
  {
    id: pk(),
    transactionId: text()
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    amountCents: integer().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index('splits_tx_idx').on(t.transactionId)],
);

export const transactionTags = sqliteTable(
  'transaction_tags',
  {
    transactionId: text()
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    tagId: text()
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.tagId] }),
    index('tx_tags_tag_idx').on(t.tagId),
  ],
);

// ── Cartão de crédito: faturas e parcelamentos ──────────────────────────────

export const cardInvoices = sqliteTable(
  'card_invoices',
  {
    id: pk(),
    cardAccountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** Mês de referência `YYYY-MM`, definido pela data de vencimento. */
    referenceMonth: text().notNull(),
    closingDate: text().notNull(),
    dueDate: text().notNull(),
    status: text({ enum: INVOICE_STATUS }).notNull().default('open'),
    /** Total consolidado das transações da fatura (cache; recalculável). */
    totalCents: integer().notNull().default(0),
    paidCents: integer().notNull().default(0),
    /** Transação de pagamento (perna de entrada na conta-cartão). */
    paymentTransactionId: text(),
    closedAt: text(),
    paidAt: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Um cartão tem exatamente uma fatura por mês de referência.
    uniqueIndex('invoice_card_month_unique').on(t.cardAccountId, t.referenceMonth),
    index('invoice_due_idx').on(t.dueDate),
    index('invoice_status_idx').on(t.status),
  ],
);

export const installmentPlans = sqliteTable(
  'installment_plans',
  {
    id: pk(),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    description: text().notNull(),
    /** Valor total da compra. A soma das parcelas é exatamente este valor. */
    totalCents: integer().notNull(),
    installments: integer().notNull(),
    purchaseDate: text().notNull(),
    /** Data da primeira parcela (pode cair em fatura futura). */
    firstChargeDate: text().notNull(),
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    payeeId: text().references(() => payees.id, { onDelete: 'set null' }),
    notes: text(),
    createdBy: text({ enum: ACTORS }).notNull().default('user'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('plans_account_idx').on(t.accountId)],
);

// ── Recorrências ────────────────────────────────────────────────────────────

export const recurrences = sqliteTable(
  'recurrences',
  {
    id: pk(),
    name: text().notNull(),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    type: text({ enum: TRANSACTION_TYPES }).notNull(),
    /** `null` = valor variável (conta de luz); o materializador cria como estimativa. */
    amountCents: integer(),
    /** Estimativa usada quando `amountCents` é nulo — média dos últimos lançamentos. */
    estimatedCents: integer(),
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    payeeId: text().references(() => payees.id, { onDelete: 'set null' }),

    freq: text({ enum: RECURRENCE_FREQ }).notNull(),
    /** A cada N períodos. `freq='monthly'` + `interval=3` = trimestral. */
    interval: integer().notNull().default(1),
    /** Para `monthly`/`yearly`: dia do mês (1-31, ou -1 para o último dia). */
    dayOfMonth: integer(),
    /** Para `weekly`: 0 = domingo … 6 = sábado. */
    weekday: integer(),
    /** Para `yearly`: mês 1-12. */
    month: integer(),

    startDate: text().notNull(),
    endDate: text(),
    maxOccurrences: integer(),

    /** `true` = lança como efetivada na data. `false` = fica pendente de confirmação. */
    autoPost: integer({ mode: 'boolean' }).notNull().default(false),
    isActive: integer({ mode: 'boolean' }).notNull().default(true),
    /** Até que data as ocorrências futuras já foram materializadas. */
    materializedThrough: text(),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recurrences_active_idx').on(t.isActive),
    index('recurrences_account_idx').on(t.accountId),
  ],
);

// ── Orçamentos ──────────────────────────────────────────────────────────────

export const budgets = sqliteTable(
  'budgets',
  {
    id: pk(),
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    amountCents: integer().notNull(),
    /** Primeiro mês de vigência (`YYYY-MM`). */
    startMonth: text().notNull(),
    /** Último mês de vigência. `null` = vale indefinidamente. */
    endMonth: text(),
    /** Sobra do mês soma ao limite do mês seguinte. */
    rollover: integer({ mode: 'boolean' }).notNull().default(false),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('budgets_category_idx').on(t.categoryId, t.startMonth)],
);

// ── Metas e reservas ────────────────────────────────────────────────────────

export const goals = sqliteTable(
  'goals',
  {
    id: pk(),
    name: text().notNull(),
    targetCents: integer().notNull(),
    targetDate: text(),
    /** Conta onde o dinheiro fica guardado. `null` = reserva virtual (caixinha). */
    accountId: text().references(() => accounts.id, { onDelete: 'set null' }),
    color: text(),
    icon: text(),
    status: text({ enum: GOAL_STATUS }).notNull().default('active'),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('goals_status_idx').on(t.status)],
);

export const goalContributions = sqliteTable(
  'goal_contributions',
  {
    id: pk(),
    goalId: text()
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    /** Transação correspondente, quando o aporte moveu dinheiro de verdade. */
    transactionId: text().references(() => transactions.id, { onDelete: 'set null' }),
    /** Positivo = aporte, negativo = resgate. */
    amountCents: integer().notNull(),
    date: text().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index('goal_contrib_goal_idx').on(t.goalId, t.date)],
);

// ── Dívidas e financiamentos ────────────────────────────────────────────────

export const debts = sqliteTable(
  'debts',
  {
    id: pk(),
    name: text().notNull(),
    kind: text({ enum: DEBT_KINDS }).notNull().default('loan'),
    /** Valor financiado na origem. */
    principalCents: integer().notNull(),
    /** Taxa de juros **anual** em basis points: 1250 = 12,50% a.a. */
    annualRateBps: integer().notNull().default(0),
    termMonths: integer().notNull(),
    system: text({ enum: AMORTIZATION_SYSTEMS }).notNull().default('price'),
    startDate: text().notNull(),
    firstDueDate: text().notNull(),
    /** Conta de onde saem as parcelas. */
    accountId: text().references(() => accounts.id, { onDelete: 'set null' }),
    categoryId: text().references(() => categories.id, { onDelete: 'set null' }),
    isSettled: integer({ mode: 'boolean' }).notNull().default(false),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('debts_settled_idx').on(t.isSettled)],
);

/** Cronograma de amortização. Uma linha por parcela, gerada na criação da dívida. */
export const debtPayments = sqliteTable(
  'debt_payments',
  {
    id: pk(),
    debtId: text()
      .notNull()
      .references(() => debts.id, { onDelete: 'cascade' }),
    transactionId: text().references(() => transactions.id, { onDelete: 'set null' }),
    installmentNo: integer().notNull(),
    dueDate: text().notNull(),
    paidDate: text(),
    /** Parcela total = amortização + juros. */
    amountCents: integer().notNull(),
    principalCents: integer().notNull(),
    interestCents: integer().notNull(),
    /** Saldo devedor após esta parcela. */
    balanceAfterCents: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('debt_payment_no_unique').on(t.debtId, t.installmentNo),
    index('debt_payment_due_idx').on(t.dueDate),
  ],
);

// ── Investimentos ───────────────────────────────────────────────────────────

export const holdings = sqliteTable(
  'holdings',
  {
    id: pk(),
    name: text().notNull(),
    ticker: text(),
    assetClass: text({ enum: ASSET_CLASSES }).notNull().default('other'),
    accountId: text().references(() => accounts.id, { onDelete: 'set null' }),
    currency: text().notNull().default('BRL'),
    /** Quantidade em unidades de 1e-8 — precisão exata inclusive para cripto. */
    quantityE8: integer().notNull().default(0),
    /**
     * Custo total acumulado. O preço médio é derivado
     * (`totalCostCents / quantidade`) em vez de armazenado, para não acumular
     * erro de arredondamento a cada aporte.
     */
    totalCostCents: integer().notNull().default(0),
    isArchived: integer({ mode: 'boolean' }).notNull().default(false),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('holdings_class_idx').on(t.assetClass)],
);

export const investmentTransactions = sqliteTable(
  'investment_transactions',
  {
    id: pk(),
    holdingId: text()
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    op: text({ enum: INVESTMENT_OPS }).notNull(),
    date: text().notNull(),
    /** Quantidade movimentada (1e-8). Zero em dividendo/juros/taxa. */
    quantityE8: integer().notNull().default(0),
    /** Movimento financeiro: negativo = aporte, positivo = resgate/provento. */
    amountCents: integer().notNull(),
    feeCents: integer().notNull().default(0),
    /** Transação no caixa que financiou a operação. */
    transactionId: text().references(() => transactions.id, { onDelete: 'set null' }),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index('inv_tx_holding_idx').on(t.holdingId, t.date)],
);

/** Valor de mercado informado manualmente numa data — base da rentabilidade. */
export const positionSnapshots = sqliteTable(
  'position_snapshots',
  {
    id: pk(),
    holdingId: text()
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    date: text().notNull(),
    marketValueCents: integer().notNull(),
    quantityE8: integer().notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('snapshot_holding_date_unique').on(t.holdingId, t.date)],
);

// ── Regras de auto-categorização ────────────────────────────────────────────

// Declarados como `type` e não `interface` de propósito: apenas type aliases
// recebem index signature implícita, o que é o que permite ao drizzle-zod
// tratá-los como JSON serializável.
export type RuleConditions = {
  descriptionContains?: string;
  descriptionRegex?: string;
  payeeId?: string;
  accountId?: string;
  type?: (typeof TRANSACTION_TYPES)[number];
  minAmountCents?: number;
  maxAmountCents?: number;
};

export type RuleActions = {
  categoryId?: string;
  payeeId?: string;
  addTagIds?: string[];
  setDescription?: string;
  setNotes?: string;
};

export const rules = sqliteTable(
  'rules',
  {
    id: pk(),
    name: text().notNull(),
    /** Menor número roda primeiro. */
    priority: integer().notNull().default(100),
    isEnabled: integer({ mode: 'boolean' }).notNull().default(true),
    /** Para de avaliar as regras seguintes quando esta casar. */
    stopOnMatch: integer({ mode: 'boolean' }).notNull().default(true),
    conditions: text({ mode: 'json' }).$type<RuleConditions>().notNull(),
    actions: text({ mode: 'json' }).$type<RuleActions>().notNull(),
    matchCount: integer().notNull().default(0),
    lastMatchedAt: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('rules_enabled_priority_idx').on(t.isEnabled, t.priority)],
);

// ── Importação de extratos ──────────────────────────────────────────────────

export const importBatches = sqliteTable(
  'import_batches',
  {
    id: pk(),
    source: text({ enum: IMPORT_SOURCES }).notNull(),
    filename: text().notNull(),
    accountId: text()
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** SHA-256 do arquivo — detecta reimportação do mesmo extrato. */
    fileHash: text().notNull(),
    status: text({ enum: IMPORT_BATCH_STATUS }).notNull().default('parsed'),
    stats: text({ mode: 'json' }).$type<Record<string, number>>(),
    /** Change set gerado na aplicação, usado para reverter o lote inteiro. */
    changeSetId: text(),
    createdAt: createdAt(),
    appliedAt: text(),
    revertedAt: text(),
  },
  (t) => [index('import_batch_account_idx').on(t.accountId), index('import_batch_hash_idx').on(t.fileHash)],
);

export const importRows = sqliteTable(
  'import_rows',
  {
    id: pk(),
    batchId: text()
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    lineNo: integer().notNull(),
    raw: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    parsed: text({ mode: 'json' }).$type<Record<string, unknown>>(),
    dedupeHash: text(),
    status: text({ enum: IMPORT_ROW_STATUS }).notNull().default('new'),
    transactionId: text().references(() => transactions.id, { onDelete: 'set null' }),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index('import_rows_batch_idx').on(t.batchId), index('import_rows_dedupe_idx').on(t.dedupeHash)],
);

// ── Anexos ──────────────────────────────────────────────────────────────────

export const attachments = sqliteTable(
  'attachments',
  {
    id: pk(),
    transactionId: text()
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    filename: text().notNull(),
    /** Caminho relativo dentro de `data/attachments`. */
    storedPath: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    sha256: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_tx_idx').on(t.transactionId)],
);

// ── Auditoria e desfazer ────────────────────────────────────────────────────

/**
 * Agrupa as mutações de uma operação lógica. É a unidade de `undo`.
 *
 * Nada é escrito no banco fora de um change set — ver `mutate/`.
 */
export const changeSets = sqliteTable(
  'change_sets',
  {
    id: pk(),
    source: text({ enum: CHANGE_SET_SOURCES }).notNull(),
    actor: text({ enum: ACTORS }).notNull(),
    /** Resumo legível: "Criou transação Mercado R$ 45,90". */
    summary: text().notNull(),
    status: text({ enum: CHANGE_SET_STATUS }).notNull().default('applied'),
    risk: text({ enum: RISK_LEVELS }).notNull().default('auto'),
    /** Ferramenta da IA que originou a mudança, quando aplicável. */
    tool: text(),
    /** Diff proposto, para change sets `pending` aguardando confirmação. */
    preview: text({ mode: 'json' }).$type<JsonValue>(),
    /** Quando este change set desfaz outro, aponta para o original. */
    revertOf: text(),
    conversationId: text(),
    requestId: text(),
    createdAt: createdAt(),
    appliedAt: text(),
    revertedAt: text(),
  },
  (t) => [
    index('change_sets_status_idx').on(t.status),
    index('change_sets_created_idx').on(t.createdAt),
    index('change_sets_revert_idx').on(t.revertOf),
  ],
);

/**
 * Registro imutável de cada linha inserida, alterada ou removida.
 *
 * `before`/`after` guardam a linha inteira, o que torna o `undo` genérico:
 * basta reaplicar `before` na ordem inversa de `seq`.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: pk(),
    changeSetId: text()
      .notNull()
      .references(() => changeSets.id, { onDelete: 'restrict' }),
    /** Ordem dentro do change set. O `undo` percorre em ordem decrescente. */
    seq: integer().notNull(),
    at: createdAt(),
    actor: text({ enum: ACTORS }).notNull(),
    action: text({ enum: AUDIT_ACTIONS }).notNull(),
    /** Nome da tabela afetada. Resolvido para o objeto Drizzle em `mutate/registry`. */
    entity: text().notNull(),
    entityId: text().notNull(),
    before: text({ mode: 'json' }).$type<Record<string, unknown> | null>(),
    after: text({ mode: 'json' }).$type<Record<string, unknown> | null>(),
  },
  (t) => [
    uniqueIndex('audit_changeset_seq_unique').on(t.changeSetId, t.seq),
    index('audit_entity_idx').on(t.entity, t.entityId),
    index('audit_at_idx').on(t.at),
  ],
);

// ── IA: conversas, mensagens e ações ────────────────────────────────────────

export const aiConversations = sqliteTable('ai_conversations', {
  id: pk(),
  title: text(),
  model: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const aiMessages = sqliteTable(
  'ai_messages',
  {
    id: pk(),
    conversationId: text()
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    role: text({ enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
    /** Partes da mensagem no formato do AI SDK (texto, tool-call, tool-result). */
    content: text({ mode: 'json' }).$type<JsonValue>().notNull(),
    inputTokens: integer(),
    outputTokens: integer(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ai_messages_seq_unique').on(t.conversationId, t.seq)],
);

/** Toda execução de ferramenta pela IA, para você poder auditar o que ela fez. */
export const aiActions = sqliteTable(
  'ai_actions',
  {
    id: pk(),
    conversationId: text().references(() => aiConversations.id, { onDelete: 'cascade' }),
    messageId: text().references(() => aiMessages.id, { onDelete: 'set null' }),
    tool: text().notNull(),
    args: text({ mode: 'json' }).$type<JsonValue>().notNull(),
    risk: text({ enum: RISK_LEVELS }).notNull(),
    status: text({ enum: AI_ACTION_STATUS }).notNull(),
    changeSetId: text().references(() => changeSets.id, { onDelete: 'set null' }),
    result: text({ mode: 'json' }).$type<JsonValue>(),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [index('ai_actions_conv_idx').on(t.conversationId), index('ai_actions_status_idx').on(t.status)],
);

// ── Insights e relatórios ───────────────────────────────────────────────────

export const insights = sqliteTable(
  'insights',
  {
    id: pk(),
    /** Analisador que produziu o insight: `budget_overrun`, `spend_spike`… */
    kind: text().notNull(),
    severity: text({ enum: INSIGHT_SEVERITY }).notNull().default('info'),
    /** Período analisado (`YYYY-MM` ou data). */
    period: text(),
    title: text().notNull(),
    /** Números e IDs de transações que sustentam o insight. */
    data: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** Identidade lógica do insight — evita reemitir o mesmo achado. */
    fingerprint: text().notNull(),
    status: text({ enum: INSIGHT_STATUS }).notNull().default('new'),
    detectedAt: createdAt(),
  },
  (t) => [
    uniqueIndex('insights_fingerprint_unique').on(t.fingerprint),
    index('insights_status_idx').on(t.status, t.severity),
  ],
);

export const reports = sqliteTable(
  'reports',
  {
    id: pk(),
    kind: text({ enum: ['weekly', 'monthly', 'adhoc'] }).notNull(),
    periodStart: text().notNull(),
    periodEnd: text().notNull(),
    /** Texto narrado pela IA a partir dos insights determinísticos. */
    bodyMd: text().notNull(),
    insightIds: text({ mode: 'json' }).$type<string[]>(),
    model: text(),
    createdAt: createdAt(),
  },
  (t) => [index('reports_period_idx').on(t.periodStart)],
);

// ── Configurações (linha única) ─────────────────────────────────────────────

export const settings = sqliteTable('settings', {
  id: text().primaryKey().default('singleton'),
  currency: text().notNull().default('BRL'),
  timezone: text().notNull().default('America/Sao_Paulo'),
  locale: text().notNull().default('pt-BR'),

  aiModel: text().notNull().default('deepseek-chat'),
  /** Acima deste valor, a IA pede confirmação antes de escrever. */
  aiConfirmAmountCents: integer().notNull().default(50_000),
  /** Acima de N linhas afetadas, a IA pede confirmação. */
  aiConfirmBulkRows: integer().notNull().default(5),

  /** Horizonte da projeção de saldo, em dias. */
  projectionHorizonDays: integer().notNull().default(90),
  /** Até quantos dias à frente as recorrências são materializadas. */
  materializeHorizonDays: integer().notNull().default(120),

  updatedAt: updatedAt(),
});

// ── Tipos inferidos ─────────────────────────────────────────────────────────

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type CreditCard = typeof creditCards.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Payee = typeof payees.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type TransactionSplit = typeof transactionSplits.$inferSelect;
export type CardInvoice = typeof cardInvoices.$inferSelect;
export type InstallmentPlan = typeof installmentPlans.$inferSelect;
export type Recurrence = typeof recurrences.$inferSelect;
export type Budget = typeof budgets.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type GoalContribution = typeof goalContributions.$inferSelect;
export type Debt = typeof debts.$inferSelect;
export type DebtPayment = typeof debtPayments.$inferSelect;
export type Holding = typeof holdings.$inferSelect;
export type InvestmentTransaction = typeof investmentTransactions.$inferSelect;
export type PositionSnapshot = typeof positionSnapshots.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
export type ImportRow = typeof importRows.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type ChangeSet = typeof changeSets.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type AiConversation = typeof aiConversations.$inferSelect;
export type AiMessage = typeof aiMessages.$inferSelect;
export type AiAction = typeof aiActions.$inferSelect;
export type Insight = typeof insights.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Settings = typeof settings.$inferSelect;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export type TransactionStatus = (typeof TRANSACTION_STATUS)[number];
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];
export type RecurrenceFreq = (typeof RECURRENCE_FREQ)[number];
export type Actor = (typeof ACTORS)[number];
export type ChangeSetSource = (typeof CHANGE_SET_SOURCES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AmortizationSystem = (typeof AMORTIZATION_SYSTEMS)[number];
export type AssetClass = (typeof ASSET_CLASSES)[number];
export type InvestmentOp = (typeof INVESTMENT_OPS)[number];
export type GoalStatus = (typeof GOAL_STATUS)[number];
export type DebtKind = (typeof DEBT_KINDS)[number];
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export type InsightSeverity = (typeof INSIGHT_SEVERITY)[number];
