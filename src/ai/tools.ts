/**
 * Ferramentas expostas ao modelo.
 *
 * Cada ferramenta é uma casca fina sobre um serviço — os **mesmos** serviços que a
 * API HTTP usa. É a regra nº 1 da arquitetura em ação: não existe caminho pelo qual
 * a IA faça algo que a interface não faria, nem com regra de negócio diferente.
 *
 * As ferramentas de leitura devolvem `...Cents` **e** o texto formatado. Isso não é
 * redundância: o número serve para a ferramenta seguinte, e o texto evita que o
 * modelo tente formatar (e erre) valores monetários.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { formatMoney, parseMoney } from '../core/money.js';
import { currentMonth, formatDateBr, monthRange, today } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { resolveAccount } from '../services/accounts.js';
import { resolveCategory } from '../services/categories.js';
import {
  bulkCategorize,
  createTransaction,
  deleteTransaction,
  getTransactionDetail,
  listTransactions,
  updateTransaction,
} from '../services/transactions.js';
import { createTransfer } from '../services/transfers.js';
import { accountBalance, allBalances, cashFlow, netWorth } from '../services/balances.js';
import { createInstallmentPlan, payInvoice, upcomingInvoices } from '../services/cards.js';
import { openInvoices } from '../services/invoices.js';
import { confirmOccurrence, pendingOccurrences, upcomingBills } from '../services/recurrences.js';
import { futureCommitments, projectBalance } from '../services/projection.js';
import { budgetSummary, categorySpending, createBudget, suggestBudgets } from '../services/budgets.js';
import { contribute, createGoal, listGoals } from '../services/goals.js';
import { listDebts, simulateExtra, simulatePayoff } from '../services/debts.js';
import { portfolioSummary } from '../services/investments.js';
import {
  categoryTrends,
  compareMonths,
  findDuplicates,
  monthOverview,
  spendByCategory,
  topPayees,
} from '../services/reports.js';
import { applyRules, previewApplyRules, suggestRules } from '../services/rules.js';
import { resolveDatePhrase } from './date-phrases.js';
import { assessRisk, loadThresholds, type RiskAssessment } from './risk.js';

export interface ToolContext {
  db?: Db;
  conversationId?: string;
  /**
   * Confirmações já dadas pelo usuário nesta conversa, por nome de ferramenta +
   * hash dos argumentos. Uma operação confirmada executa direto na próxima chamada.
   */
  approved?: Set<string>;
  /** Registra o que a IA fez, para auditoria da conversa. */
  onAction?: (action: {
    tool: string;
    args: Record<string, unknown>;
    risk: RiskAssessment;
    status: 'executed' | 'pending';
    changeSetId?: string;
  }) => void;
}

/** Resposta padrão de uma escrita bloqueada por precisar de confirmação. */
export interface PendingConfirmation {
  needsConfirmation: true;
  reason: string;
  /** Passe de volta em `confirmationToken` para executar. */
  confirmationToken: string;
  summary: string;
}

function approvalKey(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(args, Object.keys(args).sort())}`;
}

/** Anota valores monetários com o texto formatado, para o modelo não formatar. */
function money(cents: number): { cents: number; formatted: string } {
  return { cents, formatted: formatMoney(cents) };
}

/**
 * Envolve uma escrita com a classificação de risco.
 *
 * Devolve `PendingConfirmation` em vez de executar quando a operação passa dos
 * limites — e o modelo é instruído a repassar isso ao usuário.
 */
function guarded<T>(
  context: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  summarize: () => string,
  execute: () => { data: T; changeSetId: string },
): (T & { changeSetId: string }) | PendingConfirmation {
  const thresholds = loadThresholds(context.db);
  const risk = assessRisk(toolName, args, thresholds);
  const key = approvalKey(toolName, args);
  const preApproved = context.approved?.has(key) ?? false;

  if (risk.level === 'confirm' && !preApproved) {
    context.onAction?.({ tool: toolName, args, risk, status: 'pending' });
    return {
      needsConfirmation: true,
      reason: risk.reason ?? 'Esta operação precisa da sua confirmação.',
      confirmationToken: key,
      summary: summarize(),
    };
  }

  const result = execute();
  context.onAction?.({
    tool: toolName,
    args,
    risk,
    status: 'executed',
    changeSetId: result.changeSetId,
  });

  return { ...result.data, changeSetId: result.changeSetId } as T & { changeSetId: string };
}

const writeOptions = (context: ToolContext, toolName: string) => ({
  source: 'ai' as const,
  actor: 'ai' as const,
  tool: toolName,
  ...(context.conversationId ? { conversationId: context.conversationId } : {}),
  ...(context.db ? { db: context.db } : {}),
});

// Schemas reutilizados nas ferramentas.
const amountText = z
  .string()
  .describe('Valor como o usuário falou: "45", "45,90", "R$ 1.234,56". Será convertido para centavos.');
const accountRef = z.string().describe('Nome, apelido ou ID da conta. Ex.: "nubank", "conta corrente"');
const categoryRef = z
  .string()
  .describe('Nome ou ID da categoria. Aceita caminho: "Alimentação > Mercado"');
const dateRef = z
  .string()
  .describe('Data AAAA-MM-DD, ou expressão: "ontem", "sexta passada", "dia 5"');

/** Resolve a referência de data, aceitando ISO ou expressão em português. */
function resolveDate(reference: string | undefined, context: ToolContext): string {
  if (!reference) return today();
  const resolved = resolveDatePhrase(reference);
  if (!resolved) {
    throw new AppError(
      'VALIDATION',
      `Não entendi a data "${reference}". Use AAAA-MM-DD ou uma expressão como "ontem" ou "dia 5".`,
    );
  }
  void context;
  return resolved.date;
}

export function buildTools(context: ToolContext = {}): Record<string, Tool> {
  const db = context.db;

  return {
    // ══ Utilitários ═══════════════════════════════════════════════════════════

    resolve_date: tool({
      description:
        'Converte uma expressão de data em português ("ontem", "sexta passada", "dia 5", "15/03") ' +
        'na data ISO correspondente. Use SEMPRE isto em vez de calcular a data você mesmo.',
      inputSchema: z.object({ phrase: z.string().describe('A expressão de data como o usuário falou') }),
      execute: ({ phrase }) => {
        const resolved = resolveDatePhrase(phrase);
        if (!resolved) {
          return { recognized: false, hint: 'Peça ao usuário a data no formato dia/mês.' };
        }
        return {
          recognized: true,
          date: resolved.date,
          formatted: formatDateBr(resolved.date),
          interpretation: resolved.interpretation,
        };
      },
    }),

    // ══ Leitura ═══════════════════════════════════════════════════════════════

    get_balances: tool({
      description: 'Saldo de todas as contas: disponível (efetivado) e projetado (com previsões).',
      inputSchema: z.object({}),
      execute: () => ({
        accounts: allBalances({ db }).map((balance) => ({
          id: balance.accountId,
          name: balance.name,
          kind: balance.kind,
          available: money(balance.availableCents),
          projected: money(balance.projectedCents),
          ...(balance.cardUsage
            ? {
                cardUsage: {
                  usedPercent: balance.cardUsage.usedPercent,
                  used: money(balance.cardUsage.usedCents),
                  limit: money(balance.cardUsage.limitCents),
                },
              }
            : {}),
        })),
      }),
    }),

    get_account_balance: tool({
      description: 'Saldo de uma conta específica, por nome ou apelido.',
      inputSchema: z.object({ account: accountRef }),
      execute: ({ account }) => {
        const resolved = resolveAccount(account, db);
        const balance = accountBalance(resolved.id, { db });
        return {
          id: balance.accountId,
          name: balance.name,
          available: money(balance.availableCents),
          projected: money(balance.projectedCents),
        };
      },
    }),

    get_month_overview: tool({
      description:
        'Panorama de um mês: receita, despesa, taxa de poupança, maiores categorias, maiores gastos ' +
        'e comparação com o mês anterior. Use isto antes de dar qualquer opinião sobre o mês.',
      inputSchema: z.object({
        month: z.string().optional().describe('Mês AAAA-MM. Padrão: mês corrente'),
      }),
      execute: ({ month }) => {
        const overview = monthOverview(month ?? currentMonth(), { db });
        return {
          month: overview.month,
          income: money(overview.incomeCents),
          expense: money(overview.expenseCents),
          net: money(overview.netCents),
          savingsRatePercent: overview.savingsRatePercent,
          transactionCount: overview.transactionCount,
          topCategories: overview.topCategories.map((c) => ({
            name: c.categoryName,
            amount: money(c.amountCents),
            percentOfTotal: c.percentOfTotal,
          })),
          topPayees: overview.topPayees.map((p) => ({
            name: p.payeeName,
            amount: money(p.amountCents),
            count: p.transactionCount,
          })),
          largestExpenses: overview.largestExpenses.map((t) => ({
            id: t.id,
            description: t.description,
            amount: money(t.amountCents),
            date: t.date,
          })),
          vsPreviousMonth: {
            change: money(overview.comparedToPreviousMonth.expenseChangeCents),
            changePercent: overview.comparedToPreviousMonth.expenseChangePercent,
          },
        };
      },
    }),

    search_transactions: tool({
      description:
        'Busca lançamentos com filtros. `sumCents` é a soma de TODAS as linhas do filtro, ' +
        'não apenas das que voltam na lista — use esse campo para totais.',
      inputSchema: z.object({
        search: z.string().optional().describe('Texto na descrição'),
        account: accountRef.optional(),
        category: categoryRef.optional(),
        dateFrom: z.string().optional().describe('AAAA-MM-DD'),
        dateTo: z.string().optional().describe('AAAA-MM-DD'),
        type: z.enum(['expense', 'income']).optional(),
        minAmountCents: z.number().int().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: (args) => {
        const accountId = args.account ? resolveAccount(args.account, db).id : undefined;
        const categoryId = args.category ? resolveCategory(args.category, db).id : undefined;

        const page = listTransactions(
          {
            ...(args.search ? { search: args.search } : {}),
            ...(accountId ? { accountId } : {}),
            ...(categoryId ? { categoryId } : {}),
            ...(args.dateFrom ? { dateFrom: args.dateFrom } : {}),
            ...(args.dateTo ? { dateTo: args.dateTo } : {}),
            ...(args.type ? { type: args.type } : {}),
            ...(args.minAmountCents !== undefined ? { minAmountCents: args.minAmountCents } : {}),
            excludeTransfers: true,
            limit: args.limit,
          },
          db,
        );

        return {
          total: page.total,
          sum: money(page.sumCents),
          showing: page.items.length,
          transactions: page.items.map((t) => ({
            id: t.id,
            date: t.date,
            description: t.description,
            amount: money(t.amountCents),
            type: t.type,
            status: t.status,
            categoryId: t.categoryId,
          })),
        };
      },
    }),

    get_spending_by_category: tool({
      description: 'Gasto por categoria num período. Rateios contam com a parte proporcional.',
      inputSchema: z.object({
        from: z.string().describe('AAAA-MM-DD'),
        to: z.string().describe('AAAA-MM-DD'),
        rollup: z.boolean().default(true).describe('Agrupar nas categorias mãe'),
      }),
      execute: ({ from, to }) => {
        const report = spendByCategory(from, to, { db });
        return {
          total: money(report.totalCents),
          categories: report.items.map((item) => ({
            name: item.categoryName,
            parent: item.parentName,
            amount: money(item.amountCents),
            percentOfTotal: item.percentOfTotal,
            count: item.transactionCount,
          })),
        };
      },
    }),

    get_category_trends: tool({
      description:
        'Histórico por categoria com **mediana** dos meses anteriores e o desvio do mês atual. ' +
        'É a ferramenta para detectar gasto fora do padrão — a mediana não é distorcida por um mês atípico.',
      inputSchema: z.object({
        months: z.number().int().min(2).max(12).default(4),
        referenceMonth: z.string().optional().describe('AAAA-MM'),
      }),
      execute: (args) => ({
        trends: categoryTrends({ ...args, db })
          .slice(0, 15)
          .map((trend) => ({
            category: trend.categoryName,
            current: money(trend.currentCents),
            median: money(trend.medianCents),
            deviationPercent: trend.deviationPercent,
            series: trend.series.map((s) => ({ month: s.month, amount: money(s.amountCents) })),
          })),
      }),
    }),

    compare_months: tool({
      description: 'Compara dois meses e mostra em quais categorias a diferença aconteceu.',
      inputSchema: z.object({
        month: z.string().describe('AAAA-MM'),
        against: z.string().optional().describe('AAAA-MM. Padrão: mês anterior'),
      }),
      execute: ({ month, against }) => {
        const comparison = compareMonths(month, against, { db });
        return {
          currentExpense: money(comparison.current.expenseCents),
          previousExpense: money(comparison.previous.expenseCents),
          expenseChange: money(comparison.expenseChangeCents),
          expenseChangePercent: comparison.expenseChangePercent,
          incomeChange: money(comparison.incomeChangeCents),
          biggestChanges: comparison.byCategory.slice(0, 8).map((item) => ({
            category: item.categoryName,
            current: money(item.currentCents),
            previous: money(item.previousCents),
            change: money(item.changeCents),
            changePercent: item.changePercent,
          })),
        };
      },
    }),

    get_budget_status: tool({
      description: 'Situação dos orçamentos: quanto foi gasto, quanto sobra, quais estouraram.',
      inputSchema: z.object({ month: z.string().optional().describe('AAAA-MM') }),
      execute: ({ month }) => {
        const summary = budgetSummary(month ?? currentMonth(), db);
        return {
          month: summary.month,
          totalLimit: money(summary.totalLimitCents),
          totalSpent: money(summary.totalSpentCents),
          budgets: summary.items.map((item) => ({
            category: item.categoryName,
            spent: money(item.spentCents),
            limit: money(item.limitCents),
            remaining: money(item.remainingCents),
            usedPercent: item.usedPercent,
            exceeded: item.remainingCents < 0,
            willExceed: item.willExceed,
          })),
        };
      },
    }),

    get_upcoming: tool({
      description:
        'O que está por pagar: faturas de cartão em aberto, contas fixas a vencer e ocorrências ' +
        'aguardando confirmação.',
      inputSchema: z.object({ withinDays: z.number().int().min(1).max(120).default(30) }),
      execute: ({ withinDays }) => ({
        cardInvoices: upcomingInvoices({ withinDays, db }).map((item) => ({
          invoiceId: item.invoice.id,
          card: item.cardName,
          referenceMonth: item.invoice.referenceMonth,
          remaining: money(item.remainingCents),
          dueDate: item.invoice.dueDate,
          daysUntilDue: item.daysUntilDue,
        })),
        bills: upcomingBills({ withinDays, db }).map((item) => ({
          name: item.recurrenceName,
          amount: money(Math.abs(item.transaction.amountCents)),
          date: item.transaction.date,
          daysUntil: item.daysUntil,
        })),
        pendingConfirmation: pendingOccurrences(db).map((item) => ({
          transactionId: item.id,
          name: item.recurrenceName,
          estimated: money(Math.abs(item.amountCents)),
          date: item.date,
        })),
      }),
    }),

    get_projection: tool({
      description:
        'Projeção do saldo futuro e quanto da renda já está comprometido. Use para responder ' +
        '"posso gastar isso?" — o saldo de hoje não responde essa pergunta.',
      inputSchema: z.object({ days: z.number().int().min(7).max(365).default(60) }),
      execute: ({ days }) => {
        const projection = projectBalance({ days, db });
        const commitments = futureCommitments({ days: Math.min(days, 90), db });
        return {
          today: money(projection.startingCents),
          projectedEnd: money(projection.endingCents),
          lowest: money(projection.lowestCents),
          lowestDate: projection.lowestDate,
          firstNegativeDate: projection.firstNegativeDate,
          committed: money(commitments.committedCents),
          committedPercent: commitments.committedPercent,
          expectedIncome: money(commitments.expectedIncomeCents),
          breakdown: {
            installments: money(commitments.installmentsCents),
            recurring: money(commitments.recurringCents),
            cardInvoices: money(commitments.cardInvoicesCents),
          },
        };
      },
    }),

    get_net_worth: tool({
      description: 'Patrimônio líquido: ativos, dívidas e o líquido.',
      inputSchema: z.object({}),
      execute: () => {
        const worth = netWorth({ db });
        return {
          assets: money(worth.assetsCents),
          liabilities: money(worth.liabilitiesCents),
          net: money(worth.netCents),
        };
      },
    }),

    get_cash_flow: tool({
      description: 'Receita, despesa e taxa de poupança de um período. Transferências ficam fora.',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: ({ from, to }) => {
        const flow = cashFlow(from, to, { db });
        return {
          income: money(flow.incomeCents),
          expense: money(flow.expenseCents),
          net: money(flow.netCents),
          savingsRatePercent: flow.savingsRatePercent,
        };
      },
    }),

    get_goals: tool({
      description: 'Metas de economia com progresso e quanto falta guardar por mês.',
      inputSchema: z.object({}),
      execute: () => ({
        goals: listGoals({ status: 'active', db }).map((goal) => ({
          id: goal.id,
          name: goal.name,
          saved: money(goal.savedCents),
          target: money(goal.targetCents),
          progressPercent: goal.progressPercent,
          targetDate: goal.targetDate,
          requiredMonthly: goal.requiredMonthlyCents !== null ? money(goal.requiredMonthlyCents) : null,
          projectedCompletionDate: goal.projectedCompletionDate,
        })),
      }),
    }),

    get_debts: tool({
      description: 'Dívidas com saldo devedor, parcelas restantes e juros pagos.',
      inputSchema: z.object({}),
      execute: () => ({
        debts: listDebts({ db }).map((debt) => ({
          id: debt.id,
          name: debt.name,
          outstanding: money(debt.outstandingCents),
          remainingCount: debt.remainingCount,
          paidInterest: money(debt.paidInterestCents),
          totalInterest: money(debt.totalInterestCents),
          overdueCount: debt.overdueCount,
          nextDueDate: debt.nextPayment?.dueDate ?? null,
          progressPercent: debt.progressPercent,
        })),
      }),
    }),

    simulate_debt_payoff: tool({
      description:
        'Simula quitar uma dívida antecipadamente ou jogar um valor extra nela. Responde ' +
        '"vale a pena adiantar?" com números.',
      inputSchema: z.object({
        debtId: z.string(),
        extraAmount: amountText.optional().describe('Se informado, simula amortização extra'),
      }),
      execute: ({ debtId, extraAmount }) => {
        if (extraAmount) {
          const result = simulateExtra(debtId, parseMoney(extraAmount), db);
          return {
            kind: 'extra_payment' as const,
            debt: result.debtName,
            extra: money(result.extraCents),
            monthsSaved: result.monthsSaved,
            interestSaved: money(result.interestSavedCents),
            newTermMonths: result.newTermMonths,
          };
        }
        const result = simulatePayoff(debtId, db);
        return {
          kind: 'full_payoff' as const,
          debt: result.debtName,
          payoffNow: money(result.payoffCents),
          ifKeptPaying: money(result.originalRemainingCents),
          interestSaved: money(result.interestSavedCents),
          installmentsRemoved: result.installmentsRemoved,
        };
      },
    }),

    get_portfolio: tool({
      description: 'Carteira de investimentos: custo, valor de mercado e alocação por classe.',
      inputSchema: z.object({}),
      execute: () => {
        const summary = portfolioSummary(db);
        return {
          totalCost: money(summary.totalCostCents),
          totalMarketValue: money(summary.totalMarketValueCents),
          totalGain: money(summary.totalGainCents),
          totalGainPercent: summary.totalGainPercent,
          totalIncome: money(summary.totalIncomeCents),
          withoutQuote: summary.withoutSnapshot,
          allocation: summary.byAssetClass.map((c) => ({
            assetClass: c.assetClass,
            marketValue: money(c.marketValueCents),
            percentOfPortfolio: c.percentOfPortfolio,
          })),
        };
      },
    }),

    find_duplicate_charges: tool({
      description:
        'Procura cobranças possivelmente duplicadas: mesmo valor e descrição em dias próximos. ' +
        'Parcelamentos e recorrências são ignorados.',
      inputSchema: z.object({ withinDays: z.number().int().min(1).max(15).default(3) }),
      execute: ({ withinDays }) => ({
        duplicates: findDuplicates({ withinDays, db }).map((d) => ({
          description: d.description,
          amount: money(d.amountCents),
          dates: d.dates,
          transactionIds: d.ids,
        })),
      }),
    }),

    get_top_payees: tool({
      description: 'Para quem o dinheiro foi num período.',
      inputSchema: z.object({ from: z.string(), to: z.string(), limit: z.number().int().min(1).max(30).default(10) }),
      execute: ({ from, to, limit }) => ({
        payees: topPayees(from, to, { limit, db }).map((p) => ({
          name: p.payeeName,
          total: money(p.amountCents),
          count: p.transactionCount,
          average: money(p.averageCents),
        })),
      }),
    }),

    get_rule_suggestions: tool({
      description:
        'Sugere regras de auto-categorização a partir do histórico: padrões de descrição que o ' +
        'usuário categorizou consistentemente na mesma categoria.',
      inputSchema: z.object({}),
      execute: () => ({
        suggestions: suggestRules({ db }).slice(0, 15),
        pendingApplication: previewApplyRules({ db }).length,
      }),
    }),

    get_budget_suggestions: tool({
      description: 'Sugere limites de orçamento a partir da média realmente gasta nos últimos meses.',
      inputSchema: z.object({ months: z.number().int().min(1).max(12).default(3) }),
      execute: ({ months }) => ({
        suggestions: suggestBudgets({ months, db }).slice(0, 15).map((s) => ({
          category: s.categoryName,
          categoryId: s.categoryId,
          average: money(s.averageCents),
          max: money(s.maxCents),
          monthsWithSpending: s.months,
        })),
      }),
    }),

    get_category_spending: tool({
      description: 'Quanto foi gasto numa categoria específica num mês, incluindo subcategorias.',
      inputSchema: z.object({ category: categoryRef, month: z.string().optional().describe('AAAA-MM') }),
      execute: ({ category, month }) => {
        const resolved = resolveCategory(category, db);
        const targetMonth = month ?? currentMonth();
        const spent = categorySpending(resolved.id, targetMonth, db);
        const { start, end } = monthRange(targetMonth);
        return {
          category: resolved.name,
          categoryId: resolved.id,
          month: targetMonth,
          period: { from: start, to: end },
          spent: money(spent),
        };
      },
    }),

    // ══ Escrita ═══════════════════════════════════════════════════════════════

    create_transaction: tool({
      description:
        'Registra um gasto ou receita. O valor é sempre positivo — o sinal vem do tipo. ' +
        'Para compra parcelada use `create_installment_plan`.',
      inputSchema: z.object({
        type: z.enum(['expense', 'income']),
        amount: amountText,
        account: accountRef,
        description: z.string().min(1).max(200),
        date: dateRef.optional().describe('Padrão: hoje'),
        category: categoryRef.optional(),
        notes: z.string().max(500).optional(),
        tags: z.array(z.string()).max(10).optional(),
        confirmationToken: z.string().optional().describe('Token devolvido por uma confirmação pendente'),
      }),
      execute: (args) => {
        const amountCents = parseMoney(args.amount);
        const account = resolveAccount(args.account, db);
        const category = args.category ? resolveCategory(args.category, db) : undefined;
        const date = resolveDate(args.date, context);

        const riskArgs = { amountCents, accountId: account.id, description: args.description, date };

        return guarded(
          context,
          'create_transaction',
          riskArgs,
          () =>
            `${args.type === 'expense' ? 'Gasto' : 'Receita'} de ${formatMoney(amountCents)} em "${args.description}"` +
            ` na conta ${account.name}${category ? `, categoria ${category.name}` : ''}, em ${formatDateBr(date)}`,
          () => {
            const result = createTransaction(
              {
                accountId: account.id,
                type: args.type,
                amountCents,
                description: args.description,
                date,
                ...(category ? { categoryId: category.id } : {}),
                ...(args.notes ? { notes: args.notes } : {}),
                ...(args.tags ? { tags: args.tags } : {}),
              },
              writeOptions(context, 'create_transaction'),
            );

            return {
              data: {
                id: result.data.id,
                description: result.data.description,
                amount: money(result.data.amountCents),
                date: result.data.date,
                account: account.name,
                category: category?.name ?? null,
                cardInvoiceId: result.data.cardInvoiceId,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    create_installment_plan: tool({
      description:
        'Registra uma compra parcelada. Em cartão de crédito, cada parcela cai numa fatura ' +
        'consecutiva. A soma das parcelas é exatamente o total.',
      inputSchema: z.object({
        account: accountRef,
        description: z.string().min(1).max(200),
        totalAmount: amountText.describe('Valor TOTAL da compra, não o da parcela'),
        installments: z.number().int().min(2).max(120),
        date: dateRef.optional(),
        category: categoryRef.optional(),
        firstChargeDate: z.string().optional().describe('Obrigatório fora de cartão de crédito'),
        confirmationToken: z.string().optional(),
      }),
      execute: (args) => {
        const totalCents = parseMoney(args.totalAmount);
        const account = resolveAccount(args.account, db);
        const category = args.category ? resolveCategory(args.category, db) : undefined;
        const purchaseDate = resolveDate(args.date, context);

        const riskArgs = { totalCents, accountId: account.id, installments: args.installments };

        return guarded(
          context,
          'create_installment_plan',
          riskArgs,
          () =>
            `Compra "${args.description}" de ${formatMoney(totalCents)} em ${args.installments}x ` +
            `no ${account.name}`,
          () => {
            const result = createInstallmentPlan(
              {
                accountId: account.id,
                description: args.description,
                totalCents,
                installments: args.installments,
                purchaseDate,
                ...(category ? { categoryId: category.id } : {}),
                ...(args.firstChargeDate ? { firstChargeDate: args.firstChargeDate } : {}),
              },
              writeOptions(context, 'create_installment_plan'),
            );

            return {
              data: {
                planId: result.data.id,
                description: result.data.description,
                total: money(result.data.totalCents),
                installments: result.data.installments,
                installmentAmount: money(Math.abs(result.data.transactions[0]?.amountCents ?? 0)),
                firstDate: result.data.transactions[0]?.date ?? null,
                lastDate: result.data.transactions.at(-1)?.date ?? null,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    create_transfer: tool({
      description:
        'Transfere entre contas próprias. Não é receita nem despesa. Para pagar fatura de cartão, ' +
        'prefira `pay_card_invoice`.',
      inputSchema: z.object({
        fromAccount: accountRef,
        toAccount: accountRef,
        amount: amountText,
        date: dateRef.optional(),
        description: z.string().max(200).optional(),
        confirmationToken: z.string().optional(),
      }),
      execute: (args) => {
        const amountCents = parseMoney(args.amount);
        const from = resolveAccount(args.fromAccount, db);
        const to = resolveAccount(args.toAccount, db);
        const date = resolveDate(args.date, context);

        return guarded(
          context,
          'create_transfer',
          { amountCents, fromAccountId: from.id, toAccountId: to.id, date },
          () => `Transferência de ${formatMoney(amountCents)} de ${from.name} para ${to.name}`,
          () => {
            const result = createTransfer(
              {
                fromAccountId: from.id,
                toAccountId: to.id,
                amountCents,
                date,
                ...(args.description ? { description: args.description } : {}),
              },
              writeOptions(context, 'create_transfer'),
            );
            return {
              data: {
                transferId: result.data.transferId,
                amount: money(amountCents),
                from: from.name,
                to: to.name,
                date,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    categorize_transaction: tool({
      description: 'Define a categoria de um lançamento.',
      inputSchema: z.object({ transactionId: z.string(), category: categoryRef }),
      execute: (args) => {
        const category = resolveCategory(args.category, db);
        return guarded(
          context,
          'categorize_transaction',
          { transactionId: args.transactionId, categoryId: category.id },
          () => `Categoria "${category.name}" no lançamento`,
          () => {
            const result = updateTransaction(
              args.transactionId,
              { categoryId: category.id },
              writeOptions(context, 'categorize_transaction'),
            );
            return {
              data: { id: result.data.id, description: result.data.description, category: category.name },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    bulk_categorize: tool({
      description:
        'Recategoriza vários lançamentos de uma vez. Use `search_transactions` antes para obter os IDs. ' +
        'Acima do limite configurado, pede confirmação.',
      inputSchema: z.object({
        transactionIds: z.array(z.string()).min(1).max(500),
        category: categoryRef,
        confirmationToken: z.string().optional(),
      }),
      execute: (args) => {
        const category = resolveCategory(args.category, db);
        return guarded(
          context,
          'bulk_categorize',
          { transactionIds: args.transactionIds, categoryId: category.id },
          () => `Recategorizar ${args.transactionIds.length} lançamento(s) para "${category.name}"`,
          () => {
            const result = bulkCategorize(
              args.transactionIds,
              category.id,
              writeOptions(context, 'bulk_categorize'),
            );
            return {
              data: {
                updated: result.data.updated,
                skipped: result.data.skipped.length,
                category: category.name,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    update_transaction: tool({
      description: 'Altera valor, data ou descrição de um lançamento.',
      inputSchema: z.object({
        transactionId: z.string(),
        amount: amountText.optional(),
        date: dateRef.optional(),
        description: z.string().max(200).optional(),
        notes: z.string().max(500).optional(),
        confirmationToken: z.string().optional(),
      }),
      execute: (args) => {
        const current = getTransactionDetail(args.transactionId, db);
        const amountCents = args.amount ? parseMoney(args.amount) : undefined;
        const date = args.date ? resolveDate(args.date, context) : undefined;

        return guarded(
          context,
          'update_transaction',
          { transactionId: args.transactionId, amountCents: amountCents ?? Math.abs(current.amountCents) },
          () => `Alterar "${current.description}"`,
          () => {
            const result = updateTransaction(
              args.transactionId,
              {
                ...(amountCents !== undefined ? { amountCents } : {}),
                ...(date ? { date } : {}),
                ...(args.description ? { description: args.description } : {}),
                ...(args.notes ? { notes: args.notes } : {}),
              },
              writeOptions(context, 'update_transaction'),
            );
            return {
              data: {
                id: result.data.id,
                description: result.data.description,
                amount: money(result.data.amountCents),
                date: result.data.date,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    delete_transaction: tool({
      description: 'Exclui um lançamento. SEMPRE pede confirmação.',
      inputSchema: z.object({ transactionId: z.string(), confirmationToken: z.string().optional() }),
      execute: (args) => {
        const current = getTransactionDetail(args.transactionId, db);
        return guarded(
          context,
          'delete_transaction',
          { transactionId: args.transactionId },
          () =>
            `Excluir "${current.description}" de ${formatMoney(Math.abs(current.amountCents))} ` +
            `em ${formatDateBr(current.date)}`,
          () => {
            const result = deleteTransaction(
              args.transactionId,
              writeOptions(context, 'delete_transaction'),
            );
            return {
              data: { deleted: result.data.deleted.length, description: current.description },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    pay_card_invoice: tool({
      description:
        'Paga a fatura de um cartão. Registrado como transferência, não como despesa — o gasto já foi ' +
        'contabilizado quando a compra entrou na fatura.',
      inputSchema: z.object({
        invoiceId: z.string(),
        amount: amountText.optional().describe('Omitido, paga o saldo devedor inteiro'),
        fromAccount: accountRef.optional(),
        date: dateRef.optional(),
        confirmationToken: z.string().optional(),
      }),
      execute: (args) => {
        const invoices = openInvoices(db);
        const invoice = invoices.find((i) => i.id === args.invoiceId);
        const amountCents = args.amount ? parseMoney(args.amount) : (invoice?.remainingCents ?? 0);
        const fromAccountId = args.fromAccount ? resolveAccount(args.fromAccount, db).id : undefined;
        const date = args.date ? resolveDate(args.date, context) : undefined;

        return guarded(
          context,
          'pay_card_invoice',
          { amountCents, invoiceId: args.invoiceId },
          () => `Pagar ${formatMoney(amountCents)} da fatura ${invoice?.referenceMonth ?? args.invoiceId}`,
          () => {
            const result = payInvoice(
              args.invoiceId,
              {
                ...(args.amount ? { amountCents } : {}),
                ...(fromAccountId ? { fromAccountId } : {}),
                ...(date ? { date } : {}),
              },
              writeOptions(context, 'pay_card_invoice'),
            );
            return {
              data: {
                invoiceId: result.data.invoice.id,
                referenceMonth: result.data.invoice.referenceMonth,
                paid: money(result.data.invoice.paidCents),
                total: money(result.data.invoice.totalCents),
                status: result.data.invoice.status,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    confirm_occurrence: tool({
      description:
        'Confirma uma conta recorrente que caiu, com o valor real. Usado quando a conta de luz vem ' +
        'diferente da estimativa.',
      inputSchema: z.object({
        transactionId: z.string(),
        actualAmount: amountText.optional().describe('Valor real, se diferente do previsto'),
      }),
      execute: (args) => {
        const amountCents = args.actualAmount ? parseMoney(args.actualAmount) : undefined;
        return guarded(
          context,
          'confirm_occurrence',
          { transactionId: args.transactionId },
          () => 'Confirmar a ocorrência',
          () => {
            const result = confirmOccurrence(
              args.transactionId,
              amountCents !== undefined ? { amountCents } : {},
              writeOptions(context, 'confirm_occurrence'),
            );
            return {
              data: {
                id: result.data.id,
                description: result.data.description,
                amount: money(result.data.amountCents),
                status: result.data.status,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    contribute_to_goal: tool({
      description: 'Aporta (valor positivo) ou resgata (negativo) numa meta.',
      inputSchema: z.object({
        goalId: z.string(),
        amount: amountText,
        isWithdrawal: z.boolean().default(false),
        fromAccount: accountRef.optional().describe('Gera a transferência real, se a meta tiver conta'),
        date: dateRef.optional(),
        confirmationToken: z.string().optional(),
      }),
      execute: (args) => {
        const magnitude = parseMoney(args.amount);
        const amountCents = args.isWithdrawal ? -magnitude : magnitude;
        const fromAccountId = args.fromAccount ? resolveAccount(args.fromAccount, db).id : undefined;
        const date = args.date ? resolveDate(args.date, context) : undefined;

        return guarded(
          context,
          'contribute_to_goal',
          { amountCents: magnitude, goalId: args.goalId },
          () => `${args.isWithdrawal ? 'Resgatar' : 'Aportar'} ${formatMoney(magnitude)} na meta`,
          () => {
            const result = contribute(
              args.goalId,
              {
                amountCents,
                ...(fromAccountId ? { fromAccountId } : {}),
                ...(date ? { date } : {}),
              },
              writeOptions(context, 'contribute_to_goal'),
            );
            return {
              data: {
                goal: result.data.goal.name,
                saved: money(result.data.goal.savedCents),
                target: money(result.data.goal.targetCents),
                progressPercent: result.data.goal.progressPercent,
                isComplete: result.data.goal.isComplete,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    set_budget: tool({
      description: 'Define o orçamento mensal de uma categoria. SEMPRE pede confirmação.',
      inputSchema: z.object({
        category: categoryRef,
        amount: amountText,
        rollover: z.boolean().default(false).describe('Acumular a sobra para o mês seguinte'),
        confirmationToken: z.string().optional(),
      }),
      execute: (args) => {
        const amountCents = parseMoney(args.amount);
        const category = resolveCategory(args.category, db);

        return guarded(
          context,
          'set_budget',
          { amountCents, categoryId: category.id },
          () => `Orçamento de ${formatMoney(amountCents)}/mês para "${category.name}"`,
          () => {
            const result = createBudget(
              { categoryId: category.id, amountCents, rollover: args.rollover },
              writeOptions(context, 'set_budget'),
            );
            return {
              data: {
                budgetId: result.data.id,
                category: category.name,
                amount: money(result.data.amountCents),
                startMonth: result.data.startMonth,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    create_goal: tool({
      description: 'Cria uma meta de economia.',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        targetAmount: amountText,
        targetDate: z.string().optional().describe('AAAA-MM-DD'),
        account: accountRef.optional().describe('Omitido, a meta é uma reserva virtual'),
        confirmationToken: z.string().optional(),
      }),
      execute: (args) => {
        const targetCents = parseMoney(args.targetAmount);
        const accountId = args.account ? resolveAccount(args.account, db).id : undefined;

        return guarded(
          context,
          'create_goal',
          { amountCents: targetCents, name: args.name },
          () => `Meta "${args.name}" de ${formatMoney(targetCents)}`,
          () => {
            const result = createGoal(
              {
                name: args.name,
                targetCents,
                ...(args.targetDate ? { targetDate: args.targetDate } : {}),
                ...(accountId ? { accountId } : {}),
              },
              writeOptions(context, 'create_goal'),
            );
            return {
              data: {
                goalId: result.data.id,
                name: result.data.name,
                target: money(result.data.targetCents),
                requiredMonthly:
                  result.data.requiredMonthlyCents !== null ? money(result.data.requiredMonthlyCents) : null,
              },
              changeSetId: result.changeSetId,
            };
          },
        );
      },
    }),

    apply_rules: tool({
      description:
        'Aplica as regras de auto-categorização nos lançamentos sem categoria. SEMPRE pede ' +
        'confirmação, informando quantos serão afetados.',
      inputSchema: z.object({ confirmationToken: z.string().optional() }),
      execute: () => {
        const preview = previewApplyRules({ db });
        return guarded(
          context,
          'apply_rules',
          { affectedCount: preview.length },
          () => `Categorizar automaticamente ${preview.length} lançamento(s) pelas regras existentes`,
          () => {
            const result = applyRules(writeOptions(context, 'apply_rules'));
            return { data: { updated: result.data.updated }, changeSetId: result.changeSetId };
          },
        );
      },
    }),
  };
}

/** Nomes de todas as ferramentas, para diagnóstico. */
export function toolNames(): string[] {
  return Object.keys(buildTools());
}
