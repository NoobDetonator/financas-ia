import { pc98Audio } from './audio';
import { PC98MascotRenderer, PC98UserMascotRenderer, type UserAvatarPreset } from './mascot';
import { PC98ChartSuite } from './charts';
import {
  ACCOUNTS, TRANSACTIONS, BUDGETS, DEBTS, HOLDINGS, RECURRENCES,
  GOALS, RULES, INSIGHTS, CARD_INVOICES, DEBT_PAYMENTS, MONTHLY_FLOW,
  PROJECTION, CATEGORIES, IMPORT_BATCHES, PORTFOLIO, PAYEES,
  formatMoney, formatDate, toIsoDate, getAccountName, getCategoryPath,
  getCategoryName, getPayeeName, getTagNames, computeBalance,
  totalAvailableBalance, currentMonthIncome, currentMonthExpense, netWorth,
  statusLabel, statusColorClass, CREDIT_CARDS,
  openingAiMessage, refreshAfterWrite, cardUsage, TODAY,
  primaryGoalProgressPercent, primaryGoalName, radarHealthMetrics,
  categoryDonutSlices, monthWaterfallSteps,
  type Transaction, type Budget, type Account, type Debt, type Holding
} from './data';
import { BITMAP_ICONS } from './icons';
import { api, aiChatStream, ApiError, type AiChatResult } from '../api/client';

/** Escapa texto para interpolação segura em `innerHTML`. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const AI_CONFIRM_RE = /^(sim|ok|confirmo|confirma|confirmado|pode( executar)?|aprova(r)?|aprovado)\b/i;

/** Rótulos amigáveis das ferramentas — o chat mostra o que a IA está fazendo. */
const AI_TOOL_LABELS: Record<string, string> = {
  resolve_date: 'Resolver data',
  get_balances: 'Consultar saldos',
  get_account_balance: 'Saldo da conta',
  get_month_overview: 'Resumo do mês',
  search_transactions: 'Buscar lançamentos',
  get_spending_by_category: 'Gastos por categoria',
  get_category_trends: 'Tendências',
  compare_months: 'Comparar meses',
  get_budget_status: 'Status do orçamento',
  get_upcoming: 'Próximos vencimentos',
  get_projection: 'Projeção',
  get_net_worth: 'Patrimônio',
  get_cash_flow: 'Fluxo de caixa',
  get_goals: 'Listar metas',
  get_debts: 'Listar dívidas',
  simulate_debt_payoff: 'Simular dívida',
  get_portfolio: 'Portfólio',
  find_duplicate_charges: 'Buscar duplicatas',
  get_top_payees: 'Principais favorecidos',
  get_rule_suggestions: 'Sugestões de regras',
  get_budget_suggestions: 'Sugestões de orçamento',
  get_category_spending: 'Gasto da categoria',
  create_transaction: 'Criar lançamento',
  create_installment_plan: 'Criar parcelamento',
  create_transfer: 'Transferir',
  categorize_transaction: 'Categorizar',
  bulk_categorize: 'Categorizar em lote',
  update_transaction: 'Atualizar lançamento',
  delete_transaction: 'Excluir lançamento',
  pay_card_invoice: 'Pagar fatura',
  confirm_occurrence: 'Confirmar recorrência',
  contribute_to_goal: 'Aportar na meta',
  set_budget: 'Definir orçamento',
  create_goal: 'Criar meta',
  apply_rules: 'Aplicar regras',
};

function aiToolLabel(tool: string): string {
  return AI_TOOL_LABELS[tool] ?? tool.replace(/_/g, ' ');
}

const CASHLIKE_KINDS = new Set(['checking', 'savings', 'cash', 'wallet', 'investment']);

const ACCOUNT_KIND_LABELS: Record<string, string> = {
  checking: 'CORRENTE',
  savings: 'POUPANÇA',
  cash: 'DINHEIRO',
  wallet: 'CARTEIRA',
  investment: 'INVESTIMENTO',
  credit_card: 'CRÉDITO',
};

function accountKindLabel(kind: string): string {
  return ACCOUNT_KIND_LABELS[kind] ?? kind.toUpperCase();
}

const CARD_NETWORK_LABELS: Record<string, string> = {
  visa: 'VISA',
  mastercard: 'Mastercard',
  elo: 'Elo',
  amex: 'Amex',
  hipercard: 'Hipercard',
  other: 'Cartão',
};

function cardNetworkLabel(network: string | null | undefined): string {
  return CARD_NETWORK_LABELS[network ?? 'other'] ?? 'Cartão';
}

/** Mensagem curta do que a IA gravou, para o toast. */
function summarizeAiWrites(tools: string[], changeSetCount: number): string {
  const unique = [...new Set(tools)];
  if (unique.includes('create_goal')) return 'Meta criada pela IA.';
  if (unique.includes('create_transaction')) return 'Lançamento criado pela IA.';
  if (unique.includes('create_transfer')) return 'Transferência criada pela IA.';
  if (unique.includes('create_installment_plan')) return 'Parcelamento criado pela IA.';
  if (unique.includes('create_recurrence')) return 'Recorrência criada pela IA.';
  if (unique.includes('set_budget')) return 'Orçamento atualizado pela IA.';
  if (unique.includes('contribute_to_goal')) return 'Aporte na meta registrado pela IA.';
  if (unique.includes('pay_card_invoice')) return 'Fatura paga pela IA.';
  if (unique.includes('delete_transaction')) return 'Lançamento excluído pela IA.';
  if (unique.includes('categorize_transaction') || unique.includes('bulk_categorize')) {
    return 'Categorização aplicada pela IA.';
  }
  if (unique.includes('apply_rules')) return 'Regras aplicadas pela IA.';
  if (changeSetCount === 1) return 'Alteração da IA aplicada.';
  return `${changeSetCount} alterações da IA aplicadas.`;
}

function parseReaisToCents(raw: string): number {
  const n = parseFloat(raw.replace(',', '.').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Cartão plástico 3D estético — sem dados reais; só nome/bandeira/virtual. */
function buildPlasticCardHtml(options: {
  name: string;
  holder?: string | null;
  network?: string | null;
  isVirtual?: boolean;
  kindLabel: string;
  idSuffix?: string;
}): string {
  const network = options.network || 'other';
  const holder = (options.holder || options.name).trim() || options.name;
  const suffix = options.idSuffix ? `-${escapeHtml(options.idSuffix)}` : '';
  const virtualClass = options.isVirtual ? ' is-virtual' : '';
  return `
    <div class="plastic-card-stage">
      <div class="plastic-card-scene">
        <button type="button" class="plastic-card${virtualClass}" data-network="${escapeHtml(network)}" id="plastic-card${suffix}" aria-label="Virar cartão ${escapeHtml(options.name)}">
          <div class="plastic-card-face front">
            <div class="plastic-card-top">
              <div class="plastic-card-chip" aria-hidden="true"></div>
              <div class="plastic-card-network">${escapeHtml(cardNetworkLabel(network))}</div>
            </div>
            <div class="plastic-card-pan" aria-hidden="true">•••• •••• •••• ••••</div>
            <div class="plastic-card-bottom">
              <div class="plastic-card-label">${escapeHtml(holder)}</div>
              <div class="plastic-card-meta">
                ${escapeHtml(options.kindLabel)}
                ${options.isVirtual ? '<br/>VIRTUAL' : ''}
              </div>
            </div>
          </div>
          <div class="plastic-card-face back">
            <div class="plastic-card-stripe" aria-hidden="true"></div>
            <div class="plastic-card-cvv-row">
              <span>ASSINATURA</span>
              <span aria-hidden="true">CVV •••</span>
            </div>
            <div class="plastic-card-back-note">
              Modelo estético KAKEIBO — sem número real. Clique para virar.
            </div>
          </div>
        </button>
      </div>
      <div class="micro-label plastic-card-hint">[CLIQUE PARA VIRAR] frente / verso</div>
    </div>
  `;
}


/**
 * Markdown mínimo para as respostas da IA.
 *
 * O modelo escreve em markdown por natureza (`**R$ 32,50**`), e mostrar os
 * asteriscos crus fica amador. Suporta apenas negrito, itálico, código e quebra de
 * linha — o suficiente para o que a IA produz num chat.
 *
 * Escapa o HTML **antes** de aplicar as marcas: a resposta do modelo é conteúdo
 * não confiável e não pode injetar tag alguma.
 */
function renderAiMarkdown(text: string): string {
  const BOLD = /\*\*([^*]+)\*\*/g;
  const ITALIC = /(^|[^*])\*([^*\n]+)\*/g;
  const CODE = /`([^`\n]+)`/g;
  const HEADING = /^#{2,4} (.+)$/gm;
  const NEWLINE = /\n/g;

  return escapeHtml(text)
    .replace(BOLD, '<strong>$1</strong>')
    .replace(ITALIC, '$1<em>$2</em>')
    .replace(CODE, '<code>$1</code>')
    .replace(HEADING, '<div class="micro-label txt-cyan" style="margin-top: 6px;">$1</div>')
    .replace(NEWLINE, '<br/>');
}

export class KakeiboApp {
  private transactions: Transaction[] = [...TRANSACTIONS];
  /** Vazio quando o banco ainda não tem lançamento — o app precisa abrir assim mesmo. */
  private selectedTxId: string = TRANSACTIONS[0]?.id ?? '';
  /** Conversa atual com a IA, para manter o contexto entre mensagens. */
  private conversationId: string | undefined = undefined;
  private selectedJournalTxIds: Set<string> = new Set();
  private currentAiIndex: number = 0;
  private crtEnabled: boolean = true;
  private theme: 'dark' | 'light' = 'light';
  private mascotRenderer: PC98MascotRenderer | null = null;
  private isTyping: boolean = false;
  private activeTab: string = 'dashboard';
  private selectedCategoryDetail: string = '';
  private selectedAddCategoryId: string | null = null;
  private journalSearchQuery: string = '';
  private currentFilterKey: string = 'all';
  private resizeTimer: number | null = null;
  private aiRiskReject: (() => void) | null = null;
  private aiRiskDismiss: (() => void) | null = null;
  private accountsFilter: 'all' | 'cashlike' | 'credit' | 'debit' = 'all';
  private selectedAccountId: string | null = null;
  /** Filtro do Journal — separado do card selecionado em Contas. */
  private journalAccountFilter: string | null = null;
  private accountFormMode: 'create' | 'edit' = 'create';
  private editingAccountId: string | null = null;
  private editingTxId: string | null = null;
  private editingTxCategoryId: string | null = null;
  private categoryPickerSelectedId: string | null = null;
  private focusedGoalId: string | null = null;
  private focusedRecurrenceId: string | null = null;
  private focusedRuleId: string | null = null;
  private pendingAiConfirm: {
    items: Array<{ token: string; summary: string; reason: string }>;
    originalMessage: string;
    meta: HTMLElement;
  } | null = null;
  private aiDockCollapsed = false;
  private aiDockWidth = 320;
  private aiResizeActive = false;

  // USER PROFILE STATE & AVATAR RENDERERS
  private userName: string = 'Allan';
  private userAvatarPreset: UserAvatarPreset = 'cyber_pilot';
  private userAccentColor: string = '#41A6F6';
  private headerAvatarRenderer: PC98UserMascotRenderer | null = null;
  private bottomUserAvatarRenderer: PC98UserMascotRenderer | null = null;
  private presetRenderers: Record<string, PC98UserMascotRenderer> = {};

  constructor() {
    this.initTheme();
    this.initAiDockPrefs();
    this.initDOM();
    this.applyTheme(false); // refresh status-bar label after DOM exists
    this.initClock();
    this.renderAll();
    this.initEvents();
    this.initAiDockInteractions();
    window.addEventListener('resize', () => {
      if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.rerenderActiveCharts(), 150);
    });
  }

  private clampAiWidth(px: number): number {
    return Math.min(560, Math.max(260, Math.round(px)));
  }

  private initAiDockPrefs() {
    try {
      const storedWidth = Number(localStorage.getItem('kakeibo.aiWidth'));
      if (Number.isFinite(storedWidth) && storedWidth > 0) {
        this.aiDockWidth = this.clampAiWidth(storedWidth);
      }
      this.aiDockCollapsed = localStorage.getItem('kakeibo.aiCollapsed') === '1';
    } catch {
      /* ignore */
    }
    this.applyAiDockWidth(this.aiDockWidth, false);
    this.applyAiDockCollapsed(this.aiDockCollapsed, false);
  }

  private applyAiDockWidth(px: number, persist = true) {
    this.aiDockWidth = this.clampAiWidth(px);
    document.documentElement.style.setProperty('--ai-width', `${this.aiDockWidth}px`);
    if (persist) {
      try {
        localStorage.setItem('kakeibo.aiWidth', String(this.aiDockWidth));
      } catch {
        /* ignore */
      }
    }
  }

  private applyAiDockCollapsed(collapsed: boolean, persist = true) {
    this.aiDockCollapsed = collapsed;
    document.body.classList.toggle('ai-dock-collapsed', collapsed);
    if (persist) {
      try {
        localStorage.setItem('kakeibo.aiCollapsed', collapsed ? '1' : '0');
      } catch {
        /* ignore */
      }
    }
  }

  private setAiDockCollapsed(collapsed: boolean) {
    // On overlay layouts, minimize closes the dock instead of a desktop rail.
    if (collapsed && window.matchMedia('(max-width: 1100px)').matches) {
      this.applyAiDockCollapsed(false, true);
      this.setAiDockOpen(false);
      return;
    }
    this.applyAiDockCollapsed(collapsed, true);
    // Desktop collapse must not use the mobile overlay class.
    if (collapsed) {
      this.setAiDockOpen(false);
    }
  }

  private expandAiDock() {
    this.setAiDockCollapsed(false);
    if (window.matchMedia('(max-width: 1100px)').matches) {
      this.setAiDockOpen(true);
    }
    setTimeout(() => document.getElementById('chat-input-text')?.focus(), 40);
  }

  private initAiDockInteractions() {
    const handle = document.getElementById('ai-resize-handle');
    const minimizeBtn = document.getElementById('btn-minimize-ai-dock');
    const expandBtn = document.getElementById('btn-expand-ai-dock');

    minimizeBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.setAiDockCollapsed(true);
    });

    expandBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.expandAiDock();
    });

    const onPointerMove = (ev: PointerEvent) => {
      if (!this.aiResizeActive) return;
      // Sidebar is right-aligned; width = distance from pointer to right edge (minus padding).
      const next = window.innerWidth - ev.clientX - 8;
      this.applyAiDockWidth(next, false);
    };
    const onPointerUp = () => {
      if (!this.aiResizeActive) return;
      this.aiResizeActive = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      this.applyAiDockWidth(this.aiDockWidth, true);
    };

    handle?.addEventListener('pointerdown', (ev) => {
      if (window.matchMedia('(max-width: 1100px)').matches) return;
      ev.preventDefault();
      this.aiResizeActive = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });

    handle?.addEventListener('keydown', (ev) => {
      if (window.matchMedia('(max-width: 1100px)').matches) return;
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        this.applyAiDockWidth(this.aiDockWidth + 16, true);
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        this.applyAiDockWidth(this.aiDockWidth - 16, true);
      }
    });

    // Scrim click (body::before) closes overlay dock on narrow layouts.
    document.addEventListener('pointerdown', (ev) => {
      if (!document.body.classList.contains('ai-dock-open')) return;
      if (!window.matchMedia('(max-width: 1100px)').matches) return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('#ai-dock') || target.closest('#btn-mobile-ai') || target.closest('.status-bar')) return;
      this.setAiDockOpen(false);
    });
  }

  private initTheme() {
    try {
      const stored = localStorage.getItem('kakeibo.theme');
      this.theme = stored === 'dark' ? 'dark' : 'light';
    } catch {
      this.theme = 'light';
    }
    this.applyTheme(false);
  }

  private applyTheme(persist = true) {
    document.documentElement.setAttribute('data-theme', this.theme);
    const themeBtn = document.getElementById('btn-toggle-theme');
    if (themeBtn) {
      themeBtn.textContent = this.theme === 'light' ? 'THEME: LIGHT' : 'THEME: DARK';
      themeBtn.setAttribute('aria-pressed', this.theme === 'light' ? 'true' : 'false');
    }
    if (persist) {
      try {
        localStorage.setItem('kakeibo.theme', this.theme);
      } catch {
        /* ignore quota / private mode */
      }
    }
  }

  private rerenderActiveCharts() {
    if (this.activeTab === 'dashboard' || this.activeTab === 'chat' || this.activeTab === 'reports') {
      this.renderDashboardCharts();
    }
    if (this.activeTab === 'investments') {
      this.renderInvestmentCharts();
    }
    if (this.activeTab === 'category') {
      this.renderCategoryBreakdown();
    }
  }

  private initDOM() {
    const mascotCanvas = document.getElementById('ai-mascot-canvas') as HTMLCanvasElement;
    if (mascotCanvas) {
      this.mascotRenderer = new PC98MascotRenderer(mascotCanvas);
    }

    const headerAvatarCanvas = document.getElementById('user-header-avatar-canvas') as HTMLCanvasElement;
    if (headerAvatarCanvas) {
      this.headerAvatarRenderer = new PC98UserMascotRenderer(headerAvatarCanvas, this.userAvatarPreset, this.userAccentColor);
    }

    const bottomUserAvatarCanvas = document.getElementById('user-bottom-avatar-canvas') as HTMLCanvasElement;
    if (bottomUserAvatarCanvas) {
      this.bottomUserAvatarRenderer = new PC98UserMascotRenderer(bottomUserAvatarCanvas, this.userAvatarPreset, this.userAccentColor);
    }

    const presets: UserAvatarPreset[] = ['cyber_pilot', 'hacker', 'mecha', 'master'];
    presets.forEach(p => {
      const canvas = document.getElementById(`preset-canvas-${p.replace('_', '-')}`) as HTMLCanvasElement;
      if (canvas) {
        this.presetRenderers[p] = new PC98UserMascotRenderer(canvas, p, this.userAccentColor);
      }
    });
  }

  private initClock() {
    const clockEl = document.getElementById('system-clock');
    const updateTime = () => {
      const now = new Date();
      const yr = now.getFullYear();
      const mo = String(now.getMonth() + 1).padStart(2, '0');
      const da = String(now.getDate()).padStart(2, '0');
      const hr = String(now.getHours()).padStart(2, '0');
      const mi = String(now.getMinutes()).padStart(2, '0');
      const se = String(now.getSeconds()).padStart(2, '0');
      if (clockEl) {
        clockEl.textContent = `${yr}.${mo}.${da} ${hr}:${mi}:${se}`;
      }
    };
    updateTime();
    setInterval(updateTime, 1000);
  }

  private renderAll() {
    this.renderTotals();
    this.renderBudgets();
    this.renderRecentTransactions();
    this.renderAccounts();
    this.renderDebts();
    this.renderHoldings();
    this.renderJournalTransactions(this.currentFilterKey);
    this.renderCategoryBreakdown();
    this.renderDashboardCharts();
    this.renderInvestmentCharts();
    this.renderInsightsPanel();
    this.renderRecurrences();
    this.renderGoals();
    this.renderRules();
    this.renderImportHistory();
    this.renderUpcomingBills();
    this.renderChatGreeting();
    this.triggerAiInsight(this.currentAiIndex);
  }


  /**
   * Saudação inicial do chat.
   *
   * Montada a partir dos insights que o backend detectou, não de texto fixo — a
   * primeira coisa que a IA diz já é sobre os seus números.
   */
  private renderChatGreeting() {
    const streamBox = document.getElementById('chat-stream-box');
    if (!streamBox || streamBox.children.length > 0) return;

    const row = document.createElement('div');
    row.className = 'chat-bubble-row ai-side';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ai-bubble';

    const header = document.createElement('div');
    header.className = 'micro-label';
    header.style.cssText = 'color: var(--c-bone-white); margin-bottom: 4px;';
    header.textContent = 'KAKEIBO.AI';

    const body = document.createElement('div');
    body.textContent = openingAiMessage();

    bubble.append(header, body);
    row.appendChild(bubble);
    streamBox.appendChild(row);
  }

  private renderDashboardCharts() {
    setTimeout(() => {
      const radarCanvas = document.getElementById('radar-chart-canvas') as HTMLCanvasElement;
      if (radarCanvas) PC98ChartSuite.renderRadarChart(radarCanvas, radarHealthMetrics());

      const gaugeCanvas = document.getElementById('gauge-chart-canvas') as HTMLCanvasElement;
      if (gaugeCanvas) {
        const pct = primaryGoalProgressPercent();
        const title = primaryGoalName() ?? 'META ECONOMIA';
        PC98ChartSuite.renderGaugeChart(gaugeCanvas, pct, title);
      }

      const flowCanvas = document.getElementById('flow-chart-canvas') as HTMLCanvasElement;
      if (flowCanvas) PC98ChartSuite.renderFlowLineChart(flowCanvas, MONTHLY_FLOW);

      const projCanvas = document.getElementById('projection-chart-canvas') as HTMLCanvasElement;
      if (projCanvas) PC98ChartSuite.renderProjectionChart(projCanvas, PROJECTION);
    }, 50);
  }

  private renderInvestmentCharts() {
    setTimeout(() => {
      const candleCanvas = document.getElementById('candlestick-chart-canvas') as HTMLCanvasElement;
      if (candleCanvas) PC98ChartSuite.renderCandlestickChart(candleCanvas);
    }, 50);
  }

  // ── TOTALS — uses real computed values ────────────────────────────────────

  private renderTotals() {
    const income = currentMonthIncome();
    const expense = currentMonthExpense();
    const balance = totalAvailableBalance();
    const nw = netWorth();

    const balanceEl = document.getElementById('val-balance');
    const incomeEl = document.getElementById('val-income');
    const expenseEl = document.getElementById('val-expense');
    const nwEl = document.getElementById('val-net-worth');

    if (balanceEl) balanceEl.textContent = formatMoney(balance);
    if (incomeEl) incomeEl.textContent = formatMoney(income);
    if (expenseEl) expenseEl.textContent = formatMoney(expense);
    if (nwEl) nwEl.textContent = formatMoney(nw);
  }

  // ── BUDGETS — uses real Budget objects ────────────────────────────────────

  private renderBudgets() {
    const container = document.getElementById('budget-bars-container');
    if (!container) return;

    container.innerHTML = '';

    BUDGETS.forEach(bgt => {
      const catName = getCategoryName(bgt.categoryId);
      const isOver = bgt.remainingCents < 0;
      // A barra satura em 100% (não há como preencher mais que a trilha), mas o
      // texto mostra o número real: travar os dois em 100 fazia um gasto de 665%
      // do limite parecer estar exatamente no teto.
      const barPct = Math.min(100, Math.round(bgt.usedPercent));
      const realPct = Math.round(bgt.usedPercent);

      const barWrapper = document.createElement('div');
      barWrapper.className = 'segmented-bar-container';
      barWrapper.setAttribute('role', 'button');
      barWrapper.setAttribute('tabindex', '0');
      barWrapper.setAttribute(
        'aria-label',
        `Orçamento ${catName}: ${formatMoney(bgt.spentCents)} de ${formatMoney(bgt.amountCents)} (${realPct}%)${bgt.rolloverCents !== 0 ? `, limite ajustado em ${formatMoney(bgt.rolloverCents)} de rollover` : ''}${isOver ? ', estourou' : bgt.willExceed ? ', risco de estouro' : ''}`
      );

      const totalBlocks = 10;
      const filledBlocks = Math.round((barPct / 100) * totalBlocks);

      let blocksHtml = '';
      for (let i = 0; i < totalBlocks; i++) {
        let activeClass = '';
        if (i < filledBlocks) {
          activeClass = isOver ? 'filled-pink' : (bgt.willExceed ? 'filled-amber' : 'filled-cyan');
        }
        blocksHtml += `<div class="bar-block ${activeClass}"></div>`;
      }

      barWrapper.innerHTML = `
        <div class="segmented-bar-header">
          <span>${catName} ${bgt.rolloverCents !== 0 ? `<span class="micro-label ${bgt.rolloverCents < 0 ? 'txt-pink' : 'txt-cyan'}" title="Limite base ${formatMoney(bgt.baseLimitCents)} ajustado pelo saldo dos meses anteriores">[ROLLOVER ${bgt.rolloverCents > 0 ? '+' : ''}${formatMoney(bgt.rolloverCents)}]</span>` : ''}</span>
          <span class="num-currency ${isOver ? 'txt-pink' : bgt.willExceed ? 'txt-amber' : 'txt-cyan'}">
            ${formatMoney(bgt.spentCents)} / ${formatMoney(bgt.amountCents)} (${realPct}%)
            ${isOver ? ' <span class="txt-pink">[ESTOUROU!]</span>' : ''}
            ${bgt.willExceed && !isOver ? ' <span class="txt-amber">[RISCO]</span>' : ''}
          </span>
        </div>
        <div class="segmented-track">
          ${blocksHtml}
        </div>
      `;

      const openCategory = () => {
        pc98Audio.playSelect();
        this.selectedCategoryDetail = bgt.categoryId;
        this.switchTab('category');
      };
      barWrapper.addEventListener('click', openCategory);
      barWrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openCategory();
        }
      });

      container.appendChild(barWrapper);
    });
  }

  private getCategoryIcon(catNameOrId: string): string {
    const lower = catNameOrId.toLowerCase();
    if (lower.includes('aliment') || lower.includes('mercado') || lower.includes('super') || lower.includes('delivery') || lower.includes('restaur')) return BITMAP_ICONS.food;
    if (lower.includes('trans') || lower.includes('combust') || lower.includes('uber') || lower.includes('99')) return BITMAP_ICONS.transport;
    if (lower.includes('morad') || lower.includes('aluguel') || lower.includes('luz') || lower.includes('internet') || lower.includes('financ')) return BITMAP_ICONS.utilities;
    if (lower.includes('lazer') || lower.includes('stream') || lower.includes('netflix') || lower.includes('spotify')) return BITMAP_ICONS.entertainment;
    if (lower.includes('salár') || lower.includes('salario') || lower.includes('income') || lower.includes('freelance') || lower.includes('divid')) return BITMAP_ICONS.income;
    if (lower.includes('saúde') || lower.includes('saude') || lower.includes('farmácia') || lower.includes('academ') || lower.includes('plano')) return BITMAP_ICONS.health || BITMAP_ICONS.utilities;
    return BITMAP_ICONS.expense;
  }

  // ── RECENT TRANSACTIONS — uses new Transaction model ──────────────────────

  private renderRecentTransactions() {
    const listEl = document.getElementById('recent-tx-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    // Filter to only cleared/reconciled current-month transactions, non-transfer
    const recent = this.transactions
      .filter(tx => tx.type !== 'transfer' && (tx.status === 'cleared' || tx.status === 'reconciled'))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5);

    recent.forEach((tx) => {
      const isSelected = tx.id === this.selectedTxId;
      const isPositive = tx.amountCents > 0;
      const row = document.createElement('div');
      row.className = `tx-row-dense ${isSelected ? 'selected' : ''}`;

      const amtSign = isPositive ? '+' : '-';
      const amtVal = formatMoney(Math.abs(tx.amountCents));
      const amtClass = isPositive ? 'txt-green' : 'txt-pink';
      const catName = getCategoryName(tx.categoryId);
      const iconSvg = this.getCategoryIcon(catName);
      const installLabel = tx.installmentNo && tx.installmentTotal ? `<span class="micro-label">[${tx.installmentNo}/${tx.installmentTotal}]</span>` : '';
      const statusBadge = `<span class="micro-label ${statusColorClass(tx.status)}">[${statusLabel(tx.status)}]</span>`;

      row.innerHTML = `
        <div class="tx-cursor">▶</div>
        <div style="width: 16px; height: 16px;">${iconSvg}</div>
        <div>${formatDate(tx.date)}</div>
        <div>${tx.description} ${installLabel} ${statusBadge}</div>
        <div class="tx-category">${catName}</div>
        <div class="num-currency ${amtClass}" style="text-align: right;">${amtSign}${amtVal}</div>
      `;

      row.addEventListener('click', () => {
        pc98Audio.playSelect();
        this.selectedTxId = tx.id;
        this.renderRecentTransactions();
      });

      listEl.appendChild(row);
    });
  }

  // ── ACCOUNTS — uses new Account model with computed balances ───────────────

  private renderAccounts() {
    const grid = document.getElementById('accounts-cards-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const filtered = ACCOUNTS.filter((acc) => {
      if (this.accountsFilter === 'all') return true;
      if (this.accountsFilter === 'cashlike') return CASHLIKE_KINDS.has(acc.kind);
      if (this.accountsFilter === 'credit') return acc.kind === 'credit_card';
      if (this.accountsFilter === 'debit') return acc.hasDebitCard && acc.kind !== 'credit_card';
      return true;
    });

    if (ACCOUNTS.length === 0) {
      grid.innerHTML = `
        <div class="pc98-well" style="padding: 16px; grid-column: 1 / -1; display: flex; flex-direction: column; gap: 10px; align-items: flex-start;">
          <div style="font-weight: bold; color: var(--c-bone-white);">Nenhuma conta ainda.</div>
          <div class="micro-label" style="color: var(--c-pale-cyan); line-height: 1.5;">Aha: crie sua conta corrente e, se quiser, um cartão.</div>
          <button type="button" id="btn-create-first-account" class="pc98-btn btn-primary" style="padding: 8px 12px;">[+ CRIAR PRIMEIRA CONTA]</button>
        </div>
      `;
      document.getElementById('btn-create-first-account')?.addEventListener('click', () => {
        this.openAccountForm('create');
      });
      this.renderAccountDetail();
      const invoicesEmpty = document.getElementById('invoices-container');
      if (invoicesEmpty) invoicesEmpty.innerHTML = '';
      return;
    }

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue); padding: 12px;">NENHUMA CONTA — USE [+ NOVA CONTA]</div>`;
    }

    if (this.selectedAccountId && !ACCOUNTS.some((a) => a.id === this.selectedAccountId)) {
      this.selectedAccountId = null;
    }

    filtered.forEach((acc) => {
      const isCredit = acc.kind === 'credit_card';
      const balance = computeBalance(acc.id);
      const creditCard = isCredit ? CREDIT_CARDS.find((c) => c.accountId === acc.id) : null;
      const usage = isCredit ? cardUsage(acc.id) : undefined;

      const badges: string[] = [
        `<span class="micro-label" style="color: var(--c-grey-blue);">[${escapeHtml(accountKindLabel(acc.kind))}]</span>`,
      ];
      if (isCredit && creditCard?.isVirtual) {
        badges.push(`<span class="micro-label txt-cyan">[VIRTUAL]</span>`);
      }
      if (!isCredit && acc.debitIsVirtual) {
        badges.push(`<span class="micro-label txt-cyan">[VIRTUAL]</span>`);
      }
      if (acc.hasDebitCard && !isCredit) {
        badges.push(`<span class="micro-label txt-amber">[DÉBITO]</span>`);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `account-card-btn pc98-well${this.selectedAccountId === acc.id ? ' selected' : ''}`;
      btn.dataset.accountId = acc.id;
      btn.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap;">
          <span style="font-weight: bold; color: var(--c-bone-white);">${escapeHtml(acc.name)}</span>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">${badges.join('')}</div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-top: 6px;">
          <div>
            <div class="micro-label" style="color: var(--c-grey-blue);">DISPONÍVEL</div>
            <div class="num-currency ${balance.availableCents < 0 ? 'txt-pink' : 'txt-green'}" style="font-size: 20px;">
              ${formatMoney(balance.availableCents)}
            </div>
          </div>
          <div style="text-align: right;">
            <div class="micro-label" style="color: var(--c-grey-blue);">PROJETADO</div>
            <div class="num-currency" style="font-size: 13px; color: var(--c-pale-cyan);">
              ${formatMoney(balance.projectedCents)}
            </div>
          </div>
        </div>
        ${
          isCredit && creditCard
            ? `<div class="micro-label" style="color: var(--c-grey-blue); margin-top: 4px;">
                ${
                  usage
                    ? `USO: ${usage.usedPercent}% DE ${formatMoney(usage.limitCents)}`
                    : `LIMITE: ${formatMoney(creditCard.limitCents)}`
                }
               </div>`
            : `<div class="micro-label" style="color: var(--c-grey-blue); margin-top: 4px;">${escapeHtml(acc.institution || acc.currency)}</div>`
        }
      `;
      btn.addEventListener('click', () => {
        pc98Audio.playSelect();
        this.selectedAccountId = acc.id;
        this.renderAccounts();
      });
      grid.appendChild(btn);
    });

    this.renderAccountDetail();

    const invoicesContainer = document.getElementById('invoices-container');
    if (invoicesContainer) {
      invoicesContainer.innerHTML = '';
      const selected = this.selectedAccountId
        ? ACCOUNTS.find((a) => a.id === this.selectedAccountId)
        : null;
      const invoices =
        selected?.kind === 'credit_card'
          ? CARD_INVOICES.filter((inv) => inv.cardAccountId === selected.id)
          : CARD_INVOICES.filter((inv) => inv.status === 'open' || inv.status === 'overdue');

      if (invoices.length === 0) {
        invoicesContainer.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue); padding: 8px;">SEM FATURAS ABERTAS</div>`;
      }

      invoices.forEach((inv) => {
        const statusClass = inv.status === 'overdue' ? 'txt-pink' : inv.status === 'open' ? 'txt-amber' : 'txt-green';
        const statusText = inv.status === 'overdue' ? 'VENCIDA' : inv.status === 'open' ? 'ABERTA' : 'PAGA';
        const canPay = inv.status === 'open' || inv.status === 'overdue';
        const cardAcc = ACCOUNTS.find((a) => a.id === inv.cardAccountId);
        const showName = selected?.kind !== 'credit_card';
        const el = document.createElement('div');
        el.className = 'pc98-well';
        el.style.padding = '8px';
        el.innerHTML = `
          <div style="display: flex; justify-content: space-between;">
            <span class="micro-label">FATURA ${escapeHtml(inv.referenceMonth)}${showName && cardAcc ? ` · ${escapeHtml(cardAcc.name)}` : ''}</span>
            <span class="micro-label ${statusClass}">[${statusText}]</span>
          </div>
          <div class="num-currency ${statusClass}" style="font-size: var(--fs-md);">${formatMoney(inv.totalCents)}</div>
          <div class="micro-label" style="color: var(--c-grey-blue);">Vencimento: ${formatDate(inv.dueDate)}</div>
          ${canPay ? `<button type="button" class="pc98-btn btn-primary btn-pay-invoice-row" data-invoice-id="${escapeHtml(inv.id)}" style="margin-top: 6px; padding: 4px 10px; font-size: 11px;">[PAGAR]</button>` : ''}
        `;
        const payBtn = el.querySelector('.btn-pay-invoice-row') as HTMLButtonElement | null;
        payBtn?.addEventListener('click', () => {
          void this.payInvoiceById(inv.id);
        });
        invoicesContainer.appendChild(el);
      });
    }
  }

  private renderAccountDetail() {
    const panel = document.getElementById('account-detail-panel');
    if (!panel) return;

    const acc = this.selectedAccountId
      ? ACCOUNTS.find((a) => a.id === this.selectedAccountId)
      : null;

    if (!acc) {
      if (ACCOUNTS.length === 0) {
        panel.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <div style="font-weight: bold; color: var(--c-bone-white);">Nenhuma conta ainda.</div>
            <div class="micro-label" style="color: var(--c-pale-cyan); line-height: 1.5;">Aha: crie sua conta corrente e, se quiser, um cartão.</div>
            <button type="button" id="btn-create-first-account-detail" class="pc98-btn btn-primary" style="padding: 8px 12px;">[+ CRIAR PRIMEIRA CONTA]</button>
          </div>
        `;
        document.getElementById('btn-create-first-account-detail')?.addEventListener('click', () => {
          this.openAccountForm('create');
        });
        return;
      }
      panel.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue);">Selecione uma conta para ver detalhes, editar ou arquivar.</div>`;
      return;
    }

    const isCredit = acc.kind === 'credit_card';
    const balance = computeBalance(acc.id);
    const creditCard = isCredit ? CREDIT_CARDS.find((c) => c.accountId === acc.id) : null;
    const usage = isCredit ? cardUsage(acc.id) : undefined;
    const paymentName =
      creditCard?.paymentAccountId
        ? ACCOUNTS.find((a) => a.id === creditCard.paymentAccountId)?.name
        : null;

    let specifics = '';
    let plastic = '';
    if (isCredit && creditCard) {
      specifics = `
        <div class="micro-label" style="color: var(--c-grey-blue);">LIMITE: ${formatMoney(creditCard.limitCents)}</div>
        <div class="micro-label" style="color: var(--c-grey-blue);">FECHA DIA ${creditCard.closingDay} · VENCE DIA ${creditCard.dueDay}</div>
        ${usage ? `<div class="micro-label" style="color: var(--c-amber);">USO: ${usage.usedPercent}% (${formatMoney(usage.usedCents)})</div>` : ''}
        <div class="micro-label" style="color: var(--c-pale-cyan);">BANDEIRA: ${escapeHtml(cardNetworkLabel(creditCard.network))}</div>
        ${creditCard.isVirtual ? `<div class="micro-label txt-cyan">[VIRTUAL]</div>` : ''}
        ${paymentName ? `<div class="micro-label" style="color: var(--c-grey-blue);">PAGA COM: ${escapeHtml(paymentName)}</div>` : ''}
      `;
      plastic = buildPlasticCardHtml({
        name: acc.name,
        holder: creditCard.holderLabel,
        network: creditCard.network,
        isVirtual: creditCard.isVirtual,
        kindLabel: 'CRÉDITO',
        idSuffix: acc.id,
      });
    } else {
      const debitBits: string[] = [];
      if (acc.hasDebitCard) debitBits.push('[DÉBITO]');
      if (acc.debitIsVirtual) debitBits.push('[VIRTUAL]');
      specifics = `
        <div class="micro-label" style="color: var(--c-grey-blue);">SALDO ABERTURA: ${formatMoney(acc.openingBalanceCents)}</div>
        ${debitBits.length ? `<div class="micro-label txt-amber">${debitBits.join(' ')}</div>` : ''}
        ${
          acc.hasDebitCard
            ? `<div class="micro-label" style="color: var(--c-pale-cyan);">BANDEIRA: ${escapeHtml(cardNetworkLabel(acc.debitCardNetwork))}</div>`
            : ''
        }
      `;
      if (acc.hasDebitCard) {
        plastic = buildPlasticCardHtml({
          name: acc.name,
          holder: acc.debitCardHolder,
          network: acc.debitCardNetwork,
          isVirtual: acc.debitIsVirtual,
          kindLabel: 'DÉBITO',
          idSuffix: acc.id,
        });
      }
    }

    panel.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${plastic}
        <div style="font-weight: bold; color: var(--c-bone-white); font-size: 15px;">${escapeHtml(acc.name)}</div>
        <div class="micro-label" style="color: var(--c-pale-cyan);">[${escapeHtml(accountKindLabel(acc.kind))}]</div>
        ${acc.institution ? `<div class="micro-label" style="color: var(--c-grey-blue);">${escapeHtml(acc.institution)}</div>` : ''}
        <div>
          <div class="micro-label" style="color: var(--c-grey-blue);">DISPONÍVEL</div>
          <div class="num-currency ${balance.availableCents < 0 ? 'txt-pink' : 'txt-green'}" style="font-size: 18px;">${formatMoney(balance.availableCents)}</div>
        </div>
        <div>
          <div class="micro-label" style="color: var(--c-grey-blue);">PROJETADO</div>
          <div class="num-currency" style="font-size: 14px; color: var(--c-pale-cyan);">${formatMoney(balance.projectedCents)}</div>
        </div>
        ${specifics}
        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
          <button type="button" id="btn-edit-account" class="pc98-btn btn-primary" style="padding: 4px 10px; font-size: 11px;">[EDITAR]</button>
          <button type="button" id="btn-archive-account" class="pc98-btn btn-alert" style="padding: 4px 10px; font-size: 11px;">[ARQUIVAR]</button>
          <button type="button" id="btn-account-to-journal" class="pc98-btn" style="padding: 4px 10px; font-size: 11px;">[VER NO JOURNAL]</button>
          ${isCredit ? `<button type="button" id="btn-scroll-invoices" class="pc98-btn" style="padding: 4px 10px; font-size: 11px;">[VER FATURAS]</button>` : ''}
        </div>
      </div>
    `;

    panel.querySelector('.plastic-card')?.addEventListener('click', (e) => {
      e.preventDefault();
      pc98Audio.playSelect();
      (e.currentTarget as HTMLElement).classList.toggle('is-flipped');
    });

    document.getElementById('btn-edit-account')?.addEventListener('click', () => {
      pc98Audio.playSelect();
      this.openAccountForm('edit', acc);
    });
    document.getElementById('btn-archive-account')?.addEventListener('click', () => {
      void this.archiveSelectedAccount();
    });
    document.getElementById('btn-account-to-journal')?.addEventListener('click', () => {
      pc98Audio.playSelect();
      this.journalAccountFilter = this.selectedAccountId;
      this.switchTab('transactions');
    });
    document.getElementById('btn-scroll-invoices')?.addEventListener('click', () => {
      pc98Audio.playClick();
      document.getElementById('invoices-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  private syncAccountFormSections() {
    const kindSelect = document.getElementById('account-input-kind') as HTMLSelectElement | null;
    const debitSection = document.getElementById('account-debit-section');
    const creditSection = document.getElementById('account-credit-section');
    const openingGroup = document.getElementById('account-opening-balance-group');
    const hasDebit = document.getElementById('account-input-has-debit') as HTMLInputElement | null;
    const debitVisual = document.getElementById('account-debit-visual');
    if (!kindSelect) return;
    const isCredit = kindSelect.value === 'credit_card';
    if (debitSection) debitSection.style.display = isCredit ? 'none' : 'flex';
    if (creditSection) {
      creditSection.style.display = isCredit ? 'flex' : 'none';
      creditSection.classList.toggle('hidden', !isCredit);
    }
    if (openingGroup) openingGroup.style.display = isCredit ? 'none' : 'flex';
    debitVisual?.classList.toggle('is-open', !isCredit && !!hasDebit?.checked);
  }

  private populatePaymentAccountSelect(excludeId?: string) {
    const select = document.getElementById('account-input-payment-account') as HTMLSelectElement | null;
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '<option value="">— nenhuma —</option>';
    for (const acc of ACCOUNTS.filter((a) => a.kind !== 'credit_card' && !a.isArchived && a.id !== excludeId)) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = acc.name;
      select.appendChild(opt);
    }
    if (previous && [...select.options].some((o) => o.value === previous)) {
      select.value = previous;
    }
  }

  private openAccountForm(mode: 'create' | 'edit', account?: Account) {
    pc98Audio.playSelect();
    this.accountFormMode = mode;
    this.editingAccountId = mode === 'edit' && account ? account.id : null;

    const modal = document.getElementById('modal-account-form');
    const title = document.getElementById('account-form-title');
    const nameInput = document.getElementById('account-input-name') as HTMLInputElement | null;
    const kindSelect = document.getElementById('account-input-kind') as HTMLSelectElement | null;
    const institutionInput = document.getElementById('account-input-institution') as HTMLInputElement | null;
    const openingInput = document.getElementById('account-input-opening-balance') as HTMLInputElement | null;
    const hasDebit = document.getElementById('account-input-has-debit') as HTMLInputElement | null;
    const debitVirtual = document.getElementById('account-input-debit-virtual') as HTMLInputElement | null;
    const debitNetwork = document.getElementById('account-input-debit-network') as HTMLSelectElement | null;
    const debitHolder = document.getElementById('account-input-debit-holder') as HTMLInputElement | null;
    const limitInput = document.getElementById('account-input-limit') as HTMLInputElement | null;
    const closingInput = document.getElementById('account-input-closing-day') as HTMLInputElement | null;
    const dueInput = document.getElementById('account-input-due-day') as HTMLInputElement | null;
    const isVirtual = document.getElementById('account-input-is-virtual') as HTMLInputElement | null;
    const creditNetwork = document.getElementById('account-input-credit-network') as HTMLSelectElement | null;
    const creditHolder = document.getElementById('account-input-credit-holder') as HTMLInputElement | null;
    const paymentSelect = document.getElementById('account-input-payment-account') as HTMLSelectElement | null;

    if (title) title.textContent = mode === 'create' ? 'NOVA CONTA' : 'EDITAR CONTA';
    this.populatePaymentAccountSelect(account?.id);

    if (mode === 'edit' && account) {
      if (nameInput) nameInput.value = account.name;
      if (kindSelect) {
        kindSelect.value = account.kind;
        kindSelect.disabled = true;
      }
      if (institutionInput) institutionInput.value = account.institution;
      if (openingInput) openingInput.value = (account.openingBalanceCents / 100).toFixed(2);
      if (hasDebit) hasDebit.checked = account.hasDebitCard;
      if (debitVirtual) debitVirtual.checked = account.debitIsVirtual;
      if (debitNetwork) debitNetwork.value = account.debitCardNetwork || 'mastercard';
      if (debitHolder) debitHolder.value = account.debitCardHolder || '';
      const card = CREDIT_CARDS.find((c) => c.accountId === account.id);
      if (card) {
        if (limitInput) limitInput.value = (card.limitCents / 100).toFixed(2);
        if (closingInput) closingInput.value = String(card.closingDay);
        if (dueInput) dueInput.value = String(card.dueDay);
        if (isVirtual) isVirtual.checked = card.isVirtual;
        if (paymentSelect) paymentSelect.value = card.paymentAccountId || '';
        if (creditNetwork) creditNetwork.value = card.network || 'mastercard';
        if (creditHolder) creditHolder.value = card.holderLabel || '';
      }
    } else {
      if (nameInput) nameInput.value = '';
      if (kindSelect) {
        kindSelect.value = 'checking';
        kindSelect.disabled = false;
      }
      if (institutionInput) institutionInput.value = '';
      if (openingInput) openingInput.value = '0';
      if (hasDebit) hasDebit.checked = false;
      if (debitVirtual) debitVirtual.checked = false;
      if (debitNetwork) debitNetwork.value = 'mastercard';
      if (debitHolder) debitHolder.value = '';
      if (limitInput) limitInput.value = '0';
      if (closingInput) closingInput.value = '1';
      if (dueInput) dueInput.value = '10';
      if (isVirtual) isVirtual.checked = false;
      if (creditNetwork) creditNetwork.value = 'mastercard';
      if (creditHolder) creditHolder.value = '';
      if (paymentSelect) paymentSelect.value = '';
    }

    this.syncAccountFormSections();
    this.showModal(modal);
    nameInput?.focus();
  }

  private closeAccountForm() {
    document.getElementById('modal-account-form')?.classList.add('hidden');
    const kindSelect = document.getElementById('account-input-kind') as HTMLSelectElement | null;
    if (kindSelect) kindSelect.disabled = false;
    this.editingAccountId = null;
  }

  private async submitAccountForm() {
    const nameInput = document.getElementById('account-input-name') as HTMLInputElement | null;
    const kindSelect = document.getElementById('account-input-kind') as HTMLSelectElement | null;
    const institutionInput = document.getElementById('account-input-institution') as HTMLInputElement | null;
    const openingInput = document.getElementById('account-input-opening-balance') as HTMLInputElement | null;
    const hasDebit = document.getElementById('account-input-has-debit') as HTMLInputElement | null;
    const debitVirtual = document.getElementById('account-input-debit-virtual') as HTMLInputElement | null;
    const debitNetwork = document.getElementById('account-input-debit-network') as HTMLSelectElement | null;
    const debitHolder = document.getElementById('account-input-debit-holder') as HTMLInputElement | null;
    const limitInput = document.getElementById('account-input-limit') as HTMLInputElement | null;
    const closingInput = document.getElementById('account-input-closing-day') as HTMLInputElement | null;
    const dueInput = document.getElementById('account-input-due-day') as HTMLInputElement | null;
    const isVirtual = document.getElementById('account-input-is-virtual') as HTMLInputElement | null;
    const creditNetwork = document.getElementById('account-input-credit-network') as HTMLSelectElement | null;
    const creditHolder = document.getElementById('account-input-credit-holder') as HTMLInputElement | null;
    const paymentSelect = document.getElementById('account-input-payment-account') as HTMLSelectElement | null;

    const name = nameInput?.value.trim() ?? '';
    if (!name) {
      this.notify('Informe o nome da conta.', 'warn');
      return;
    }

    const kind = (kindSelect?.value ?? 'checking') as Account['kind'];
    const institution = institutionInput?.value.trim() || undefined;
    const isCredit = kind === 'credit_card';
    const debitHolderValue = debitHolder?.value.trim() || undefined;
    const creditHolderValue = creditHolder?.value.trim() || undefined;

    try {
      if (this.accountFormMode === 'create') {
        const body: Record<string, unknown> = {
          name,
          kind,
          currency: 'BRL',
          ...(institution ? { institution } : {}),
        };
        if (isCredit) {
          const closingDay = Number(closingInput?.value || 1);
          const dueDay = Number(dueInput?.value || 10);
          body.card = {
            limitCents: parseReaisToCents(limitInput?.value || '0'),
            closingDay,
            dueDay,
            isVirtual: isVirtual?.checked ?? false,
            network: creditNetwork?.value || 'other',
            ...(creditHolderValue ? { holderLabel: creditHolderValue } : {}),
            ...(paymentSelect?.value ? { paymentAccountId: paymentSelect.value } : {}),
          };
        } else {
          body.openingBalanceCents = parseReaisToCents(openingInput?.value || '0');
          body.hasDebitCard = hasDebit?.checked ?? false;
          body.debitIsVirtual = (hasDebit?.checked && debitVirtual?.checked) ?? false;
          if (hasDebit?.checked) {
            body.debitCardNetwork = debitNetwork?.value || 'other';
            if (debitHolderValue) body.debitCardHolder = debitHolderValue;
          }
        }
        const result = await api.createAccount(body);
        this.closeAccountForm();
        this.selectedAccountId = result.data.id;
        await this.reloadAfterWrite('Conta criada.', result.changeSetId);
      } else if (this.editingAccountId) {
        const body: Record<string, unknown> = {
          name,
          ...(institution !== undefined ? { institution: institution || null } : {}),
        };
        if (isCredit) {
          body.card = {
            limitCents: parseReaisToCents(limitInput?.value || '0'),
            closingDay: Number(closingInput?.value || 1),
            dueDay: Number(dueInput?.value || 10),
            isVirtual: isVirtual?.checked ?? false,
            network: creditNetwork?.value || 'other',
            holderLabel: creditHolderValue || null,
            paymentAccountId: paymentSelect?.value || null,
          };
        } else {
          body.openingBalanceCents = parseReaisToCents(openingInput?.value || '0');
          body.hasDebitCard = hasDebit?.checked ?? false;
          body.debitIsVirtual = (hasDebit?.checked && debitVirtual?.checked) ?? false;
          body.debitCardNetwork = hasDebit?.checked ? (debitNetwork?.value || 'other') : null;
          body.debitCardHolder = hasDebit?.checked ? (debitHolderValue || null) : null;
        }
        const result = await api.updateAccount(this.editingAccountId, body);
        this.closeAccountForm();
        await this.reloadAfterWrite('Conta atualizada.', result.changeSetId);
      }
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao salvar conta: ${String(error)}`,
        'error',
      );
    }
  }

  private async archiveSelectedAccount() {
    if (!this.selectedAccountId) return;
    const acc = ACCOUNTS.find((a) => a.id === this.selectedAccountId);
    if (!acc) return;
    pc98Audio.playSelect();
    const ok = await this.openSystemDialog({
      title: '✦ ARQUIVAR CONTA ✦',
      body: `Arquivar <strong>${escapeHtml(acc.name)}</strong>?`,
      confirmLabel: '[ARQUIVAR]',
      cancelLabel: '[CANCELAR]',
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await api.archiveAccount(acc.id);
      this.selectedAccountId = null;
      await this.reloadAfterWrite('Conta arquivada.', result.changeSetId);
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao arquivar: ${String(error)}`,
        'error',
      );
    }
  }

  // ── DEBTS — uses new Debt model with amortization schedule ────────────────

  private renderDebts() {
    const container = document.getElementById('debts-cards-container');
    if (!container) return;
    container.innerHTML = '';

    DEBTS.forEach(d => {
      const card = document.createElement('div');
      card.className = 'pc98-well';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.gap = '6px';

      const ratePercent = (d.annualRateBps / 100).toFixed(2);

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: bold; color: var(--c-pink);">${d.name}</span>
          <span class="micro-label" style="color: var(--c-amber);">${d.system.toUpperCase()} • ${ratePercent}% a.a.</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <div>
            <div class="micro-label" style="color: var(--c-grey-blue);">SALDO DEVEDOR</div>
            <div class="num-currency txt-pink" style="font-size: 22px;">${formatMoney(d.outstandingCents)}</div>
          </div>
          <div style="text-align: right;">
            <div class="micro-label" style="color: var(--c-grey-blue);">PROGRESSO</div>
            <div class="num-currency txt-green" style="font-size: 14px;">${d.progressPercent.toFixed(1)}%</div>
          </div>
        </div>
        <div class="micro-label">
          PARCELA: ${formatMoney(DEBT_PAYMENTS[0]?.amountCents ?? 0)} | PAGAS: ${d.paidCount}/${d.termMonths} | JUROS PAGOS: ${formatMoney(d.paidInterestCents)}
        </div>
      `;

      container.appendChild(card);
    });

    // Amortization table with real payments data
    const tbody = document.getElementById('amortization-table-body');
    if (tbody) {
      tbody.innerHTML = '';
      DEBT_PAYMENTS.slice(0, 12).forEach(payment => {
        const isPaid = payment.paidDate !== null;
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px dotted var(--c-grey-blue)';
        tr.innerHTML = `
          <td style="padding: 6px;">${payment.installmentNo}/${DEBTS[0].termMonths} ${isPaid ? '<span class="txt-green">✓</span>' : '<span class="txt-amber">○</span>'}</td>
          <td style="padding: 6px;" class="num-currency">${formatMoney(payment.amountCents)}</td>
          <td style="padding: 6px;" class="num-currency txt-pink">${formatMoney(payment.interestCents)}</td>
          <td style="padding: 6px;" class="num-currency txt-green">${formatMoney(payment.principalCents)}</td>
          <td style="padding: 6px;" class="num-currency">${formatMoney(payment.balanceAfterCents)}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  // ── HOLDINGS — uses new Holding model with asset classes ──────────────────

  private renderHoldings() {
    const container = document.getElementById('holdings-table-container');
    if (!container) return;

    const assetClassLabel: Record<string, string> = {
      stock: 'AÇÕES', fii: 'FIIs', etf: 'ETFs', fixed_income: 'RENDA FIXA',
      crypto: 'CRIPTO', fund: 'FUNDOS', pension: 'PREVIDÊNCIA', other: 'OUTROS',
    };

    let html = `
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: var(--c-slate); color: var(--c-bone-white); font-family: var(--font-micro); font-size: 10px; text-align: left;">
            <th style="padding: 6px;">TICKER</th>
            <th style="padding: 6px;">ATIVO</th>
            <th style="padding: 6px;">CLASSE</th>
            <th style="padding: 6px;">QTD</th>
            <th style="padding: 6px;">VALOR MERC.</th>
            <th style="padding: 6px;">GANHO</th>
            <th style="padding: 6px; text-align: right;">RETORNO</th>
          </tr>
        </thead>
        <tbody>
    `;

    let totalMarketValue = 0;
    let totalGain = 0;

    if (HOLDINGS.length === 0) {
      html += `
        <tr>
          <td colspan="7" style="padding: 16px; text-align: center;" class="micro-label">NENHUM ATIVO NA CARTEIRA</td>
        </tr>
      `;
    }

    HOLDINGS.forEach(h => {
      const returnClass = (h.gainPercent ?? 0) >= 0 ? 'txt-green' : 'txt-pink';
      totalMarketValue += h.marketValueCents ?? h.totalCostCents;
      totalGain += h.gainCents ?? 0;

      html += `
        <tr style="border-bottom: 1px dotted var(--c-grey-blue);">
          <td style="padding: 6px; font-weight: bold; color: var(--c-cyan);">${h.ticker ?? '—'}</td>
          <td style="padding: 6px;">${h.name}</td>
          <td style="padding: 6px;" class="micro-label">${assetClassLabel[h.assetClass] ?? h.assetClass}</td>
          <td style="padding: 6px;" class="num-currency">${h.quantity}</td>
          <td style="padding: 6px;" class="num-currency">${formatMoney(h.marketValueCents ?? h.totalCostCents)}</td>
          <td style="padding: 6px;" class="num-currency ${returnClass}">${formatMoney(h.gainCents ?? 0)}</td>
          <td style="padding: 6px; text-align: right;" class="num-currency ${returnClass}">${(h.gainPercent ?? 0) >= 0 ? '+' : ''}${(h.gainPercent ?? 0).toFixed(1)}%</td>
        </tr>
      `;
    });

    html += `
        <tr style="border-top: 2px solid var(--c-grey-blue); font-weight: bold;">
          <td style="padding: 6px;" colspan="4">TOTAL CARTEIRA</td>
          <td style="padding: 6px;" class="num-currency">${formatMoney(totalMarketValue)}</td>
          <td style="padding: 6px;" class="num-currency ${totalGain >= 0 ? 'txt-green' : 'txt-pink'}">${formatMoney(totalGain)}</td>
          <td style="padding: 6px; text-align: right;"></td>
        </tr>
      </tbody></table>`;
    container.innerHTML = html;

    const consolidatedEl = document.getElementById('val-consolidated-portfolio');
    if (consolidatedEl) consolidatedEl.textContent = formatMoney(totalMarketValue);

    const retEl = document.getElementById('val-portfolio-return');
    if (retEl) {
      const pct = PORTFOLIO?.totalGainPercent;
      if (pct == null || HOLDINGS.length === 0) {
        retEl.textContent = 'RENTABILIDADE: —';
        retEl.className = 'micro-label';
      } else {
        const sign = pct >= 0 ? '+' : '';
        retEl.textContent = `RENTABILIDADE: ${sign}${pct.toFixed(1)}%`;
        retEl.className = `micro-label ${pct >= 0 ? 'txt-green' : 'txt-pink'}`;
      }
    }
  }

  // ── JOURNAL — uses new Transaction model with status/tags/payees ──────────

  /** Linhas do journal após filtros ativos (conta / tipo / busca). */
  private journalVisibleTxs(filterKey: string = this.currentFilterKey): Transaction[] {
    return this.transactions.filter((tx) => {
      if (tx.type === 'transfer') return false;
      if (this.journalAccountFilter && tx.accountId !== this.journalAccountFilter) return false;

      let matchesFilter = true;
      if (filterKey === 'income') matchesFilter = tx.amountCents > 0;
      else if (filterKey === 'expense') matchesFilter = tx.amountCents < 0;
      else if (filterKey === 'scheduled') matchesFilter = tx.status === 'scheduled';
      else if (filterKey !== 'all') {
        const childIds = new Set(
          CATEGORIES.filter((c) => c.id === filterKey || c.parentId === filterKey).map((c) => c.id),
        );
        matchesFilter = !!tx.categoryId && childIds.has(tx.categoryId);
      }

      if (matchesFilter && this.journalSearchQuery.trim() !== '') {
        const query = this.journalSearchQuery.toLowerCase();
        const catName = getCategoryName(tx.categoryId).toLowerCase();
        const payee = getPayeeName(tx.payeeId).toLowerCase();
        matchesFilter =
          tx.description.toLowerCase().includes(query) ||
          catName.includes(query) ||
          payee.includes(query) ||
          tx.date.includes(query);
      }

      return matchesFilter;
    });
  }

  private renderJournalTransactions(filterKey: string = 'all') {
    const container = document.getElementById('journal-rows-container');
    const batchBar = document.getElementById('journal-batch-bar');
    const selectedCountEl = document.getElementById('batch-selected-count');
    const accountBanner = document.getElementById('journal-account-filter-banner');

    if (!container) return;
    container.innerHTML = '';
    this.currentFilterKey = filterKey;

    const accountFilter = this.journalAccountFilter
      ? ACCOUNTS.find((a) => a.id === this.journalAccountFilter)
      : null;

    if (accountBanner) {
      if (accountFilter) {
        accountBanner.classList.remove('hidden');
        accountBanner.style.display = 'flex';
        accountBanner.innerHTML = `
          <span class="micro-label" style="color: var(--c-amber);">CONTA: ${escapeHtml(accountFilter.name)}</span>
          <button type="button" id="btn-clear-journal-account-filter" class="pc98-btn" style="padding: 2px 8px; font-size: 11px;">[LIMPAR]</button>
        `;
        accountBanner.querySelector('#btn-clear-journal-account-filter')?.addEventListener('click', () => {
          pc98Audio.playClick();
          this.journalAccountFilter = null;
          this.renderJournalTransactions(this.currentFilterKey);
        });
      } else {
        accountBanner.classList.add('hidden');
        accountBanner.style.display = 'none';
        accountBanner.innerHTML = '';
      }
    }

    const filtered = this.journalVisibleTxs(filterKey);

    // Descarta ids que sumiram do filtro atual (busca/conta mudou).
    for (const id of [...this.selectedJournalTxIds]) {
      if (!filtered.some((tx) => tx.id === id)) this.selectedJournalTxIds.delete(id);
    }

    if (batchBar && selectedCountEl) {
      if (this.selectedJournalTxIds.size > 0) {
        batchBar.classList.remove('hidden');
        selectedCountEl.textContent = `[${this.selectedJournalTxIds.size} SELECIONADOS]`;
      } else {
        batchBar.classList.add('hidden');
      }
    }

    if (filtered.length === 0) {
      container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--c-grey-blue);" class="micro-label">NENHUMA TRANSAÇÃO ENCONTRADA</div>`;
      return;
    }

    filtered.sort((a, b) => b.date.localeCompare(a.date)).forEach(tx => {
      const isSelectedRow = tx.id === this.selectedTxId;
      const isChecked = this.selectedJournalTxIds.has(tx.id);
      const isPositive = tx.amountCents > 0;
      const row = document.createElement('div');
      row.className = `tx-row-dense ${isSelectedRow ? 'selected' : ''}`;

      const amtSign = isPositive ? '+' : '-';
      const amtVal = formatMoney(Math.abs(tx.amountCents));
      const amtClass = isPositive ? 'txt-green' : 'txt-pink';
      const catName = getCategoryName(tx.categoryId);
      const iconSvg = this.getCategoryIcon(catName);
      const installLabel = tx.installmentNo && tx.installmentTotal ? `<span class="micro-label">[${tx.installmentNo}/${tx.installmentTotal}]</span>` : '';
      const statusBadge = `<span class="micro-label ${statusColorClass(tx.status)}">[${statusLabel(tx.status)}]</span>`;
      const accountName = getAccountName(tx.accountId);
      const tags = getTagNames(tx.tagIds);
      const tagsHtml = tags.map(t => `<span class="micro-label" style="color: var(--c-pale-cyan);">#${t}</span>`).join(' ');
      const payee = getPayeeName(tx.payeeId);

      row.innerHTML = `
        <div style="width: 24px; text-align: center;">
          <input type="checkbox" class="tx-batch-checkbox" data-tx-id="${tx.id}" ${isChecked ? 'checked' : ''} style="cursor: pointer;" title="Selecionar para lote" />
        </div>
        <div style="width: 16px; height: 16px;">${iconSvg}</div>
        <div>${formatDate(tx.date)}</div>
        <div>
          <div>${tx.description} ${installLabel} ${statusBadge}</div>
          <div class="micro-label">${accountName} • ${payee ? payee + ' • ' : ''}VIA ${tx.createdBy.toUpperCase()} ${tagsHtml}</div>
        </div>
        <div class="tx-category" data-tx-id="${tx.id}" title="Clique para trocar a categoria">${escapeHtml(catName)}</div>
        <button type="button" class="pc98-btn tx-cat-mobile" data-tx-id="${tx.id}" title="Trocar categoria">CAT</button>
        <div class="num-currency text-md ${amtClass}" style="text-align: right;">${amtSign}${amtVal}</div>
      `;

      const checkbox = row.querySelector('.tx-batch-checkbox') as HTMLInputElement;
      checkbox?.addEventListener('change', (e) => {
        e.stopPropagation();
        pc98Audio.playClick();
        if (checkbox.checked) {
          this.selectedJournalTxIds.add(tx.id);
        } else {
          this.selectedJournalTxIds.delete(tx.id);
        }
        this.renderJournalTransactions(filterKey);
      });

      const openCat = (e: Event) => {
        e.stopPropagation();
        pc98Audio.playSelect();
        this.selectedTxId = tx.id;
        void this.quickChangeCategory(tx.id);
      };
      row.querySelector('.tx-category')?.addEventListener('click', openCat);
      row.querySelector('.tx-cat-mobile')?.addEventListener('click', openCat);

      // Clique na linha = editar. Checkbox / categoria têm stopPropagation.
      // ponytail: sem Shift+range; checkbox + SELECIONAR VISÍVEIS cobrem lote até doer
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        if ((e.target as HTMLElement).closest('.tx-category')) return;
        pc98Audio.playSelect();
        this.selectedTxId = tx.id;
        void this.openTxEdit(tx.id);
      });

      container.appendChild(row);
    });
  }

  // ── INSIGHTS PANEL — deterministic insights from analyzers ────────────────

  private renderInsightsPanel() {
    const container = document.getElementById('insights-panel');
    if (!container) return;
    container.innerHTML = '';

    INSIGHTS.forEach(ins => {
      const severityClass = ins.severity === 'critical' ? 'txt-pink' : ins.severity === 'warn' ? 'txt-amber' : 'txt-cyan';
      const severityIcon = ins.severity === 'critical' ? '◆' : ins.severity === 'warn' ? '▲' : '●';

      const el = document.createElement('div');
      el.className = 'pc98-well';
      el.style.padding = '8px';
      el.style.marginBottom = '6px';
      el.style.cursor = 'pointer';

      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.innerHTML = `
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="${severityClass}" style="font-size: 10px;" aria-hidden="true">${severityIcon}</span>
          <span class="micro-label ${severityClass}">[${ins.severity.toUpperCase()}]</span>
          <span class="text-xs">${ins.title}</span>
        </div>
      `;

      const openInsight = () => {
        pc98Audio.playSelect();
        this.navigateFromInsight(ins);
      };
      el.addEventListener('click', openInsight);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openInsight();
        }
      });

      container.appendChild(el);
    });
  }

  private navigateFromInsight(ins: { kind: string; data: Record<string, unknown>; title: string }) {
    const categoryName = typeof ins.data.category === 'string' ? ins.data.category : null;
    const categoryId =
      (typeof ins.data.categoryId === 'string' ? ins.data.categoryId : null) ||
      (categoryName
        ? CATEGORIES.find((c) => c.name.toLowerCase() === categoryName.toLowerCase())?.id ?? null
        : null);

    switch (ins.kind) {
      case 'budget_exceeded':
      case 'budget_at_risk':
      case 'spend_spike': {
        if (categoryId) {
          const cat = CATEGORIES.find((c) => c.id === categoryId);
          this.selectedCategoryDetail = cat?.parentId ?? categoryId;
        }
        this.switchTab('category');
        break;
      }
      case 'invoice_overdue':
      case 'invoice_due_soon': {
        const invoiceId = typeof ins.data.invoiceId === 'string' ? ins.data.invoiceId : null;
        const invoice = invoiceId ? CARD_INVOICES.find((i) => i.id === invoiceId) : null;
        if (invoice) this.selectedAccountId = invoice.cardAccountId;
        this.switchTab('accounts');
        this.renderAccounts();
        setTimeout(() => {
          document.getElementById('invoices-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
        break;
      }
      case 'possible_duplicate':
      case 'duplicate_charge': {
        const ids = Array.isArray(ins.data.ids)
          ? ins.data.ids.filter((id): id is string => typeof id === 'string')
          : [];
        this.journalAccountFilter = null;
        this.journalSearchQuery = typeof ins.data.description === 'string' ? ins.data.description : '';
        const searchInput = document.getElementById('journal-search-input') as HTMLInputElement | null;
        if (searchInput) searchInput.value = this.journalSearchQuery;
        if (ids[0]) this.selectedTxId = ids[0];
        this.switchTab('transactions');
        break;
      }
      case 'goal_behind': {
        const goalId = typeof ins.data.goalId === 'string' ? ins.data.goalId : null;
        if (goalId) this.focusedGoalId = goalId;
        this.switchTab('goals');
        break;
      }
      case 'debt_overdue': {
        this.switchTab('debts');
        break;
      }
      case 'bills_due_week':
      case 'stale_pending': {
        this.currentFilterKey = 'scheduled';
        this.journalAccountFilter = null;
        this.switchTab('transactions');
        break;
      }
      case 'cash_crunch':
      case 'income_overcommitted':
        this.switchTab('reports');
        break;
      case 'rules_applicable':
      case 'rule_suggestions':
        this.switchTab('rules');
        break;
      default:
        this.switchTab('dashboard');
    }
  }

  /** Avança para o próximo insight detectado pelo backend. */
  private advanceAiDialogue() {
    if (this.isTyping) return;
    const total = Math.max(1, INSIGHTS.length);
    this.currentAiIndex = (this.currentAiIndex + 1) % total;
    pc98Audio.playSelect();
    this.triggerAiInsight(this.currentAiIndex);
  }

  // ── RECURRENCES — new view ────────────────────────────────────────────────

  private renderRecurrences() {
    const container = document.getElementById('recurrences-list');
    if (!container) return;
    container.innerHTML = '';

    if (RECURRENCES.length === 0) {
      container.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue); padding: 12px;">NENHUMA RECORRÊNCIA</div>`;
    }

    RECURRENCES.forEach(rec => {
      const amount = rec.amountCents ? formatMoney(rec.amountCents) : `~${formatMoney(rec.estimatedCents ?? 0)}`;
      const typeClass = rec.type === 'income' ? 'txt-green' : 'txt-pink';
      const typeLabel = rec.type === 'income' ? 'RECEITA' : 'DESPESA';
      const accountName = getAccountName(rec.accountId);
      const freqLabel = rec.freq === 'monthly' ? 'MENSAL' : rec.freq === 'weekly' ? 'SEMANAL' : rec.freq.toUpperCase();

      const el = document.createElement('div');
      el.className = `pc98-well list-card-clickable${this.focusedRecurrenceId === rec.id ? ' is-focused' : ''}`;
      el.style.padding = '8px';
      el.style.marginBottom = '6px';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;

      el.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-weight: bold; color: var(--c-bone-white);">${escapeHtml(rec.name)}</span>
            <span class="micro-label ${typeClass}">[${typeLabel}]</span>
            ${rec.autoPost ? '<span class="micro-label txt-green">[AUTO]</span>' : '<span class="micro-label txt-amber">[MANUAL]</span>'}
          </div>
          <div class="num-currency ${typeClass}" style="font-size: 16px;">${rec.type === 'expense' ? '-' : '+'}${amount}</div>
        </div>
        <div class="micro-label" style="color: var(--c-grey-blue);">
          ${escapeHtml(accountName)} • ${freqLabel} • DIA ${rec.dayOfMonth ?? '—'} • ${escapeHtml(getCategoryName(rec.categoryId))}
          ${!rec.amountCents ? ' • <span class="txt-amber">VALOR VARIÁVEL</span>' : ''}
        </div>
      `;

      const open = () => {
        pc98Audio.playSelect();
        this.focusedRecurrenceId = rec.id;
        this.renderRecurrences();
        void this.openSystemDialog({
          title: `✦ ${rec.name.toUpperCase()} ✦`,
          body: `${typeLabel} ${freqLabel}<br/>Conta: <strong>${escapeHtml(accountName)}</strong><br/>Categoria: ${escapeHtml(getCategoryName(rec.categoryId))}<br/>Valor: <strong>${amount}</strong><br/>Modo: ${rec.autoPost ? 'AUTO' : 'MANUAL'}`,
          confirmLabel: '[OK]',
          cancelLabel: '',
          danger: false,
        });
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });

      container.appendChild(el);
    });

    const active = RECURRENCES.filter((r) => r.isActive);
    let incomeCents = 0;
    let expenseCents = 0;
    for (const rec of active) {
      const cents = rec.amountCents ?? rec.estimatedCents ?? 0;
      if (rec.type === 'income') incomeCents += cents;
      else if (rec.type === 'expense') expenseCents += cents;
    }
    const balanceCents = incomeCents - expenseCents;

    const incomeEl = document.getElementById('rec-sum-income');
    const expenseEl = document.getElementById('rec-sum-expense');
    const balanceEl = document.getElementById('rec-sum-balance');
    if (incomeEl) {
      incomeEl.textContent = `+${formatMoney(incomeCents)}`;
      incomeEl.className = 'num-currency txt-green';
    }
    if (expenseEl) {
      expenseEl.textContent = `-${formatMoney(expenseCents)}`;
      expenseEl.className = 'num-currency txt-pink';
    }
    if (balanceEl) {
      const sign = balanceCents >= 0 ? '+' : '';
      balanceEl.textContent = `${sign}${formatMoney(balanceCents)}`;
      balanceEl.className = `num-currency ${balanceCents >= 0 ? 'txt-green' : 'txt-pink'}`;
    }
  }

  // ── GOALS — new view ──────────────────────────────────────────────────────

  private renderGoals() {
    const container = document.getElementById('goals-list');
    if (!container) return;
    container.innerHTML = '';

    if (GOALS.length === 0) {
      container.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue); padding: 12px;">NENHUMA META</div>`;
    }

    GOALS.forEach(goal => {
      const pct = Math.min(100, Math.round(goal.progressPercent));
      const totalBlocks = 20;
      const filledBlocks = Math.round((pct / 100) * totalBlocks);

      let blocksHtml = '';
      for (let i = 0; i < totalBlocks; i++) {
        blocksHtml += `<div class="bar-block ${i < filledBlocks ? 'filled-green' : ''}" style="flex: 1; height: 8px;"></div>`;
      }

      const isBehind = goal.projectedCompletionDate && goal.targetDate && goal.projectedCompletionDate > goal.targetDate;

      const el = document.createElement('div');
      el.className = `pc98-well list-card-clickable${this.focusedGoalId === goal.id ? ' is-focused' : ''}`;
      el.style.padding = '10px';
      el.style.marginBottom = '8px';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;

      el.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-weight: bold; color: var(--c-bone-white);">${escapeHtml(goal.name)}</span>
          <span class="micro-label" style="color: ${goal.color};">${goal.accountId ? 'CONTA VINCULADA' : 'CAIXINHA VIRTUAL'}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span class="num-currency txt-green">${formatMoney(goal.savedCents)}</span>
          <span class="num-currency" style="color: var(--c-grey-blue);">/ ${formatMoney(goal.targetCents)}</span>
          <span class="num-currency txt-cyan">${pct}%</span>
        </div>
        <div class="segmented-track" style="display: flex; gap: 1px; margin-bottom: 6px;">
          ${blocksHtml}
        </div>
        <div class="micro-label" style="color: var(--c-grey-blue);">
          ${goal.targetDate ? `META: ${formatDate(goal.targetDate)}` : 'SEM PRAZO'}
          ${goal.requiredMonthlyCents ? ` • NECESSÁRIO/MÊS: ${formatMoney(goal.requiredMonthlyCents)}` : ''}
          ${goal.daysRemaining !== null ? ` • ${goal.daysRemaining} DIAS RESTANTES` : ''}
          ${isBehind ? ' <span class="txt-amber">[ATRASADA]</span>' : ''}
        </div>
        <div class="micro-label" style="color: var(--c-grey-blue); margin-top: 2px;">
          ${goal.contributionCount} APORTES | ÚLTIMO: ${goal.lastContributionDate ? formatDate(goal.lastContributionDate) : '—'}
          ${goal.notes ? ` • ${escapeHtml(goal.notes)}` : ''}
        </div>
      `;

      const open = () => {
        pc98Audio.playSelect();
        this.focusedGoalId = goal.id;
        this.renderGoals();
        void this.openGoalActions(goal.id);
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });

      container.appendChild(el);
    });

    const totalSaved = GOALS.reduce((sum, g) => sum + (g.savedCents ?? 0), 0);
    const totalTarget = GOALS.reduce((sum, g) => sum + (g.targetCents ?? 0), 0);
    const globalPct = totalTarget > 0 ? Math.min(100, Math.round((totalSaved / totalTarget) * 100)) : 0;

    const savedEl = document.getElementById('goals-sum-saved');
    const targetEl = document.getElementById('goals-sum-target');
    const progressEl = document.getElementById('goals-sum-progress');
    if (savedEl) savedEl.textContent = formatMoney(totalSaved);
    if (targetEl) targetEl.textContent = formatMoney(totalTarget);
    if (progressEl) progressEl.textContent = `${globalPct}%`;

    const alertBox = document.getElementById('goals-alert-box');
    if (alertBox) {
      const active = GOALS.filter((g) => g.status === 'active');
      if (active.length === 0) {
        alertBox.innerHTML = `
          <div class="micro-label" style="color: var(--c-sky); margin-bottom: 4px;">STATUS:</div>
          Nenhuma meta ativa. Crie a primeira com [+ NOVA META].
        `;
      } else {
        const primary = active[0]!;
        if (primary.requiredMonthlyCents != null && primary.requiredMonthlyCents > 0) {
          alertBox.innerHTML = `
            <div class="micro-label" style="color: var(--c-sky); margin-bottom: 4px;">STATUS:</div>
            Meta <strong>${escapeHtml(primary.name)}</strong>: aporte necessário de
            <span class="num-currency txt-amber">${formatMoney(primary.requiredMonthlyCents)}</span>/mês para atingir o prazo.
          `;
        } else {
          alertBox.innerHTML = `
            <div class="micro-label" style="color: var(--c-sky); margin-bottom: 4px;">STATUS:</div>
            Meta <strong>${escapeHtml(primary.name)}</strong> no ritmo — sem aporte mensal adicional necessário.
          `;
        }
      }
    }
  }

  // ── RULES — new view ──────────────────────────────────────────────────────

  private renderRules() {
    const container = document.getElementById('rules-list');
    if (!container) return;
    container.innerHTML = '';

    if (RULES.length === 0) {
      container.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue); padding: 12px;">NENHUMA REGRA</div>`;
      return;
    }

    RULES.forEach(rule => {
      const el = document.createElement('div');
      el.className = `pc98-well list-card-clickable${this.focusedRuleId === rule.id ? ' is-focused' : ''}`;
      el.style.padding = '8px';
      el.style.marginBottom = '6px';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;

      el.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-weight: bold; color: var(--c-bone-white);">${escapeHtml(rule.name)}</span>
            <span class="micro-label ${rule.isEnabled ? 'txt-green' : 'txt-pink'}">[${rule.isEnabled ? 'ATIVA' : 'INATIVA'}]</span>
          </div>
          <span class="micro-label txt-cyan">${rule.matchCount} MATCHES</span>
        </div>
        <div class="micro-label" style="color: var(--c-grey-blue);">
          SE: ${escapeHtml(rule.conditionDescription)} → ENTÃO: ${escapeHtml(rule.actionCategoryName ?? '—')}
          ${rule.lastMatchedAt ? ` • ÚLTIMO MATCH: ${formatDate(rule.lastMatchedAt)}` : ''}
        </div>
      `;

      const open = () => {
        pc98Audio.playSelect();
        this.focusedRuleId = rule.id;
        this.renderRules();
        const tester = document.getElementById('rule-test-input') as HTMLInputElement | null;
        if (tester && rule.conditionRegex) {
          tester.value = rule.conditionRegex;
          tester.focus();
        }
        void this.openSystemDialog({
          title: `✦ REGRA: ${rule.name.toUpperCase()} ✦`,
          body: `Status: <strong>${rule.isEnabled ? 'ATIVA' : 'INATIVA'}</strong><br/>Condição: ${escapeHtml(rule.conditionDescription)}<br/>Categoria: ${escapeHtml(rule.actionCategoryName ?? '—')}<br/>Matches: ${rule.matchCount}`,
          confirmLabel: '[OK]',
          cancelLabel: '',
          danger: false,
        });
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });

      container.appendChild(el);
    });
  }

  // ── IMPORT HISTORY ────────────────────────────────────────────────────────

  private renderImportHistory() {
    const tbody = document.getElementById('import-history-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (IMPORT_BATCHES.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="padding: 12px; text-align: center;" class="micro-label">NENHUM EXTRATO IMPORTADO</td></tr>`;
      return;
    }

    IMPORT_BATCHES.forEach((batch) => {
      const rawDate = batch.appliedAt || batch.createdAt;
      const dateLabel = rawDate && rawDate.includes('T')
        ? formatDate(rawDate.slice(0, 10))
        : (rawDate ? formatDate(rawDate.slice(0, 10)) : '—');
      const statusLabelText =
        batch.status === 'applied' ? 'APLICADO' :
        batch.status === 'reverted' ? 'REVERTIDO' :
        'PARSEADO';
      const statusClass =
        batch.status === 'applied' ? 'txt-green' :
        batch.status === 'reverted' ? 'txt-pink' :
        'txt-amber';
      const txCount = batch.stats
        ? (batch.stats.created ?? batch.stats.transactions ?? batch.stats.total ?? batch.stats.newRows ?? 0)
        : 0;

      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px dotted var(--c-grey-blue)';
      tr.innerHTML = `
        <td style="padding: 6px;">${escapeHtml(dateLabel)}</td>
        <td style="padding: 6px;">${escapeHtml(batch.filename)}</td>
        <td style="padding: 6px;">${escapeHtml(getAccountName(batch.accountId))}</td>
        <td style="padding: 6px;" class="num-currency">${txCount}</td>
        <td style="padding: 6px; text-align: right;" class="micro-label ${statusClass}">[${statusLabelText}]</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // ── UPCOMING BILLS — dashboard widget ─────────────────────────────────────

  private renderUpcomingBills() {
    const container = document.getElementById('upcoming-bills');
    if (!container) return;
    container.innerHTML = '';

    const upcoming = this.transactions
      .filter(tx => tx.status === 'scheduled')
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 5);

    if (upcoming.length === 0) {
      container.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue); padding: 4px 0;">Nenhuma conta agendada</div>`;
      return;
    }

    upcoming.forEach(tx => {
      const el = document.createElement('div');
      el.className = 'upcoming-bill-row';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.style.display = 'flex';
      el.style.justifyContent = 'space-between';
      el.style.padding = '6px 4px';
      el.style.borderBottom = '1px dotted var(--c-grey-blue)';

      el.innerHTML = `
        <span class="micro-label">${formatDate(tx.date)} — ${escapeHtml(tx.description)}</span>
        <span class="num-currency ${tx.amountCents > 0 ? 'txt-green' : 'txt-amber'}">${formatMoney(tx.amountCents)}</span>
      `;

      const open = () => {
        pc98Audio.playSelect();
        this.selectedTxId = tx.id;
        this.switchTab('transactions');
        void this.openTxEdit(tx.id);
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });

      container.appendChild(el);
    });
  }

  // ── CATEGORY BREAKDOWN ────────────────────────────────────────────────────

  private renderCategoryBreakdown() {
    setTimeout(() => {
      const hasMonthData = (currentMonthIncome() + currentMonthExpense()) > 0;
      const sankeyCanvas = document.getElementById('sankey-chart-canvas') as HTMLCanvasElement;
      if (sankeyCanvas) PC98ChartSuite.renderSankeyChart(sankeyCanvas, hasMonthData);

      const waterfallCanvas = document.getElementById('waterfall-chart-canvas') as HTMLCanvasElement;
      if (waterfallCanvas) PC98ChartSuite.renderWaterfallChart(waterfallCanvas, monthWaterfallSteps());

      const donutCanvas = document.getElementById('donut-chart-canvas') as HTMLCanvasElement;
      if (donutCanvas) PC98ChartSuite.renderDonutChart(donutCanvas, categoryDonutSlices());
    }, 50);

    const picker = document.getElementById('cat-detail-picker');
    if (picker) {
      picker.innerHTML = '';
      const parentCats = CATEGORIES.filter(c => c.parentId === null && c.kind === 'expense' && !c.isArchived);
      if (!this.selectedCategoryDetail && parentCats[0]) {
        this.selectedCategoryDetail = parentCats[0].id;
      }
      parentCats.forEach(cat => {
        const isSelected = cat.id === this.selectedCategoryDetail;
        const iconSvg = this.getCategoryIcon(cat.name);
        const budget = BUDGETS.find(b => b.categoryId === cat.id);
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = `icon-tile ${isSelected ? 'selected' : ''}`;
        tile.style.display = 'flex';
        tile.style.flexDirection = 'row';
        tile.style.justifyContent = 'flex-start';
        tile.style.padding = '6px';
        tile.style.gap = '8px';
        tile.style.width = '100%';
        tile.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

        tile.innerHTML = `
          <div style="width: 16px; height: 16px;">${iconSvg}</div>
          <div>
            <div style="font-size: 13px;">${escapeHtml(cat.name)}</div>
            ${budget ? `<div class="micro-label">${formatMoney(budget.spentCents)} / ${formatMoney(budget.amountCents)}</div>` : '<div class="micro-label">SEM ORÇAMENTO</div>'}
          </div>
        `;

        tile.addEventListener('click', () => {
          pc98Audio.playSelect();
          this.selectedCategoryDetail = cat.id;
          this.renderCategoryBreakdown();
        });

        picker.appendChild(tile);
      });
    }

    this.renderCategorySelectionDetail();

    const breakdownContainer = document.getElementById('cat-breakdown-bars');
    if (breakdownContainer) {
      const selectedId = this.selectedCategoryDetail;
      const childIds = new Set(
        CATEGORIES.filter((c) => c.parentId === selectedId || c.id === selectedId).map((c) => c.id),
      );
      const childSpend = new Map<string, number>();
      for (const tx of this.transactions) {
        if (tx.type === 'transfer' || !tx.categoryId || !childIds.has(tx.categoryId)) continue;
        if (tx.amountCents >= 0) continue;
        childSpend.set(tx.categoryId, (childSpend.get(tx.categoryId) ?? 0) + Math.abs(tx.amountCents));
      }
      const rows = [...childSpend.entries()]
        .map(([id, cents]) => ({ id, name: getCategoryName(id), cents }))
        .sort((a, b) => b.cents - a.cents)
        .slice(0, 6);
      const maxCents = Math.max(1, ...rows.map((r) => r.cents));

      if (rows.length === 0) {
        breakdownContainer.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue); padding: 8px;">Sem gastos nesta categoria no journal carregado.</div>`;
      } else {
        breakdownContainer.innerHTML = rows
          .map((r) => {
            const heightPct = Math.round((r.cents / maxCents) * 90);
            return `
              <div class="dither-col" style="flex: 1;">
                <div class="num-currency txt-pink" style="font-size: 12px;">${formatMoney(r.cents)}</div>
                <div class="dither-col-bar dither-pink" style="height: ${heightPct}%;"></div>
                <div class="micro-label">${escapeHtml(r.name.slice(0, 8).toUpperCase())}</div>
              </div>
            `;
          })
          .join('');
      }
    }
  }

  private renderCategorySelectionDetail() {
    const detail = document.getElementById('cat-selection-detail');
    if (!detail) return;
    const cat = CATEGORIES.find((c) => c.id === this.selectedCategoryDetail);
    if (!cat) {
      detail.innerHTML = `<div class="micro-label" style="color: var(--c-grey-blue);">Selecione uma categoria</div>`;
      return;
    }

    const childIds = new Set(
      CATEGORIES.filter((c) => c.parentId === cat.id || c.id === cat.id).map((c) => c.id),
    );
    const related = this.transactions
      .filter((tx) => tx.categoryId && childIds.has(tx.categoryId) && tx.type !== 'transfer')
      .sort((a, b) => b.date.localeCompare(a.date));
    const spent = related.reduce((s, tx) => s + (tx.amountCents < 0 ? Math.abs(tx.amountCents) : 0), 0);
    const budget = BUDGETS.find((b) => b.categoryId === cat.id);
    const recent = related.slice(0, 5);

    detail.innerHTML = `
      <div class="micro-label txt-cyan">CATEGORIA SELECIONADA</div>
      <div style="font-weight: bold;">${escapeHtml(cat.name)}</div>
      <div class="micro-label">GASTO (journal): <span class="num-currency txt-pink">${formatMoney(spent)}</span>
        ${budget ? ` · ORÇAMENTO: ${formatMoney(budget.spentCents)} / ${formatMoney(budget.amountCents)} (${budget.usedPercent}%)` : ' · SEM ORÇAMENTO'}
      </div>
      <div class="micro-label" style="color: var(--c-grey-blue); margin-top: 4px;">ÚLTIMOS LANÇAMENTOS</div>
      ${
        recent.length === 0
          ? `<div class="micro-label" style="color: var(--c-grey-blue);">Nenhum lançamento nesta categoria.</div>`
          : recent
              .map(
                (tx) => `
            <button type="button" class="pc98-btn text-micro cat-detail-tx" data-tx-id="${tx.id}" style="justify-content: space-between; width: 100%; text-align: left; padding: 4px 6px;">
              <span>${formatDate(tx.date)} · ${escapeHtml(tx.description)}</span>
              <span class="num-currency">${formatMoney(tx.amountCents)}</span>
            </button>`,
              )
              .join('')
      }
      <button type="button" id="btn-cat-to-journal" class="pc98-btn btn-primary text-micro" style="align-self: flex-start; margin-top: 4px;">[VER NO JOURNAL]</button>
    `;

    detail.querySelectorAll('.cat-detail-tx').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.txId;
        if (!id) return;
        pc98Audio.playSelect();
        this.selectedTxId = id;
        this.journalAccountFilter = null;
        this.switchTab('transactions');
        void this.openTxEdit(id);
      });
    });
    detail.querySelector('#btn-cat-to-journal')?.addEventListener('click', () => {
      pc98Audio.playSelect();
      this.journalAccountFilter = null;
      this.journalSearchQuery = '';
      const searchInput = document.getElementById('journal-search-input') as HTMLInputElement | null;
      if (searchInput) searchInput.value = '';
      this.currentFilterKey = cat.id;
      this.switchTab('transactions');
    });
  }

  // ── NATURAL LANGUAGE PARSER ───────────────────────────────────────────────

  private parseNaturalLanguageEntry(text: string): { amount: number; memo: string; account: string; categoryId: string } {
    const lower = text.toLowerCase();

    const amtMatch = lower.match(/(?:r\$|\$)?\s*(\d+(?:[.,]\d+)?)/);
    const amount = amtMatch ? parseFloat(amtMatch[1].replace(',', '.')) : 50.00;

    let account = 'acc-checking';
    if (lower.includes('crédito') || lower.includes('credito') || lower.includes('nubank') || lower.includes('cartão')) {
      account = 'acc-nubank';
    }

    let categoryId = 'cat-supermercado';
    let memo = 'Compra Mercado';
    if (lower.includes('combust') || lower.includes('posto')) {
      categoryId = 'cat-combustivel'; memo = 'Posto de Combustível';
    } else if (lower.includes('luz') || lower.includes('enel')) {
      categoryId = 'cat-luz'; memo = 'Conta de luz';
    } else if (lower.includes('aluguel')) {
      categoryId = 'cat-aluguel'; memo = 'Aluguel';
    } else if (lower.includes('uber') || lower.includes('99')) {
      categoryId = 'cat-app-transporte'; memo = 'Aplicativo de transporte';
    } else if (lower.includes('ifood') || lower.includes('delivery')) {
      categoryId = 'cat-delivery'; memo = 'Delivery';
    } else if (lower.includes('netflix') || lower.includes('spotify') || lower.includes('stream')) {
      categoryId = 'cat-streaming'; memo = 'Streaming';
    }

    return { amount, memo, account, categoryId };
  }

  private looksLikeLedgerEntry(text: string): boolean {
    const lower = text.toLowerCase();
    return /\b(gastei|paguei|comprei|lancei|despesa|compra)\b/.test(lower)
      || /(?:r\$|\$)\s*\d/.test(lower);
  }

  /**
   * Lançamento por linguagem natural.
   *
   * Vai para a IA em vez de ser interpretado aqui. O parser local do protótipo
   * acertava casos simples, mas não resolve "em 3x", "sexta passada" nem apelido
   * de conta — e adivinhar errado num lançamento financeiro é pior que demorar
   * alguns segundos.
   *
   * A classificação de risco é a do backend: valor acima do limite abre o modal de
   * confirmação, e nada é gravado antes do seu OK.
   *
   * Devolve `true` quando tratou como lançamento; `false` deixa seguir como
   * pergunta comum.
   */
  private commitNaturalLanguageEntry(text: string): boolean {
    if (!this.looksLikeLedgerEntry(text)) return false;

    const textEl = document.getElementById('ai-text-target');
    if (textEl) {
      textEl.innerHTML = `INTERPRETANDO LANÇAMENTO... <span class="ai-thinking"><span></span><span></span><span></span></span>`;
    }

    void this.sendChatMessage(text);
    return true;
  }

  // ── AI RISK CONFIRMATION ──────────────────────────────────────────────────

  private buildAiConfirmListHtml(items: Array<{ token: string; summary: string; reason: string }>): string {
    return items
      .map(
        (p, idx) =>
          `<div class="ai-risk-item" data-confirm-idx="${idx}">
             <div><strong>${escapeHtml(p.summary)}</strong></div>
             <div class="micro-label" style="color: var(--c-grey-blue);">${escapeHtml(p.reason)}</div>
             <div class="ai-risk-item-actions">
               <button type="button" class="pc98-btn btn-primary btn-ai-approve-one" data-token="${escapeHtml(p.token)}" style="padding: 2px 8px; font-size: 11px;">[CONFIRMAR]</button>
             </div>
           </div>`,
      )
      .join('');
  }

  private renderPendingAiConfirmMeta() {
    const pending = this.pendingAiConfirm;
    if (!pending) return;
    const { meta, items } = pending;
    const count = items.length;
    meta.innerHTML = `
      <span class="micro-label txt-amber">[AGUARDANDO PERMISSÃO · ${count}]</span>
      <div style="display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
        <button type="button" class="pc98-btn btn-ai-reject-inline" style="padding: 2px 8px; font-size: 11px;">[NEGAR]</button>
        <button type="button" class="pc98-btn btn-primary btn-ai-approve-inline" style="padding: 2px 8px; font-size: 11px;">[CONFIRMAR]</button>
      </div>
      <div class="micro-label" style="color: var(--c-grey-blue); margin-top: 4px;">Use a caixa de permissão — ou estes botões.</div>
    `;

    meta.querySelector('.btn-ai-approve-inline')?.addEventListener('click', () => {
      pc98Audio.playSelect();
      this.approveAllPendingAiConfirm();
    });
    meta.querySelector('.btn-ai-reject-inline')?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.rejectAllPendingAiConfirm();
    });
  }

  private approveOnePendingAiConfirm(token: string) {
    const pending = this.pendingAiConfirm;
    if (!pending || this.isTyping) return;
    const idx = pending.items.findIndex((i) => i.token === token);
    if (idx < 0) return;
    pending.items.splice(idx, 1);
    void this.sendChatMessage(pending.originalMessage, [token], { silentUser: true });
    if (pending.items.length === 0) {
      this.pendingAiConfirm = null;
      this.aiRiskDismiss?.();
      pending.meta.innerHTML = `<span class="micro-label txt-green">[APROVADO]</span>`;
      return;
    }
    this.renderPendingAiConfirmMeta();
    this.refreshAiRiskModalContent();
  }

  private approveAllPendingAiConfirm() {
    const pending = this.pendingAiConfirm;
    if (!pending || pending.items.length === 0 || this.isTyping) return;
    const tokens = pending.items.map((i) => i.token);
    this.pendingAiConfirm = null;
    this.aiRiskDismiss?.();
    pending.meta.innerHTML = `<span class="micro-label txt-green">[CONFIRMADO…]</span>`;
    void this.sendChatMessage(pending.originalMessage, tokens, { silentUser: true });
  }

  private rejectAllPendingAiConfirm() {
    const pending = this.pendingAiConfirm;
    this.pendingAiConfirm = null;
    this.aiRiskReject?.();
    if (pending) {
      pending.meta.innerHTML = `<span class="micro-label txt-pink">[NEGADO]</span>`;
    }
    const dockStatus = document.getElementById('ai-dock-status');
    if (dockStatus) {
      dockStatus.classList.remove('is-busy');
      dockStatus.classList.add('txt-green');
      dockStatus.textContent = 'STATUS: MONITORANDO';
    }
  }

  private refreshAiRiskModalContent() {
    const pending = this.pendingAiConfirm;
    const diffEl = document.getElementById('ai-risk-diff-text');
    if (!pending || !diffEl) return;
    diffEl.innerHTML = this.buildAiConfirmListHtml(pending.items);
    diffEl.querySelectorAll('.btn-ai-approve-one').forEach((btn) => {
      btn.addEventListener('click', () => {
        const token = (btn as HTMLElement).dataset.token;
        if (!token) return;
        pc98Audio.playSelect();
        this.approveOnePendingAiConfirm(token);
      });
    });
  }

  private triggerAiRiskConfirmation() {
    const pending = this.pendingAiConfirm;
    const modal = document.getElementById('modal-ai-risk-confirm');
    const diffEl = document.getElementById('ai-risk-diff-text');
    const approveBtn = document.getElementById('btn-confirm-risk') as HTMLButtonElement | null;
    const rejectBtn = document.getElementById('btn-reject-risk') as HTMLButtonElement | null;
    const closeBtn = document.getElementById('btn-close-risk');
    if (!pending || !modal || !diffEl) return;

    this.refreshAiRiskModalContent();
    this.showModal(modal);
    pc98Audio.playWarning();

    const cleanup = (rejected: boolean) => {
      modal.classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      this.aiRiskReject = null;
      this.aiRiskDismiss = null;
      if (rejected) {
        const p = this.pendingAiConfirm;
        this.pendingAiConfirm = null;
        if (p) p.meta.innerHTML = `<span class="micro-label txt-pink">[CANCELADO]</span>`;
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cleanup(true); }
    };
    this.aiRiskReject = () => cleanup(true);
    this.aiRiskDismiss = () => cleanup(false);
    if (approveBtn) {
      approveBtn.onclick = () => { pc98Audio.playSelect(); this.approveAllPendingAiConfirm(); };
    }
    if (rejectBtn) {
      rejectBtn.onclick = () => this.rejectAllPendingAiConfirm();
      rejectBtn.focus();
    }
    if (closeBtn) closeBtn.onclick = () => cleanup(true);
    document.addEventListener('keydown', onKey);
  }

  // ── AI INSIGHT TYPEWRITER ─────────────────────────────────────────────────

  /**
   * Exibe um insight no comunicador, com efeito de digitação.
   *
   * O texto vem dos analisadores determinísticos do backend — não é roteiro
   * fixo. Sem insights, mostra a mensagem de abertura montada a partir do estado
   * real das finanças.
   */
  private triggerAiInsight(index: number) {
    const textEl = document.getElementById('ai-text-target');
    if (!textEl) return;

    const insight = INSIGHTS.length > 0 ? INSIGHTS[index % INSIGHTS.length] : undefined;

    // Monta o texto a partir dos campos formatados que o analisador já produziu.
    let fullText: string;
    let badges: string[];

    if (insight) {
      const data = insight.data as Record<string, unknown>;
      const details = ['spentFormatted', 'limitFormatted', 'remainingFormatted', 'currentFormatted', 'medianFormatted', 'amountFormatted', 'outstandingFormatted']
        .map((key) => (typeof data[key] === 'string' ? (data[key] as string) : null))
        .filter((v): v is string => v !== null)
        .slice(0, 2);

      fullText = insight.title + (details.length > 0 ? ` — ${details.join(' de ')}.` : '.');
      badges = [insight.kind, insight.severity.toUpperCase()];
    } else {
      fullText = openingAiMessage();
      badges = ['sem_alertas'];
    }

    textEl.innerHTML = '';
    this.isTyping = true;

    const finishTyping = () => {
      const badgeHtml = badges.map((b) => `<span class="micro-label txt-cyan">[${escapeHtml(b)}]</span>`).join(' ');
      textEl.innerHTML = `${escapeHtml(fullText)}<br/><div style="margin-top: 4px;">${badgeHtml}</div><span class="blinking-cursor"></span>`;
      this.isTyping = false;
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishTyping();
      return;
    }

    let charIdx = 0;
    const typeNextChar = () => {
      if (charIdx < fullText.length) {
        textEl.textContent = fullText.slice(0, charIdx + 1);
        if (charIdx % 3 === 0) pc98Audio.playTypewriter();
        charIdx += 1;
        setTimeout(typeNextChar, 25);
      } else {
        finishTyping();
      }
    };

    typeNextChar();
  }

  // ── TAB SWITCHING ─────────────────────────────────────────────────────────

  private setAiDockOpen(open: boolean) {
    document.body.classList.toggle('ai-dock-open', open);
    const toggle = document.getElementById('btn-mobile-ai');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  private switchTab(tabId: string) {
    this.activeTab = tabId;

    const navBtns = document.querySelectorAll('.sidebar-item-btn');
    const viewPanels = document.querySelectorAll('.view-panel');

    navBtns.forEach(b => {
      b.classList.remove('active');
      if (b.getAttribute('data-tab') === tabId) {
        b.classList.add('active');
      }
    });

    // Chat lives in the right AI dock — keep dashboard as context, never blank the center.
    const effectiveView = tabId === 'chat' ? 'dashboard' : tabId;

    viewPanels.forEach(panel => {
      panel.classList.remove('active-view');
      if (panel.id === `view-${effectiveView}`) {
        panel.classList.add('active-view');
      }
    });

    if (tabId === 'chat') {
      if (this.aiDockCollapsed) {
        this.expandAiDock();
      } else {
        this.setAiDockOpen(true);
        setTimeout(() => document.getElementById('chat-input-text')?.focus(), 40);
      }
      this.renderDashboardCharts();
      return;
    }

    // Closing a non-chat tab on narrow layouts should not force-close the dock if user pinned it;
    // only auto-close when leaving chat explicitly via another nav target on overlay layouts.
    if (window.matchMedia('(max-width: 1100px)').matches) {
      this.setAiDockOpen(false);
    }

    if (tabId === 'category') {
      setTimeout(() => this.renderCategoryBreakdown(), 50);
    } else if (tabId === 'transactions') {
      this.renderJournalTransactions(this.currentFilterKey);
    } else if (tabId === 'accounts') {
      this.renderAccounts();
    } else if (tabId === 'goals') {
      this.renderGoals();
    } else if (tabId === 'recurrences') {
      this.renderRecurrences();
    } else if (tabId === 'rules') {
      this.renderRules();
    } else if (tabId === 'add') {
      this.prepareAddForm();
    } else if (tabId === 'dashboard') {
      this.renderDashboardCharts();
    } else if (tabId === 'investments') {
      this.renderInvestmentCharts();
    } else if (tabId === 'reports') {
      setTimeout(() => {
        const flowCanvas = document.getElementById('flow-chart-canvas') as HTMLCanvasElement;
        if (flowCanvas) PC98ChartSuite.renderFlowLineChart(flowCanvas, MONTHLY_FLOW);
        const projCanvas = document.getElementById('projection-chart-canvas') as HTMLCanvasElement;
        if (projCanvas) PC98ChartSuite.renderProjectionChart(projCanvas, PROJECTION);
      }, 50);
    }
  }

  private openSystemDialog(options: {
    title: string;
    body: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    promptDefault?: string;
    showInput?: boolean;
  }): Promise<string | boolean | null> {
    const modal = document.getElementById('modal-system-dialog');
    const titleEl = document.getElementById('system-dialog-title');
    const bodyEl = document.getElementById('system-dialog-body');
    const inputWrap = document.getElementById('system-dialog-input-wrap');
    const inputEl = document.getElementById('system-dialog-input') as HTMLInputElement | null;
    const confirmBtn = document.getElementById('btn-system-dialog-confirm');
    const cancelBtn = document.getElementById('btn-system-dialog-cancel');
    const closeBtn = document.getElementById('btn-close-system-dialog');

    if (!modal || !titleEl || !bodyEl || !confirmBtn || !cancelBtn) {
      return Promise.resolve(null);
    }

    titleEl.textContent = options.title;
    bodyEl.innerHTML = options.body;
    confirmBtn.textContent = options.confirmLabel || '[CONFIRMAR]';
    cancelBtn.textContent = options.cancelLabel || '[CANCELAR]';
    confirmBtn.classList.toggle('btn-alert', options.danger !== false && !options.showInput);
    confirmBtn.classList.toggle('btn-gold', !!options.showInput || options.danger === false);
    cancelBtn.classList.toggle('hidden', options.cancelLabel === '');

    if (inputWrap && inputEl) {
      if (options.showInput) {
        inputWrap.classList.remove('hidden');
        inputEl.value = options.promptDefault || '';
      } else {
        inputWrap.classList.add('hidden');
      }
    }

    this.showModal(modal);
    if (options.showInput) inputEl?.focus();
    else confirmBtn.focus();

    return new Promise((resolve) => {
      const cleanup = () => {
        modal.classList.add('hidden');
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn?.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
      };

      const onConfirm = () => {
        pc98Audio.playClick();
        const value = options.showInput ? (inputEl?.value ?? '') : true;
        cleanup();
        resolve(value);
      };

      const onCancel = () => {
        pc98Audio.playClick();
        cleanup();
        resolve(options.showInput ? null : (options.cancelLabel === '' ? true : false));
      };

      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          if (options.cancelLabel === '') onConfirm();
          else onCancel();
        } else if (ev.key === 'Enter' && options.showInput) {
          ev.preventDefault();
          onConfirm();
        }
      };

      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      closeBtn?.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }

  /** Empilha modal acima dos já abertos (toast fica sempre por cima via CSS). */
  private showModal(modal: HTMLElement | null) {
    if (!modal) return;
    const openCount = document.querySelectorAll('.modal-backdrop:not(.hidden)').length;
    modal.style.zIndex = String(10000 + openCount * 20);
    modal.classList.remove('hidden');
  }

  /** Fecha só o modal do topo; devolve true se fechou algo. */
  private closeTopModal(): boolean {
    const open = [...document.querySelectorAll('.modal-backdrop:not(.hidden)')] as HTMLElement[];
    if (open.length === 0) return false;
    open.sort((a, b) => Number(b.style.zIndex || 10000) - Number(a.style.zIndex || 10000));
    const top = open[0]!;
    const id = top.id;

    if (id === 'modal-tx-edit') {
      this.closeTxEdit();
      return true;
    }
    if (id === 'modal-category-picker') {
      document.getElementById('btn-category-picker-cancel')?.click();
      return true;
    }
    if (id === 'modal-system-dialog') {
      document.getElementById('btn-system-dialog-cancel')?.click();
      return true;
    }
    if (id === 'modal-ai-risk-confirm' && this.aiRiskReject) {
      this.aiRiskReject();
      return true;
    }
    if (id === 'modal-category-form') {
      this.closeCategoryForm();
      return true;
    }
    if (id === 'modal-account-form') {
      this.closeAccountForm();
      return true;
    }

    const closer = top.querySelector(
      '[id*="-cancel"], [id^="btn-close-"], .win-btn',
    ) as HTMLElement | null;
    if (closer) closer.click();
    else top.classList.add('hidden');
    return true;
  }

  // ── CHAT ──────────────────────────────────────────────────────────────────

  /**
   * Conversa com a IA de verdade.
   *
   * Usa o endpoint com streaming, então o texto aparece conforme o modelo escreve
   * — sem isso a espera de 10 a 15 segundos pareceria travamento.
   *
   * Operações que passam dos limites de autonomia voltam em `pendingConfirmations`
   * e **não foram executadas**: a interface abre o modal de confirmação e só então
   * reenvia com o token de aprovação.
   */
  private async sendChatMessage(
    query: string,
    approvedTokens: string[] = [],
    options: { silentUser?: boolean } = {},
  ) {
    const text = query.trim();
    if (!text || this.isTyping) return;

    const streamBox = document.getElementById('chat-stream-box');
    if (!streamBox) return;

    // Bolha do usuário. `textContent` em vez de innerHTML: a mensagem é texto do
    // usuário e não deve ser interpretada como HTML.
    if (!options.silentUser) {
      const userBubble = document.createElement('div');
      userBubble.className = 'chat-bubble-row user-side';
      const userInner = document.createElement('div');
      userInner.className = 'chat-bubble user-bubble';
      const userHeader = document.createElement('div');
      userHeader.className = 'micro-label';
      userHeader.style.cssText = 'color: var(--c-sky); margin-bottom: 4px;';
      userHeader.textContent = this.userName;
      const userBody = document.createElement('div');
      userBody.textContent = text;
      userInner.append(userHeader, userBody);
      userBubble.appendChild(userInner);
      streamBox.appendChild(userBubble);
      streamBox.scrollTop = streamBox.scrollHeight;
    }

    // Bolha da IA, com status de trabalho + tools em tempo real.
    const aiBubble = document.createElement('div');
    aiBubble.className = 'chat-bubble-row ai-side';
    aiBubble.innerHTML = `
      <div class="chat-bubble ai-bubble">
        <div class="micro-label" style="color: var(--c-bone-white); margin-bottom: 4px;">KAKEIBO.AI</div>
        <div class="ai-work-status" aria-live="polite">
          <div class="ai-work-status-header micro-label">
            <span class="ai-work-phase">TRABALHANDO</span>
            <span class="ai-thinking" aria-hidden="true"><span></span><span></span><span></span></span>
          </div>
          <div class="ai-tool-chip-row"></div>
        </div>
        <div class="ai-response-body"></div>
        <div class="ai-response-meta"></div>
      </div>
    `;
    streamBox.appendChild(aiBubble);
    streamBox.scrollTop = streamBox.scrollHeight;

    const body = aiBubble.querySelector('.ai-response-body') as HTMLElement;
    const meta = aiBubble.querySelector('.ai-response-meta') as HTMLElement;
    const workStatus = aiBubble.querySelector('.ai-work-status') as HTMLElement;
    const workPhase = aiBubble.querySelector('.ai-work-phase') as HTMLElement;
    const toolRow = aiBubble.querySelector('.ai-tool-chip-row') as HTMLElement;

    const toolChips = new Map<string, HTMLElement>();

    const upsertToolChip = (
      toolCallId: string,
      tool: string,
      state: 'running' | 'done' | 'error' | 'confirm',
    ) => {
      let chip = toolChips.get(toolCallId);
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'ai-tool-chip';
        chip.dataset.tool = tool;
        toolRow.appendChild(chip);
        toolChips.set(toolCallId, chip);
      }
      chip.classList.remove('is-running', 'is-done', 'is-error', 'is-confirm');
      chip.classList.add(`is-${state}`);
      const mark =
        state === 'running' ? '…' : state === 'done' ? '✓' : state === 'confirm' ? '?' : '!';
      chip.textContent = `${mark} ${aiToolLabel(tool)}`;
      streamBox.scrollTop = streamBox.scrollHeight;
    };

    this.isTyping = true;
    this.setChatBusy(true, 'PROCESSANDO…');

    let accumulated = '';
    let firstChunk = true;
    let sawTool = false;

    try {
      await aiChatStream(text, {
        ...(this.conversationId ? { conversationId: this.conversationId } : {}),
        approvedTokens,
        onToolStart: ({ tool, toolCallId }) => {
          sawTool = true;
          workPhase.textContent = 'USANDO FERRAMENTAS';
          this.setChatBusy(true, `TOOL: ${aiToolLabel(tool).toUpperCase()}`);
          upsertToolChip(toolCallId, tool, 'running');
        },
        onToolResult: ({ tool, toolCallId, needsConfirmation, error }) => {
          if (error) upsertToolChip(toolCallId, tool, 'error');
          else if (needsConfirmation) upsertToolChip(toolCallId, tool, 'confirm');
          else upsertToolChip(toolCallId, tool, 'done');
          const stillRunning = [...toolChips.values()].some((c) => c.classList.contains('is-running'));
          if (!stillRunning && !firstChunk) {
            workPhase.textContent = 'RESPONDENDO';
            this.setChatBusy(true, 'RESPONDENDO…');
          } else if (!stillRunning && firstChunk) {
            workPhase.textContent = 'ANALISANDO RESULTADOS';
            this.setChatBusy(true, 'ANALISANDO…');
          }
        },
        onText: (chunk) => {
          if (firstChunk) {
            firstChunk = false;
            workPhase.textContent = sawTool ? 'RESPONDENDO' : 'ESCREVENDO';
            this.setChatBusy(true, 'RESPONDENDO…');
            pc98Audio.playTypewriter();
          }
          accumulated += chunk;
          body.textContent = accumulated;
          streamBox.scrollTop = streamBox.scrollHeight;
        },
        onDone: (result) => {
          this.conversationId = result.conversationId;
          // Só ao final: durante o stream, texto puro evita reparsear markdown
          // incompleto a cada pedaço.
          if (accumulated) body.innerHTML = renderAiMarkdown(accumulated);
          else if (!sawTool) body.textContent = '';

          if (result.pendingConfirmations.length > 0) {
            workPhase.textContent = 'AGUARDANDO SUA PERMISSÃO';
            workStatus.querySelector('.ai-thinking')?.remove();
          } else {
            workStatus.remove();
          }
          this.handleAiOutcome(result, text, meta);
        },
        onError: (message) => {
          workPhase.textContent = 'FALHA';
          body.textContent = `Erro: ${message}`;
          body.classList.add('txt-pink');
        },
      });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
      workPhase.textContent = 'FALHA';
      body.textContent = message;
      body.classList.add('txt-pink');
      pc98Audio.playWarning();
    } finally {
      this.isTyping = false;
      this.setChatBusy(false);
      // Se ainda não havia pending (workStatus removido no onDone), ok.
      // Se falhou sem pending, some o indicador de trabalho.
      if (!this.pendingAiConfirm) {
        workStatus.remove();
      }
      streamBox.scrollTop = streamBox.scrollHeight;
    }
  }

  /** Habilita/desabilita a entrada durante a resposta + status no dock. */
  private setChatBusy(busy: boolean, statusLabel?: string) {
    const input = document.getElementById('chat-input-text') as HTMLInputElement | null;
    const send = document.getElementById('btn-send-chat') as HTMLButtonElement | null;
    const dockStatus = document.getElementById('ai-dock-status');
    document.body.classList.toggle('ai-chat-busy', busy);
    if (input) {
      input.disabled = busy;
      input.placeholder = busy ? 'IA trabalhando…' : 'Pergunte ou lance um gasto...';
    }
    if (send) send.disabled = busy;
    if (dockStatus) {
      dockStatus.classList.toggle('is-busy', busy);
      dockStatus.classList.toggle('txt-green', !busy);
      dockStatus.textContent = busy
        ? `STATUS: ${statusLabel ?? 'TRABALHANDO…'}`
        : 'STATUS: MONITORANDO';
    }
  }

  /**
   * Trata o que voltou do turno: confirmações pendentes, escritas e undo.
   * Após escrita da IA, recarrega o store completo para a tela atualizar na hora.
   */
  private handleAiOutcome(
    result: {
      pendingConfirmations: AiChatResult['pendingConfirmations'];
      changeSetIds: string[];
      executedTools?: string[];
    },
    originalMessage: string,
    meta: HTMLElement,
  ) {
    // Escritas aconteceram: recarrega os dados e oferece desfazer.
    if (result.changeSetIds.length > 0) {
      const changeSetId = result.changeSetIds[result.changeSetIds.length - 1]!;
      const tools = result.executedTools ?? [];
      const message = summarizeAiWrites(tools, result.changeSetIds.length);

      meta.innerHTML = `<span class="micro-label txt-green">[GRAVADO · ATUALIZANDO…]</span>`;
      pc98Audio.playSelect();

      void this.reloadAfterWrite(message, changeSetId).then(() => {
        meta.innerHTML = `<span class="micro-label txt-green">[GRAVADO · TELA ATUALIZADA]</span>`;
        this.focusViewAfterAiWrites(tools);
      });
    }

    if (result.pendingConfirmations.length === 0) return;

    // Nada foi escrito nestas: pede aprovação e reenvia com o token.
    const items = result.pendingConfirmations.map((p) => ({
      token: p.token,
      summary: p.summary,
      reason: p.reason,
    }));

    this.pendingAiConfirm = { items, originalMessage, meta };
    this.renderPendingAiConfirmMeta();
    const dockStatus = document.getElementById('ai-dock-status');
    if (dockStatus) {
      dockStatus.classList.add('is-busy');
      dockStatus.classList.remove('txt-green');
      dockStatus.textContent = 'STATUS: AGUARDANDO PERMISSÃO';
    }
    this.triggerAiRiskConfirmation();
  }

  /** Recarrega o store e redesenha, avisando com opção de desfazer. */
  private async reloadAfterWrite(message: string, changeSetId?: string) {
    try {
      await refreshAfterWrite();
      this.transactions = [...TRANSACTIONS];
      this.renderAll();
      this.notify(message, 'ok', changeSetId);
    } catch (error) {
      this.notify(
        `Alteração feita, mas não consegui recarregar a tela: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }

  /**
   * Depois que a IA escreve, leva o usuário à tela onde a mudança aparece —
   * evita o "já criei" sem nada visível na aba atual.
   */
  private focusViewAfterAiWrites(tools: string[]) {
    const unique = new Set(tools);
    if (unique.has('create_goal') || unique.has('contribute_to_goal')) {
      if (this.activeTab !== 'goals') this.switchTab('goals');
      else this.renderGoals();
      return;
    }
    if (
      unique.has('create_transaction') ||
      unique.has('update_transaction') ||
      unique.has('delete_transaction') ||
      unique.has('create_transfer') ||
      unique.has('categorize_transaction') ||
      unique.has('bulk_categorize')
    ) {
      // Mostra o resultado: limpa filtro de conta que esconderia o lançamento novo.
      this.journalAccountFilter = null;
      this.currentFilterKey = 'all';
      if (this.activeTab !== 'transactions') this.switchTab('transactions');
      else this.renderJournalTransactions(this.currentFilterKey);
      return;
    }
    if (unique.has('create_installment_plan') || unique.has('pay_card_invoice')) {
      if (this.activeTab !== 'accounts') this.switchTab('accounts');
      else this.renderAccounts();
      return;
    }
    if (unique.has('set_budget')) {
      if (this.activeTab !== 'category') this.switchTab('category');
      return;
    }
    if (unique.has('create_recurrence') || unique.has('confirm_occurrence')) {
      if (this.activeTab !== 'recurrences') this.switchTab('recurrences');
      return;
    }
  }

  /** Preenche conta/data/categorias do formulário NOVO REGISTRO com dados reais. */
  private prepareAddForm() {
    const dateInput = document.getElementById('full-input-date') as HTMLInputElement | null;
    if (dateInput) dateInput.value = TODAY;

    const accountSelect = document.getElementById('full-input-account') as HTMLSelectElement | null;
    if (accountSelect) {
      const previous = accountSelect.value;
      accountSelect.innerHTML = '';
      const spendable = ACCOUNTS.filter((a) => !a.isArchived && a.kind !== 'investment');
      for (const account of spendable) {
        const opt = document.createElement('option');
        opt.value = account.id;
        opt.textContent = account.name;
        accountSelect.appendChild(opt);
      }
      if (previous && spendable.some((a) => a.id === previous)) {
        accountSelect.value = previous;
      } else {
        const checking = spendable.find((a) => a.kind === 'checking');
        if (checking) accountSelect.value = checking.id;
      }
    }

    const grid = document.getElementById('add-cat-tile-grid');
    if (!grid) return;
    grid.innerHTML = '';

    // Folhas de despesa + raízes sem filhas (novos grupos ainda sem subcategoria).
    const expenseCats = CATEGORIES.filter((c) => c.kind === 'expense' && !c.isArchived);
    const hasChildren = new Set(
      expenseCats.filter((c) => c.parentId).map((c) => c.parentId as string),
    );
    const tileCats = expenseCats
      .filter((c) => c.parentId !== null || !hasChildren.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    if (
      this.selectedAddCategoryId &&
      !tileCats.some((c) => c.id === this.selectedAddCategoryId)
    ) {
      this.selectedAddCategoryId = null;
    }
    if (!this.selectedAddCategoryId && tileCats[0]) {
      this.selectedAddCategoryId = tileCats[0].id;
    }

    for (const cat of tileCats) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pc98-btn text-xs ${cat.id === this.selectedAddCategoryId ? 'btn-primary' : ''}`;
      btn.style.padding = '8px 6px';
      const parentName =
        cat.parentId != null
          ? CATEGORIES.find((p) => p.id === cat.parentId)?.name
          : null;
      btn.textContent = cat.name.toUpperCase();
      btn.title = parentName ? `${parentName} › ${cat.name}` : cat.name;
      btn.setAttribute('aria-pressed', cat.id === this.selectedAddCategoryId ? 'true' : 'false');
      btn.addEventListener('click', () => {
        pc98Audio.playSelect();
        this.selectedAddCategoryId = cat.id;
        this.prepareAddForm();
      });
      grid.appendChild(btn);
    }

    if (tileCats.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'micro-label';
      empty.style.color = 'var(--c-grey-blue)';
      empty.style.gridColumn = '1 / -1';
      empty.textContent = 'Nenhuma categoria ainda. Crie uma com [+ NOVA CATEGORIA].';
      grid.appendChild(empty);
    }
  }

  private syncCategoryParentOptions() {
    const kindSelect = document.getElementById('category-input-kind') as HTMLSelectElement | null;
    const parentSelect = document.getElementById('category-input-parent') as HTMLSelectElement | null;
    if (!parentSelect) return;

    const kind = (kindSelect?.value || 'expense') as 'expense' | 'income';
    const previous = parentSelect.value;
    parentSelect.innerHTML = '';

    const rootOpt = document.createElement('option');
    rootOpt.value = '';
    rootOpt.textContent = '— categoria raiz (novo grupo) —';
    parentSelect.appendChild(rootOpt);

    const roots = CATEGORIES.filter(
      (c) => c.kind === kind && c.parentId === null && !c.isArchived,
    ).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    for (const root of roots) {
      const opt = document.createElement('option');
      opt.value = root.id;
      opt.textContent = root.name;
      parentSelect.appendChild(opt);
    }

    if (previous && roots.some((r) => r.id === previous)) {
      parentSelect.value = previous;
    } else if (kind === 'expense') {
      const alimentacao = roots.find((r) => /alimenta/i.test(r.name));
      if (alimentacao) parentSelect.value = alimentacao.id;
      else if (roots[0]) parentSelect.value = roots[0].id;
    }
  }

  private openCategoryForm() {
    const modal = document.getElementById('modal-category-form');
    const nameInput = document.getElementById('category-input-name') as HTMLInputElement | null;
    const kindSelect = document.getElementById('category-input-kind') as HTMLSelectElement | null;
    if (nameInput) nameInput.value = '';
    if (kindSelect) kindSelect.value = 'expense';
    this.syncCategoryParentOptions();
    this.showModal(modal);
    nameInput?.focus();
  }

  private closeCategoryForm() {
    document.getElementById('modal-category-form')?.classList.add('hidden');
  }

  /** Categorias clicáveis (folhas + raízes sem filhas), filtráveis por texto. */
  private listPickableCategories(
    kind: 'expense' | 'income' | 'both',
    query = '',
  ): Array<{ id: string; name: string; parentName: string | null; kind: 'expense' | 'income' }> {
    const pool = CATEGORIES.filter(
      (c) => !c.isArchived && (kind === 'both' || c.kind === kind),
    );
    const hasChildren = new Set(
      pool.filter((c) => c.parentId).map((c) => c.parentId as string),
    );
    const pickable = pool.filter((c) => c.parentId !== null || !hasChildren.has(c.id));
    const q = query.trim().toLowerCase();

    return pickable
      .map((c) => ({
        id: c.id,
        name: c.name,
        parentName: c.parentId
          ? (CATEGORIES.find((p) => p.id === c.parentId)?.name ?? null)
          : null,
        kind: c.kind,
      }))
      .filter((c) => {
        if (!q) return true;
        const hay = `${c.parentName ?? ''} ${c.name}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        const ap = a.parentName ?? a.name;
        const bp = b.parentName ?? b.name;
        return ap.localeCompare(bp, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR');
      });
  }

  private renderCategoryPickerList(kind: 'expense' | 'income' | 'both', query: string) {
    const list = document.getElementById('category-picker-list');
    if (!list) return;

    const items = this.listPickableCategories(kind, query);
    list.innerHTML = '';

    if (items.length === 0) {
      list.innerHTML = `<div class="category-picker-empty micro-label">Nenhuma categoria encontrada</div>`;
      return;
    }

    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `category-picker-item${item.id === this.categoryPickerSelectedId ? ' is-selected' : ''}`;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', item.id === this.categoryPickerSelectedId ? 'true' : 'false');
      btn.dataset.categoryId = item.id;
      btn.innerHTML = item.parentName
        ? `<span class="cat-parent">${escapeHtml(item.parentName)}</span><span>${escapeHtml(item.name)}</span>`
        : `<span>${escapeHtml(item.name)}</span>`;
      btn.addEventListener('click', () => {
        pc98Audio.playSelect();
        this.categoryPickerSelectedId = item.id;
        this.renderCategoryPickerList(kind, query);
      });
      btn.addEventListener('dblclick', () => {
        pc98Audio.playClick();
        this.categoryPickerSelectedId = item.id;
        document.getElementById('btn-category-picker-confirm')?.click();
      });
      list.appendChild(btn);
    }

    const selected = list.querySelector('.category-picker-item.is-selected') as HTMLElement | null;
    selected?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Abre o seletor pesquisável de categorias.
   * `false` = cancelou; `null` = sem categoria; `string` = id escolhido.
   */
  private openCategoryPicker(options: {
    title?: string;
    selectedId?: string | null;
    kind?: 'expense' | 'income' | 'both';
    allowClear?: boolean;
  }): Promise<string | null | false> {
    const modal = document.getElementById('modal-category-picker');
    const titleEl = document.getElementById('category-picker-title');
    const searchEl = document.getElementById('category-picker-search') as HTMLInputElement | null;
    const clearBtn = document.getElementById('btn-category-picker-clear');
    const cancelBtn = document.getElementById('btn-category-picker-cancel');
    const confirmBtn = document.getElementById('btn-category-picker-confirm');
    const closeBtn = document.getElementById('btn-close-category-picker');

    if (!modal || !confirmBtn || !cancelBtn) return Promise.resolve(false);

    const kind = options.kind ?? 'both';
    this.categoryPickerSelectedId = options.selectedId ?? null;
    if (titleEl) titleEl.textContent = options.title ?? '✦ ESCOLHER CATEGORIA ✦';
    if (searchEl) searchEl.value = '';
    clearBtn?.classList.toggle('hidden', options.allowClear === false);

    this.renderCategoryPickerList(kind, '');
    this.showModal(modal);
    searchEl?.focus();

    return new Promise((resolve) => {
      const cleanup = () => {
        modal.classList.add('hidden');
        searchEl?.removeEventListener('input', onSearch);
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        closeBtn?.removeEventListener('click', onCancel);
        clearBtn?.removeEventListener('click', onClear);
        document.removeEventListener('keydown', onKey);
      };

      const onSearch = () => {
        this.renderCategoryPickerList(kind, searchEl?.value ?? '');
      };

      const onConfirm = () => {
        if (!this.categoryPickerSelectedId) {
          this.notify('Selecione uma categoria na lista (ou use Sem categoria).', 'warn');
          return;
        }
        pc98Audio.playClick();
        const id = this.categoryPickerSelectedId;
        cleanup();
        resolve(id);
      };

      const onClear = () => {
        pc98Audio.playClick();
        cleanup();
        resolve(null);
      };

      const onCancel = () => {
        pc98Audio.playClick();
        cleanup();
        resolve(false);
      };

      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          onCancel();
        } else if (ev.key === 'Enter' && document.activeElement !== searchEl) {
          ev.preventDefault();
          onConfirm();
        }
      };

      searchEl?.addEventListener('input', onSearch);
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      closeBtn?.addEventListener('click', onCancel);
      clearBtn?.addEventListener('click', onClear);
      document.addEventListener('keydown', onKey);
    });
  }

  private async quickChangeCategory(txId: string) {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx || tx.type === 'transfer') return;

    const picked = await this.openCategoryPicker({
      title: '✦ MUDAR CATEGORIA ✦',
      selectedId: tx.categoryId,
      kind: tx.type === 'income' ? 'income' : 'expense',
      allowClear: true,
    });
    if (picked === false) return;

    try {
      const result = await api.updateTransaction(txId, { categoryId: picked });
      await this.reloadAfterWrite(`Categoria de "${tx.description}" atualizada.`, result.changeSetId);
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao mudar categoria: ${String(error)}`,
        'error',
      );
    }
  }

  private syncTxEditCategoryLabel() {
    const label = document.getElementById('tx-edit-category-label');
    if (!label) return;
    label.textContent = this.editingTxCategoryId
      ? getCategoryPath(this.editingTxCategoryId)
      : 'Sem categoria';
  }

  private openTxEdit(txId: string) {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx || tx.type === 'transfer') {
      this.notify('Transferências não são editadas por aqui.', 'warn');
      return;
    }

    const modal = document.getElementById('modal-tx-edit');
    const summary = document.getElementById('tx-edit-summary');
    const description = document.getElementById('tx-edit-description') as HTMLInputElement | null;
    const amount = document.getElementById('tx-edit-amount') as HTMLInputElement | null;
    const amountHint = document.getElementById('tx-edit-amount-hint');
    const date = document.getElementById('tx-edit-date') as HTMLInputElement | null;
    const status = document.getElementById('tx-edit-status') as HTMLSelectElement | null;
    const account = document.getElementById('tx-edit-account') as HTMLSelectElement | null;
    const payee = document.getElementById('tx-edit-payee') as HTMLSelectElement | null;
    const notes = document.getElementById('tx-edit-notes') as HTMLTextAreaElement | null;
    const tags = document.getElementById('tx-edit-tags') as HTMLInputElement | null;

    this.editingTxId = tx.id;
    this.editingTxCategoryId = tx.categoryId;

    if (summary) {
      const sign = tx.amountCents < 0 ? 'DESPESA' : 'RECEITA';
      summary.textContent = `${sign} · ${getAccountName(tx.accountId)} · ${formatDate(tx.date)} · ${formatMoney(tx.amountCents)}`;
    }
    if (description) description.value = tx.description;
    if (amount) {
      amount.value = (Math.abs(tx.amountCents) / 100).toFixed(2);
      amount.disabled = tx.hasSplits;
    }
    if (amountHint) {
      if (tx.hasSplits) {
        amountHint.classList.remove('hidden');
        amountHint.textContent = 'Lançamento rateado: o valor não pode ser alterado aqui.';
      } else {
        amountHint.classList.add('hidden');
        amountHint.textContent = '';
      }
    }
    if (date) date.value = tx.date;
    if (status) status.value = tx.status;

    if (account) {
      account.innerHTML = '';
      const spendable = ACCOUNTS.filter((a) => !a.isArchived);
      for (const a of spendable) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        account.appendChild(opt);
      }
      account.value = tx.accountId;
    }

    if (payee) {
      payee.innerHTML = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— nenhum —';
      payee.appendChild(none);
      for (const p of [...PAYEES].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        payee.appendChild(opt);
      }
      payee.value = tx.payeeId ?? '';
    }

    if (notes) notes.value = tx.notes ?? '';
    if (tags) tags.value = getTagNames(tx.tagIds).join(', ');

    this.syncTxEditCategoryLabel();
    this.showModal(modal);
    description?.focus();
  }

  private closeTxEdit() {
    document.getElementById('modal-tx-edit')?.classList.add('hidden');
    this.editingTxId = null;
    this.editingTxCategoryId = null;
  }

  private async submitTxEdit() {
    if (!this.editingTxId) return;
    const tx = this.transactions.find((t) => t.id === this.editingTxId);
    if (!tx) return;

    const description = (document.getElementById('tx-edit-description') as HTMLInputElement | null)?.value.trim() ?? '';
    const amountRaw = (document.getElementById('tx-edit-amount') as HTMLInputElement | null)?.value ?? '';
    const date = (document.getElementById('tx-edit-date') as HTMLInputElement | null)?.value ?? '';
    const status = (document.getElementById('tx-edit-status') as HTMLSelectElement | null)?.value;
    const accountId = (document.getElementById('tx-edit-account') as HTMLSelectElement | null)?.value;
    const payeeId = (document.getElementById('tx-edit-payee') as HTMLSelectElement | null)?.value || null;
    const notesRaw = (document.getElementById('tx-edit-notes') as HTMLTextAreaElement | null)?.value ?? '';
    const tagsRaw = (document.getElementById('tx-edit-tags') as HTMLInputElement | null)?.value ?? '';

    if (!description) {
      this.notify('Informe a descrição.', 'warn');
      return;
    }
    if (!date) {
      this.notify('Informe a data.', 'warn');
      return;
    }
    if (!accountId) {
      this.notify('Selecione a conta.', 'warn');
      return;
    }

    const amountNumber = Number(amountRaw.replace(',', '.'));
    if (!tx.hasSplits && (!Number.isFinite(amountNumber) || amountNumber <= 0)) {
      this.notify('Informe um valor válido maior que zero.', 'warn');
      return;
    }

    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const body: Record<string, unknown> = {
      description,
      date,
      status,
      accountId,
      payeeId,
      categoryId: this.editingTxCategoryId,
      notes: notesRaw.trim() ? notesRaw.trim() : null,
      tags,
    };

    if (!tx.hasSplits) {
      body.amountCents = Math.round(amountNumber * 100);
    }

    try {
      const result = await api.updateTransaction(tx.id, body);
      this.closeTxEdit();
      await this.reloadAfterWrite(`Lançamento "${description}" atualizado.`, result.changeSetId);
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao salvar: ${String(error)}`,
        'error',
      );
    }
  }

  private async deleteTxFromEdit() {
    if (!this.editingTxId) return;
    const tx = this.transactions.find((t) => t.id === this.editingTxId);
    if (!tx) return;

    const ok = await this.openSystemDialog({
      title: '✦ CONFIRMAR EXCLUSÃO ✦',
      body: `Apagar <strong>${escapeHtml(tx.description)}</strong> (${formatMoney(tx.amountCents)})?`,
      confirmLabel: '[APAGAR]',
      cancelLabel: '[CANCELAR]',
      danger: true,
    });
    if (!ok) return;

    try {
      const result = await api.deleteTransaction(tx.id);
      this.selectedJournalTxIds.delete(tx.id);
      this.closeTxEdit();
      await this.reloadAfterWrite(`Lançamento "${tx.description}" excluído.`, result.changeSetId);
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao excluir: ${String(error)}`,
        'error',
      );
    }
  }

  private async openGoalActions(goalId: string, fromAccountId?: string) {
    const goal = GOALS.find((g) => g.id === goalId);
    if (!goal) return;

    const amountText = await this.openSystemDialog({
      title: `✦ APORTAR: ${goal.name.toUpperCase()} ✦`,
      body: `Progresso: <strong>${formatMoney(goal.savedCents)}</strong> / ${formatMoney(goal.targetCents)} (${Math.round(goal.progressPercent)}%)<br/><br/>Valor do aporte (R$):`,
      confirmLabel: '[APORTAR]',
      cancelLabel: '[FECHAR]',
      showInput: true,
      promptDefault: goal.requiredMonthlyCents
        ? (goal.requiredMonthlyCents / 100).toFixed(2)
        : '100',
      danger: false,
    });
    if (typeof amountText !== 'string' || !amountText.trim()) return;

    const amountNumber = Number(amountText.replace(',', '.'));
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      this.notify('Informe um valor válido.', 'warn');
      return;
    }

    const accountId =
      fromAccountId ||
      goal.accountId ||
      ACCOUNTS.find((a) => a.kind === 'checking')?.id ||
      ACCOUNTS[0]?.id;
    if (!accountId) {
      this.notify('Crie uma conta antes de aportar.', 'warn');
      return;
    }

    try {
      const result = await api.contributeToGoal(goal.id, {
        amountCents: Math.round(amountNumber * 100),
        fromAccountId: accountId,
        date: TODAY,
      });
      await this.reloadAfterWrite(`Aporte em "${goal.name}" registrado.`, result.changeSetId);
      this.switchTab('goals');
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha no aporte: ${String(error)}`,
        'error',
      );
    }
  }

  private async submitCategoryForm() {
    const nameInput = document.getElementById('category-input-name') as HTMLInputElement | null;
    const kindSelect = document.getElementById('category-input-kind') as HTMLSelectElement | null;
    const parentSelect = document.getElementById('category-input-parent') as HTMLSelectElement | null;

    const name = nameInput?.value.trim() ?? '';
    if (!name) {
      this.notify('Informe o nome da categoria.', 'warn');
      return;
    }

    const kind = (kindSelect?.value || 'expense') as 'expense' | 'income';
    const parentId = parentSelect?.value || undefined;

    try {
      const result = await api.createCategory({
        name,
        kind,
        ...(parentId ? { parentId } : {}),
      });
      this.closeCategoryForm();
      // Só pré-seleciona no form de registro se for despesa utilizável (folha ou raiz).
      if (kind === 'expense') {
        this.selectedAddCategoryId = result.data.id;
      }
      await this.reloadAfterWrite(`Categoria "${result.data.name}" criada.`, result.changeSetId);
      if (this.activeTab === 'add') this.prepareAddForm();
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao criar categoria: ${String(error)}`,
        'error',
      );
    }
  }

  /** Grava o lançamento do formulário via API (nada de ID fictício local). */
  private async submitNewTransaction() {
    pc98Audio.playSelect();

    const amtInput = document.getElementById('full-input-amount') as HTMLInputElement;
    const memoInput = document.getElementById('full-input-memo') as HTMLInputElement;
    const dateInput = document.getElementById('full-input-date') as HTMLInputElement;
    const accountSelect = document.getElementById('full-input-account') as HTMLSelectElement | null;

    const amt = parseFloat(amtInput.value);
    if (!Number.isFinite(amt) || amt <= 0) {
      this.notify('Informe um valor maior que zero.', 'warn');
      return;
    }

    const accountId =
      accountSelect?.value ||
      ACCOUNTS.find((a) => a.kind === 'checking')?.id ||
      ACCOUNTS.find((a) => a.kind !== 'credit_card')?.id;

    if (!accountId) {
      this.notify('Crie uma conta antes de lançar.', 'warn');
      return;
    }

    try {
      const result = await api.createTransaction({
        accountId,
        type: 'expense',
        amountCents: Math.round(amt * 100),
        date: toIsoDate(dateInput.value || TODAY),
        description: (memoInput.value || 'Nova despesa').trim(),
        categoryId: this.selectedAddCategoryId ?? undefined,
      });
      (document.getElementById('form-full-add-tx') as HTMLFormElement | null)?.reset();
      this.prepareAddForm();
      await this.reloadAfterWrite('Lançamento registrado.', result.changeSetId);
      this.selectedTxId = result.data.id;
      this.journalAccountFilter = accountId;
      this.currentFilterKey = 'all';
      this.journalSearchQuery = '';
      const searchInput = document.getElementById('journal-search-input') as HTMLInputElement | null;
      if (searchInput) searchInput.value = '';
      this.switchTab('transactions');
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao registrar: ${String(error)}`,
        'error',
      );
    }
  }

  /**
   * Aviso no canto da tela.
   *
   * Com `changeSetId`, mostra o botão de desfazer — é o que torna a autonomia da
   * IA confortável: o erro está sempre a um clique de ser revertido.
   */
  public notify(message: string, kind: 'ok' | 'warn' | 'error' = 'ok', changeSetId?: string) {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    const tag = document.createElement('span');
    tag.className = 'toast-tag';
    tag.textContent = kind === 'ok' ? '[OK]' : kind === 'warn' ? '[!]' : '[ERRO]';

    const textEl = document.createElement('span');
    textEl.style.flex = '1';
    textEl.textContent = message;

    toast.append(tag, textEl);

    if (changeSetId) {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'toast-action';
      undoBtn.type = 'button';
      undoBtn.textContent = '[DESFAZER]';
      undoBtn.addEventListener('click', async () => {
        undoBtn.disabled = true;
        undoBtn.textContent = '[...]';
        try {
          await api.undo(changeSetId);
          toast.remove();
          await this.reloadAfterWrite('Alteração desfeita.');
        } catch (error) {
          undoBtn.disabled = false;
          undoBtn.textContent = '[DESFAZER]';
          this.notify(
            error instanceof ApiError ? error.message : 'Não consegui desfazer.',
            'error',
          );
        }
      });
      toast.appendChild(undoBtn);
    }

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Fechar aviso');
    close.textContent = '×';
    close.addEventListener('click', () => toast.remove());
    toast.appendChild(close);

    stack.appendChild(toast);

    // Avisos com ação ficam mais tempo: dá para ler e decidir.
    const timeout = changeSetId ? 15_000 : kind === 'error' ? 10_000 : 5_000;
    setTimeout(() => toast.remove(), timeout);
  }

  // ── IMPORTER (honesto: histórico real; upload ainda não implementado) ─────

  private startImporterSimulation(filename: string) {
    const progressBox = document.getElementById('importer-progress-box');
    const statusText = document.getElementById('import-status-text');
    const statusPct = document.getElementById('import-status-pct');
    const ditherBar = document.getElementById('import-dither-bar');
    const progressbar = document.getElementById('import-progressbar');
    const parsedResults = document.getElementById('importer-parsed-results');

    if (!progressBox || !statusText || !statusPct || !ditherBar) return;

    progressBox.classList.remove('hidden');
    if (parsedResults) parsedResults.classList.add('hidden');
    statusText.textContent = `ARQUIVO: ${filename.toUpperCase()}`;
    ditherBar.style.setProperty('--progress', '0');
    statusPct.textContent = '—';
    progressbar?.setAttribute('aria-valuenow', '0');

    // ponytail: sem parser real ainda; não inventar sucesso
    statusText.textContent = `IMPORTAÇÃO DE "${filename.toUpperCase()}" AINDA NÃO ESTÁ PRONTA`;
    ditherBar.style.setProperty('--progress', '0');
    if (parsedResults) {
      parsedResults.classList.remove('hidden');
      const summary = document.getElementById('parsed-summary-text');
      if (summary) {
        summary.innerHTML =
          'O upload/parse de extrato ainda não está ligado à API.<br/>' +
          'O histórico abaixo mostra importações reais já aplicadas.<br/>' +
          'Por agora, lance manualmente ou peça à IA.';
      }
      const confirmBtn = document.getElementById('btn-confirm-import-rows');
      if (confirmBtn) {
        confirmBtn.textContent = '[IR AO JOURNAL]';
        confirmBtn.classList.remove('btn-gold');
      }
    }
    this.notify('Importação de arquivo ainda não disponível.', 'warn');
  }

  // ── EVENTS ────────────────────────────────────────────────────────────────

  private initEvents() {
    // Keyboard Hotkey Navigation
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === '1') this.switchTab('dashboard');
      else if (e.key === '2') this.switchTab('chat');
      else if (e.key === '3') this.switchTab('transactions');
      else if (e.key === '4') this.switchTab('accounts');
      else if (e.key === '5') this.switchTab('debts');
      else if (e.key === '6') this.switchTab('investments');
      else if (e.key === '7') this.switchTab('importer');
      else if (e.key === '8') this.switchTab('category');
      else if (e.key.toLowerCase() === 'r') this.switchTab('recurrences');
      else if (e.key.toLowerCase() === 'm') this.switchTab('goals');
      else if (e.key.toLowerCase() === 'g') this.switchTab('rules');
      else if (e.key.toLowerCase() === 'f') this.switchTab('reports');
      else if (e.key.toLowerCase() === 'p') {
        document.getElementById('btn-open-profile')?.click();
      } else if (e.key === '+' || e.key === '=') {
        this.switchTab('add');
      }
      else if (e.key === 'F1') {
        e.preventDefault();
        const helpModal = document.getElementById('modal-help-guide');
        if (helpModal?.classList.contains('hidden')) this.showModal(helpModal);
        else helpModal?.classList.add('hidden');
      } else if (e.key === 'Escape') {
        if (this.closeTopModal()) return;
        if (window.matchMedia('(max-width: 1100px)').matches) {
          this.setAiDockOpen(false);
        }
      } else if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Advance bottom dialogue dock (Continue)
        if (this.activeTab === 'dashboard' || this.activeTab === 'chat') {
          this.advanceAiDialogue();
        }
      }
    });

    document.getElementById('btn-ai-continue')?.addEventListener('click', () => {
      this.advanceAiDialogue();
    });

    // AI DOCK (narrow layouts + collapsed expand)
    const mobileAiBtn = document.getElementById('btn-mobile-ai');
    const closeAiDockBtn = document.getElementById('btn-close-ai-dock');
    mobileAiBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      if (this.aiDockCollapsed) {
        this.expandAiDock();
        return;
      }
      const open = !document.body.classList.contains('ai-dock-open');
      this.setAiDockOpen(open);
      if (open) document.getElementById('chat-input-text')?.focus();
    });
    closeAiDockBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      if (this.aiDockCollapsed) {
        this.expandAiDock();
        return;
      }
      this.setAiDockOpen(false);
    });

    // BATCH ACTION HANDLERS — só lote (categoria / apagar). Edição = clique na linha.
    const btnSelectAll = document.getElementById('btn-batch-select-all');
    const btnBatchDelete = document.getElementById('btn-batch-delete');
    const btnBatchRecategorize = document.getElementById('btn-batch-recategorize');

    btnSelectAll?.addEventListener('click', () => {
      pc98Audio.playClick();
      const visibleTxs = this.journalVisibleTxs();
      const allSelected =
        visibleTxs.length > 0 && visibleTxs.every((t) => this.selectedJournalTxIds.has(t.id));
      if (allSelected) {
        visibleTxs.forEach((t) => this.selectedJournalTxIds.delete(t.id));
      } else {
        visibleTxs.forEach((t) => this.selectedJournalTxIds.add(t.id));
      }
      this.renderJournalTransactions(this.currentFilterKey);
    });

    btnBatchDelete?.addEventListener('click', async () => {
      if (this.selectedJournalTxIds.size === 0) return;
      pc98Audio.playWarning();
      const ok = await this.openSystemDialog({
        title: '✦ CONFIRMAR EXCLUSÃO ✦',
        body: `Deseja excluir os <strong>${this.selectedJournalTxIds.size}</strong> registros selecionados?<br/><span class="txt-pink">Esta ação não pode ser desfeita nesta sessão.</span>`,
        confirmLabel: '[APAGAR]',
        cancelLabel: '[CANCELAR]',
        danger: true
      });
      if (ok) {
        const ids = [...this.selectedJournalTxIds];
        const results = await Promise.allSettled(ids.map((id) => api.deleteTransaction(id)));
        const failed = results.filter((r) => r.status === 'rejected').length;
        const deleted = ids.length - failed;
        this.selectedJournalTxIds.clear();
        if (this.selectedTxId && ids.includes(this.selectedTxId)) this.selectedTxId = '';
        await this.reloadAfterWrite(
          failed > 0
            ? `${deleted} excluído(s), ${failed} falhou(aram).`
            : `${deleted} lançamento(s) excluído(s).`,
        );
        if (failed > 0) this.notify(`${failed} exclusão(ões) falharam.`, 'warn');
      }
    });

    btnBatchRecategorize?.addEventListener('click', async () => {
      if (this.selectedJournalTxIds.size === 0) return;
      pc98Audio.playSelect();

      const ids = [...this.selectedJournalTxIds];
      const sample = this.transactions.find((t) => t.id === ids[0]);
      const kinds = new Set(
        ids
          .map((id) => this.transactions.find((t) => t.id === id)?.type)
          .filter((t): t is 'expense' | 'income' => t === 'expense' || t === 'income'),
      );
      const kind: 'expense' | 'income' | 'both' =
        kinds.size === 1 ? ([...kinds][0] as 'expense' | 'income') : 'both';

      const picked = await this.openCategoryPicker({
        title: `✦ MUDAR CATEGORIA (${ids.length}) ✦`,
        selectedId: sample?.categoryId ?? null,
        kind,
        allowClear: false,
      });
      if (picked === false || picked === null) return;

      try {
        const result = await api.bulkCategorize(ids, picked);
        this.selectedJournalTxIds.clear();
        await this.reloadAfterWrite(
          `${result.data.updated} lançamento(s) recategorizado(s).`,
          result.changeSetId,
        );
      } catch (error) {
        this.notify(
          error instanceof ApiError ? error.message : `Falha ao recategorizar: ${String(error)}`,
          'error',
        );
      }
    });

    document.getElementById('btn-close-tx-edit')?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.closeTxEdit();
    });
    document.getElementById('btn-cancel-tx-edit')?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.closeTxEdit();
    });
    document.getElementById('form-tx-edit')?.addEventListener('submit', (e) => {
      e.preventDefault();
      pc98Audio.playSelect();
      void this.submitTxEdit();
    });
    document.getElementById('btn-tx-edit-delete')?.addEventListener('click', () => {
      pc98Audio.playWarning();
      void this.deleteTxFromEdit();
    });
    document.getElementById('tx-edit-category-btn')?.addEventListener('click', async () => {
      if (!this.editingTxId) return;
      pc98Audio.playSelect();
      const tx = this.transactions.find((t) => t.id === this.editingTxId);
      const picked = await this.openCategoryPicker({
        title: '✦ CATEGORIA DO LANÇAMENTO ✦',
        selectedId: this.editingTxCategoryId,
        kind: tx?.type === 'income' ? 'income' : 'expense',
        allowClear: true,
      });
      if (picked === false) return;
      this.editingTxCategoryId = picked;
      this.syncTxEditCategoryLabel();
    });

    document.getElementById('btn-new-account')?.addEventListener('click', () => {
      this.openAccountForm('create');
    });

    document.getElementById('btn-new-category')?.addEventListener('click', () => {
      pc98Audio.playSelect();
      this.openCategoryForm();
    });
    document.getElementById('category-input-kind')?.addEventListener('change', () => {
      this.syncCategoryParentOptions();
    });
    document.getElementById('btn-close-category-form')?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.closeCategoryForm();
    });
    document.getElementById('btn-cancel-category-form')?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.closeCategoryForm();
    });
    document.getElementById('form-category')?.addEventListener('submit', (e) => {
      e.preventDefault();
      pc98Audio.playSelect();
      void this.submitCategoryForm();
    });

    document.getElementById('accounts-filter-strip')?.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('[data-accounts-filter]') as HTMLElement | null;
      if (!target) return;
      pc98Audio.playSelect();
      const filter = (target.dataset.accountsFilter || 'all') as typeof this.accountsFilter;
      this.accountsFilter = filter;
      document.querySelectorAll('#accounts-filter-strip .filter-btn').forEach((b) => {
        b.classList.remove('active', 'btn-primary');
      });
      target.classList.add('active', 'btn-primary');
      this.renderAccounts();
    });

    document.getElementById('account-input-kind')?.addEventListener('change', () => {
      this.syncAccountFormSections();
    });
    document.getElementById('account-input-has-debit')?.addEventListener('change', () => {
      this.syncAccountFormSections();
    });
    document.getElementById('btn-close-account-form')?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.closeAccountForm();
    });
    document.getElementById('btn-cancel-account-form')?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.closeAccountForm();
    });
    document.getElementById('form-account')?.addEventListener('submit', (e) => {
      e.preventDefault();
      pc98Audio.playSelect();
      void this.submitAccountForm();
    });

    document.getElementById('btn-new-goal')?.addEventListener('click', () => {
      void this.promptCreateGoal();
    });
    document.getElementById('btn-new-recurrence')?.addEventListener('click', () => {
      void this.promptCreateRecurrence();
    });
    document.getElementById('btn-new-rule')?.addEventListener('click', () => {
      void this.promptCreateRule();
    });

    // SAC vs PRICE HELP MODAL
    const openSacPriceBtn = document.getElementById('btn-open-sac-price-help');
    const closeSacPriceBtn = document.getElementById('btn-close-sac-price');
    const confirmSacPriceBtn = document.getElementById('btn-close-sac-price-confirm');
    const sacPriceModal = document.getElementById('modal-sac-price-help');

    openSacPriceBtn?.addEventListener('click', () => { pc98Audio.playClick(); this.showModal(sacPriceModal); });
    closeSacPriceBtn?.addEventListener('click', () => { pc98Audio.playClick(); sacPriceModal?.classList.add('hidden'); });
    confirmSacPriceBtn?.addEventListener('click', () => { pc98Audio.playClick(); sacPriceModal?.classList.add('hidden'); });

    // IMPORTER
    const dropzone = document.getElementById('importer-dropzone');
    const fileInputBtn = document.getElementById('btn-trigger-file-select');
    const fileInput = document.getElementById('input-statement-file') as HTMLInputElement;
    const confirmImportRowsBtn = document.getElementById('btn-confirm-import-rows');

    fileInputBtn?.addEventListener('click', (e) => { e.stopPropagation(); pc98Audio.playClick(); fileInput?.click(); });
    dropzone?.addEventListener('click', () => { pc98Audio.playClick(); fileInput?.click(); });

    fileInput?.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        this.startImporterSimulation(fileInput.files[0].name);
      }
    });

    confirmImportRowsBtn?.addEventListener('click', async () => {
      pc98Audio.playClick();
      this.switchTab('transactions');
    });

    // Rule Tester
    const testRuleBtn = document.getElementById('btn-test-rule');
    const testRuleInput = document.getElementById('rule-test-input') as HTMLInputElement;
    const testRuleResult = document.getElementById('rule-test-result');

    testRuleBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      const text = testRuleInput?.value.trim() || '';
      if (!text) {
        if (testRuleResult) testRuleResult.innerHTML = '<span class="txt-pink">DIGITE UM TEXTO DE EXEMPLO!</span>';
        return;
      }
      const matchedRule = RULES.find(r => r.conditionRegex && text.toUpperCase().includes(r.conditionRegex.toUpperCase()));
      if (matchedRule && testRuleResult) {
        const catName = matchedRule.actionCategoryName || (matchedRule.actionCategoryId ? getCategoryName(matchedRule.actionCategoryId) : 'Geral');
        testRuleResult.innerHTML = `<span class="txt-green">✓ CORRESPONDÊNCIA DETECTADA!</span><br/>Regra: ${matchedRule.name}<br/>Padrão: "${matchedRule.conditionRegex}" → Categoria: <strong>${catName}</strong>`;
      } else if (testRuleResult) {
        testRuleResult.innerHTML = `<span class="txt-amber">⚠ NENHUMA REGRA CORRESPONDEU</span><br/>A transação será atribuída à categoria padrão [Outros].`;
      }
    });

    // User Profile Modal
    const profileBtn = document.getElementById('btn-open-profile');
    const sidebarProfileBtn = document.getElementById('btn-sidebar-profile');
    const profileModal = document.getElementById('modal-user-profile');
    const closeProfileBtn = document.getElementById('btn-close-profile');
    const saveProfileBtn = document.getElementById('btn-save-user-profile');
    const usernameInput = document.getElementById('profile-input-username') as HTMLInputElement;
    const headerUsernameEl = document.getElementById('header-username');
    const bottomUsernameTagEl = document.getElementById('bottom-username-tag');

    const openProfile = () => {
      pc98Audio.playClick();
      if (usernameInput) usernameInput.value = this.userName;
      this.showModal(profileModal);
    };

    profileBtn?.addEventListener('click', openProfile);
    sidebarProfileBtn?.addEventListener('click', openProfile);
    closeProfileBtn?.addEventListener('click', () => { pc98Audio.playClick(); profileModal?.classList.add('hidden'); });

    // Profile Avatar Preset Selection
    const presetTiles = document.querySelectorAll('.avatar-preset-tile');
    presetTiles.forEach(tile => {
      tile.addEventListener('click', (e) => {
        pc98Audio.playSelect();
        presetTiles.forEach(t => t.classList.remove('selected'));
        const target = e.currentTarget as HTMLElement;
        target.classList.add('selected');
        const preset = (target.dataset.preset || 'cyber_pilot') as UserAvatarPreset;
        this.userAvatarPreset = preset;
      });
    });

    // Profile Accent Color Picker
    const colorBtns = document.querySelectorAll('.profile-color-btn');
    colorBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        pc98Audio.playSelect();
        colorBtns.forEach(b => b.classList.remove('active'));
        const target = e.currentTarget as HTMLElement;
        target.classList.add('active');
        const color = target.dataset.color || '#41A6F6';
        this.userAccentColor = color;
        Object.keys(this.presetRenderers).forEach(key => {
          this.presetRenderers[key].accentColor = color;
        });
      });
    });

    // Save Profile
    saveProfileBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      if (usernameInput && usernameInput.value.trim()) {
        this.userName = usernameInput.value.trim();
        if (headerUsernameEl) headerUsernameEl.textContent = this.userName;
        if (bottomUsernameTagEl) bottomUsernameTagEl.textContent = `[USER] ${this.userName}`;
      }
      if (this.headerAvatarRenderer) {
        this.headerAvatarRenderer.preset = this.userAvatarPreset;
        this.headerAvatarRenderer.accentColor = this.userAccentColor;
      }
      if (this.bottomUserAvatarRenderer) {
        this.bottomUserAvatarRenderer.preset = this.userAvatarPreset;
        this.bottomUserAvatarRenderer.accentColor = this.userAccentColor;
      }
      profileModal?.classList.add('hidden');
    });

    // Theme / Sound / CRT Toggles
    const themeBtn = document.getElementById('btn-toggle-theme');
    themeBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      this.applyTheme(true);
      this.rerenderActiveCharts();
      this.renderBudgets();
    });

    const soundBtn = document.getElementById('btn-toggle-sound');
    soundBtn?.addEventListener('click', () => {
      const enabled = pc98Audio.toggleSound();
      if (soundBtn) {
        soundBtn.textContent = enabled ? 'SND: ON' : 'SND: OFF';
        soundBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      }
    });

    const crtBtn = document.getElementById('btn-toggle-crt');
    const crtOverlay = document.getElementById('crt-overlay');
    crtBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.crtEnabled = !this.crtEnabled;
      if (crtOverlay) {
        crtOverlay.classList.toggle('disabled', !this.crtEnabled);
      }
      if (crtBtn) {
        crtBtn.textContent = this.crtEnabled ? 'CRT: ON' : 'CRT: OFF';
        crtBtn.setAttribute('aria-pressed', this.crtEnabled ? 'true' : 'false');
      }
    });

    // System Help Modal
    const helpBtn = document.getElementById('btn-open-help');
    const helpModal = document.getElementById('modal-help-guide');
    const closeHelpBtn = document.getElementById('btn-close-help');
    const confirmHelpBtn = document.getElementById('btn-close-help-confirm');

    helpBtn?.addEventListener('click', () => { pc98Audio.playClick(); this.showModal(helpModal); });
    closeHelpBtn?.addEventListener('click', () => { pc98Audio.playClick(); helpModal?.classList.add('hidden'); });
    confirmHelpBtn?.addEventListener('click', () => { pc98Audio.playClick(); helpModal?.classList.add('hidden'); });

    // Sidebar Navigation
    const sidebarBtns = document.querySelectorAll('.sidebar-item-btn[data-tab]');
    sidebarBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        pc98Audio.playSelect();
        const target = e.currentTarget as HTMLElement;
        const tabId = target.dataset.tab || 'dashboard';
        this.switchTab(tabId);
      });
    });

    // Journal Live Search
    const searchInput = document.getElementById('journal-search-input') as HTMLInputElement;
    searchInput?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.journalSearchQuery = target.value;
      this.renderJournalTransactions(this.currentFilterKey);
    });

    // Journal Filters
    const filterBtns = document.querySelectorAll('#tx-filter-strip .filter-btn');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        pc98Audio.playSelect();
        filterBtns.forEach(b => { b.classList.remove('active', 'btn-primary'); });
        const target = e.currentTarget as HTMLElement;
        target.classList.add('active', 'btn-primary');
        const filterKey = target.dataset.filter || 'all';
        this.renderJournalTransactions(filterKey);
      });
    });

    // Chat Prompt Chips
    document.querySelectorAll('.prompt-dash-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        pc98Audio.playSelect();
        const query = (e.currentTarget as HTMLElement).dataset.query || '';
        this.sendChatMessage(query);
      });
    });

    // Full Add Transaction Form — grava na API de verdade
    const fullAddForm = document.getElementById('form-full-add-tx') as HTMLFormElement;
    fullAddForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submitNewTransaction();
    });

    // Chat Input (also accepts NL ledger entries — replaces removed top quick-entry bar)
    const chatForm = document.getElementById('chat-input-form') as HTMLFormElement;
    chatForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      pc98Audio.playClick();
      const textInput = document.getElementById('chat-input-text') as HTMLInputElement;
      const query = textInput.value.trim();
      if (!query) return;

      if (this.pendingAiConfirm && AI_CONFIRM_RE.test(query)) {
        textInput.value = '';
        const streamBox = document.getElementById('chat-stream-box');
        if (streamBox) {
          const note = document.createElement('div');
          note.className = 'chat-bubble-row ai-side';
          note.innerHTML = `<div class="chat-bubble ai-bubble"><div class="micro-label txt-green">Confirmação pelo chat — executando.</div></div>`;
          streamBox.appendChild(note);
          streamBox.scrollTop = streamBox.scrollHeight;
        }
        this.approveAllPendingAiConfirm();
        return;
      }

      if (!this.commitNaturalLanguageEntry(query)) {
        this.sendChatMessage(query);
      }
      textInput.value = '';
    });

    // Credit Card Pay Invoice (legacy global button — prefer per-invoice [PAGAR])
    const payInvoiceBtn = document.getElementById('btn-pay-invoice');
    payInvoiceBtn?.addEventListener('click', async () => {
      pc98Audio.playSelect();
      const openInv = CARD_INVOICES.find((inv) => inv.status === 'open' || inv.status === 'overdue');
      if (!openInv) {
        this.notify('Nenhuma fatura aberta para pagar.', 'warn');
        return;
      }
      await this.payInvoiceById(openInv.id);
    });

    // Early Payment Simulation
    const simEarlyPayBtn = document.getElementById('btn-simulate-early-pay');
    simEarlyPayBtn?.addEventListener('click', async () => {
      pc98Audio.playSelect();
      const d = DEBTS[0];
      if (!d) {
        this.notify('Nenhuma dívida cadastrada para simular.', 'warn');
        return;
      }
      try {
        const sim = await api.simulateExtra(d.id, 1000000);
        await this.openSystemDialog({
          title: `✦ SIMULAÇÃO ${d.system.toUpperCase()} ✦`,
          body: `Ao aportar <strong class="txt-amber">${formatMoney(1000000)}</strong> extras em <strong>${escapeHtml(sim.debtName)}</strong>, você economizará aproximadamente <strong class="txt-green">${formatMoney(sim.interestSavedCents)}</strong> em juros e reduzirá o prazo em <strong>${sim.monthsSaved}</strong> meses (novo prazo: ${sim.newTermMonths} meses).<br/><br/><span class="micro-label">Parcelas restantes: ${d.remainingCount}</span>`,
          confirmLabel: '[ENTENDI]',
          cancelLabel: '',
          danger: false
        });
      } catch (error) {
        this.notify(
          error instanceof ApiError ? error.message : `Falha na simulação: ${String(error)}`,
          'error',
        );
      }
    });
  }

  private async payInvoiceById(invoiceId: string) {
    pc98Audio.playSelect();
    const inv = CARD_INVOICES.find((i) => i.id === invoiceId);
    if (!inv) {
      this.notify('Fatura não encontrada.', 'warn');
      return;
    }
    const ok = await this.openSystemDialog({
      title: '✦ PAGAR FATURA ✦',
      body: `Pagar fatura <strong>${escapeHtml(inv.referenceMonth)}</strong> de <strong class="txt-amber">${formatMoney(inv.totalCents)}</strong>?`,
      confirmLabel: '[PAGAR]',
      cancelLabel: '[CANCELAR]',
      danger: false,
    });
    if (!ok) return;
    try {
      const result = await api.payInvoice(invoiceId);
      await this.reloadAfterWrite('Fatura paga.', result.changeSetId);
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao pagar fatura: ${String(error)}`,
        'error',
      );
    }
  }

  private async promptCreateAccount() {
    this.openAccountForm('create');
  }

  private async promptCreateGoal() {
    pc98Audio.playSelect();
    const name = await this.openSystemDialog({
      title: '✦ NOVA META ✦',
      body: 'Nome da meta:',
      confirmLabel: '[PRÓXIMO]',
      cancelLabel: '[CANCELAR]',
      showInput: true,
      promptDefault: '',
      danger: false,
    });
    if (typeof name !== 'string' || !name.trim()) return;

    const targetStr = await this.openSystemDialog({
      title: '✦ NOVA META ✦',
      body: `Alvo de <strong>${escapeHtml(name.trim())}</strong> em R$:`,
      confirmLabel: '[CRIAR]',
      cancelLabel: '[CANCELAR]',
      showInput: true,
      promptDefault: '1000',
      danger: false,
    });
    if (typeof targetStr !== 'string') return;
    const target = parseFloat(targetStr.replace(',', '.'));
    if (!Number.isFinite(target) || target <= 0) {
      this.notify('Informe um valor alvo válido.', 'warn');
      return;
    }
    try {
      const result = await api.createGoal({ name: name.trim(), targetCents: Math.round(target * 100) });
      await this.reloadAfterWrite('Meta criada.', result.changeSetId);
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao criar meta: ${String(error)}`,
        'error',
      );
    }
  }

  private async promptCreateRecurrence() {
    pc98Audio.playSelect();
    if (ACCOUNTS.length === 0) {
      this.notify('Crie uma conta antes de adicionar recorrências.', 'warn');
      return;
    }
    const name = await this.openSystemDialog({
      title: '✦ NOVA RECORRÊNCIA ✦',
      body: 'Nome da recorrência:',
      confirmLabel: '[PRÓXIMO]',
      cancelLabel: '[CANCELAR]',
      showInput: true,
      promptDefault: '',
      danger: false,
    });
    if (typeof name !== 'string' || !name.trim()) return;

    const amountStr = await this.openSystemDialog({
      title: '✦ NOVA RECORRÊNCIA ✦',
      body: `Valor mensal de <strong>${escapeHtml(name.trim())}</strong> em R$:`,
      confirmLabel: '[CRIAR]',
      cancelLabel: '[CANCELAR]',
      showInput: true,
      promptDefault: '100',
      danger: false,
    });
    if (typeof amountStr !== 'string') return;
    const amount = parseFloat(amountStr.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      this.notify('Informe um valor válido.', 'warn');
      return;
    }

    const accountId =
      ACCOUNTS.find((a) => !a.isArchived && a.kind === 'checking')?.id ||
      ACCOUNTS.find((a) => !a.isArchived)?.id ||
      ACCOUNTS[0]?.id;
    if (!accountId) {
      this.notify('Crie uma conta antes de adicionar recorrências.', 'warn');
      return;
    }

    try {
      const result = await api.createRecurrence({
        name: name.trim(),
        accountId,
        type: 'expense',
        amountCents: Math.round(amount * 100),
        freq: 'monthly',
        dayOfMonth: 1,
        startDate: TODAY,
        autoPost: false,
      });
      await this.reloadAfterWrite('Recorrência criada.', result.changeSetId);
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao criar recorrência: ${String(error)}`,
        'error',
      );
    }
  }

  private async promptCreateRule() {
    pc98Audio.playSelect();
    const name = await this.openSystemDialog({
      title: '✦ NOVA REGRA ✦',
      body: 'Nome da regra:',
      confirmLabel: '[PRÓXIMO]',
      cancelLabel: '[CANCELAR]',
      showInput: true,
      promptDefault: '',
      danger: false,
    });
    if (typeof name !== 'string' || !name.trim()) return;

    const contains = await this.openSystemDialog({
      title: '✦ NOVA REGRA ✦',
      body: 'Texto que a descrição deve conter:',
      confirmLabel: '[CRIAR]',
      cancelLabel: '[CANCELAR]',
      showInput: true,
      promptDefault: '',
      danger: false,
    });
    if (typeof contains !== 'string' || !contains.trim()) return;

    const leafCat = CATEGORIES.find((c) => c.kind === 'expense' && c.parentId && !c.isArchived);
    if (!leafCat) {
      this.notify('Nenhuma categoria de despesa disponível para a regra.', 'warn');
      return;
    }

    try {
      const result = await api.createRule({
        name: name.trim(),
        conditions: { descriptionContains: contains.trim() },
        actions: { categoryId: leafCat.id },
      });
      await this.reloadAfterWrite('Regra criada.', result.changeSetId);
    } catch (error) {
      this.notify(
        error instanceof ApiError ? error.message : `Falha ao criar regra: ${String(error)}`,
        'error',
      );
    }
  }
}

