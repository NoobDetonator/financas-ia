import { pc98Audio } from './audio';
import { PC98MascotRenderer, PC98UserMascotRenderer, type UserAvatarPreset } from './mascot';
import { PC98ChartSuite } from './charts';
import {
  ACCOUNTS, TRANSACTIONS, BUDGETS, DEBTS, HOLDINGS, RECURRENCES,
  GOALS, RULES, INSIGHTS, CARD_INVOICES, DEBT_PAYMENTS, MONTHLY_FLOW,
  PROJECTION, CATEGORIES,
  formatMoney, formatDate, toIsoDate, getAccountName, getCategoryPath,
  getCategoryName, getPayeeName, getTagNames, computeBalance,
  totalAvailableBalance, currentMonthIncome, currentMonthExpense, netWorth,
  statusLabel, statusColorClass, CREDIT_CARDS,
  openingAiMessage, refreshAfterWrite, savingsRate, cardUsage, TODAY,
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

  // USER PROFILE STATE & AVATAR RENDERERS
  private userName: string = 'Allan';
  private userAvatarPreset: UserAvatarPreset = 'cyber_pilot';
  private userAccentColor: string = '#41A6F6';
  private headerAvatarRenderer: PC98UserMascotRenderer | null = null;
  private bottomUserAvatarRenderer: PC98UserMascotRenderer | null = null;
  private presetRenderers: Record<string, PC98UserMascotRenderer> = {};

  constructor() {
    this.initTheme();
    this.initDOM();
    this.applyTheme(false); // refresh status-bar label after DOM exists
    this.initClock();
    this.renderAll();
    this.initEvents();
    window.addEventListener('resize', () => this.rerenderActiveCharts());
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

    ACCOUNTS.forEach(acc => {
      const isCredit = acc.kind === 'credit_card';
      const balance = computeBalance(acc.id);
      const card = document.createElement('div');
      card.className = 'pc98-well';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.gap = '6px';

      const creditCard = isCredit ? CREDIT_CARDS.find(c => c.accountId === acc.id) : null;

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: bold; color: var(--c-bone-white);">${acc.name}</span>
          <span class="micro-label" style="color: ${acc.color};">${acc.institution || acc.kind.toUpperCase()}</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: baseline;">
          <div>
            <div class="micro-label" style="color: var(--c-grey-blue);">DISPONÍVEL</div>
            <div class="num-currency ${balance.availableCents < 0 ? 'txt-pink' : 'txt-green'}" style="font-size: 22px;">
              ${formatMoney(balance.availableCents)}
            </div>
          </div>
          <div style="text-align: right;">
            <div class="micro-label" style="color: var(--c-grey-blue);">PROJETADO</div>
            <div class="num-currency" style="font-size: 14px; color: var(--c-pale-cyan);">
              ${formatMoney(balance.projectedCents)}
            </div>
          </div>
        </div>
        ${isCredit && creditCard ? `
          <div class="micro-label" style="color: var(--c-grey-blue);">
            LIMITE: ${formatMoney(creditCard.limitCents)} | FECHA: DIA ${creditCard.closingDay} | VENCE: DIA ${creditCard.dueDay}
          </div>
        ` : `
          <div class="micro-label" style="color: var(--c-grey-blue);">${acc.kind.toUpperCase()} • ${acc.currency}</div>
        `}
      `;

      grid.appendChild(card);
    });

    // Render invoices section
    const invoicesContainer = document.getElementById('invoices-container');
    if (invoicesContainer) {
      invoicesContainer.innerHTML = '';
      CARD_INVOICES.forEach(inv => {
        const statusClass = inv.status === 'overdue' ? 'txt-pink' : inv.status === 'open' ? 'txt-amber' : 'txt-green';
        const statusText = inv.status === 'overdue' ? 'VENCIDA' : inv.status === 'open' ? 'ABERTA' : 'PAGA';
        const el = document.createElement('div');
        el.className = 'pc98-well';
        el.style.padding = '8px';
        el.innerHTML = `
          <div style="display: flex; justify-content: space-between;">
            <span class="micro-label">FATURA ${inv.referenceMonth}</span>
            <span class="micro-label ${statusClass}">[${statusText}]</span>
          </div>
          <div class="num-currency ${statusClass}" style="font-size: var(--fs-md);">${formatMoney(inv.totalCents)}</div>
          <div class="micro-label" style="color: var(--c-grey-blue);">Vencimento: ${formatDate(inv.dueDate)}</div>
        `;
        invoicesContainer.appendChild(el);
      });
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
  }

  // ── JOURNAL — uses new Transaction model with status/tags/payees ──────────

  private renderJournalTransactions(filterKey: string = 'all') {
    const container = document.getElementById('journal-rows-container');
    const batchBar = document.getElementById('journal-batch-bar');
    const selectedCountEl = document.getElementById('batch-selected-count');

    if (!container) return;
    container.innerHTML = '';
    this.currentFilterKey = filterKey;

    const filtered = this.transactions.filter(tx => {
      // Exclude transfers from journal view
      if (tx.type === 'transfer') return false;

      let matchesFilter = true;
      if (filterKey === 'income') matchesFilter = tx.amountCents > 0;
      else if (filterKey === 'expense') matchesFilter = tx.amountCents < 0;
      else if (filterKey === 'scheduled') matchesFilter = tx.status === 'scheduled';
      else if (filterKey !== 'all') matchesFilter = tx.categoryId === filterKey;

      if (matchesFilter && this.journalSearchQuery.trim() !== '') {
        const query = this.journalSearchQuery.toLowerCase();
        const catName = getCategoryName(tx.categoryId).toLowerCase();
        const payee = getPayeeName(tx.payeeId).toLowerCase();
        matchesFilter = tx.description.toLowerCase().includes(query) || catName.includes(query) || payee.includes(query) || tx.date.includes(query);
      }

      return matchesFilter;
    });

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
          <input type="checkbox" class="tx-batch-checkbox" data-tx-id="${tx.id}" ${isChecked ? 'checked' : ''} style="cursor: pointer;" />
        </div>
        <div style="width: 16px; height: 16px;">${iconSvg}</div>
        <div>${formatDate(tx.date)}</div>
        <div>
          <div>${tx.description} ${installLabel} ${statusBadge}</div>
          <div class="micro-label">${accountName} • ${payee ? payee + ' • ' : ''}VIA ${tx.createdBy.toUpperCase()} ${tagsHtml}</div>
        </div>
        <div class="tx-category">${catName}</div>
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

      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        pc98Audio.playSelect();
        this.selectedTxId = tx.id;
        this.renderJournalTransactions(filterKey);
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
        this.navigateFromInsight(ins.kind);
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

  private navigateFromInsight(kind: string) {
    switch (kind) {
      case 'budget_exceeded':
      case 'budget_at_risk':
      case 'spend_spike':
        this.switchTab('category');
        break;
      case 'invoice_overdue':
        this.switchTab('accounts');
        break;
      case 'duplicate_charge':
        this.switchTab('transactions');
        break;
      case 'goal_behind':
        this.switchTab('goals');
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

    RECURRENCES.forEach(rec => {
      const amount = rec.amountCents ? formatMoney(rec.amountCents) : `~${formatMoney(rec.estimatedCents ?? 0)}`;
      const typeClass = rec.type === 'income' ? 'txt-green' : 'txt-pink';
      const typeLabel = rec.type === 'income' ? 'RECEITA' : 'DESPESA';
      const accountName = getAccountName(rec.accountId);
      const freqLabel = rec.freq === 'monthly' ? 'MENSAL' : rec.freq === 'weekly' ? 'SEMANAL' : rec.freq.toUpperCase();

      const el = document.createElement('div');
      el.className = 'pc98-well';
      el.style.padding = '8px';
      el.style.marginBottom = '6px';

      el.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-weight: bold; color: var(--c-bone-white);">${rec.name}</span>
            <span class="micro-label ${typeClass}">[${typeLabel}]</span>
            ${rec.autoPost ? '<span class="micro-label txt-green">[AUTO]</span>' : '<span class="micro-label txt-amber">[MANUAL]</span>'}
          </div>
          <div class="num-currency ${typeClass}" style="font-size: 16px;">${rec.type === 'expense' ? '-' : '+'}${amount}</div>
        </div>
        <div class="micro-label" style="color: var(--c-grey-blue);">
          ${accountName} • ${freqLabel} • DIA ${rec.dayOfMonth ?? '—'} • ${getCategoryName(rec.categoryId)}
          ${!rec.amountCents ? ' • <span class="txt-amber">VALOR VARIÁVEL</span>' : ''}
        </div>
      `;

      container.appendChild(el);
    });
  }

  // ── GOALS — new view ──────────────────────────────────────────────────────

  private renderGoals() {
    const container = document.getElementById('goals-list');
    if (!container) return;
    container.innerHTML = '';

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
      el.className = 'pc98-well';
      el.style.padding = '10px';
      el.style.marginBottom = '8px';

      el.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-weight: bold; color: var(--c-bone-white);">${goal.name}</span>
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
          ${goal.notes ? ` • ${goal.notes}` : ''}
        </div>
      `;

      container.appendChild(el);
    });
  }

  // ── RULES — new view ──────────────────────────────────────────────────────

  private renderRules() {
    const container = document.getElementById('rules-list');
    if (!container) return;
    container.innerHTML = '';

    RULES.forEach(rule => {
      const el = document.createElement('div');
      el.className = 'pc98-well';
      el.style.padding = '8px';
      el.style.marginBottom = '6px';

      el.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-weight: bold; color: var(--c-bone-white);">${rule.name}</span>
            <span class="micro-label ${rule.isEnabled ? 'txt-green' : 'txt-pink'}">[${rule.isEnabled ? 'ATIVA' : 'INATIVA'}]</span>
          </div>
          <span class="micro-label txt-cyan">${rule.matchCount} MATCHES</span>
        </div>
        <div class="micro-label" style="color: var(--c-grey-blue);">
          SE: ${rule.conditionDescription} → ENTÃO: ${rule.actionCategoryName ?? '—'}
          ${rule.lastMatchedAt ? ` • ÚLTIMO MATCH: ${formatDate(rule.lastMatchedAt)}` : ''}
        </div>
      `;

      container.appendChild(el);
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

    upcoming.forEach(tx => {
      const el = document.createElement('div');
      el.style.display = 'flex';
      el.style.justifyContent = 'space-between';
      el.style.padding = '4px 0';
      el.style.borderBottom = '1px dotted var(--c-grey-blue)';

      el.innerHTML = `
        <span class="micro-label">${formatDate(tx.date)} — ${tx.description}</span>
        <span class="num-currency ${tx.amountCents > 0 ? 'txt-green' : 'txt-amber'}">${formatMoney(tx.amountCents)}</span>
      `;

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
      // Show parent categories only
      const parentCats = CATEGORIES.filter(c => c.parentId === null && c.kind === 'expense');
      if (!this.selectedCategoryDetail && parentCats[0]) {
        this.selectedCategoryDetail = parentCats[0].id;
      }
      parentCats.forEach(cat => {
        const isSelected = cat.id === this.selectedCategoryDetail;
        const iconSvg = this.getCategoryIcon(cat.name);
        const budget = BUDGETS.find(b => b.categoryId === cat.id);
        const tile = document.createElement('div');
        tile.className = `icon-tile ${isSelected ? 'selected' : ''}`;
        tile.style.display = 'flex';
        tile.style.flexDirection = 'row';
        tile.style.justifyContent = 'flex-start';
        tile.style.padding = '6px';
        tile.style.gap = '8px';

        tile.innerHTML = `
          <div style="width: 16px; height: 16px;">${iconSvg}</div>
          <div>
            <div style="font-size: 13px;">${cat.name}</div>
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

    // Monthly expense dither bars with real data
    const breakdownContainer = document.getElementById('cat-breakdown-bars');
    if (breakdownContainer) {
      const monthLabels = ['FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL'];
      const maxExpense = Math.max(...MONTHLY_FLOW.map(m => m.expenseCents));

      breakdownContainer.innerHTML = MONTHLY_FLOW.map((m, i) => {
        const heightPct = Math.round((m.expenseCents / maxExpense) * 90);
        const color = m.netCents >= 0 ? 'cyan' : 'pink';
        return `
          <div class="dither-col" style="flex: 1;">
            <div class="num-currency txt-${color}" style="font-size: 14px;">${formatMoney(m.expenseCents)}</div>
            <div class="dither-col-bar dither-${color}" style="height: ${heightPct}%;"></div>
            <div class="micro-label">${monthLabels[i]}</div>
          </div>
        `;
      }).join('');
    }
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

  private triggerAiRiskConfirmation(diffText: string, onApprove: () => void) {
    const modal = document.getElementById('modal-ai-risk-confirm');
    const diffEl = document.getElementById('ai-risk-diff-text');
    const approveBtn = document.getElementById('btn-confirm-risk');
    const rejectBtn = document.getElementById('btn-reject-risk');
    const closeBtn = document.getElementById('btn-close-risk');

    if (!modal || !diffEl) return;

    diffEl.innerHTML = diffText;
    modal.classList.remove('hidden');
    pc98Audio.playWarning();

    const cleanup = () => {
      modal.classList.add('hidden');
    };

    if (approveBtn) {
      approveBtn.onclick = () => {
        pc98Audio.playSelect();
        cleanup();
        onApprove();
      };
    }

    if (rejectBtn) rejectBtn.onclick = cleanup;
    if (closeBtn) closeBtn.onclick = cleanup;
  }

  // ── STYLE GUIDE ───────────────────────────────────────────────────────────

  private renderStyleGuide() {
    const swatchContainer = document.getElementById('swatch-grid-container');
    if (swatchContainer && swatchContainer.children.length === 0) {
      const colors = [
        { name: 'VOID BLACK', hex: '#0A0A14' }, { name: 'DEEP NAVY', hex: '#14142B' },
        { name: 'INDIGO', hex: '#22224A' }, { name: 'SLATE', hex: '#333C57' },
        { name: 'GREY BLUE', hex: '#566C86' }, { name: 'PALE GREY', hex: '#C0CBDC' },
        { name: 'BONE WHITE', hex: '#F2F0E5' }, { name: 'PURE WHITE', hex: '#FFFFFF' },
        { name: 'BLUE', hex: '#3B5DC9' }, { name: 'SKY', hex: '#41A6F6' },
        { name: 'PALE CYAN', hex: '#73EFF7' }, { name: 'GREEN', hex: '#38B764' },
        { name: 'AMBER', hex: '#F4B41B' }, { name: 'MAGENTA PINK', hex: '#E5537A' },
        { name: 'PURPLE', hex: '#A23E8C' }, { name: 'TAN', hex: '#E4A672' },
      ];

      colors.forEach(c => {
        const card = document.createElement('div');
        card.className = 'swatch-card';
        card.innerHTML = `
          <div class="swatch-box" style="background-color: ${c.hex};"></div>
          <div class="swatch-info">
            <span style="color: var(--c-bone-white); font-weight: bold;">${c.name}</span>
            <span style="color: var(--c-pale-cyan);">${c.hex}</span>
          </div>
        `;
        swatchContainer.appendChild(card);
      });
    }

    const iconContainer = document.getElementById('icon-sheet-container');
    if (iconContainer && iconContainer.children.length === 0) {
      Object.keys(BITMAP_ICONS).forEach(key => {
        const tile = document.createElement('div');
        tile.className = 'icon-tile';
        tile.innerHTML = `
          <div style="width: 16px; height: 16px;">${BITMAP_ICONS[key]}</div>
          <span class="micro-label">${key}</span>
        `;
        iconContainer.appendChild(tile);
      });
    }
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

    let charIdx = 0;
    const typeNextChar = () => {
      if (charIdx < fullText.length) {
        textEl.textContent = fullText.slice(0, charIdx + 1);
        if (charIdx % 3 === 0) pc98Audio.playTypewriter();
        charIdx += 1;
        setTimeout(typeNextChar, 25);
      } else {
        const badgeHtml = badges.map((b) => `<span class="micro-label txt-cyan">[${escapeHtml(b)}]</span>`).join(' ');
        textEl.innerHTML = `${escapeHtml(fullText)}<br/><div style="margin-top: 4px;">${badgeHtml}</div><span class="blinking-cursor"></span>`;
        this.isTyping = false;
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
      this.setAiDockOpen(true);
      setTimeout(() => document.getElementById('chat-input-text')?.focus(), 40);
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
    } else if (tabId === 'style-guide') {
      this.renderStyleGuide();
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

    modal.classList.remove('hidden');
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
  private async sendChatMessage(query: string, approvedTokens: string[] = []) {
    const text = query.trim();
    if (!text || this.isTyping) return;

    const streamBox = document.getElementById('chat-stream-box');
    if (!streamBox) return;

    // Bolha do usuário. `textContent` em vez de innerHTML: a mensagem é texto do
    // usuário e não deve ser interpretada como HTML.
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

    // Bolha da IA, preenchida conforme o stream chega.
    const aiBubble = document.createElement('div');
    aiBubble.className = 'chat-bubble-row ai-side';
    aiBubble.innerHTML = `
      <div class="chat-bubble ai-bubble">
        <div class="micro-label" style="color: var(--c-bone-white); margin-bottom: 4px;">KAKEIBO.AI</div>
        <div class="ai-response-body"><span class="ai-thinking"><span></span><span></span><span></span></span></div>
        <div class="ai-response-meta"></div>
      </div>
    `;
    streamBox.appendChild(aiBubble);
    streamBox.scrollTop = streamBox.scrollHeight;

    const body = aiBubble.querySelector('.ai-response-body') as HTMLElement;
    const meta = aiBubble.querySelector('.ai-response-meta') as HTMLElement;

    this.isTyping = true;
    this.setChatBusy(true);

    let accumulated = '';
    let firstChunk = true;

    try {
      await aiChatStream(text, {
        ...(this.conversationId ? { conversationId: this.conversationId } : {}),
        approvedTokens,
        onText: (chunk) => {
          if (firstChunk) {
            body.textContent = '';
            firstChunk = false;
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
          this.handleAiOutcome(result, text, meta);
        },
        onError: (message) => {
          body.textContent = `Erro: ${message}`;
          body.classList.add('txt-pink');
        },
      });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
      body.textContent = message;
      body.classList.add('txt-pink');
      pc98Audio.playWarning();
    } finally {
      this.isTyping = false;
      this.setChatBusy(false);
      streamBox.scrollTop = streamBox.scrollHeight;
    }
  }

  /** Habilita/desabilita a entrada durante a resposta. */
  private setChatBusy(busy: boolean) {
    const input = document.getElementById('chat-input') as HTMLInputElement | null;
    const send = document.getElementById('btn-send-chat') as HTMLButtonElement | null;
    if (input) {
      input.disabled = busy;
      input.placeholder = busy ? 'Aguardando resposta...' : 'Pergunte ou lance um gasto...';
    }
    if (send) send.disabled = busy;
  }

  /**
   * Trata o que voltou do turno: confirmações pendentes, escritas e undo.
   */
  private handleAiOutcome(
    result: { pendingConfirmations: AiChatResult['pendingConfirmations']; changeSetIds: string[] },
    originalMessage: string,
    meta: HTMLElement,
  ) {
    // Escritas aconteceram: recarrega os dados e oferece desfazer.
    if (result.changeSetIds.length > 0) {
      const changeSetId = result.changeSetIds[result.changeSetIds.length - 1]!;
      void this.reloadAfterWrite(`${result.changeSetIds.length} alteração(ões) aplicada(s)`, changeSetId);

      meta.innerHTML = `<span class="micro-label txt-green">[GRAVADO]</span>`;
      pc98Audio.playSelect();
    }

    if (result.pendingConfirmations.length === 0) return;

    // Nada foi escrito nestas: pede aprovação e reenvia com o token.
    const pending = result.pendingConfirmations;
    const listHtml = pending
      .map(
        (p) =>
          `<div style="margin-bottom: 8px;">
             <div><strong>${escapeHtml(p.summary)}</strong></div>
             <div class="micro-label" style="color: var(--c-grey-blue);">${escapeHtml(p.reason)}</div>
           </div>`,
      )
      .join('');

    meta.innerHTML = `<span class="micro-label txt-amber">[AGUARDANDO CONFIRMAÇÃO]</span>`;

    this.triggerAiRiskConfirmation(listHtml, () => {
      void this.sendChatMessage(
        'Confirmado, pode executar.',
        pending.map((p) => p.token),
      );
    });

    void originalMessage;
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

    const leafCats = CATEGORIES.filter((c) => c.kind === 'expense' && c.parentId && !c.isArchived).slice(0, 12);
    if (!this.selectedAddCategoryId && leafCats[0]) {
      this.selectedAddCategoryId = leafCats[0].id;
    }

    for (const cat of leafCats) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pc98-btn text-xs ${cat.id === this.selectedAddCategoryId ? 'btn-primary' : ''}`;
      btn.style.padding = '8px 6px';
      btn.textContent = cat.name.toUpperCase();
      btn.addEventListener('click', () => {
        pc98Audio.playSelect();
        this.selectedAddCategoryId = cat.id;
        this.prepareAddForm();
      });
      grid.appendChild(btn);
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

  // ── IMPORTER SIMULATION ───────────────────────────────────────────────────

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
    statusText.textContent = `PARSANDO ARQUIVO ${filename.toUpperCase()}...`;
    ditherBar.style.setProperty('--progress', '0');
    statusPct.textContent = '0%';
    progressbar?.setAttribute('aria-valuenow', '0');

    let currentPct = 0;
    const interval = setInterval(() => {
      currentPct += Math.floor(Math.random() * 18) + 12;
      if (currentPct >= 100) {
        currentPct = 100;
        clearInterval(interval);
        pc98Audio.playSelect();
        statusText.textContent = `EXTRATO ${filename.toUpperCase()} PARSADO COM SUCESSO!`;
        if (parsedResults) parsedResults.classList.remove('hidden');
      } else {
        pc98Audio.playTypewriter();
      }
      ditherBar.style.setProperty('--progress', String(currentPct / 100));
      statusPct.textContent = `${currentPct}%`;
      progressbar?.setAttribute('aria-valuenow', String(currentPct));
    }, 150);
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
      else if (e.key === '9') this.switchTab('style-guide');
      else if (e.key.toLowerCase() === 'r') this.switchTab('recurrences');
      else if (e.key.toLowerCase() === 'm') this.switchTab('goals');
      else if (e.key.toLowerCase() === 'g') this.switchTab('rules');
      else if (e.key.toLowerCase() === 'f') this.switchTab('reports');
      else if (e.key === 'F1') {
        e.preventDefault();
        const helpModal = document.getElementById('modal-help-guide');
        helpModal?.classList.toggle('hidden');
      } else if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.add('hidden'));
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

    // AI DOCK (narrow layouts)
    const mobileAiBtn = document.getElementById('btn-mobile-ai');
    const closeAiDockBtn = document.getElementById('btn-close-ai-dock');
    mobileAiBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      const open = !document.body.classList.contains('ai-dock-open');
      this.setAiDockOpen(open);
      if (open) document.getElementById('chat-input-text')?.focus();
    });
    closeAiDockBtn?.addEventListener('click', () => {
      pc98Audio.playClick();
      this.setAiDockOpen(false);
    });

    // BATCH ACTION HANDLERS
    const btnSelectAll = document.getElementById('btn-batch-select-all');
    const btnBatchDelete = document.getElementById('btn-batch-delete');
    const btnBatchRecategorize = document.getElementById('btn-batch-recategorize');

    btnSelectAll?.addEventListener('click', () => {
      pc98Audio.playClick();
      const visibleTxs = this.transactions.filter(t => t.type !== 'transfer');
      if (this.selectedJournalTxIds.size === visibleTxs.length) {
        this.selectedJournalTxIds.clear();
      } else {
        visibleTxs.forEach(t => this.selectedJournalTxIds.add(t.id));
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
        this.transactions = this.transactions.filter(t => !this.selectedJournalTxIds.has(t.id));
        this.selectedJournalTxIds.clear();
        this.renderAll();
      }
    });

    btnBatchRecategorize?.addEventListener('click', async () => {
      if (this.selectedJournalTxIds.size === 0) return;
      pc98Audio.playSelect();
      const cats = CATEGORIES.filter(c => c.parentId !== null).map(c => c.name);
      const newCatName = await this.openSystemDialog({
        title: '✦ MUDAR CATEGORIA ✦',
        body: `Categorias disponíveis:<br/><span class="txt-cyan">${cats.join(', ')}</span><br/><br/>Digite o nome da categoria destino:`,
        confirmLabel: '[APLICAR]',
        cancelLabel: '[CANCELAR]',
        showInput: true,
        promptDefault: 'Supermercado',
        danger: false
      });
      if (typeof newCatName === 'string' && newCatName.trim()) {
        const matchedCat = CATEGORIES.find(c => c.name.toLowerCase() === newCatName.trim().toLowerCase());
        if (matchedCat) {
          this.transactions.forEach(t => {
            if (this.selectedJournalTxIds.has(t.id)) {
              t.categoryId = matchedCat.id;
            }
          });
          this.selectedJournalTxIds.clear();
          this.renderAll();
        } else {
          await this.openSystemDialog({
            title: '✦ CATEGORIA NÃO ENCONTRADA ✦',
            body: `Nenhuma categoria corresponde a "<strong>${newCatName}</strong>".`,
            confirmLabel: '[OK]',
            cancelLabel: '',
            danger: false
          });
        }
      }
    });

    // SAC vs PRICE HELP MODAL
    const openSacPriceBtn = document.getElementById('btn-open-sac-price-help');
    const closeSacPriceBtn = document.getElementById('btn-close-sac-price');
    const confirmSacPriceBtn = document.getElementById('btn-close-sac-price-confirm');
    const sacPriceModal = document.getElementById('modal-sac-price-help');

    openSacPriceBtn?.addEventListener('click', () => { pc98Audio.playClick(); sacPriceModal?.classList.remove('hidden'); });
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
      await this.openSystemDialog({
        title: '✦ IMPORTAÇÃO CONCLUÍDA ✦',
        body: '14 novas transações foram incorporadas ao Journal com sucesso.',
        confirmLabel: '[ABRIR JOURNAL]',
        cancelLabel: '',
        danger: false
      });
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
      profileModal?.classList.remove('hidden');
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

    helpBtn?.addEventListener('click', () => { pc98Audio.playClick(); helpModal?.classList.remove('hidden'); });
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
      if (!this.commitNaturalLanguageEntry(query)) {
        this.sendChatMessage(query);
      }
      textInput.value = '';
    });

    // Credit Card Pay Invoice
    const payInvoiceBtn = document.getElementById('btn-pay-invoice');
    payInvoiceBtn?.addEventListener('click', async () => {
      pc98Audio.playSelect();
      await this.openSystemDialog({
        title: '✦ FATURA PAGA ✦',
        body: 'Fatura Nubank paga com sucesso.<br/><span class="micro-label txt-cyan">mutate() → changeSet criado para auditoria</span>',
        confirmLabel: '[OK]',
        cancelLabel: '',
        danger: false
      });
    });

    // Early Payment Simulation
    const simEarlyPayBtn = document.getElementById('btn-simulate-early-pay');
    simEarlyPayBtn?.addEventListener('click', async () => {
      pc98Audio.playSelect();
      const d = DEBTS[0];
      const ratePercent = (d.annualRateBps / 100).toFixed(2);
      await this.openSystemDialog({
        title: `✦ SIMULAÇÃO ${d.system.toUpperCase()} ✦`,
        body: `Ao aportar <strong class="txt-amber">R$ 10.000,00</strong> extras, você economizará aproximadamente <strong class="txt-green">R$ 8.400,00</strong> em juros futuros e reduzirá o prazo em <strong>7 parcelas</strong>.<br/><br/><span class="micro-label">Taxa: ${ratePercent}% a.a. · Parcelas restantes: ${d.remainingCount}</span>`,
        confirmLabel: '[ENTENDI]',
        cancelLabel: '',
        danger: false
      });
    });
  }
}

