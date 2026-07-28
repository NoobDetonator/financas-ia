/**
 * Datas e horas do projeto.
 *
 * Duas regras que evitam a maior parte dos bugs de data em app financeiro:
 *
 *  1. **Data civil** (`IsoDate`, `YYYY-MM-DD`) é o tipo do domínio. Competência
 *     de transação, vencimento de fatura e dia de recorrência não têm hora nem
 *     fuso — tratá-los como `Date` faz a transação do dia 1º virar dia 31 do mês
 *     anterior dependendo do fuso.
 *  2. Toda aritmética usa `Date.UTC` internamente, então horário de verão nunca
 *     desloca um cálculo. O único ponto sensível a fuso é "que dia é hoje", que
 *     usa explicitamente o timezone da aplicação.
 *
 * O relógio é injetável (`setClock`) porque testar recorrência, fechamento de
 * fatura e projeção de saldo exige congelar o tempo.
 */

/** Data civil no formato `YYYY-MM-DD`. */
export type IsoDate = string;
/** Timestamp UTC ISO-8601, ex. `2026-07-26T14:03:11.482Z`. */
export type IsoDateTime = string;
/** Mês de referência no formato `YYYY-MM`. */
export type MonthKey = string;

export const APP_TIMEZONE = 'America/Sao_Paulo';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export class DateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateError';
  }
}

// ── Relógio injetável ───────────────────────────────────────────────────────

let nowProvider: () => Date = () => new Date();

/** Congela ou controla o relógio. Use apenas em testes e seeds. */
export function setClock(provider: (() => Date) | Date): void {
  nowProvider = provider instanceof Date ? () => new Date(provider) : provider;
}

/** Restaura o relógio real. */
export function resetClock(): void {
  nowProvider = () => new Date();
}

/** Timestamp atual em UTC ISO. É o formato gravado em todo `created_at`. */
export function nowIso(): IsoDateTime {
  return nowProvider().toISOString();
}

/** Data de hoje no fuso da aplicação. */
export function today(timeZone: string = APP_TIMEZONE): IsoDate {
  return toIsoDateInZone(nowProvider(), timeZone);
}

/** Mês corrente no fuso da aplicação. */
export function currentMonth(timeZone: string = APP_TIMEZONE): MonthKey {
  return monthKey(today(timeZone));
}

/** Converte um instante para a data civil observada num fuso. */
export function toIsoDateInZone(instant: Date, timeZone: string = APP_TIMEZONE): IsoDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!year || !month || !day) {
    throw new DateError(`Não consegui obter a data no fuso "${timeZone}".`);
  }
  return `${year}-${month}-${day}`;
}

// ── Parse / construção ──────────────────────────────────────────────────────

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= lastDayOfMonth(year, month);
}

export function parseDate(iso: IsoDate): DateParts {
  const m = DATE_RE.exec(iso);
  if (!m) throw new DateError(`Data inválida (esperado YYYY-MM-DD): "${iso}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) throw new DateError(`Mês inválido em "${iso}"`);
  if (day < 1 || day > lastDayOfMonth(year, month)) {
    throw new DateError(`Dia inválido em "${iso}"`);
  }
  return { year, month, day };
}

/** Monta uma `IsoDate`, validando. Para acomodar dia 31 em fevereiro use {@link clampDay}. */
export function makeDate(year: number, month: number, day: number): IsoDate {
  const iso = `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  parseDate(iso); // valida ou lança
  return iso;
}

/** Número de dias do mês. Trata ano bissexto. */
export function lastDayOfMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new DateError(`Mês inválido: ${month}`);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Ajusta um dia do mês para caber no mês informado.
 *
 * Essencial para cartão e recorrência: fechamento no dia 31 precisa cair no dia
 * 28 (ou 29) em fevereiro. `day = -1` significa "último dia do mês".
 */
export function clampDay(year: number, month: number, day: number): number {
  const last = lastDayOfMonth(year, month);
  if (day === -1) return last;
  if (day < 1) throw new DateError(`Dia do mês inválido: ${day}`);
  return Math.min(day, last);
}

/**
 * Constrói uma data ajustando o dia ao mês, e aceitando mês fora de 1..12
 * (`month = 13` vira janeiro do ano seguinte). Nunca lança por dia fora de faixa.
 */
export function makeDateClamped(year: number, month: number, day: number): IsoDate {
  const total = year * 12 + (month - 1);
  const y = Math.floor(total / 12);
  const m = floorMod(total, 12) + 1;
  return makeDate(y, m, clampDay(y, m, day));
}

// ── Aritmética ──────────────────────────────────────────────────────────────

function toUtc(iso: IsoDate): Date {
  const { year, month, day } = parseDate(iso);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtc(d: Date): IsoDate {
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** Soma meses preservando o dia quando possível: `31/01 + 1 mês` = `28/02`. */
export function addMonths(iso: IsoDate, months: number): IsoDate {
  const { year, month, day } = parseDate(iso);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = floorMod(total, 12) + 1;
  return makeDate(y, m, clampDay(y, m, day));
}

export function startOfMonth(iso: IsoDate): IsoDate {
  const { year, month } = parseDate(iso);
  return makeDate(year, month, 1);
}

export function endOfMonth(iso: IsoDate): IsoDate {
  const { year, month } = parseDate(iso);
  return makeDate(year, month, lastDayOfMonth(year, month));
}

/** Dias completos de `from` até `to`. Negativo se `to` for anterior. */
export function diffDays(from: IsoDate, to: IsoDate): number {
  const ms = toUtc(to).getTime() - toUtc(from).getTime();
  return Math.round(ms / 86_400_000);
}

/** Meses completos entre duas datas (ignora o dia). */
export function diffMonths(from: IsoDate, to: IsoDate): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

export function compareDate(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  // Formato ISO é ordenável lexicograficamente — validamos antes para não
  // comparar lixo silenciosamente.
  parseDate(a);
  parseDate(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export const isBefore = (a: IsoDate, b: IsoDate): boolean => compareDate(a, b) < 0;
export const isAfter = (a: IsoDate, b: IsoDate): boolean => compareDate(a, b) > 0;
export const isSameOrBefore = (a: IsoDate, b: IsoDate): boolean => compareDate(a, b) <= 0;
export const isSameOrAfter = (a: IsoDate, b: IsoDate): boolean => compareDate(a, b) >= 0;

/** Dia da semana: 0 = domingo … 6 = sábado. */
export function weekday(iso: IsoDate): number {
  return toUtc(iso).getUTCDay();
}

// ── Mês de referência (YYYY-MM) ─────────────────────────────────────────────

export function monthKey(iso: IsoDate): MonthKey {
  const { year, month } = parseDate(iso);
  return `${pad4(year)}-${pad2(month)}`;
}

export function isMonthKeyLike(value: unknown): value is MonthKey {
  if (typeof value !== 'string') return false;
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export function parseMonthKey(key: MonthKey): { year: number; month: number } {
  const m = MONTH_RE.exec(key);
  if (!m) throw new DateError(`Mês de referência inválido (esperado YYYY-MM): "${key}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new DateError(`Mês inválido: "${key}"`);
  return { year, month };
}

export function addMonthKey(key: MonthKey, months: number): MonthKey {
  const { year, month } = parseMonthKey(key);
  const total = year * 12 + (month - 1) + months;
  return `${pad4(Math.floor(total / 12))}-${pad2(floorMod(total, 12) + 1)}`;
}

export function diffMonthKeys(from: MonthKey, to: MonthKey): number {
  const a = parseMonthKey(from);
  const b = parseMonthKey(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/** Primeiro e último dia do mês de referência. */
export function monthRange(key: MonthKey): { start: IsoDate; end: IsoDate } {
  const { year, month } = parseMonthKey(key);
  return {
    start: makeDate(year, month, 1),
    end: makeDate(year, month, lastDayOfMonth(year, month)),
  };
}

/** Lista de meses de `from` a `to`, inclusive. */
export function monthsBetween(from: MonthKey, to: MonthKey): MonthKey[] {
  const count = diffMonthKeys(from, to);
  if (count < 0) return [];
  return Array.from({ length: count + 1 }, (_unused, i) => addMonthKey(from, i));
}

// ── Formatação pt-BR ────────────────────────────────────────────────────────

const MONTH_NAMES_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
] as const;

/** `2026-07-26` → `26/07/2026`. */
export function formatDateBr(iso: IsoDate): string {
  const { year, month, day } = parseDate(iso);
  return `${pad2(day)}/${pad2(month)}/${pad4(year)}`;
}

/** `2026-07` → `julho de 2026`. */
export function formatMonthBr(key: MonthKey): string {
  const { year, month } = parseMonthKey(key);
  return `${MONTH_NAMES_PT[month - 1]} de ${year}`;
}

// ── Utilitários ─────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/** Módulo que sempre retorna resultado não-negativo (`-1 % 12` = 11, não -1). */
function floorMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
