/**
 * Resolução de expressões de data em português.
 *
 * "ontem", "sexta passada", "dia 5", "semana passada" → data ISO concreta.
 *
 * Isto é **determinístico de propósito**, e não trabalho do LLM. Um modelo não
 * sabe com segurança que dia é hoje, e erra aritmética de calendário — pedir para
 * ele resolver "sexta passada" produz uma data plausível e errada, que é o pior
 * resultado possível num lançamento financeiro.
 *
 * A divisão de trabalho é: o LLM extrai a **frase** de data do texto ("gastei 45
 * ontem" → `"ontem"`), e esta função a converte.
 */

import {
  addDays,
  addMonths,
  isAfter,
  isIsoDate,
  makeDateClamped,
  parseDate,
  today,
  weekday as weekdayOf,
  type IsoDate,
} from '../core/clock.js';
import { slugify } from '../core/ids.js';

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  'segunda-feira': 1,
  terca: 2,
  'terca-feira': 2,
  quarta: 3,
  'quarta-feira': 3,
  quinta: 4,
  'quinta-feira': 4,
  sexta: 5,
  'sexta-feira': 5,
  sabado: 6,
};

const MONTHS: Record<string, number> = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12,
};

export interface DatePhraseResult {
  date: IsoDate;
  /** Como a frase foi interpretada, para a IA poder explicar. */
  interpretation: string;
}

/**
 * Converte uma expressão de data em português numa data concreta.
 *
 * Devolve `null` quando a frase não é reconhecida — cabe a quem chamou decidir
 * o padrão (normalmente hoje), em vez de esta função adivinhar.
 */
export function resolveDatePhrase(
  phrase: string | undefined | null,
  reference: IsoDate = today(),
): DatePhraseResult | null {
  if (!phrase) return null;

  const raw = phrase.trim();
  if (raw === '') return null;

  // Já é uma data ISO.
  if (isIsoDate(raw)) return { date: raw, interpretation: raw };

  // Formato brasileiro: 26/07/2026 ou 26/07.
  const brDate = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(raw);
  if (brDate) {
    const day = Number(brDate[1]);
    const month = Number(brDate[2]);
    let year = brDate[3] ? Number(brDate[3]) : parseDate(reference).year;
    if (year < 100) year += year < 70 ? 2000 : 1900;

    const date = makeDateClamped(year, month, day);
    // Sem ano informado e a data cairia no futuro? Provavelmente é do ano passado
    // ("gastei em 28/12" dito em janeiro).
    if (!brDate[3] && isAfter(date, reference)) {
      return {
        date: makeDateClamped(year - 1, month, day),
        interpretation: `${day}/${month} do ano passado (a data deste ano ainda não chegou)`,
      };
    }
    return { date, interpretation: `${day}/${month}/${year}` };
  }

  const text = slugify(raw);

  // ── Referências simples ──────────────────────────────────────────────────
  if (text === 'hoje' || text === 'agora') return { date: reference, interpretation: 'hoje' };
  if (text === 'ontem') return { date: addDays(reference, -1), interpretation: 'ontem' };
  if (text === 'anteontem') return { date: addDays(reference, -2), interpretation: 'anteontem' };
  if (text === 'amanha') return { date: addDays(reference, 1), interpretation: 'amanhã' };
  if (text === 'depois-de-amanha') {
    return { date: addDays(reference, 2), interpretation: 'depois de amanhã' };
  }

  // ── "há N dias" / "em N dias" ────────────────────────────────────────────
  const relativeDays = /^(?:ha|faz|fazem)-(\d+)-(dia|dias|semana|semanas|mes|meses)$/.exec(text);
  if (relativeDays) {
    const amount = Number(relativeDays[1]);
    const unit = relativeDays[2]!;
    if (unit.startsWith('dia')) {
      return { date: addDays(reference, -amount), interpretation: `há ${amount} dia(s)` };
    }
    if (unit.startsWith('semana')) {
      return { date: addDays(reference, -amount * 7), interpretation: `há ${amount} semana(s)` };
    }
    return { date: addMonths(reference, -amount), interpretation: `há ${amount} mês(es)` };
  }

  const inDays = /^(?:em|daqui-a|daqui)-(\d+)-(dia|dias|semana|semanas|mes|meses)$/.exec(text);
  if (inDays) {
    const amount = Number(inDays[1]);
    const unit = inDays[2]!;
    if (unit.startsWith('dia')) {
      return { date: addDays(reference, amount), interpretation: `em ${amount} dia(s)` };
    }
    if (unit.startsWith('semana')) {
      return { date: addDays(reference, amount * 7), interpretation: `em ${amount} semana(s)` };
    }
    return { date: addMonths(reference, amount), interpretation: `em ${amount} mês(es)` };
  }

  // ── Dia da semana ────────────────────────────────────────────────────────
  // O modificador aparece tanto depois ("sexta que vem") quanto antes
  // ("próxima sexta") do dia da semana — as duas ordens são naturais em
  // português e as duas precisam funcionar.
  const weekdaySuffix = /^(?:na-|no-)?([a-z-]+?)(?:-(passada|passado|ultima|ultimo|que-vem|proxima|proximo|retrasada))?$/.exec(text);
  const weekdayPrefix = /^(?:na-|no-)?(proxima|proximo|ultima|ultimo)-([a-z-]+)$/.exec(text);

  const weekdayMatch = weekdayPrefix
    ? { dayName: weekdayPrefix[2]!, modifier: weekdayPrefix[1] }
    : weekdaySuffix
      ? { dayName: weekdaySuffix[1]!, modifier: weekdaySuffix[2] }
      : null;

  if (weekdayMatch) {
    const { dayName, modifier } = weekdayMatch;
    const target = WEEKDAYS[dayName];

    if (target !== undefined) {
      const current = weekdayOf(reference);

      if (modifier === 'que-vem' || modifier === 'proxima' || modifier === 'proximo') {
        // Próxima ocorrência futura, nunca hoje.
        const delta = ((target - current + 7) % 7) || 7;
        return { date: addDays(reference, delta), interpretation: `próxima ${dayName}` };
      }

      if (modifier === 'retrasada') {
        const delta = ((current - target + 7) % 7) || 7;
        return { date: addDays(reference, -delta - 7), interpretation: `${dayName} retrasada` };
      }

      // Padrão (com ou sem "passada"): a ocorrência mais recente no passado.
      // "sexta" dito numa segunda quer dizer a sexta que passou.
      const delta = ((current - target + 7) % 7) || 7;
      return {
        date: addDays(reference, -delta),
        interpretation: modifier ? `${dayName} passada` : `última ${dayName}`,
      };
    }
  }

  // ── "dia 5", "dia 5 de agosto" ───────────────────────────────────────────
  const dayOfMonth = /^dia-(\d{1,2})(?:-de-([a-z]+))?$/.exec(text);
  if (dayOfMonth) {
    const day = Number(dayOfMonth[1]);
    const monthName = dayOfMonth[2];
    const { year, month } = parseDate(reference);

    if (monthName) {
      const targetMonth = MONTHS[monthName];
      if (targetMonth !== undefined) {
        const date = makeDateClamped(year, targetMonth, day);
        // Mês nomeado que cairia no futuro: é do ano passado.
        return isAfter(date, reference)
          ? {
              date: makeDateClamped(year - 1, targetMonth, day),
              interpretation: `dia ${day} de ${monthName} do ano passado`,
            }
          : { date, interpretation: `dia ${day} de ${monthName}` };
      }
    }

    const thisMonth = makeDateClamped(year, month, day);
    // "dia 5" dito no dia 2 provavelmente se refere ao mês anterior.
    return isAfter(thisMonth, reference)
      ? { date: makeDateClamped(year, month - 1, day), interpretation: `dia ${day} do mês passado` }
      : { date: thisMonth, interpretation: `dia ${day} deste mês` };
  }

  // ── Períodos ─────────────────────────────────────────────────────────────
  if (text === 'semana-passada') {
    return { date: addDays(reference, -7), interpretation: 'semana passada' };
  }
  if (text === 'mes-passado') {
    return { date: addMonths(reference, -1), interpretation: 'mês passado' };
  }
  if (text === 'inicio-do-mes') {
    const { year, month } = parseDate(reference);
    return { date: makeDateClamped(year, month, 1), interpretation: 'início do mês' };
  }
  if (text === 'fim-do-mes' || text === 'final-do-mes') {
    const { year, month } = parseDate(reference);
    return { date: makeDateClamped(year, month, -1), interpretation: 'fim do mês' };
  }

  return null;
}

/**
 * Extrai uma frase de data de um texto livre e resolve.
 *
 * Usado como rede de segurança: se o modelo não isolou a expressão de data, ainda
 * há chance de encontrá-la por varredura.
 */
export function findDateInText(text: string, reference: IsoDate = today()): DatePhraseResult | null {
  const normalized = slugify(text);

  const patterns = [
    /\b(anteontem|ontem|hoje|amanha)\b/,
    /\bdepois-de-amanha\b/,
    /\b(semana-passada|mes-passado|inicio-do-mes|fim-do-mes|final-do-mes)\b/,
    /\b(?:ha|faz)-\d+-(?:dias?|semanas?|mes|meses)\b/,
    /\bdia-\d{1,2}(?:-de-[a-z]+)?\b/,
    /\b(?:domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?(?:-(?:passada|passado|que-vem|proxima|retrasada))?\b/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match) {
      const resolved = resolveDatePhrase(match[0].replace(/-/g, ' '), reference);
      if (resolved) return resolved;
    }
  }

  // Data numérica em qualquer posição do texto.
  const numeric = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/.exec(text);
  if (numeric) return resolveDatePhrase(numeric[1], reference);

  return null;
}
