/**
 * Expansão de regras de repetição em datas concretas.
 *
 * Função pura, isolada para poder ser testada exaustivamente — recorrência é a
 * segunda maior fonte de bug de data num app financeiro, depois de fatura.
 *
 * Não usa RRULE completo (RFC 5545) de propósito: dele só interessam quatro
 * frequências e um intervalo, e implementar o padrão inteiro traria complexidade
 * que nunca seria exercida. O que existe aqui cobre conta de luz, aluguel,
 * assinatura, salário e mesada — que é o universo real do caso de uso.
 *
 * Casos que os testes cobrem: dia 31 em meses curtos, 29 de fevereiro,
 * bimestral/trimestral, fim por data e por número de ocorrências.
 */

import {
  addDays,
  addMonths,
  clampDay,
  compareDate,
  isAfter,
  isSameOrBefore,
  makeDateClamped,
  parseDate,
  weekday as weekdayOf,
  type IsoDate,
} from '../core/clock.js';
import { validation } from '../core/errors.js';
import type { RecurrenceFreq } from '../db/schema.js';

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** A cada N períodos. `monthly` + `interval: 3` = trimestral. */
  interval: number;
  startDate: IsoDate;
  endDate?: IsoDate | null;
  maxOccurrences?: number | null;
  /** Para `monthly`: dia do mês (1-31, ou -1 = último dia). Padrão: dia de `startDate`. */
  dayOfMonth?: number | null;
  /** Para `weekly`: 0 = domingo … 6 = sábado. Padrão: dia da semana de `startDate`. */
  weekday?: number | null;
  /** Para `yearly`: mês 1-12. Padrão: mês de `startDate`. */
  month?: number | null;
}

/** Limite de segurança: uma regra malformada não pode gerar datas para sempre. */
const MAX_ITERATIONS = 10_000;

function assertRule(rule: RecurrenceRule): void {
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw validation(`Intervalo de recorrência inválido: ${rule.interval}. Use um inteiro ≥ 1.`);
  }
  if (rule.dayOfMonth != null && rule.dayOfMonth !== -1 && (rule.dayOfMonth < 1 || rule.dayOfMonth > 31)) {
    throw validation(`Dia do mês inválido: ${rule.dayOfMonth}. Use 1 a 31, ou -1 para o último dia.`);
  }
  if (rule.weekday != null && (rule.weekday < 0 || rule.weekday > 6)) {
    throw validation(`Dia da semana inválido: ${rule.weekday}. Use 0 (domingo) a 6 (sábado).`);
  }
  if (rule.month != null && (rule.month < 1 || rule.month > 12)) {
    throw validation(`Mês inválido: ${rule.month}.`);
  }
  if (rule.endDate && isAfter(rule.startDate, rule.endDate)) {
    throw validation('A data final da recorrência é anterior à inicial.');
  }
  parseDate(rule.startDate);
}

/**
 * Primeira ocorrência da regra, que pode não ser a `startDate`.
 *
 * Exemplo: regra mensal no dia 10 começando em 20/01 tem a primeira ocorrência
 * em 10/02 — o dia 10 de janeiro já passou.
 */
function firstOccurrence(rule: RecurrenceRule): IsoDate {
  const start = parseDate(rule.startDate);

  switch (rule.freq) {
    case 'daily':
      return rule.startDate;

    case 'weekly': {
      const target = rule.weekday ?? weekdayOf(rule.startDate);
      const current = weekdayOf(rule.startDate);
      const delta = (target - current + 7) % 7;
      return addDays(rule.startDate, delta);
    }

    case 'monthly': {
      const day = rule.dayOfMonth ?? start.day;
      const candidate = makeDateClamped(start.year, start.month, day);
      // Se o dia deste mês já passou, vai para o próximo ciclo.
      return isSameOrBefore(rule.startDate, candidate)
        ? candidate
        : makeDateClamped(start.year, start.month + rule.interval, day);
    }

    case 'yearly': {
      const month = rule.month ?? start.month;
      const day = rule.dayOfMonth ?? start.day;
      const candidate = makeDateClamped(start.year, month, day);
      return isSameOrBefore(rule.startDate, candidate)
        ? candidate
        : makeDateClamped(start.year + rule.interval, month, day);
    }
  }
}

/**
 * Avança uma ocorrência.
 *
 * Para `monthly`/`yearly`, avança a partir do **mês de referência** e reencaixa o
 * dia — nunca a partir da data anterior já encaixada. Sem isso, uma regra "dia 31"
 * que passou por fevereiro (28) ficaria presa no dia 28 para sempre.
 */
function advance(rule: RecurrenceRule, occurrenceIndex: number, first: IsoDate): IsoDate {
  const base = parseDate(first);

  switch (rule.freq) {
    case 'daily':
      return addDays(first, occurrenceIndex * rule.interval);

    case 'weekly':
      return addDays(first, occurrenceIndex * rule.interval * 7);

    case 'monthly': {
      const day = rule.dayOfMonth ?? base.day;
      return makeDateClamped(base.year, base.month + occurrenceIndex * rule.interval, day);
    }

    case 'yearly': {
      const day = rule.dayOfMonth ?? base.day;
      const month = rule.month ?? base.month;
      return makeDateClamped(base.year + occurrenceIndex * rule.interval, month, day);
    }
  }
}

/**
 * Todas as ocorrências da regra dentro de `[from, to]`.
 *
 * Respeita `endDate` e `maxOccurrences` contando desde a **primeira** ocorrência
 * da regra, não desde `from` — do contrário uma regra limitada a 12 parcelas
 * geraria 12 novas a cada janela consultada.
 */
export function occurrencesBetween(rule: RecurrenceRule, from: IsoDate, to: IsoDate): IsoDate[] {
  assertRule(rule);
  if (isAfter(from, to)) return [];

  const first = firstOccurrence(rule);
  const limit = rule.maxOccurrences ?? Number.POSITIVE_INFINITY;
  const result: IsoDate[] = [];

  for (let index = 0; index < MAX_ITERATIONS; index += 1) {
    if (index >= limit) break;

    const date = advance(rule, index, first);

    if (rule.endDate && isAfter(date, rule.endDate)) break;
    if (isAfter(date, to)) break;
    if (compareDate(date, from) >= 0) result.push(date);
  }

  return result;
}

/** Próxima ocorrência a partir de uma data (inclusive). */
export function nextOccurrence(rule: RecurrenceRule, after: IsoDate): IsoDate | null {
  assertRule(rule);

  const first = firstOccurrence(rule);
  const limit = rule.maxOccurrences ?? Number.POSITIVE_INFINITY;

  for (let index = 0; index < MAX_ITERATIONS; index += 1) {
    if (index >= limit) return null;

    const date = advance(rule, index, first);
    if (rule.endDate && isAfter(date, rule.endDate)) return null;
    if (compareDate(date, after) >= 0) return date;
  }

  return null;
}

/** Descrição legível da regra, para exibir e para a IA narrar. */
export function describeRule(rule: RecurrenceRule): string {
  const every = rule.interval === 1 ? '' : ` a cada ${rule.interval}`;

  switch (rule.freq) {
    case 'daily':
      return rule.interval === 1 ? 'todos os dias' : `a cada ${rule.interval} dias`;

    case 'weekly': {
      const names = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
      const day = names[rule.weekday ?? weekdayOf(rule.startDate)] ?? '';
      return rule.interval === 1 ? `toda ${day}` : `${day}${every} semanas`;
    }

    case 'monthly': {
      const day = rule.dayOfMonth ?? parseDate(rule.startDate).day;
      const dayText = day === -1 ? 'no último dia do mês' : `no dia ${day}`;
      return rule.interval === 1 ? `todo mês ${dayText}` : `${dayText}${every} meses`;
    }

    case 'yearly': {
      const months = [
        'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
      ];
      const monthIndex = (rule.month ?? parseDate(rule.startDate).month) - 1;
      const day = rule.dayOfMonth ?? parseDate(rule.startDate).day;
      return `todo ano em ${day} de ${months[monthIndex] ?? ''}`;
    }
  }
}

export { clampDay, addMonths };
