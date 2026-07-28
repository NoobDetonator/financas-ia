/**
 * Dinheiro é sempre representado como **centavos em inteiro**.
 *
 * Regra do projeto: nenhum valor monetário passa por `number` fracionário em
 * momento algum — nem no banco, nem na API, nem nas ferramentas da IA.
 * Float quebra somas de dinheiro (0.1 + 0.2 !== 0.3) e o erro só aparece meses
 * depois, num relatório que não fecha.
 *
 * Convenção de sinal: negativo = saída, positivo = entrada.
 */

export const CENTS_PER_UNIT = 100;

/** Erro de conversão de valor monetário. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Garante que o valor é um inteiro de centavos utilizável. */
export function assertCents(value: number, label = 'valor'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyError(`${label} deve ser um número finito, recebido: ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(
      `${label} deve ser um inteiro de centavos (sem decimais), recebido: ${value}`,
    );
  }
  return value;
}

/**
 * Converte entrada humana em centavos.
 *
 * Aceita: `45`, `"45"`, `"45,90"`, `"45.90"`, `"R$ 1.234,56"`, `"1,234.56"`,
 * `"1.500"` (= mil e quinhentos), `"-45,90"`.
 *
 * Heurística de separador decimal, na ordem:
 *  1. Se há `.` e `,`, o **último** dos dois é o decimal (cobre pt-BR e en-US).
 *  2. Só `,` → é decimal (pt-BR).
 *  3. Só `.` seguido de exatamente 3 dígitos → é separador de milhar
 *     (`"1.500"` = 1500). Caso contrário é decimal (`"45.9"` = 45,90).
 *
 * Mais de 2 casas decimais são arredondadas (meio para cima): `"45,999"` → R$ 46,00.
 */
export function parseMoney(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new MoneyError(`Valor inválido: ${String(input)}`);
    }
    return Math.round(input * CENTS_PER_UNIT);
  }

  const original = input;
  let s = input.trim().replace(/\s/g, '');
  if (s === '') throw new MoneyError('Valor vazio.');

  // Remove símbolo de moeda e qualquer coisa que não seja dígito/separador/sinal.
  s = s.replace(/r\$/gi, '').replace(/[^\d.,+-]/g, '');

  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  // Contabilidade às vezes escreve "45,90-" para negativo.
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/[+-]/g, '');

  if (s === '' || !/\d/.test(s)) {
    throw new MoneyError(`Não consegui interpretar o valor: "${original}"`);
  }

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  /** `null` = não há parte decimal; todos os separadores são de milhar. */
  let decimalSep: '.' | ',' | null;
  if (lastComma >= 0 && lastDot >= 0) {
    decimalSep = lastComma > lastDot ? ',' : '.';
  } else if (lastComma >= 0) {
    decimalSep = ',';
  } else if (lastDot >= 0) {
    const digitsAfter = s.length - lastDot - 1;
    decimalSep = digitsAfter === 3 ? null : '.';
  } else {
    decimalSep = null;
  }

  let intPart: string;
  let fracPart: string;
  if (decimalSep === null) {
    intPart = s.replace(/[.,]/g, '');
    fracPart = '';
  } else {
    const idx = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, idx).replace(/[.,]/g, '');
    fracPart = s.slice(idx + 1).replace(/[.,]/g, '');
  }

  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) {
    throw new MoneyError(`Não consegui interpretar o valor: "${original}"`);
  }

  // Três dígitos garantem material para arredondar a terceira casa.
  const frac = fracPart.padEnd(3, '0');
  let cents = Number(intPart === '' ? '0' : intPart) * CENTS_PER_UNIT + Number(frac.slice(0, 2));
  if (Number(frac.charAt(2)) >= 5) cents += 1;

  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError(`Valor fora da faixa suportada: "${original}"`);
  }
  return negative ? -cents : cents;
}

export interface FormatMoneyOptions {
  /** Inclui o símbolo `R$`. Padrão: `true`. */
  symbol?: boolean;
  /** Força `+` em valores positivos. Padrão: `false`. */
  showSign?: boolean;
  /** Código da moeda, para o símbolo. Padrão: `'BRL'`. */
  currency?: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  BRL: 'R$',
  USD: 'US$',
  EUR: '€',
};

/**
 * Formata centavos em texto pt-BR: `123456` → `"R$ 1.234,56"`.
 *
 * Formata a partir do inteiro (sem dividir por 100 em float), então o último
 * centavo nunca se perde em arredondamento de ponto flutuante.
 */
export function formatMoney(cents: number, options: FormatMoneyOptions = {}): string {
  assertCents(cents, 'valor a formatar');
  const { symbol = true, showSign = false, currency = 'BRL' } = options;

  const negative = cents < 0;
  const abs = Math.abs(cents);
  const units = Math.trunc(abs / CENTS_PER_UNIT);
  const frac = abs % CENTS_PER_UNIT;

  const body = `${units.toLocaleString('pt-BR')},${String(frac).padStart(2, '0')}`;
  const sign = negative ? '-' : showSign ? '+' : '';
  const prefix = symbol ? `${CURRENCY_SYMBOLS[currency] ?? currency} ` : '';

  return `${sign}${prefix}${body}`;
}

/** Soma exata de centavos. */
export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += assertCents(v);
  if (!Number.isSafeInteger(total)) {
    throw new MoneyError('Soma excedeu a faixa de inteiros seguros.');
  }
  return total;
}

/**
 * Divide um total em `parts` parcelas cujo somatório é **exatamente** o total.
 *
 * R$ 100,00 em 3x não é 3 × R$ 33,33 (sobra 1 centavo). A sobra vai para as
 * primeiras parcelas, que é a prática do mercado: `[3334, 3333, 3333]`.
 */
export function splitEvenly(total: number, parts: number): number[] {
  assertCents(total, 'total a parcelar');
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`Número de parcelas inválido: ${parts}`);
  }

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / parts);
  const remainder = abs - base * parts;

  return Array.from({ length: parts }, (_unused, i) => sign * (base + (i < remainder ? 1 : 0)));
}

/** Arredondamento meio-para-cima em magnitude (simétrico para negativos). */
export function roundHalf(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
