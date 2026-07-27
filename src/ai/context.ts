/**
 * Contexto financeiro injetado em toda conversa.
 *
 * Sem isto, a IA gasta cinco chamadas de ferramenta só para descobrir quais
 * contas existem antes de conseguir responder qualquer coisa. Com um retrato
 * compacto no prompt, ela já começa orientada — e o custo por conversa cai muito.
 *
 * O retrato é **agregado**, nunca uma lista de transações cruas: despejar
 * lançamentos no prompt gastaria tokens e convidaria o modelo a fazer conta, o
 * que é justamente o que a arquitetura evita.
 */

import { getDb, type Db } from '../db/client.js';
import { formatMoney } from '../core/money.js';
import { currentMonth, formatDateBr, formatMonthBr, today } from '../core/clock.js';
import { listAccounts } from '../services/accounts.js';
import { categoryTree } from '../services/categories.js';
import { allBalances } from '../services/balances.js';
import { monthOverview } from '../services/reports.js';
import { budgetSummary } from '../services/budgets.js';
import { openInvoices } from '../services/invoices.js';
import { upcomingBills } from '../services/recurrences.js';
import { futureCommitments, projectBalance } from '../services/projection.js';
import { listGoals } from '../services/goals.js';
import { listDebts } from '../services/debts.js';
import { loadThresholds } from './risk.js';

export interface SnapshotOptions {
  db?: Db;
  /** Inclui a árvore de categorias com IDs. Necessário para a IA categorizar. */
  includeCategories?: boolean;
}

/**
 * Monta o retrato em Markdown.
 *
 * Markdown e não JSON de propósito: o modelo lê melhor, e a economia de tokens
 * de chaves e aspas repetidas é significativa num prompt enviado a cada turno.
 */
export function buildSnapshot(options: SnapshotOptions = {}): string {
  const db = options.db ?? getDb();
  const reference = today();
  const month = currentMonth();
  const lines: string[] = [];

  lines.push(`# Retrato financeiro — ${formatDateBr(reference)}`);
  lines.push('');

  // ── Contas ────────────────────────────────────────────────────────────────
  const balances = allBalances({ db });
  if (balances.length === 0) {
    lines.push('Nenhuma conta cadastrada ainda.');
    lines.push('');
  } else {
    lines.push('## Contas');
    const accounts = listAccounts({ db });
    for (const balance of balances) {
      const account = accounts.find((a) => a.id === balance.accountId);
      const aliases = account?.aliases?.length ? ` (apelidos: ${account.aliases.join(', ')})` : '';
      const projected =
        balance.projectedCents !== balance.availableCents
          ? `, projetado ${formatMoney(balance.projectedCents)}`
          : '';
      const limit = balance.cardUsage
        ? `, limite usado ${balance.cardUsage.usedPercent}% de ${formatMoney(balance.cardUsage.limitCents)}`
        : '';

      lines.push(
        `- **${balance.name}** [${balance.accountId}] — ${kindLabel(balance.kind)}: ${formatMoney(balance.availableCents)}${projected}${limit}${aliases}`,
      );
    }
    lines.push('');
  }

  // ── Mês corrente ──────────────────────────────────────────────────────────
  const overview = monthOverview(month, { db });
  lines.push(`## ${formatMonthBr(month)}`);
  lines.push(
    `Receita ${formatMoney(overview.incomeCents)} · Despesa ${formatMoney(overview.expenseCents)} · ` +
      `Saldo ${formatMoney(overview.netCents)}` +
      (overview.savingsRatePercent !== null ? ` · Taxa de poupança ${overview.savingsRatePercent}%` : ''),
  );
  if (overview.comparedToPreviousMonth.expenseChangePercent !== null) {
    const change = overview.comparedToPreviousMonth.expenseChangePercent;
    lines.push(
      `Despesa ${change >= 0 ? 'subiu' : 'caiu'} ${Math.abs(change)}% em relação ao mês anterior.`,
    );
  }
  if (overview.topCategories.length > 0) {
    lines.push(
      `Maiores categorias: ${overview.topCategories
        .slice(0, 5)
        .map((c) => `${c.categoryName} ${formatMoney(c.amountCents)}`)
        .join(' · ')}`,
    );
  }
  lines.push('');

  // ── Orçamentos ────────────────────────────────────────────────────────────
  const budgets = budgetSummary(month, db);
  if (budgets.items.length > 0) {
    lines.push('## Orçamentos');
    for (const item of budgets.items.slice(0, 8)) {
      const flag = item.remainingCents < 0 ? ' ⚠️ ESTOUROU' : item.willExceed ? ' ⚠️ no ritmo, vai estourar' : '';
      lines.push(
        `- ${item.categoryName}: ${formatMoney(item.spentCents)} de ${formatMoney(item.limitCents)} (${item.usedPercent}%)${flag}`,
      );
    }
    lines.push('');
  }

  // ── A pagar ───────────────────────────────────────────────────────────────
  const invoices = openInvoices(db);
  const bills = upcomingBills({ withinDays: 30, db });
  if (invoices.length > 0 || bills.length > 0) {
    lines.push('## A pagar');
    for (const invoice of invoices.slice(0, 5)) {
      const account = listAccounts({ includeArchived: true, db }).find((a) => a.id === invoice.cardAccountId);
      lines.push(
        `- Fatura ${account?.name ?? invoice.cardAccountId} de ${invoice.referenceMonth}: ` +
          `${formatMoney(invoice.remainingCents)}, vence ${formatDateBr(invoice.dueDate)} [${invoice.id}]`,
      );
    }
    for (const bill of bills.slice(0, 8)) {
      lines.push(
        `- ${bill.recurrenceName}: ${formatMoney(Math.abs(bill.transaction.amountCents))} em ${formatDateBr(bill.transaction.date)} (${bill.daysUntil}d)`,
      );
    }
    lines.push('');
  }

  // ── Projeção ──────────────────────────────────────────────────────────────
  const projection = projectBalance({ days: 60, db });
  const commitments = futureCommitments({ days: 30, db });
  lines.push('## Projeção');
  lines.push(
    `Saldo de caixa hoje ${formatMoney(projection.startingCents)}, projetado para ${formatMoney(projection.endingCents)} em 60 dias.`,
  );
  if (projection.firstNegativeDate) {
    lines.push(`⚠️ O saldo projetado fica negativo em ${formatDateBr(projection.firstNegativeDate)}.`);
  }
  if (commitments.committedPercent !== null) {
    lines.push(
      `Comprometido nos próximos 30 dias: ${formatMoney(commitments.committedCents)} ` +
        `(${commitments.committedPercent}% da receita prevista de ${formatMoney(commitments.expectedIncomeCents)}).`,
    );
  }
  lines.push('');

  // ── Metas e dívidas ───────────────────────────────────────────────────────
  const goals = listGoals({ status: 'active', db });
  if (goals.length > 0) {
    lines.push('## Metas');
    for (const goal of goals.slice(0, 6)) {
      lines.push(
        `- ${goal.name} [${goal.id}]: ${formatMoney(goal.savedCents)} de ${formatMoney(goal.targetCents)} (${goal.progressPercent}%)` +
          (goal.targetDate ? `, alvo ${formatDateBr(goal.targetDate)}` : ''),
      );
    }
    lines.push('');
  }

  const debts = listDebts({ db });
  if (debts.length > 0) {
    lines.push('## Dívidas');
    for (const debt of debts.slice(0, 6)) {
      lines.push(
        `- ${debt.name} [${debt.id}]: falta ${formatMoney(debt.outstandingCents)} em ${debt.remainingCount} parcela(s)` +
          (debt.overdueCount > 0 ? ` ⚠️ ${debt.overdueCount} vencida(s)` : ''),
      );
    }
    lines.push('');
  }

  // ── Categorias ────────────────────────────────────────────────────────────
  if (options.includeCategories !== false) {
    lines.push('## Categorias disponíveis');
    // Só os nomes, sem os IDs: as ferramentas resolvem categoria por nome
    // ("Mercado") ou por caminho ("Alimentação > Mercado"). Carregar 99 IDs de
    // 26 caracteres a cada turno custaria mais de mil tokens sem servir para nada.
    lines.push('Use o nome ao categorizar. Para subcategoria com nome ambíguo, use "Mãe > Filha".');
    for (const kind of ['expense', 'income'] as const) {
      const tree = categoryTree({ kind, db });
      if (tree.length === 0) continue;
      lines.push(`\n**${kind === 'expense' ? 'Despesa' : 'Receita'}:**`);
      for (const root of tree) {
        const children = root.children.map((c) => c.name).join(', ');
        lines.push(`- ${root.name}${children ? `: ${children}` : ''}`);
      }
    }
    lines.push('');
  }

  // ── Limites de autonomia ──────────────────────────────────────────────────
  const thresholds = loadThresholds(db);
  lines.push('## Seus limites de autonomia');
  lines.push(
    `Operações acima de ${formatMoney(thresholds.amountCents)} ou que afetem mais de ` +
      `${thresholds.bulkRows} lançamentos precisam de confirmação do usuário.`,
  );

  return lines.join('\n');
}

function kindLabel(kind: string): string {
  return (
    {
      checking: 'conta corrente',
      savings: 'poupança',
      cash: 'dinheiro',
      wallet: 'carteira digital',
      investment: 'investimento',
      credit_card: 'cartão de crédito',
    }[kind] ?? kind
  );
}

/**
 * Instruções de sistema do agente.
 *
 * O ponto central: o modelo **não faz conta**. Ele escolhe ferramentas e narra
 * resultados. Números vêm sempre das ferramentas, que os calculam em SQL ou em
 * função determinística.
 */
export function systemPrompt(snapshot: string): string {
  return `Você é o assistente financeiro pessoal do usuário, integrado ao aplicativo de finanças dele.
Responda sempre em português do Brasil, de forma direta e concreta.

## Regras que você não quebra

1. **Você nunca faz cálculo de cabeça.** Todo número que você apresentar tem que vir
   de uma ferramenta. Se precisa de um total, chame a ferramenta que o calcula. Nunca
   some, subtraia, calcule percentual ou média mentalmente — a ferramenta faz isso
   com exatidão, você apenas relata.

2. **Valores são inteiros em centavos.** \`4590\` significa R$ 45,90. As ferramentas
   já devolvem o texto formatado junto com o número; use o texto formatado ao falar
   com o usuário.

3. **Datas no formato AAAA-MM-DD.** Para converter expressões como "ontem" ou
   "sexta passada", use a ferramenta \`resolve_date\` — não calcule você mesmo, porque
   você não tem certeza de qual é a data de hoje nem de qual dia da semana ela cai.

4. **Não invente IDs.** Use os IDs que aparecem no retrato abaixo ou que vieram de
   uma ferramenta. Se não encontrar o que precisa, use as ferramentas de busca.

5. **Operações que precisam de confirmação retornam \`needsConfirmation: true\`.**
   Nesse caso, explique ao usuário em uma frase o que será feito e por que precisa de
   aprovação, e diga que basta confirmar. Não tente burlar o limite dividindo a
   operação em partes menores.

6. **Se algo não fizer sentido nos dados, diga.** É mais útil apontar "esse gasto de
   R$ 3.000 em Alimentação parece fora do padrão, confere?" do que relatar o número
   sem comentário.

7. **Separe o que os dados mostram do que você está supondo.** O sistema registra
   valores, datas e categorias — ele **não** calcula juros de rotativo, multa por
   atraso, rendimento de aplicação nem imposto. Se a fatura está vencida, diga que
   está vencida e há quantos dias; não afirme quanto de juros ela acumulou, porque
   esse número não existe nos dados. Quando for suposição, use "provavelmente" ou
   "vale conferir" — apresentar inferência como fato é o erro mais grave que você
   pode cometer aqui.

## Como se comportar

- Seja específico: "você gastou R$ 1.240 em Alimentação, 38% acima da sua mediana"
  vale mais do que "seus gastos com comida aumentaram".
- Ao lançar um gasto, confirme em uma linha o que foi registrado, incluindo conta e
  categoria, para o usuário poder corrigir na hora se você entendeu errado.
- Quando o usuário pedir conselho, use as ferramentas de análise antes de opinar.
  Conselho sem número é palpite.
- Não dê recomendação de investimento específico ("compre essa ação"). Você pode
  mostrar os números da carteira e apontar concentração ou risco.
- Respostas curtas. O usuário está no celular na fila do mercado, na maior parte
  das vezes.

${snapshot}`;
}
