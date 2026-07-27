/**
 * Store da interface.
 *
 * Substitui os dados fictícios do protótipo mantendo **exatamente os mesmos nomes
 * de export** — `app.ts` continua importando `ACCOUNTS`, `TRANSACTIONS`,
 * `formatMoney` etc. e não sabe que agora vêm do backend.
 *
 * Isso é possível por *live bindings* do ESM: reatribuir um `export let` dentro
 * deste módulo é visível para quem importou. O ganho é não ter que reescrever
 * 1.777 linhas de renderização, e o visual ficar preservado por construção.
 *
 * ⚠️ `loadAll()` precisa terminar **antes** de `new KakeiboApp()`, porque o app
 * copia alguns arrays em inicializadores de campo.
 *
 * Onde o formato do backend difere do que a interface espera, a conversão fica
 * nos adaptadores abaixo — nunca espalhada pelas telas. O backend é a fonte da
 * verdade dos números: nada aqui recalcula saldo ou total, apenas exibe.
 */

import {
  api,
  type Account as ApiAccount,
  type AccountBalance,
  type BudgetStatus,
  type CardInvoice,
  type Category,
  type CategoryTrend,
  type Debt,
  type Finding,
  type DebtPayment,
  type Goal,
  type Holding,
  type ImportBatch,
  type Insight,
  type InstallmentPlanDetail,
  type InvoiceView,
  type MonthlyFlow,
  type MonthOverview,
  type NetWorth,
  type Payee,
  type PortfolioSummary,
  type Recurrence,
  type Rule as ApiRule,
  type Tag,
  type Transaction as ApiTransaction,
  type TransactionStatus,
  type CommitmentSummary,
} from '../api/client';

// ── Vocabulário (reexportado para o app.ts) ─────────────────────────────────

export type {
  AccountKind,
  TransactionType,
  TransactionStatus,
  CategoryKind,
  InvoiceStatus,
  RecurrenceFreq,
  DebtKind,
  AmortizationSystem,
  AssetClass,
  GoalStatus,
  InsightSeverity,
  Category,
  Payee,
  Tag,
  CardInvoice,
  Recurrence,
  Goal,
  Debt,
  DebtPayment,
  Holding,
  Insight,
  MonthlyFlow,
  ImportBatch,
} from '../api/client';

/**
 * Conta com os campos não-nulos que a interface assume.
 *
 * O backend permite `null` em institution/color/icon/aliases; normalizar aqui
 * evita espalhar `?? ''` por dezenas de pontos de renderização.
 */
export interface Account {
  id: string;
  name: string;
  kind: ApiAccount['kind'];
  institution: string;
  currency: string;
  openingBalanceCents: number;
  openingDate: string;
  color: string;
  icon: string;
  aliases: string[];
  isArchived: boolean;
  sortOrder: number;
}

export interface CreditCard {
  accountId: string;
  limitCents: number;
  closingDay: number;
  dueDay: number;
  paymentAccountId: string;
}

/** Transação com os campos derivados que a interface exibe. */
export interface Transaction {
  id: string;
  accountId: string;
  type: ApiTransaction['type'];
  date: string;
  amountCents: number;
  description: string;
  notes: string | null;
  categoryId: string | null;
  payeeId: string | null;
  status: TransactionStatus;
  transferId: string | null;
  hasSplits: boolean;
  installmentPlanId: string | null;
  installmentNo: number | null;
  /** Total de parcelas do plano — o backend guarda no plano, não na parcela. */
  installmentTotal: number | null;
  recurrenceId: string | null;
  cardInvoiceId: string | null;
  goalId: string | null;
  debtId: string | null;
  tagIds: string[];
  createdBy: 'user' | 'ai' | 'system';
}

/** Orçamento no formato da interface (`id` em vez de `budgetId`). */
export interface Budget {
  id: string;
  categoryId: string;
  /** Limite efetivo do mês: base + rollover acumulado. */
  amountCents: number;
  /** Limite nominal, sem o rollover. */
  baseLimitCents: number;
  startMonth: string;
  endMonth: string | null;
  rollover: boolean;
  spentCents: number;
  remainingCents: number;
  usedPercent: number;
  rolloverCents: number;
  projectedSpentCents: number;
  willExceed: boolean;
}

/** Regra com a condição já descrita em português. */
export interface Rule {
  id: string;
  name: string;
  priority: number;
  isEnabled: boolean;
  conditionDescription: string;
  conditionRegex: string | null;
  actionCategoryId: string | null;
  actionCategoryName: string | null;
  matchCount: number;
  lastMatchedAt: string | null;
}

/** Ponto da projeção com rótulo pronto para o gráfico. */
export interface ProjectionPoint {
  date: string;
  balanceCents: number;
  changeCents: number;
  label: string | null;
}

// ── Estado (live bindings) ──────────────────────────────────────────────────

export let ACCOUNTS: Account[] = [];
export let CREDIT_CARDS: CreditCard[] = [];
export let CATEGORIES: Category[] = [];
export let PAYEES: Payee[] = [];
export let TAGS: Tag[] = [];
export let TRANSACTIONS: Transaction[] = [];
export let CARD_INVOICES: InvoiceView[] = [];
export let INSTALLMENT_PLANS: InstallmentPlanDetail[] = [];
export let RECURRENCES: Recurrence[] = [];
export let BUDGETS: Budget[] = [];
export let GOALS: Goal[] = [];
export let DEBTS: Debt[] = [];
export let DEBT_PAYMENTS: DebtPayment[] = [];
export let HOLDINGS: Holding[] = [];
export let RULES: Rule[] = [];
export let INSIGHTS: Insight[] = [];
export let MONTHLY_FLOW: MonthlyFlow[] = [];
export let PROJECTION: ProjectionPoint[] = [];
export let IMPORT_BATCHES: ImportBatch[] = [];
export let TRENDS: CategoryTrend[] = [];

/** Agregados calculados pelo backend. A interface só exibe. */
export let BALANCES: AccountBalance[] = [];
export let OVERVIEW: MonthOverview | null = null;
export let NET_WORTH: NetWorth | null = null;
export let PORTFOLIO: PortfolioSummary | null = null;
export let COMMITMENTS: CommitmentSummary | null = null;
export let UPCOMING_BILLS: Array<{ transaction: ApiTransaction; recurrenceName: string; daysUntil: number }> = [];
export let PENDING_OCCURRENCES: Array<ApiTransaction & { recurrenceName: string }> = [];

/** Data de referência do servidor — evita divergir do fuso do backend. */
export let TODAY = new Date().toISOString().slice(0, 10);
export let CURRENT_MONTH = TODAY.slice(0, 7);

// ── Adaptadores ─────────────────────────────────────────────────────────────

function adaptAccount(account: ApiAccount): Account {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    institution: account.institution ?? '',
    currency: account.currency,
    openingBalanceCents: account.openingBalanceCents,
    openingDate: account.openingDate,
    color: account.color ?? '#566C86',
    icon: account.icon ?? iconForKind(account.kind),
    aliases: account.aliases ?? [],
    isArchived: account.isArchived,
    sortOrder: account.sortOrder,
  };
}

function iconForKind(kind: ApiAccount['kind']): string {
  return (
    {
      checking: 'bank',
      savings: 'piggy',
      cash: 'wallet',
      wallet: 'wallet',
      investment: 'chart',
      credit_card: 'card',
    }[kind] ?? 'bank'
  );
}

function adaptTransaction(
  tx: ApiTransaction,
  planTotals: Map<string, number>,
  tagsByTx: Map<string, string[]>,
): Transaction {
  return {
    id: tx.id,
    accountId: tx.accountId,
    type: tx.type,
    date: tx.date,
    amountCents: tx.amountCents,
    description: tx.description,
    notes: tx.notes,
    categoryId: tx.categoryId,
    payeeId: tx.payeeId,
    status: tx.status,
    transferId: tx.transferId,
    hasSplits: tx.hasSplits,
    installmentPlanId: tx.installmentPlanId,
    installmentNo: tx.installmentNo,
    // O total vem do plano; a parcela guarda só o próprio número.
    installmentTotal: tx.installmentPlanId ? (planTotals.get(tx.installmentPlanId) ?? null) : null,
    recurrenceId: tx.recurrenceId,
    cardInvoiceId: tx.cardInvoiceId,
    goalId: tx.goalId,
    debtId: tx.debtId,
    tagIds: tagsByTx.get(tx.id) ?? [],
    createdBy: tx.createdBy,
  };
}

function adaptBudget(status: BudgetStatus): Budget {
  return {
    id: status.budgetId,
    categoryId: status.categoryId,
    // Limite **efetivo** (base + rollover acumulado), não o base.
    //
    // O percentual que o backend calcula é contra o efetivo. Exibir o base ao lado
    // dele produz uma leitura falsa: com rollover de -R$ 542,80, um gasto de
    // R$ 380,30 aparecia como "R$ 380,30 / R$ 600,00" — parecendo dentro do limite
    // quando na verdade é 665% do que sobrou para o mês.
    amountCents: status.limitCents,
    baseLimitCents: status.baseLimitCents,
    startMonth: status.month,
    endMonth: null,
    rollover: status.rolloverCents !== 0,
    spentCents: status.spentCents,
    remainingCents: status.remainingCents,
    usedPercent: status.usedPercent,
    rolloverCents: status.rolloverCents,
    projectedSpentCents: status.projectedSpentCents,
    willExceed: status.willExceed,
  };
}

/** Converte achados ao vivo no formato de insight que a interface exibe. */
function adaptFinding(finding: Finding): Insight {
  return {
    id: finding.fingerprint,
    kind: finding.kind,
    severity: finding.severity,
    period: finding.period ?? null,
    title: finding.title,
    data: finding.data,
    fingerprint: finding.fingerprint,
    status: 'new',
    detectedAt: new Date().toISOString(),
  };
}

/** Descreve as condições da regra em português, para exibição. */
function describeConditions(rule: ApiRule): string {
  const parts: string[] = [];
  const c = rule.conditions;

  if (c.descriptionContains) parts.push(`descrição contém "${c.descriptionContains}"`);
  if (c.descriptionRegex) parts.push(`descrição casa /${c.descriptionRegex}/`);
  if (c.minAmountCents !== undefined) parts.push(`valor ≥ ${formatMoney(c.minAmountCents)}`);
  if (c.maxAmountCents !== undefined) parts.push(`valor ≤ ${formatMoney(c.maxAmountCents)}`);

  return parts.length > 0 ? parts.join(' e ') : 'qualquer lançamento';
}

function adaptRule(rule: ApiRule): Rule {
  const categoryId = rule.actions.categoryId ?? null;
  return {
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    isEnabled: rule.isEnabled,
    conditionDescription: describeConditions(rule),
    conditionRegex: rule.conditions.descriptionRegex ?? null,
    actionCategoryId: categoryId,
    actionCategoryName: categoryId ? getCategoryName(categoryId) : null,
    matchCount: rule.matchCount,
    lastMatchedAt: rule.lastMatchedAt ? rule.lastMatchedAt.slice(0, 10) : null,
  };
}

/**
 * Converte a projeção do backend para pontos com rótulo.
 *
 * O backend devolve todos os itens de cada dia; o gráfico mostra um rótulo por
 * ponto, então usa-se o item de maior valor absoluto — o que mais explica o
 * movimento daquele dia.
 */
function adaptProjection(projection: { startingCents: number; from: string; points: Array<{ date: string; balanceCents: number; changeCents: number; items: Array<{ description: string; amountCents: number }> }> }): ProjectionPoint[] {
  const points: ProjectionPoint[] = [
    { date: projection.from, balanceCents: projection.startingCents, changeCents: 0, label: null },
  ];

  for (const point of projection.points) {
    const dominant = [...point.items].sort(
      (a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents),
    )[0];

    points.push({
      date: point.date,
      balanceCents: point.balanceCents,
      changeCents: point.changeCents,
      label: dominant?.description ?? null,
    });
  }

  return points;
}

// ── Carregamento ────────────────────────────────────────────────────────────

function monthsAgo(months: number): string {
  const [year, month] = CURRENT_MONTH.split('-').map(Number);
  const total = year! * 12 + (month! - 1) - months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export interface LoadReport {
  ok: boolean;
  failed: string[];
  elapsedMs: number;
}

/**
 * Carrega tudo o que a interface precisa.
 *
 * As requisições vão em paralelo, e uma falha isolada **não** derruba a tela: o
 * nome do bloco que falhou volta em `failed` para a interface avisar, e o resto
 * continua utilizável. Num app de finanças é melhor mostrar o saldo sem o gráfico
 * de tendências do que uma tela branca.
 */
export async function loadAll(): Promise<LoadReport> {
  const started = performance.now();
  const failed: string[] = [];

  const settle = async <T>(label: string, promise: Promise<T>, apply: (value: T) => void): Promise<void> => {
    try {
      apply(await promise);
    } catch (error) {
      failed.push(label);
      console.error(`[store] falhou ao carregar ${label}:`, error);
    }
  };

  // Primeiro a data do servidor: tudo o mais depende do mês de referência.
  await settle('data do servidor', api.health(), (health) => {
    TODAY = health.today;
    CURRENT_MONTH = health.today.slice(0, 7);
  });

  // Categorias antes das regras, que resolvem nome de categoria.
  await settle('categorias', api.categories(), (rows) => {
    CATEGORIES = rows;
  });

  const plansPromise = api.installmentPlans();
  const tagsPromise = api.tags();

  await Promise.all([
    settle('contas', api.accounts(), (rows) => {
      ACCOUNTS = rows.map(adaptAccount);
      CREDIT_CARDS = rows
        .filter((a): a is ApiAccount & { card: NonNullable<ApiAccount['card']> } => a.card !== null)
        .map((a) => ({
          accountId: a.card.accountId,
          limitCents: a.card.limitCents,
          closingDay: a.card.closingDay,
          dueDay: a.card.dueDay,
          paymentAccountId: a.card.paymentAccountId ?? '',
        }));
    }),
    settle('saldos', api.balances(), (rows) => {
      BALANCES = rows;
    }),
    settle('favorecidos', api.payees(), (rows) => {
      PAYEES = rows;
    }),
    settle('tags', tagsPromise, (rows) => {
      TAGS = rows;
    }),
    settle('parcelamentos', plansPromise, (rows) => {
      INSTALLMENT_PLANS = rows;
    }),
    settle('resumo do mês', api.monthOverview(), (value) => {
      OVERVIEW = value;
    }),
    settle('patrimônio', api.netWorth(), (value) => {
      NET_WORTH = value;
    }),
    settle('faturas', api.invoices(), (rows) => {
      CARD_INVOICES = rows;
    }),
    settle('recorrências', api.recurrences(), (rows) => {
      RECURRENCES = rows;
    }),
    settle('orçamentos', api.budgets(), (rows) => {
      BUDGETS = rows.map(adaptBudget);
    }),
    settle('metas', api.goals('active'), (rows) => {
      GOALS = rows;
    }),
    settle('dívidas', api.debts(), (rows) => {
      DEBTS = rows;
    }),
    settle('investimentos', api.portfolio(), (value) => {
      PORTFOLIO = value;
      HOLDINGS = value.positions;
    }),
    // Analisadores ao vivo em vez da tabela persistida: os achados sempre
    // refletem o estado atual, e não dependem de alguém ter rodado a detecção.
    settle('insights', api.analyzeInsights(), (result) => {
      INSIGHTS = result.findings.map(adaptFinding);
    }),
    settle('fluxo mensal', api.monthlyFlow(monthsAgo(5), CURRENT_MONTH), (rows) => {
      MONTHLY_FLOW = rows;
    }),
    settle('projeção', api.projection(60), (value) => {
      PROJECTION = adaptProjection(value);
    }),
    settle('comprometimento', api.commitments(30), (value) => {
      COMMITMENTS = value;
    }),
    settle('contas a vencer', api.upcomingBills(30), (rows) => {
      UPCOMING_BILLS = rows;
    }),
    settle('confirmações pendentes', api.pendingOccurrences(), (rows) => {
      PENDING_OCCURRENCES = rows;
    }),
    settle('importações', api.imports(), (rows) => {
      IMPORT_BATCHES = rows;
    }),
    settle('tendências', api.trends(4), (rows) => {
      TRENDS = rows;
    }),
  ]);

  // Regras depois das categorias, para resolver o nome na descrição.
  await settle('regras', api.rules(), (rows) => {
    RULES = rows.map(adaptRule);
  });

  // Transações depois dos planos, para saber o total de parcelas.
  const planTotals = new Map(INSTALLMENT_PLANS.map((p) => [p.id, p.installments]));
  await settle('transações', api.transactions({ limit: 300, sort: 'date_desc' }), (page) => {
    TRANSACTIONS = page.items.map((tx) => adaptTransaction(tx, planTotals, new Map()));
  });

  // Cronograma da primeira dívida, para a tela de dívidas.
  if (DEBTS.length > 0) {
    await settle('cronograma da dívida', api.debtDetail(DEBTS[0]!.id), (detail) => {
      DEBT_PAYMENTS = detail.schedule;
    });
  }

  return { ok: failed.length === 0, failed, elapsedMs: Math.round(performance.now() - started) };
}

/** Recarrega o que muda depois de uma escrita. */
export async function refreshAfterWrite(): Promise<void> {
  const planTotals = new Map(INSTALLMENT_PLANS.map((p) => [p.id, p.installments]));

  const [page, balances, overview, invoices, budgets, worth, projection] = await Promise.all([
    api.transactions({ limit: 300, sort: 'date_desc' }),
    api.balances(),
    api.monthOverview(),
    api.invoices(),
    api.budgets(),
    api.netWorth(),
    api.projection(60),
  ]);

  TRANSACTIONS = page.items.map((tx) => adaptTransaction(tx, planTotals, new Map()));
  BALANCES = balances;
  OVERVIEW = overview;
  CARD_INVOICES = invoices;
  BUDGETS = budgets.map(adaptBudget);
  NET_WORTH = worth;
  PROJECTION = adaptProjection(projection);
}

/** Substitui as tags de uma transação no store, após edição. */
export async function refreshTransactionTags(transactionId: string): Promise<void> {
  const detail = await api.transaction(transactionId);
  const index = TRANSACTIONS.findIndex((t) => t.id === transactionId);
  if (index >= 0) {
    TRANSACTIONS[index] = { ...TRANSACTIONS[index]!, tagIds: detail.tags.map((t) => t.id) };
  }
}

// ── Formatação ──────────────────────────────────────────────────────────────

/**
 * Formata centavos em pt-BR.
 *
 * Feito a partir do inteiro, sem dividir por 100 em float — mesma regra do
 * backend, para os dois nunca discordarem no último centavo.
 */
export function formatMoney(cents: number): string {
  const abs = Math.abs(cents);
  const int = Math.floor(abs / 100);
  const dec = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}R$ ${int.toLocaleString('pt-BR')},${dec}`;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// ── Consultas derivadas ─────────────────────────────────────────────────────

export function getAccountName(id: string): string {
  return ACCOUNTS.find((a) => a.id === id)?.name ?? id;
}

export function getCategoryPath(categoryId: string | null): string {
  if (!categoryId) return 'Sem categoria';
  const category = CATEGORIES.find((c) => c.id === categoryId);
  if (!category) return 'Sem categoria';

  if (category.parentId) {
    const parent = CATEGORIES.find((c) => c.id === category.parentId);
    return parent ? `${parent.name} > ${category.name}` : category.name;
  }
  return category.name;
}

export function getCategoryName(categoryId: string | null): string {
  if (!categoryId) return 'Sem categoria';
  return CATEGORIES.find((c) => c.id === categoryId)?.name ?? 'Sem categoria';
}

export function getPayeeName(payeeId: string | null): string {
  if (!payeeId) return '';
  return PAYEES.find((p) => p.id === payeeId)?.name ?? '';
}

export function getTagNames(tagIds: string[]): string[] {
  return tagIds.map((id) => TAGS.find((t) => t.id === id)?.name ?? '').filter(Boolean);
}

/**
 * Saldo de uma conta.
 *
 * Vem do backend (`/balances`), que exclui transferências dos totais e distingue
 * efetivado de previsto. A interface não recalcula.
 */
export function computeBalance(accountId: string): { availableCents: number; projectedCents: number } {
  const balance = BALANCES.find((b) => b.accountId === accountId);
  return {
    availableCents: balance?.availableCents ?? 0,
    projectedCents: balance?.projectedCents ?? 0,
  };
}

/** Uso do limite de um cartão, calculado pelo backend. */
export function cardUsage(accountId: string): AccountBalance['cardUsage'] | undefined {
  return BALANCES.find((b) => b.accountId === accountId)?.cardUsage;
}

export function totalAvailableBalance(): number {
  return BALANCES.filter((b) => b.kind !== 'credit_card').reduce((sum, b) => sum + b.availableCents, 0);
}

export function currentMonthIncome(): number {
  return OVERVIEW?.incomeCents ?? 0;
}

export function currentMonthExpense(): number {
  return OVERVIEW?.expenseCents ?? 0;
}

export function netWorth(): number {
  return NET_WORTH?.netCents ?? 0;
}

/** Taxa de poupança do mês. `null` quando não houve receita. */
export function savingsRate(): number | null {
  return OVERVIEW?.savingsRatePercent ?? null;
}

export function statusLabel(status: TransactionStatus): string {
  return {
    scheduled: 'AGENDADO',
    pending: 'PENDENTE',
    cleared: 'EFETIVADO',
    reconciled: 'CONFERIDO',
  }[status];
}

export function statusColorClass(status: TransactionStatus): string {
  return {
    scheduled: 'txt-amber',
    pending: 'txt-cyan',
    cleared: 'txt-green',
    reconciled: 'txt-green',
  }[status];
}

/**
 * Diálogo inicial da IA.
 *
 * Mantido para a interface ter algo a exibir antes da primeira resposta real.
 * O texto é montado a partir dos insights que o backend já detectou — não é
 * roteiro fixo.
 */
export function openingAiMessage(): string {
  if (INSIGHTS.length === 0) {
    return 'SISTEMA PRONTO. Nenhum ponto de atenção detectado nos seus dados. Pergunte o que quiser ou lance um gasto em linguagem natural.';
  }

  const critical = INSIGHTS.filter((i) => i.severity === 'critical');
  const warn = INSIGHTS.filter((i) => i.severity === 'warn');
  const highlight = [...critical, ...warn].slice(0, 2);

  const parts = highlight.map((i) => i.title);
  const rest = INSIGHTS.length - highlight.length;

  return (
    `SISTEMA PRONTO. ${parts.join('. ')}.` +
    (rest > 0 ? ` Mais ${rest} ponto(s) de atenção na aba de insights.` : '') +
    ' Quer que eu detalhe algum?'
  );
}
