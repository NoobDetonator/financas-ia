/**
 * Projeção de saldo futuro.
 *
 * Responde à pergunta que os apps de finanças costumam ignorar: *"posso gastar
 * isso?"*. O saldo de hoje não responde — ele ignora a fatura que fecha semana
 * que vem, as parcelas em aberto e o aluguel do dia 5.
 *
 * Como as ocorrências futuras já estão materializadas como transações
 * `scheduled` (ver `recurrences.ts`), a projeção é uma soma cumulativa sobre a
 * mesma tabela de sempre — não uma simulação paralela que poderia divergir do
 * que o resto do sistema mostra.
 */

import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { accounts, settings, transactions, type TransactionStatus } from '../db/schema.js';
import { addDays, diffDays, today, type IsoDate } from '../core/clock.js';
import { getAccount } from './accounts.js';
import { accountBalance } from './balances.js';

const SETTLED: readonly TransactionStatus[] = ['cleared', 'reconciled'];
const FORECAST: readonly TransactionStatus[] = ['pending', 'scheduled'];

export interface ProjectionPoint {
  date: IsoDate;
  /** Saldo acumulado até esta data, incluindo o previsto. */
  balanceCents: number;
  /** Movimento previsto neste dia. */
  changeCents: number;
  /** O que compõe o movimento do dia. */
  items: Array<{ id: string; description: string; amountCents: number; status: TransactionStatus }>;
}

export interface BalanceProjection {
  accountId: string | null;
  accountName: string;
  from: IsoDate;
  to: IsoDate;
  /** Saldo efetivado no ponto de partida. */
  startingCents: number;
  /** Saldo projetado ao final do horizonte. */
  endingCents: number;
  /** Menor saldo do período — o número que revela aperto de caixa. */
  lowestCents: number;
  lowestDate: IsoDate | null;
  /** Primeiro dia em que o saldo fica negativo, se houver. */
  firstNegativeDate: IsoDate | null;
  points: ProjectionPoint[];
}

function horizonDays(db: Db): number {
  const row = db.select().from(settings).where(eq(settings.id, 'singleton')).all()[0];
  return row?.projectionHorizonDays ?? 90;
}

/**
 * Projeta o saldo dia a dia.
 *
 * Sem `accountId`, projeta o consolidado das contas que não são cartão de
 * crédito: somar o cartão ao caixa misturaria dívida com dinheiro disponível.
 */
export function projectBalance(
  options: { accountId?: string; days?: number; db?: Db; includeCards?: boolean } = {},
): BalanceProjection {
  const db = options.db ?? getDb();
  const from = today();
  const to = addDays(from, options.days ?? horizonDays(db));

  let accountIds: string[];
  let accountName: string;
  let startingCents: number;

  if (options.accountId) {
    const account = getAccount(options.accountId, db);
    accountIds = [account.id];
    accountName = account.name;
    startingCents = accountBalance(account.id, { db }).availableCents;
  } else {
    const rows = db.select().from(accounts).where(eq(accounts.isArchived, false)).all();
    const relevant = options.includeCards ? rows : rows.filter((a) => a.kind !== 'credit_card');
    accountIds = relevant.map((a) => a.id);
    accountName = options.includeCards ? 'Todas as contas' : 'Contas de caixa';
    startingCents = relevant.reduce((sum, a) => sum + accountBalance(a.id, { db }).availableCents, 0);
  }

  if (accountIds.length === 0) {
    return {
      accountId: options.accountId ?? null,
      accountName,
      from,
      to,
      startingCents: 0,
      endingCents: 0,
      lowestCents: 0,
      lowestDate: null,
      firstNegativeDate: null,
      points: [],
    };
  }

  // Movimentos previstos dentro da janela. O saldo de partida já contém tudo o
  // que efetivou, então aqui entram apenas as previsões.
  const upcoming = db
    .select()
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, accountIds),
        inArray(transactions.status, [...FORECAST]),
        lte(transactions.date, to),
      ),
    )
    .orderBy(asc(transactions.date), asc(transactions.id))
    .all();

  const byDate = new Map<IsoDate, ProjectionPoint>();
  for (const row of upcoming) {
    // Previsão atrasada (data já passou e ninguém confirmou) entra no primeiro
    // dia da projeção: ela ainda vai sair da conta.
    const date = row.date < from ? from : row.date;

    const point = byDate.get(date) ?? { date, balanceCents: 0, changeCents: 0, items: [] };
    point.changeCents += row.amountCents;
    point.items.push({
      id: row.id,
      description: row.description,
      amountCents: row.amountCents,
      status: row.status,
    });
    byDate.set(date, point);
  }

  const points = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  let running = startingCents;
  let lowestCents = startingCents;
  let lowestDate: IsoDate | null = null;
  let firstNegativeDate: IsoDate | null = null;

  for (const point of points) {
    running += point.changeCents;
    point.balanceCents = running;

    if (running < lowestCents) {
      lowestCents = running;
      lowestDate = point.date;
    }
    if (running < 0 && firstNegativeDate === null) {
      firstNegativeDate = point.date;
    }
  }

  return {
    accountId: options.accountId ?? null,
    accountName,
    from,
    to,
    startingCents,
    endingCents: running,
    lowestCents,
    lowestDate,
    firstNegativeDate,
    points,
  };
}

export interface CommitmentSummary {
  /** Total já comprometido com parcelas e recorrências no período. */
  committedCents: number;
  /** Parcelas de compras parceladas. */
  installmentsCents: number;
  /** Contas fixas e assinaturas. */
  recurringCents: number;
  /** Faturas de cartão em aberto. */
  cardInvoicesCents: number;
  /** Receita prevista no período. */
  expectedIncomeCents: number;
  /**
   * Percentual da receita prevista já comprometido. `null` sem receita prevista.
   *
   * Acima de 100% significa que o previsto não cabe no que vai entrar.
   */
  committedPercent: number | null;
}

/**
 * Quanto da renda futura já está preso.
 *
 * É o número que explica a sensação de "ganho bem e não sobra nada": o salário
 * chega, mas parcelas e contas fixas já consumiram a maior parte antes.
 */
export function futureCommitments(
  options: { days?: number; db?: Db } = {},
): CommitmentSummary {
  const db = options.db ?? getDb();
  const from = today();
  const to = addDays(from, options.days ?? 30);

  const [row] = db
    .select({
      installments: sql<number>`coalesce(sum(case when ${transactions.installmentPlanId} is not null and ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
      recurring: sql<number>`coalesce(sum(case when ${transactions.recurrenceId} is not null and ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
      other: sql<number>`coalesce(sum(case when ${transactions.installmentPlanId} is null and ${transactions.recurrenceId} is null and ${transactions.amountCents} < 0 then -${transactions.amountCents} else 0 end), 0)`,
      income: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.status, [...FORECAST]),
        gt(transactions.date, from),
        lte(transactions.date, to),
        sql`${transactions.type} != 'transfer'`,
      ),
    )
    .all();

  const installmentsCents = row?.installments ?? 0;
  const recurringCents = row?.recurring ?? 0;
  const otherCents = row?.other ?? 0;
  const expectedIncomeCents = row?.income ?? 0;

  // Faturas em aberto contam separado: as compras que as compõem já foram
  // efetivadas, então não aparecem como previsão.
  const [invoiceRow] = db
    .select({
      total: sql<number>`coalesce(sum(total_cents - paid_cents), 0)`,
    })
    .from(sql`card_invoices`)
    .where(sql`total_cents > paid_cents and due_date between ${from} and ${to}`)
    .all() as Array<{ total: number }>;

  const cardInvoicesCents = invoiceRow?.total ?? 0;
  const committedCents = installmentsCents + recurringCents + otherCents + cardInvoicesCents;

  return {
    committedCents,
    installmentsCents,
    recurringCents,
    cardInvoicesCents,
    expectedIncomeCents,
    committedPercent:
      expectedIncomeCents > 0
        ? Math.round((committedCents / expectedIncomeCents) * 1000) / 10
        : null,
  };
}

/**
 * Evolução do patrimônio mês a mês, olhando para trás.
 *
 * Reconstrói o saldo em cada data usando apenas o que estava efetivado até ali —
 * o gráfico mostra o passado como ele foi, não como ficou depois.
 */
export function netWorthHistory(
  options: { months?: number; db?: Db } = {},
): Array<{ date: IsoDate; assetsCents: number; liabilitiesCents: number; netCents: number }> {
  const db = options.db ?? getDb();
  const months = options.months ?? 12;
  const reference = today();

  const rows = db.select().from(accounts).all();
  const result: Array<{ date: IsoDate; assetsCents: number; liabilitiesCents: number; netCents: number }> = [];

  for (let offset = months - 1; offset >= 0; offset -= 1) {
    // Último dia de cada mês do intervalo.
    const monthEnd = endOfMonthOffset(reference, -offset);

    let assetsCents = 0;
    let liabilitiesCents = 0;

    for (const account of rows) {
      const [movement] = db
        .select({ total: sql<number>`coalesce(sum(${transactions.amountCents}), 0)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, account.id),
            inArray(transactions.status, [...SETTLED]),
            lte(transactions.date, monthEnd),
          ),
        )
        .all();

      const balance = account.openingBalanceCents + (movement?.total ?? 0);
      if (balance >= 0) assetsCents += balance;
      else liabilitiesCents += -balance;
    }

    result.push({ date: monthEnd, assetsCents, liabilitiesCents, netCents: assetsCents - liabilitiesCents });
  }

  return result;
}

function endOfMonthOffset(reference: IsoDate, monthOffset: number): IsoDate {
  const [yearText, monthText] = reference.split('-');
  const total = Number(yearText) * 12 + (Number(monthText) - 1) + monthOffset;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export { diffDays };
