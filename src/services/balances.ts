/**
 * Saldos e patrimônio.
 *
 * Dois saldos, e a diferença entre eles importa no uso diário:
 *
 *  • **disponível** — só o que já efetivou (`cleared`/`reconciled`). É o número
 *    que deve bater com o app do banco.
 *  • **projetado** — inclui o que está `pending` (aconteceu, falta confirmar) e
 *    `scheduled` (recorrência futura já materializada). É o número que responde
 *    "posso gastar isso?".
 *
 * Confundir os dois é o que faz a pessoa gastar dinheiro que já estava
 * comprometido com a fatura do cartão.
 */

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import {
  accounts,
  transactions,
  transactionSplits,
  type Account,
  type AccountKind,
  type TransactionStatus,
} from '../db/schema.js';
import type { IsoDate } from '../core/clock.js';
import { today } from '../core/clock.js';
import { getAccount } from './accounts.js';

/** Status que contam como dinheiro que já saiu ou entrou de fato. */
const SETTLED_STATUS: readonly TransactionStatus[] = ['cleared', 'reconciled'];
/** Status previstos, que entram apenas no saldo projetado. */
const FORECAST_STATUS: readonly TransactionStatus[] = ['pending', 'scheduled'];

export interface AccountBalance {
  accountId: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingBalanceCents: number;
  /** Saldo efetivado — o que bate com o extrato do banco. */
  availableCents: number;
  /** Efetivado + previsto (pendente e agendado). */
  projectedCents: number;
  /** Movimento ainda não efetivado. */
  forecastCents: number;
  /** Para cartão de crédito: quanto do limite está comprometido. */
  cardUsage?: {
    limitCents: number;
    usedCents: number;
    availableCents: number;
    usedPercent: number;
  };
}

/**
 * Soma o movimento de uma conta até uma data.
 *
 * `upTo` permite reconstruir o saldo em qualquer ponto do passado, que é o que
 * alimenta o gráfico de evolução patrimonial.
 */
function sumMovement(
  db: Db,
  accountId: string,
  statuses: readonly TransactionStatus[],
  upTo?: IsoDate,
): number {
  const filters = [eq(transactions.accountId, accountId), inArray(transactions.status, [...statuses])];
  if (upTo) filters.push(lte(transactions.date, upTo));

  const [row] = db
    .select({ total: sql<number>`coalesce(sum(${transactions.amountCents}), 0)` })
    .from(transactions)
    .where(and(...filters))
    .all();

  return row?.total ?? 0;
}

export function accountBalance(accountId: string, options: { upTo?: IsoDate; db?: Db } = {}): AccountBalance {
  const db = options.db ?? getDb();
  const account = getAccount(accountId, db);

  const settled = sumMovement(db, accountId, SETTLED_STATUS, options.upTo);
  const forecast = sumMovement(db, accountId, FORECAST_STATUS, options.upTo);

  const availableCents = account.openingBalanceCents + settled;
  const projectedCents = availableCents + forecast;

  const balance: AccountBalance = {
    accountId,
    name: account.name,
    kind: account.kind,
    currency: account.currency,
    openingBalanceCents: account.openingBalanceCents,
    availableCents,
    projectedCents,
    forecastCents: forecast,
  };

  if (account.kind === 'credit_card' && account.card) {
    // Saldo do cartão é negativo (dívida); o uso do limite é o módulo disso.
    const usedCents = Math.max(0, -projectedCents);
    const limitCents = account.card.limitCents;
    balance.cardUsage = {
      limitCents,
      usedCents,
      availableCents: Math.max(0, limitCents - usedCents),
      usedPercent: limitCents > 0 ? Math.round((usedCents / limitCents) * 1000) / 10 : 0,
    };
  }

  return balance;
}

export function allBalances(options: { upTo?: IsoDate; includeArchived?: boolean; db?: Db } = {}): AccountBalance[] {
  const db = options.db ?? getDb();
  const rows = db
    .select()
    .from(accounts)
    .where(options.includeArchived ? undefined : eq(accounts.isArchived, false))
    .orderBy(accounts.sortOrder, accounts.name)
    .all();

  return rows.map((account) =>
    accountBalance(account.id, { ...(options.upTo ? { upTo: options.upTo } : {}), db }),
  );
}

export interface NetWorth {
  date: IsoDate;
  /** Soma das contas com saldo positivo (contas, dinheiro, investimento). */
  assetsCents: number;
  /** Soma das dívidas: cartões e contas negativas. */
  liabilitiesCents: number;
  /** Ativos − passivos. */
  netCents: number;
  byAccount: AccountBalance[];
}

/**
 * Patrimônio líquido no momento (ou numa data passada).
 *
 * Usa o saldo **disponível**, não o projetado: patrimônio é o que existe, não o
 * que está previsto.
 */
export function netWorth(options: { upTo?: IsoDate; db?: Db } = {}): NetWorth {
  const byAccount = allBalances({ ...options, includeArchived: true });

  let assetsCents = 0;
  let liabilitiesCents = 0;

  for (const balance of byAccount) {
    if (balance.availableCents >= 0) assetsCents += balance.availableCents;
    else liabilitiesCents += -balance.availableCents;
  }

  return {
    date: options.upTo ?? today(),
    assetsCents,
    liabilitiesCents,
    netCents: assetsCents - liabilitiesCents,
    byAccount,
  };
}

export interface CashFlowPeriod {
  incomeCents: number;
  expenseCents: number;
  /** Receita − despesa. Positivo = sobrou. */
  netCents: number;
  /** Percentual da receita que sobrou. `null` quando não houve receita. */
  savingsRatePercent: number | null;
}

/**
 * Fluxo de caixa de um intervalo.
 *
 * Transferências ficam **fora** por construção (`type != 'transfer'`): mover
 * dinheiro entre as próprias contas não é receita nem despesa, e contá-las
 * infla a renda e o gasto ao mesmo tempo.
 */
export function cashFlow(
  from: IsoDate,
  to: IsoDate,
  options: { accountIds?: string[]; includeForecast?: boolean; db?: Db } = {},
): CashFlowPeriod {
  const db = options.db ?? getDb();

  const statuses: TransactionStatus[] = options.includeForecast
    ? [...SETTLED_STATUS, ...FORECAST_STATUS]
    : [...SETTLED_STATUS];

  const filters = [
    gte(transactions.date, from),
    lte(transactions.date, to),
    sql`${transactions.type} != 'transfer'`,
    inArray(transactions.status, statuses),
  ];
  if (options.accountIds?.length) {
    filters.push(inArray(transactions.accountId, options.accountIds));
  }

  const [row] = db
    .select({
      income: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
      expense: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
    })
    .from(transactions)
    .where(and(...filters))
    .all();

  const incomeCents = row?.income ?? 0;
  const expenseCents = row?.expense ?? 0;
  const netCents = incomeCents - expenseCents;

  return {
    incomeCents,
    expenseCents,
    netCents,
    savingsRatePercent:
      incomeCents > 0 ? Math.round((netCents / incomeCents) * 1000) / 10 : null,
  };
}

/**
 * Verificação de integridade contábil.
 *
 * Roda sobre o banco inteiro e confirma as invariantes que nenhum relatório
 * deveria violar. Usada nos testes e exposta como endpoint de diagnóstico:
 * se algo aqui falha, existe escrita acontecendo fora do `mutate()`.
 */
export interface IntegrityIssue {
  check: string;
  detail: string;
  ids?: string[];
}

export function checkIntegrity(db: Db = getDb()): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];

  // 1. Saldo de cada conta = abertura + soma das transações.
  for (const account of db.select().from(accounts).all()) {
    const balance = accountBalance(account.id, { db });
    const [row] = db
      .select({ total: sql<number>`coalesce(sum(${transactions.amountCents}), 0)` })
      .from(transactions)
      .where(and(eq(transactions.accountId, account.id), inArray(transactions.status, [...SETTLED_STATUS])))
      .all();
    const expected = account.openingBalanceCents + (row?.total ?? 0);
    if (balance.availableCents !== expected) {
      issues.push({
        check: 'saldo_da_conta',
        detail: `Conta "${account.name}": saldo ${balance.availableCents} ≠ esperado ${expected}`,
        ids: [account.id],
      });
    }
  }

  // 2. Toda transferência tem exatamente 2 pernas que somam zero.
  const transferRows = db
    .select({
      transferId: transactions.transferId,
      legs: sql<number>`count(*)`,
      total: sql<number>`sum(${transactions.amountCents})`,
    })
    .from(transactions)
    .where(sql`${transactions.transferId} is not null`)
    .groupBy(transactions.transferId)
    .all();

  for (const row of transferRows) {
    if (row.legs !== 2) {
      issues.push({
        check: 'pernas_da_transferencia',
        detail: `Transferência ${row.transferId} tem ${row.legs} perna(s) em vez de 2`,
        ids: row.transferId ? [row.transferId] : [],
      });
    }
    if (row.total !== 0) {
      issues.push({
        check: 'transferencia_soma_zero',
        detail: `Transferência ${row.transferId} soma ${row.total} em vez de 0`,
        ids: row.transferId ? [row.transferId] : [],
      });
    }
  }

  // 3. Rateio soma exatamente o valor da transação.
  //
  // Feito com duas consultas e agregação em memória, e não com subquery
  // correlacionada: o Drizzle renderiza referências de coluna sem qualificar a
  // tabela quando a consulta tem uma única origem, e dentro de uma subquery esse
  // `"id"` solto passa a apontar para a tabela interna. O resultado é uma soma
  // sempre zero — uma verificação de integridade que acusa erro onde não há.
  const splitTotals = new Map<string, number>();
  for (const row of db
    .select({
      transactionId: transactionSplits.transactionId,
      total: sql<number>`coalesce(sum(${transactionSplits.amountCents}), 0)`,
    })
    .from(transactionSplits)
    .groupBy(transactionSplits.transactionId)
    .all()) {
    splitTotals.set(row.transactionId, row.total);
  }

  const splitRows = db
    .select({
      transactionId: transactions.id,
      description: transactions.description,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(eq(transactions.hasSplits, true))
    .all();

  for (const row of splitRows) {
    const splitTotal = splitTotals.get(row.transactionId) ?? 0;
    if (splitTotal !== row.amountCents) {
      issues.push({
        check: 'soma_do_rateio',
        detail: `"${row.description}": rateio soma ${splitTotal}, transação vale ${row.amountCents}`,
        ids: [row.transactionId],
      });
    }
  }

  // Rateio órfão: linhas de rateio numa transação que não está marcada como rateada.
  for (const [transactionId, total] of splitTotals) {
    if (!splitRows.some((r) => r.transactionId === transactionId)) {
      issues.push({
        check: 'rateio_orfao',
        detail: `Transação ${transactionId} tem rateio somando ${total} mas não está marcada como rateada`,
        ids: [transactionId],
      });
    }
  }

  // 4. Transferência não pode ter categoria.
  const categorizedTransfers = db
    .select({ id: transactions.id, description: transactions.description })
    .from(transactions)
    .where(and(eq(transactions.type, 'transfer'), sql`${transactions.categoryId} is not null`))
    .all();

  for (const row of categorizedTransfers) {
    issues.push({
      check: 'transferencia_sem_categoria',
      detail: `Transferência "${row.description}" tem categoria`,
      ids: [row.id],
    });
  }

  // 5. Sinal coerente com o tipo.
  const wrongSign = db
    .select({ id: transactions.id, description: transactions.description, type: transactions.type, amountCents: transactions.amountCents })
    .from(transactions)
    .where(
      sql`(${transactions.type} = 'expense' and ${transactions.amountCents} > 0)
          or (${transactions.type} = 'income' and ${transactions.amountCents} < 0)`,
    )
    .all();

  for (const row of wrongSign) {
    issues.push({
      check: 'sinal_do_valor',
      detail: `"${row.description}" é ${row.type} mas tem valor ${row.amountCents}`,
      ids: [row.id],
    });
  }

  return issues;
}

export type { Account };
