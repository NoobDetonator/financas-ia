/**
 * A qual fatura pertence uma compra.
 *
 * Função pura, isolada num arquivo próprio, porque é o ponto onde quase todo app
 * de finanças erra — e o erro é silencioso: a compra aparece na fatura errada e o
 * mês fecha com valor que não bate com o do banco.
 *
 * Regra: a fatura fecha no `closingDay`. Uma compra feita **no** dia do
 * fechamento já entra na fatura seguinte, que é o comportamento dos cartões
 * brasileiros (o fechamento consolida o que veio até o dia anterior).
 *
 * O vencimento (`dueDay`) cai depois do fechamento. Quando `dueDay <= closingDay`,
 * o vencimento é no mês seguinte ao fechamento — é o caso mais comum
 * (fecha dia 28, vence dia 5).
 *
 * O **mês de referência** da fatura é o mês do vencimento, não o do fechamento:
 * é assim que os bancos nomeiam ("fatura de agosto" é a que vence em agosto).
 *
 * Casos que os testes cobrem explicitamente:
 *  • fechamento dia 31 em fevereiro (encaixa em 28, ou 29 em ano bissexto);
 *  • compra exatamente no dia do fechamento;
 *  • vencimento em dia menor que o fechamento;
 *  • virada de ano;
 *  • `closingDay = -1` (último dia do mês).
 */

import {
  addMonths,
  clampDay,
  isAfter,
  isSameOrAfter,
  makeDateClamped,
  monthKey,
  parseDate,
  type IsoDate,
  type MonthKey,
} from '../core/clock.js';
import { validation } from '../core/errors.js';

export interface InvoiceCycle {
  /** Mês de referência da fatura (`YYYY-MM`), definido pelo vencimento. */
  referenceMonth: MonthKey;
  /** Data em que a fatura fecha. Compras a partir deste dia vão para a próxima. */
  closingDate: IsoDate;
  /** Data de vencimento. Sempre posterior ao fechamento. */
  dueDate: IsoDate;
  /** Primeiro dia coberto por esta fatura (dia do fechamento anterior). */
  periodStart: IsoDate;
  /** Último dia coberto: o dia anterior ao fechamento. */
  periodEnd: IsoDate;
}

export interface CardCycleConfig {
  /** 1-31, ou -1 para o último dia do mês. */
  closingDay: number;
  /** 1-31, ou -1 para o último dia do mês. */
  dueDay: number;
}

function assertDay(day: number, label: string): void {
  if (!Number.isInteger(day) || (day !== -1 && (day < 1 || day > 31))) {
    throw validation(`${label} inválido: ${day}. Use 1 a 31, ou -1 para o último dia do mês.`);
  }
}

/** Data de fechamento no mês de uma data de referência, com o dia encaixado. */
function closingDateIn(year: number, month: number, closingDay: number): IsoDate {
  return makeDateClamped(year, month, closingDay === -1 ? -1 : clampDay(year, month, closingDay));
}

/**
 * Monta o ciclo cujo fechamento é `closingDate`.
 *
 * O vencimento é calculado a partir do fechamento: mesmo mês se o dia for maior,
 * mês seguinte caso contrário.
 */
function cycleFromClosing(closingDate: IsoDate, config: CardCycleConfig): InvoiceCycle {
  const { year, month } = parseDate(closingDate);

  let dueDate = makeDateClamped(year, month, config.dueDay);
  // O vencimento precisa vir depois do fechamento. Fecha dia 28 e vence dia 5?
  // Então vence em 5 do mês seguinte.
  if (!isAfter(dueDate, closingDate)) {
    dueDate = makeDateClamped(year, month + 1, config.dueDay);
  }

  const previousClosing = previousClosingDate(closingDate, config);

  return {
    // Referência é o mês do vencimento: "fatura de agosto" vence em agosto.
    referenceMonth: monthKey(dueDate),
    closingDate,
    dueDate,
    periodStart: previousClosing,
    // A fatura cobre até o dia anterior ao fechamento.
    periodEnd: addDaysIso(closingDate, -1),
  };
}

/** Fechamento imediatamente anterior a `closingDate`. */
function previousClosingDate(closingDate: IsoDate, config: CardCycleConfig): IsoDate {
  const previous = addMonths(closingDate, -1);
  const { year, month } = parseDate(previous);
  return closingDateIn(year, month, config.closingDay);
}

function addDaysIso(iso: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseDate(iso);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (n: number, size = 2): string => String(n).padStart(size, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * Resolve em qual fatura uma compra cai.
 *
 * @param purchaseDate data da compra
 * @param config dia de fechamento e de vencimento do cartão
 */
export function resolveInvoiceCycle(
  purchaseDate: IsoDate,
  config: CardCycleConfig,
): InvoiceCycle {
  assertDay(config.closingDay, 'Dia de fechamento');
  assertDay(config.dueDay, 'Dia de vencimento');

  const { year, month } = parseDate(purchaseDate);

  // Fechamento deste mês. Se a compra caiu no dia do fechamento ou depois, ela
  // pertence ao ciclo que fecha no mês seguinte.
  const thisMonthClosing = closingDateIn(year, month, config.closingDay);
  const closingDate = isSameOrAfter(purchaseDate, thisMonthClosing)
    ? closingDateIn(...nextMonth(year, month), config.closingDay)
    : thisMonthClosing;

  return cycleFromClosing(closingDate, config);
}

function nextMonth(year: number, month: number): [number, number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}

/** Ciclo de um mês de referência específico. */
export function cycleForReferenceMonth(
  referenceMonth: MonthKey,
  config: CardCycleConfig,
): InvoiceCycle {
  assertDay(config.closingDay, 'Dia de fechamento');
  assertDay(config.dueDay, 'Dia de vencimento');

  const [yearText, monthText] = referenceMonth.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw validation(`Mês de referência inválido: "${referenceMonth}". Use AAAA-MM.`);
  }

  // O vencimento define o mês de referência; o fechamento vem antes dele.
  const dueDate = makeDateClamped(year, month, config.dueDay);

  // Fechamento no mesmo mês do vencimento, se for antes; senão, no mês anterior.
  const sameMonthClosing = closingDateIn(year, month, config.closingDay);
  const closingDate = isAfter(dueDate, sameMonthClosing)
    ? sameMonthClosing
    : closingDateIn(...previousMonth(year, month), config.closingDay);

  return cycleFromClosing(closingDate, config);
}

function previousMonth(year: number, month: number): [number, number] {
  return month === 1 ? [year - 1, 12] : [year, month - 1];
}

/**
 * Ciclos consecutivos a partir de uma data — usado para gerar as faturas futuras
 * de um parcelamento.
 */
export function nextCycles(
  fromDate: IsoDate,
  config: CardCycleConfig,
  count: number,
): InvoiceCycle[] {
  if (count < 1) return [];

  const cycles: InvoiceCycle[] = [];
  let cycle = resolveInvoiceCycle(fromDate, config);

  for (let i = 0; i < count; i += 1) {
    cycles.push(cycle);
    // Avança um mês a partir do fechamento atual para achar o ciclo seguinte.
    cycle = resolveInvoiceCycle(addDaysIso(cycle.closingDate, 1), config);
  }

  return cycles;
}
