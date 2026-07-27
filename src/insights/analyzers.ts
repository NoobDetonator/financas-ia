/**
 * Analisadores de insight.
 *
 * Funções **determinísticas**: recebem o banco, devolvem achados tipados com os
 * números e os IDs das transações que os sustentam. Nenhum LLM participa daqui.
 *
 * Essa separação é a regra nº 3 da arquitetura levada ao limite: o LLM recebe
 * estes objetos prontos e apenas escreve o texto (ver `narrator.ts`). Ganhos:
 *
 *  • os números estão certos por construção, e são conferíveis;
 *  • o mesmo insight sai igual toda vez, então dá para comparar semana a semana;
 *  • o custo de token é uma fração do que seria despejar transações no prompt;
 *  • os insights funcionam mesmo sem chave de API configurada.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { insights, type InsightSeverity } from '../db/schema.js';
import { formatMoney } from '../core/money.js';
import { addMonthKey, currentMonth, diffDays, formatDateBr, formatMonthBr, today } from '../core/clock.js';
import { budgetSummary } from '../services/budgets.js';
import { categoryTrends, findDuplicates, monthlyFlow, monthOverview } from '../services/reports.js';
import { openInvoices } from '../services/invoices.js';
import { pendingOccurrences, upcomingBills } from '../services/recurrences.js';
import { futureCommitments, projectBalance } from '../services/projection.js';
import { goalsBehindSchedule } from '../services/goals.js';
import { listDebts } from '../services/debts.js';
import { previewApplyRules, suggestRules } from '../services/rules.js';
import { listTransactions } from '../services/transactions.js';

export interface Finding {
  kind: string;
  severity: InsightSeverity;
  title: string;
  /** Números e IDs que sustentam o achado. Vai inteiro para o narrador. */
  data: Record<string, unknown>;
  /** Identidade lógica, para não reemitir o mesmo achado. */
  fingerprint: string;
  period?: string;
}

function fingerprint(kind: string, parts: readonly (string | number)[]): string {
  return createHash('sha256').update([kind, ...parts].join('|')).digest('hex').slice(0, 24);
}

// ── Analisadores ────────────────────────────────────────────────────────────

/** Orçamentos estourados e no caminho de estourar. */
function budgetFindings(db: Db): Finding[] {
  const month = currentMonth();
  const summary = budgetSummary(month, db);
  const found: Finding[] = [];

  for (const item of summary.exceeded) {
    found.push({
      kind: 'budget_exceeded',
      severity: 'warn',
      title: `Orçamento de ${item.categoryName} estourou`,
      period: month,
      data: {
        category: item.categoryName,
        spentCents: item.spentCents,
        spentFormatted: formatMoney(item.spentCents),
        limitCents: item.limitCents,
        limitFormatted: formatMoney(item.limitCents),
        overByCents: -item.remainingCents,
        overByFormatted: formatMoney(-item.remainingCents),
        usedPercent: item.usedPercent,
      },
      fingerprint: fingerprint('budget_exceeded', [item.budgetId, month]),
    });
  }

  for (const item of summary.atRisk) {
    found.push({
      kind: 'budget_at_risk',
      severity: 'info',
      title: `${item.categoryName} deve estourar antes do fim do mês`,
      period: month,
      data: {
        category: item.categoryName,
        spentCents: item.spentCents,
        spentFormatted: formatMoney(item.spentCents),
        limitCents: item.limitCents,
        limitFormatted: formatMoney(item.limitCents),
        projectedCents: item.projectedSpentCents,
        projectedFormatted: formatMoney(item.projectedSpentCents),
        usedPercent: item.usedPercent,
      },
      fingerprint: fingerprint('budget_at_risk', [item.budgetId, month]),
    });
  }

  return found;
}

/**
 * Gasto fora do padrão, comparado à **mediana** dos meses anteriores.
 *
 * Mediana e não média: um único mês atípico puxa a média e o próprio pico passaria
 * a ser considerado normal.
 */
function spendSpikeFindings(db: Db): Finding[] {
  const month = currentMonth();
  const found: Finding[] = [];

  for (const trend of categoryTrends({ months: 4, db })) {
    // Exige histórico e um desvio relevante em valor absoluto, para não alertar
    // sobre "café subiu 80%" quando são R$ 12.
    if (trend.medianCents < 5_000) continue;
    if (trend.deviationPercent === null || trend.deviationPercent < 40) continue;
    if (trend.currentCents - trend.medianCents < 10_000) continue;

    found.push({
      kind: 'spend_spike',
      severity: trend.deviationPercent > 100 ? 'warn' : 'info',
      title: `${trend.categoryName} está ${Math.round(trend.deviationPercent)}% acima do normal`,
      period: month,
      data: {
        category: trend.categoryName,
        currentCents: trend.currentCents,
        currentFormatted: formatMoney(trend.currentCents),
        medianCents: trend.medianCents,
        medianFormatted: formatMoney(trend.medianCents),
        differenceCents: trend.currentCents - trend.medianCents,
        differenceFormatted: formatMoney(trend.currentCents - trend.medianCents),
        deviationPercent: trend.deviationPercent,
        history: trend.series.map((s) => ({ month: s.month, formatted: formatMoney(s.amountCents) })),
      },
      fingerprint: fingerprint('spend_spike', [trend.categoryId, month]),
    });
  }

  return found;
}

/** Fatura vencida ou vencendo. */
function invoiceFindings(db: Db): Finding[] {
  const reference = today();
  const found: Finding[] = [];

  for (const invoice of openInvoices(db)) {
    const daysUntilDue = diffDays(reference, invoice.dueDate);

    if (daysUntilDue < 0) {
      found.push({
        kind: 'invoice_overdue',
        severity: 'critical',
        title: `Fatura de ${invoice.referenceMonth} vencida há ${-daysUntilDue} dias`,
        data: {
          referenceMonth: invoice.referenceMonth,
          remainingCents: invoice.remainingCents,
          remainingFormatted: formatMoney(invoice.remainingCents),
          dueDate: invoice.dueDate,
          dueDateFormatted: formatDateBr(invoice.dueDate),
          daysOverdue: -daysUntilDue,
          invoiceId: invoice.id,
          // O sistema não calcula juros de rotativo. O narrador é instruído a não
          // inventar esse número.
          interestNotTracked: true,
        },
        fingerprint: fingerprint('invoice_overdue', [invoice.id]),
      });
    } else if (daysUntilDue <= 5) {
      found.push({
        kind: 'invoice_due_soon',
        severity: 'warn',
        title: `Fatura de ${invoice.referenceMonth} vence em ${daysUntilDue} dia(s)`,
        data: {
          referenceMonth: invoice.referenceMonth,
          remainingCents: invoice.remainingCents,
          remainingFormatted: formatMoney(invoice.remainingCents),
          dueDate: invoice.dueDate,
          dueDateFormatted: formatDateBr(invoice.dueDate),
          daysUntilDue,
          invoiceId: invoice.id,
        },
        fingerprint: fingerprint('invoice_due_soon', [invoice.id]),
      });
    }
  }

  return found;
}

/** Saldo projetado ficando negativo — o alerta mais útil do sistema. */
function cashCrunchFindings(db: Db): Finding[] {
  const projection = projectBalance({ days: 60, db });
  if (!projection.firstNegativeDate) return [];

  const daysAhead = diffDays(today(), projection.firstNegativeDate);

  return [
    {
      kind: 'cash_crunch',
      severity: daysAhead <= 14 ? 'critical' : 'warn',
      title: `O saldo projetado fica negativo em ${daysAhead} dias`,
      data: {
        date: projection.firstNegativeDate,
        dateFormatted: formatDateBr(projection.firstNegativeDate),
        daysAhead,
        todayCents: projection.startingCents,
        todayFormatted: formatMoney(projection.startingCents),
        lowestCents: projection.lowestCents,
        lowestFormatted: formatMoney(projection.lowestCents),
        lowestDate: projection.lowestDate,
        // O que causa o aperto, para o narrador poder explicar.
        upcomingItems: projection.points
          .filter((p) => p.date <= projection.firstNegativeDate!)
          .flatMap((p) =>
            p.items.map((item) => ({
              date: p.date,
              description: item.description,
              formatted: formatMoney(item.amountCents),
            })),
          )
          .slice(0, 10),
      },
      fingerprint: fingerprint('cash_crunch', [projection.firstNegativeDate]),
    },
  ];
}

/** Renda futura muito comprometida. */
function commitmentFindings(db: Db): Finding[] {
  const commitments = futureCommitments({ days: 30, db });
  if (commitments.committedPercent === null || commitments.committedPercent < 70) return [];

  return [
    {
      kind: 'income_overcommitted',
      severity: commitments.committedPercent > 100 ? 'critical' : 'warn',
      title: `${Math.round(commitments.committedPercent)}% da renda prevista já está comprometida`,
      period: currentMonth(),
      data: {
        committedPercent: commitments.committedPercent,
        committedCents: commitments.committedCents,
        committedFormatted: formatMoney(commitments.committedCents),
        expectedIncomeCents: commitments.expectedIncomeCents,
        expectedIncomeFormatted: formatMoney(commitments.expectedIncomeCents),
        breakdown: {
          installments: formatMoney(commitments.installmentsCents),
          recurring: formatMoney(commitments.recurringCents),
          cardInvoices: formatMoney(commitments.cardInvoicesCents),
        },
      },
      fingerprint: fingerprint('income_overcommitted', [currentMonth()]),
    },
  ];
}

/** Cobranças possivelmente duplicadas. */
function duplicateFindings(db: Db): Finding[] {
  return findDuplicates({ withinDays: 3, db })
    .slice(0, 5)
    .map((duplicate) => ({
      kind: 'possible_duplicate',
      severity: 'info' as const,
      title: `Cobrança repetida: ${duplicate.description}`,
      data: {
        description: duplicate.description,
        amountCents: duplicate.amountCents,
        amountFormatted: formatMoney(duplicate.amountCents),
        dates: duplicate.dates.map(formatDateBr),
        transactionIds: duplicate.ids,
      },
      fingerprint: fingerprint('possible_duplicate', duplicate.ids),
    }));
}

/** Ocorrências esperando confirmação há tempo. */
function pendingFindings(db: Db): Finding[] {
  const pending = pendingOccurrences(db);
  const stale = pending.filter((item) => diffDays(item.date, today()) > 5);
  if (stale.length === 0) return [];

  return [
    {
      kind: 'stale_pending',
      severity: 'info',
      title: `${stale.length} conta(s) aguardando sua confirmação há mais de 5 dias`,
      data: {
        count: stale.length,
        items: stale.map((item) => ({
          name: item.recurrenceName,
          date: formatDateBr(item.date),
          estimatedFormatted: formatMoney(Math.abs(item.amountCents)),
          daysWaiting: diffDays(item.date, today()),
          transactionId: item.id,
        })),
      },
      fingerprint: fingerprint('stale_pending', [today(), String(stale.length)]),
    },
  ];
}

/** Tendência da taxa de poupança. */
function savingsRateFindings(db: Db): Finding[] {
  const month = currentMonth();
  const flow = monthlyFlow(addMonthKey(month, -3), month, { db });
  const withIncome = flow.filter((f) => f.savingsRatePercent !== null);
  if (withIncome.length < 3) return [];

  const current = withIncome.at(-1)!;
  const previous = withIncome.slice(0, -1);
  const averagePrevious =
    previous.reduce((sum, f) => sum + (f.savingsRatePercent ?? 0), 0) / previous.length;

  const drop = averagePrevious - (current.savingsRatePercent ?? 0);
  if (drop < 15) return [];

  return [
    {
      kind: 'savings_rate_drop',
      severity: 'warn',
      title: `Sua taxa de poupança caiu para ${current.savingsRatePercent}%`,
      period: month,
      data: {
        currentPercent: current.savingsRatePercent,
        previousAveragePercent: Math.round(averagePrevious * 10) / 10,
        dropPercentPoints: Math.round(drop * 10) / 10,
        history: withIncome.map((f) => ({
          month: f.month,
          savingsRatePercent: f.savingsRatePercent,
          incomeFormatted: formatMoney(f.incomeCents),
          expenseFormatted: formatMoney(f.expenseCents),
        })),
      },
      fingerprint: fingerprint('savings_rate_drop', [month]),
    },
  ];
}

/** Dívidas com parcela vencida. */
function debtFindings(db: Db): Finding[] {
  return listDebts({ db })
    .filter((debt) => debt.overdueCount > 0)
    .map((debt) => ({
      kind: 'debt_overdue',
      severity: 'critical' as const,
      title: `${debt.name} tem ${debt.overdueCount} parcela(s) vencida(s)`,
      data: {
        debtName: debt.name,
        debtId: debt.id,
        overdueCount: debt.overdueCount,
        outstandingCents: debt.outstandingCents,
        outstandingFormatted: formatMoney(debt.outstandingCents),
        nextDueDate: debt.nextPayment?.dueDate ?? null,
      },
      fingerprint: fingerprint('debt_overdue', [debt.id, String(debt.overdueCount)]),
    }));
}

/** Metas atrasadas em relação ao ritmo necessário. */
function goalFindings(db: Db): Finding[] {
  return goalsBehindSchedule(db)
    .slice(0, 3)
    .map((goal) => ({
      kind: 'goal_behind',
      severity: 'info' as const,
      title: `A meta "${goal.name}" está atrasada`,
      data: {
        goalName: goal.name,
        goalId: goal.id,
        savedFormatted: formatMoney(goal.savedCents),
        targetFormatted: formatMoney(goal.targetCents),
        progressPercent: goal.progressPercent,
        targetDate: goal.targetDate ? formatDateBr(goal.targetDate) : null,
        requiredMonthlyFormatted:
          goal.requiredMonthlyCents !== null ? formatMoney(goal.requiredMonthlyCents) : null,
        projectedCompletionDate: goal.projectedCompletionDate
          ? formatDateBr(goal.projectedCompletionDate)
          : null,
      },
      fingerprint: fingerprint('goal_behind', [goal.id, currentMonth()]),
    }));
}

/** Lançamentos sem categoria e regras que resolveriam isso. */
function categorizationFindings(db: Db): Finding[] {
  const uncategorized = listTransactions(
    { limit: 1, excludeTransfers: true, rollupCategories: false },
    db,
  );
  const applicable = previewApplyRules({ db }).length;
  const suggestions = suggestRules({ db });

  const found: Finding[] = [];

  if (applicable >= 3) {
    found.push({
      kind: 'rules_applicable',
      severity: 'info',
      title: `${applicable} lançamento(s) podem ser categorizados automaticamente`,
      data: { count: applicable },
      fingerprint: fingerprint('rules_applicable', [today(), String(applicable)]),
    });
  }

  if (suggestions.length >= 2) {
    found.push({
      kind: 'rule_suggestions',
      severity: 'info',
      title: `${suggestions.length} padrão(ões) de gasto poderiam virar regra`,
      data: {
        count: suggestions.length,
        suggestions: suggestions.slice(0, 5).map((s) => ({
          pattern: s.descriptionPattern,
          category: s.categoryName,
          occurrences: s.occurrences,
          confidencePercent: s.confidencePercent,
        })),
      },
      fingerprint: fingerprint('rule_suggestions', [today(), String(suggestions.length)]),
    });
  }

  void uncategorized;
  return found;
}

/** Contas fixas grandes a vencer nos próximos dias. */
function upcomingBillFindings(db: Db): Finding[] {
  const bills = upcomingBills({ withinDays: 7, db });
  if (bills.length === 0) return [];

  const totalCents = bills.reduce((sum, bill) => sum + Math.abs(bill.transaction.amountCents), 0);
  if (totalCents < 20_000) return [];

  return [
    {
      kind: 'bills_due_week',
      severity: 'info',
      title: `${bills.length} conta(s) vencem nos próximos 7 dias`,
      data: {
        count: bills.length,
        totalCents,
        totalFormatted: formatMoney(totalCents),
        bills: bills.map((bill) => ({
          name: bill.recurrenceName,
          formatted: formatMoney(Math.abs(bill.transaction.amountCents)),
          date: formatDateBr(bill.transaction.date),
          daysUntil: bill.daysUntil,
        })),
      },
      fingerprint: fingerprint('bills_due_week', [today()]),
    },
  ];
}

// ── Orquestração ────────────────────────────────────────────────────────────

const ANALYZERS: Array<{ name: string; run: (db: Db) => Finding[] }> = [
  { name: 'invoices', run: invoiceFindings },
  { name: 'debts', run: debtFindings },
  { name: 'cash_crunch', run: cashCrunchFindings },
  { name: 'budgets', run: budgetFindings },
  { name: 'commitments', run: commitmentFindings },
  { name: 'spend_spikes', run: spendSpikeFindings },
  { name: 'savings_rate', run: savingsRateFindings },
  { name: 'duplicates', run: duplicateFindings },
  { name: 'pending', run: pendingFindings },
  { name: 'goals', run: goalFindings },
  { name: 'bills', run: upcomingBillFindings },
  { name: 'categorization', run: categorizationFindings },
];

const SEVERITY_ORDER: Record<InsightSeverity, number> = { critical: 0, warn: 1, info: 2 };

/**
 * Roda todos os analisadores.
 *
 * Um analisador que falha não derruba os outros: um erro em "tendência de
 * poupança" não pode impedir o alerta de fatura vencida de aparecer.
 */
export function analyze(db: Db = getDb()): { findings: Finding[]; errors: Array<{ analyzer: string; message: string }> } {
  const findings: Finding[] = [];
  const errors: Array<{ analyzer: string; message: string }> = [];

  for (const analyzer of ANALYZERS) {
    try {
      findings.push(...analyzer.run(db));
    } catch (error) {
      errors.push({
        analyzer: analyzer.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { findings, errors };
}

/**
 * Grava os achados, ignorando os que já existem.
 *
 * O `fingerprint` com índice único é o que impede o mesmo alerta de aparecer
 * repetido a cada execução do job.
 */
export function persistFindings(findings: readonly Finding[], db: Db = getDb()): { created: number; existing: number } {
  let created = 0;
  let existing = 0;

  for (const finding of findings) {
    const already = db.select().from(insights).where(eq(insights.fingerprint, finding.fingerprint)).all()[0];
    if (already) {
      existing += 1;
      continue;
    }

    db.insert(insights)
      .values({
        kind: finding.kind,
        severity: finding.severity,
        title: finding.title,
        period: finding.period ?? null,
        data: finding.data,
        fingerprint: finding.fingerprint,
        status: 'new',
      })
      .run();
    created += 1;
  }

  return { created, existing };
}

/** Insights gravados, do mais grave para o menos. */
export function listInsights(
  options: { status?: 'new' | 'seen' | 'dismissed'; limit?: number; db?: Db } = {},
) {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(insights)
    .where(options.status ? eq(insights.status, options.status) : undefined)
    .limit(options.limit ?? 50)
    .all()
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function markInsight(id: string, status: 'seen' | 'dismissed', db: Db = getDb()): void {
  db.update(insights).set({ status }).where(eq(insights.id, id)).run();
}

/** Resumo textual dos achados, sem LLM — funciona sem chave de API. */
export function summarizeFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'Nenhum ponto de atenção encontrado.';

  const lines: string[] = [];
  const icons: Record<InsightSeverity, string> = { critical: '🔴', warn: '🟡', info: 'ℹ️' };

  for (const finding of findings) {
    lines.push(`${icons[finding.severity]} ${finding.title}`);
  }

  return lines.join('\n');
}

export { monthOverview, formatMonthBr };
