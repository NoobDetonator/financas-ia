/**
 * Cliente HTTP da API de finanças.
 *
 * Camada fina e única: nenhuma tela chama `fetch` direto. Isso concentra num só
 * lugar o tratamento de sessão expirada, a tradução de erro para mensagem em
 * português e o envelope de escrita com `changeSetId` — que é o que permite
 * oferecer "desfazer" em qualquer operação.
 *
 * Em desenvolvimento o Vite faz proxy de `/api` para o backend, então tudo é
 * same-origin e o cookie de sessão funciona sem CORS. Em produção o próprio
 * Fastify serve estes arquivos, e o caminho é o mesmo.
 */

/**
 * Prefixo das rotas, que difere entre os dois modos de execução:
 *
 * • **desenvolvimento** — o Vite serve a interface na 3000 e faz proxy de `/api`
 *   para o backend na 3333, removendo o prefixo no caminho.
 * • **produção** — o próprio Fastify serve a interface e a API na mesma porta, com
 *   as rotas na raiz. Aqui não existe `/api`.
 *
 * Usar `/api` fixo fazia a interface compilada pedir `/api/auth/status`, cair no
 * fallback da página única e receber HTML onde esperava JSON.
 */
const BASE = import.meta.env.DEV ? '/api' : '';

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RULE_VIOLATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL'
  | 'NETWORK';

/** Erro da API, já com mensagem legível em português. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Erro de uso (dado inválido, regra de negócio) em vez de falha do sistema. */
  get isUserError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/** Envelope devolvido por toda rota de escrita. */
export interface WriteResult<T> {
  data: T;
  /** Passe para `undoChangeSet` para reverter a operação. */
  changeSetId: string;
  touched: number;
}

type Listener = (authenticated: boolean) => void;
const authListeners = new Set<Listener>();

/** Notifica a interface quando a sessão cai, para ela mostrar o login. */
export function onAuthChange(listener: Listener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function announceAuth(authenticated: boolean): void {
  for (const listener of authListeners) listener(authenticated);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Não dispara o evento de sessão expirada — usado pelo próprio login. */
  silentAuth?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }

  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Executa a requisição.
 *
 * Traduz falha de rede e resposta não-JSON em `ApiError` também — a interface
 * nunca recebe uma exceção crua que não saberia exibir.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, silentAuth } = options;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Necessário para o cookie de sessão viajar.
      credentials: 'same-origin',
    });
  } catch (error) {
    throw new ApiError(
      'NETWORK',
      'Não consegui falar com o servidor. Ele está rodando? (npm run dev na pasta do projeto)',
      0,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  if (response.status === 401 && !silentAuth) {
    announceAuth(false);
  }

  // 204 e afins não têm corpo.
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(
      'INTERNAL',
      `O servidor respondeu algo que não é JSON (${response.status}).`,
      response.status,
      { body: text.slice(0, 200) },
    );
  }

  if (!response.ok) {
    const payload = (parsed ?? {}) as { error?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiError(
      (payload.error as ErrorCode) ?? 'INTERNAL',
      payload.message ?? `Erro ${response.status}.`,
      response.status,
      payload.details,
    );
  }

  return parsed as T;
}

// ── Autenticação ────────────────────────────────────────────────────────────

export interface AuthStatus {
  authEnabled: boolean;
  authenticated: boolean;
  passwordConfigured: boolean;
  warning?: string;
}

export const auth = {
  status: () => request<AuthStatus>('/auth/status', { silentAuth: true }),

  async login(password: string): Promise<void> {
    await request<{ ok: true }>('/auth/login', {
      method: 'POST',
      body: { password },
      silentAuth: true,
    });
    announceAuth(true);
  },

  async logout(): Promise<void> {
    await request<{ ok: true }>('/auth/logout', { method: 'POST' });
    announceAuth(false);
  },
};

// ── Tipos do domínio (espelham os DTOs do backend) ──────────────────────────

export type AccountKind = 'checking' | 'savings' | 'cash' | 'wallet' | 'investment' | 'credit_card';
export type TransactionType = 'expense' | 'income' | 'transfer';
export type TransactionStatus = 'scheduled' | 'pending' | 'cleared' | 'reconciled';
export type CategoryKind = 'expense' | 'income';
export type InvoiceStatus = 'open' | 'closed' | 'paid' | 'overdue';
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type DebtKind = 'loan' | 'financing' | 'installment_debt' | 'other';
export type AmortizationSystem = 'sac' | 'price';
export type AssetClass = 'stock' | 'fii' | 'etf' | 'fixed_income' | 'crypto' | 'fund' | 'pension' | 'other';
export type GoalStatus = 'active' | 'done' | 'archived';
export type InsightSeverity = 'info' | 'warn' | 'critical';
export type Actor = 'user' | 'ai' | 'system';

export interface CreditCard {
  accountId: string;
  limitCents: number;
  closingDay: number;
  dueDay: number;
  paymentAccountId: string | null;
  notes: string | null;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  institution: string | null;
  currency: string;
  openingBalanceCents: number;
  openingDate: string;
  color: string | null;
  icon: string | null;
  notes: string | null;
  aliases: string[] | null;
  isArchived: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  card: CreditCard | null;
}

export interface AccountBalance {
  accountId: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingBalanceCents: number;
  availableCents: number;
  projectedCents: number;
  forecastCents: number;
  cardUsage?: {
    limitCents: number;
    usedCents: number;
    availableCents: number;
    usedPercent: number;
  };
}

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  parentId: string | null;
  color: string | null;
  icon: string | null;
  isSystem: boolean;
  isArchived: boolean;
  sortOrder: number;
}

export interface CategoryNode extends Category {
  children: Category[];
}

export interface Payee {
  id: string;
  name: string;
  normalizedName: string;
  defaultCategoryId: string | null;
}

export interface Tag {
  id: string;
  name: string;
  normalizedName: string;
  color: string | null;
}

export interface Transaction {
  id: string;
  accountId: string;
  type: TransactionType;
  date: string;
  postedDate: string | null;
  amountCents: number;
  currency: string;
  description: string;
  notes: string | null;
  categoryId: string | null;
  payeeId: string | null;
  status: TransactionStatus;
  transferId: string | null;
  hasSplits: boolean;
  installmentPlanId: string | null;
  installmentNo: number | null;
  recurrenceId: string | null;
  recurrenceOccurrence: string | null;
  cardInvoiceId: string | null;
  goalId: string | null;
  debtId: string | null;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionSplit {
  id: string;
  transactionId: string;
  categoryId: string;
  amountCents: number;
  note: string | null;
}

export interface TransactionDetail extends Transaction {
  splits: TransactionSplit[];
  tags: Tag[];
  attachmentCount: number;
}

export interface TransactionPage {
  items: Transaction[];
  total: number;
  limit: number;
  offset: number;
  /** Soma de TODAS as linhas do filtro, não só da página. */
  sumCents: number;
}

export interface CardInvoice {
  id: string;
  cardAccountId: string;
  referenceMonth: string;
  closingDate: string;
  dueDate: string;
  status: InvoiceStatus;
  totalCents: number;
  paidCents: number;
  paymentTransactionId: string | null;
  paidAt: string | null;
}

export interface InvoiceView extends CardInvoice {
  effectiveStatus: InvoiceStatus;
  remainingCents: number;
}

export interface InstallmentPlan {
  id: string;
  accountId: string;
  description: string;
  totalCents: number;
  installments: number;
  purchaseDate: string;
  firstChargeDate: string;
  categoryId: string | null;
}

export interface InstallmentPlanDetail extends InstallmentPlan {
  transactions: Transaction[];
  remainingCents: number;
  paidCount: number;
}

export interface Recurrence {
  id: string;
  name: string;
  accountId: string;
  type: TransactionType;
  amountCents: number | null;
  estimatedCents: number | null;
  categoryId: string | null;
  freq: RecurrenceFreq;
  interval: number;
  dayOfMonth: number | null;
  weekday: number | null;
  startDate: string;
  endDate: string | null;
  autoPost: boolean;
  isActive: boolean;
  /** Regra em português: "todo mês no dia 10". */
  description: string;
  nextDate: string | null;
  effectiveCents: number;
}

export interface BudgetStatus {
  budgetId: string;
  categoryId: string;
  categoryName: string;
  month: string;
  limitCents: number;
  baseLimitCents: number;
  rolloverCents: number;
  spentCents: number;
  remainingCents: number;
  usedPercent: number;
  projectedSpentCents: number;
  willExceed: boolean;
}

export interface BudgetSummary {
  month: string;
  totalLimitCents: number;
  totalSpentCents: number;
  totalRemainingCents: number;
  exceeded: BudgetStatus[];
  atRisk: BudgetStatus[];
  items: BudgetStatus[];
}

export interface Goal {
  id: string;
  name: string;
  targetCents: number;
  targetDate: string | null;
  accountId: string | null;
  color: string | null;
  status: GoalStatus;
  notes: string | null;
  savedCents: number;
  remainingCents: number;
  progressPercent: number;
  contributionCount: number;
  lastContributionDate: string | null;
  requiredMonthlyCents: number | null;
  daysRemaining: number | null;
  projectedCompletionDate: string | null;
  isComplete: boolean;
}

export interface GoalContribution {
  id: string;
  goalId: string;
  transactionId: string | null;
  amountCents: number;
  date: string;
  note: string | null;
}

export interface DebtPayment {
  id: string;
  debtId: string;
  transactionId: string | null;
  installmentNo: number;
  dueDate: string;
  paidDate: string | null;
  amountCents: number;
  principalCents: number;
  interestCents: number;
  balanceAfterCents: number;
}

export interface Debt {
  id: string;
  name: string;
  kind: DebtKind;
  principalCents: number;
  annualRateBps: number;
  termMonths: number;
  system: AmortizationSystem;
  startDate: string;
  firstDueDate: string;
  accountId: string | null;
  categoryId: string | null;
  isSettled: boolean;
  outstandingCents: number;
  paidPrincipalCents: number;
  paidInterestCents: number;
  paidCount: number;
  remainingCount: number;
  totalInterestCents: number;
  nextPayment: DebtPayment | null;
  overdueCount: number;
  progressPercent: number;
}

export interface Holding {
  id: string;
  name: string;
  ticker: string | null;
  assetClass: AssetClass;
  accountId: string | null;
  currency: string;
  quantityE8: number;
  totalCostCents: number;
  isArchived: boolean;
  quantity: number;
  averageCostCents: number | null;
  marketValueCents: number | null;
  lastSnapshotDate: string | null;
  gainCents: number | null;
  gainPercent: number | null;
  incomeCents: number;
}

export interface PortfolioSummary {
  totalCostCents: number;
  totalMarketValueCents: number;
  totalGainCents: number;
  totalGainPercent: number | null;
  totalIncomeCents: number;
  withoutSnapshot: string[];
  byAssetClass: Array<{
    assetClass: string;
    costCents: number;
    marketValueCents: number;
    percentOfPortfolio: number;
  }>;
  positions: Holding[];
}

export interface Rule {
  id: string;
  name: string;
  priority: number;
  isEnabled: boolean;
  stopOnMatch: boolean;
  conditions: {
    descriptionContains?: string;
    descriptionRegex?: string;
    minAmountCents?: number;
    maxAmountCents?: number;
  };
  actions: { categoryId?: string; payeeId?: string };
  matchCount: number;
  lastMatchedAt: string | null;
}

export interface Insight {
  id: string;
  kind: string;
  severity: InsightSeverity;
  period: string | null;
  title: string;
  data: Record<string, unknown>;
  fingerprint: string;
  status: 'new' | 'seen' | 'dismissed';
  detectedAt: string;
}

export interface Finding {
  kind: string;
  severity: InsightSeverity;
  title: string;
  data: Record<string, unknown>;
  fingerprint: string;
  period?: string;
}

export interface MonthlyFlow {
  month: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  savingsRatePercent: number | null;
}

export interface CategoryBreakdownItem {
  categoryId: string | null;
  categoryName: string;
  parentId: string | null;
  parentName: string | null;
  amountCents: number;
  transactionCount: number;
  percentOfTotal: number;
}

export interface MonthOverview {
  month: string;
  from: string;
  to: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  savingsRatePercent: number | null;
  transactionCount: number;
  topCategories: CategoryBreakdownItem[];
  topPayees: Array<{
    payeeName: string;
    amountCents: number;
    transactionCount: number;
    averageCents: number;
  }>;
  largestExpenses: Array<{ id: string; description: string; amountCents: number; date: string }>;
  comparedToPreviousMonth: {
    expenseChangeCents: number;
    expenseChangePercent: number | null;
  };
}

export interface ProjectionPoint {
  date: string;
  balanceCents: number;
  changeCents: number;
  items: Array<{ id: string; description: string; amountCents: number; status: TransactionStatus }>;
}

export interface BalanceProjection {
  accountId: string | null;
  accountName: string;
  from: string;
  to: string;
  startingCents: number;
  endingCents: number;
  lowestCents: number;
  lowestDate: string | null;
  firstNegativeDate: string | null;
  points: ProjectionPoint[];
}

export interface CommitmentSummary {
  committedCents: number;
  installmentsCents: number;
  recurringCents: number;
  cardInvoicesCents: number;
  expectedIncomeCents: number;
  committedPercent: number | null;
}

export interface NetWorth {
  date: string;
  assetsCents: number;
  liabilitiesCents: number;
  netCents: number;
  byAccount: AccountBalance[];
}

export interface CategoryTrend {
  categoryId: string;
  categoryName: string;
  series: Array<{ month: string; amountCents: number }>;
  averageCents: number;
  medianCents: number;
  currentCents: number;
  deviationPercent: number | null;
}

export interface ImportBatch {
  id: string;
  source: 'csv' | 'ofx' | 'manual';
  filename: string;
  accountId: string;
  status: 'parsed' | 'applied' | 'reverted';
  stats: Record<string, number> | null;
  createdAt: string;
  appliedAt: string | null;
}

export interface ImportPreview {
  batchId: string;
  accountId: string;
  accountName: string;
  filename: string;
  source: 'csv' | 'ofx';
  totalRows: number;
  newRows: number;
  duplicateRows: number;
  netCents: number;
  dateRange: { from: string; to: string } | null;
  rows: Array<{
    lineNo: number;
    date: string;
    amountCents: number;
    description: string;
    status: 'new' | 'duplicate';
    suggestedCategoryName?: string;
  }>;
}

export interface ChangeSet {
  id: string;
  source: string;
  actor: Actor;
  summary: string;
  status: 'applied' | 'pending' | 'reverted' | 'rejected';
  risk: 'auto' | 'confirm';
  tool: string | null;
  revertOf: string | null;
  createdAt: string;
  entryCount?: number;
}

export interface AiChatResult {
  conversationId: string;
  text: string;
  toolCalls: Array<{ tool: string; args: unknown; result: unknown }>;
  pendingConfirmations: Array<{
    tool: string;
    summary: string;
    reason: string;
    token: string;
  }>;
  changeSetIds: string[];
  usage: { inputTokens?: number; outputTokens?: number };
}

export interface AiStatus {
  provider: string;
  model: string;
  configured: boolean;
  toolCount: number;
  conversationCount: number;
  actionCount: number;
  tools: string[];
  thresholds: { amountCents: number; bulkRows: number };
  risk: { alwaysAuto: string[]; conditional: string[]; alwaysConfirm: string[] };
}

export interface IntegrityReport {
  ok: boolean;
  issues: Array<{ check: string; detail: string; ids?: string[] }>;
}

export interface Settings {
  id: string;
  currency: string;
  timezone: string;
  locale: string;
  aiModel: string;
  aiConfirmAmountCents: number;
  aiConfirmBulkRows: number;
  projectionHorizonDays: number;
  materializeHorizonDays: number;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

export const api = {
  // Sistema
  health: () => request<{ ok: true; today: string; aiConfigured: boolean }>('/health'),
  settings: () => request<Settings>('/settings'),
  integrity: () => request<IntegrityReport>('/integrity'),
  runJobs: () => request<Array<{ name: string; ok: boolean; detail: string }>>('/system/run-jobs', { method: 'POST' }),
  backup: () => request<{ path: string; sizeBytes: number }>('/system/backup', { method: 'POST', body: {} }),

  // Contas e saldos
  accounts: (includeArchived = false) => request<Account[]>('/accounts', { query: { includeArchived } }),
  balances: () => request<AccountBalance[]>('/balances'),
  netWorth: () => request<NetWorth>('/net-worth'),
  netWorthHistory: (months = 12) =>
    request<Array<{ date: string; assetsCents: number; liabilitiesCents: number; netCents: number }>>(
      '/net-worth/history',
      { query: { months } },
    ),
  createAccount: (body: unknown) => request<WriteResult<Account>>('/accounts', { method: 'POST', body }),
  archiveAccount: (id: string) => request<WriteResult<Account>>(`/accounts/${id}/archive`, { method: 'POST', body: {} }),

  // Categorias, favorecidos, tags
  categories: (kind?: CategoryKind) => request<Category[]>('/categories', { query: { kind } }),
  categoryTree: (kind?: CategoryKind) => request<CategoryNode[]>('/categories/tree', { query: { kind } }),
  payees: () => request<Payee[]>('/payees'),
  tags: () => request<Tag[]>('/tags'),

  // Transações
  transactions: (query: Record<string, string | number | boolean | undefined> = {}) =>
    request<TransactionPage>('/transactions', { query }),
  transaction: (id: string) => request<TransactionDetail>(`/transactions/${id}`),
  createTransaction: (body: unknown) => request<WriteResult<Transaction>>('/transactions', { method: 'POST', body }),
  updateTransaction: (id: string, body: unknown) =>
    request<WriteResult<Transaction>>(`/transactions/${id}`, { method: 'PATCH', body }),
  deleteTransaction: (id: string) =>
    request<WriteResult<{ deleted: string[] }>>(`/transactions/${id}`, { method: 'DELETE' }),
  bulkCategorize: (transactionIds: string[], categoryId: string) =>
    request<WriteResult<{ updated: number; skipped: string[] }>>('/transactions/bulk-categorize', {
      method: 'POST',
      body: { transactionIds, categoryId },
    }),
  createTransfer: (body: unknown) => request<WriteResult<unknown>>('/transfers', { method: 'POST', body }),

  // Cartão
  invoices: (cardAccountId?: string) => request<InvoiceView[]>('/invoices', { query: { cardAccountId } }),
  openInvoices: () => request<InvoiceView[]>('/invoices/open'),
  upcomingInvoices: (withinDays = 45) =>
    request<Array<{ invoice: CardInvoice; cardName: string; daysUntilDue: number; remainingCents: number }>>(
      '/invoices/upcoming',
      { query: { withinDays } },
    ),
  payInvoice: (id: string, body: unknown = {}) =>
    request<WriteResult<unknown>>(`/invoices/${id}/pay`, { method: 'POST', body }),
  installmentPlans: (onlyActive = false) =>
    request<InstallmentPlanDetail[]>('/installment-plans', { query: { onlyActive } }),
  createInstallmentPlan: (body: unknown) =>
    request<WriteResult<InstallmentPlanDetail>>('/installment-plans', { method: 'POST', body }),

  // Recorrências
  recurrences: (onlyActive = false) => request<Recurrence[]>('/recurrences', { query: { onlyActive } }),
  createRecurrence: (body: unknown) => request<WriteResult<unknown>>('/recurrences', { method: 'POST', body }),
  upcomingBills: (withinDays = 30) =>
    request<Array<{ transaction: Transaction; recurrenceName: string; daysUntil: number }>>('/bills/upcoming', {
      query: { withinDays },
    }),
  pendingOccurrences: () => request<Array<Transaction & { recurrenceName: string }>>('/occurrences/pending'),
  confirmOccurrence: (id: string, body: unknown = {}) =>
    request<WriteResult<Transaction>>(`/occurrences/${id}/confirm`, { method: 'POST', body }),

  // Projeção
  projection: (days = 60) => request<BalanceProjection>('/projection', { query: { days } }),
  commitments: (days = 30) => request<CommitmentSummary>('/commitments', { query: { days } }),

  // Planejamento
  budgets: (month?: string) => request<BudgetStatus[]>('/budgets', { query: { month } }),
  budgetSummary: (month?: string) => request<BudgetSummary>('/budgets/summary', { query: { month } }),
  budgetSuggestions: (months = 3) =>
    request<Array<{ categoryId: string; categoryName: string; averageCents: number; maxCents: number }>>(
      '/budgets/suggestions',
      { query: { months } },
    ),
  createBudget: (body: unknown) => request<WriteResult<unknown>>('/budgets', { method: 'POST', body }),
  goals: (status?: GoalStatus) => request<Goal[]>('/goals', { query: { status } }),
  goalDetail: (id: string) => request<Goal & { contributions: GoalContribution[] }>(`/goals/${id}`),
  createGoal: (body: unknown) => request<WriteResult<Goal>>('/goals', { method: 'POST', body }),
  contributeToGoal: (id: string, body: unknown) =>
    request<WriteResult<unknown>>(`/goals/${id}/contribute`, { method: 'POST', body }),
  debts: (includeSettled = false) => request<Debt[]>('/debts', { query: { includeSettled } }),
  debtDetail: (id: string) => request<Debt & { schedule: DebtPayment[] }>(`/debts/${id}`),
  payDebtInstallment: (id: string, installmentNo: number, body: unknown = {}) =>
    request<WriteResult<unknown>>(`/debts/${id}/pay/${installmentNo}`, { method: 'POST', body }),
  simulatePayoff: (id: string) =>
    request<{
      debtName: string;
      payoffCents: number;
      interestSavedCents: number;
      installmentsRemoved: number;
      originalRemainingCents: number;
    }>(`/debts/${id}/simulate-payoff`),
  simulateExtra: (id: string, extraCents: number) =>
    request<{ debtName: string; monthsSaved: number; interestSavedCents: number; newTermMonths: number }>(
      `/debts/${id}/simulate-extra`,
      { query: { extraCents } },
    ),

  // Investimentos
  holdings: () => request<Holding[]>('/holdings'),
  portfolio: () => request<PortfolioSummary>('/portfolio'),
  recordSnapshot: (id: string, body: unknown) =>
    request<WriteResult<unknown>>(`/holdings/${id}/snapshot`, { method: 'POST', body }),

  // Relatórios
  monthOverview: (month?: string) => request<MonthOverview>('/reports/month-overview', { query: { month } }),
  monthlyFlow: (fromMonth: string, toMonth: string) =>
    request<MonthlyFlow[]>('/reports/monthly-flow', { query: { fromMonth, toMonth } }),
  byCategory: (from: string, to: string, rollup = false) =>
    request<{ items: CategoryBreakdownItem[]; totalCents: number }>('/reports/by-category', {
      query: { from, to, rollup },
    }),
  trends: (months = 4) => request<CategoryTrend[]>('/reports/trends', { query: { months } }),
  duplicates: (withinDays = 3) =>
    request<Array<{ description: string; amountCents: number; dates: string[]; ids: string[] }>>(
      '/reports/duplicates',
      { query: { withinDays } },
    ),

  // Regras
  rules: () => request<Rule[]>('/rules'),
  ruleSuggestions: () =>
    request<
      Array<{
        descriptionPattern: string;
        categoryId: string;
        categoryName: string;
        occurrences: number;
        confidencePercent: number;
      }>
    >('/rules/suggestions'),
  applyRules: () => request<WriteResult<{ updated: number }>>('/rules/apply', { method: 'POST', body: {} }),

  // Importação
  imports: () => request<ImportBatch[]>('/imports'),
  parseImport: (body: { accountId: string; filename: string; content: string }) =>
    request<WriteResult<ImportPreview>>('/imports/parse', { method: 'POST', body }),
  applyImport: (id: string, body: unknown = {}) =>
    request<WriteResult<{ created: number; skipped: number }>>(`/imports/${id}/apply`, { method: 'POST', body }),
  revertImport: (id: string) =>
    request<WriteResult<{ reverted: number }>>(`/imports/${id}/revert`, { method: 'POST', body: {} }),

  // Insights
  analyzeInsights: () =>
    request<{ findings: Finding[]; summary: string; errors: unknown[] }>('/insights/analyze'),
  insights: (status?: 'new' | 'seen' | 'dismissed') => request<Insight[]>('/insights', { query: { status } }),
  markInsight: (id: string, action: 'seen' | 'dismissed') =>
    request<{ ok: true }>(`/insights/${id}/${action}`, { method: 'POST', body: {} }),
  generateReport: (kind: 'weekly' | 'monthly' | 'adhoc' = 'adhoc') =>
    request<{ reportId: string | null; bodyMd: string; findings: Finding[]; narrated: boolean }>(
      '/reports/generate',
      { method: 'POST', body: { kind } },
    ),

  // Auditoria
  changeSets: (query: Record<string, string | number | undefined> = {}) =>
    request<{ items: ChangeSet[]; total: number }>('/change-sets', { query }),
  changeSetDetail: (id: string) =>
    request<ChangeSet & { entries: Array<{ action: string; entity: string; before: unknown; after: unknown }> }>(
      `/change-sets/${id}`,
    ),
  undo: (id: string) =>
    request<WriteResult<{ reverted: number }>>(`/change-sets/${id}/undo`, { method: 'POST', body: {} }),

  // IA
  aiStatus: () => request<AiStatus>('/ai/status'),
  aiSnapshot: () => request<{ snapshot: string }>('/ai/snapshot'),
  aiChat: (message: string, conversationId?: string, approvedTokens?: string[]) =>
    request<AiChatResult>('/ai/chat', {
      method: 'POST',
      body: { message, conversationId, approvedTokens },
    }),
  aiActions: (limit = 50) => request<unknown[]>('/ai/actions', { query: { limit } }),
  resolveDate: (phrase: string) =>
    request<{ recognized: boolean; date?: string; interpretation?: string }>('/ai/resolve-date', {
      query: { phrase },
    }),
};

/**
 * Conversa com streaming (SSE).
 *
 * O `fetch` com corpo é usado em vez de `EventSource` porque a rota é POST —
 * `EventSource` só faz GET.
 */
export async function aiChatStream(
  message: string,
  options: {
    conversationId?: string;
    approvedTokens?: string[];
    onText: (chunk: string) => void;
    onDone: (result: {
      conversationId: string;
      pendingConfirmations: AiChatResult['pendingConfirmations'];
      changeSetIds: string[];
    }) => void;
    onError?: (message: string) => void;
  },
): Promise<void> {
  const response = await fetch(`${BASE}/ai/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      message,
      conversationId: options.conversationId,
      approvedTokens: options.approvedTokens,
    }),
  });

  if (response.status === 401) {
    announceAuth(false);
    throw new ApiError('UNAUTHORIZED', 'Sessão expirada.', 401);
  }
  if (!response.body) {
    throw new ApiError('INTERNAL', 'O servidor não devolveu um stream.', response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Eventos SSE são separados por linha em branco.
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const raw of events) {
      const lines = raw.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      const event = eventLine.slice(7).trim();
      let payload: any;
      try {
        payload = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }

      if (event === 'text') options.onText(payload.chunk ?? '');
      else if (event === 'done') options.onDone(payload);
      else if (event === 'error') options.onError?.(payload.message ?? 'Erro desconhecido.');
    }
  }
}
