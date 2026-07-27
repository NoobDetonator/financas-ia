/**
 * Identificadores ULID (26 caracteres, Crockford base32).
 *
 * Preferidos a UUID v4 porque são **ordenáveis por tempo de criação**: o índice
 * da chave primária não fragmenta, `ORDER BY id` já dá ordem cronológica, e ao
 * depurar dá para saber quando a linha nasceu só de olhar o ID.
 *
 * Monotônicos dentro do mesmo milissegundo, então duas transações criadas no
 * mesmo tick continuam com ordem estável — importante para a sequência do
 * audit log e para paginação por cursor.
 */

import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: sem I, L, O, U
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ID_LEN = TIME_LEN + RANDOM_LEN;

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastMs = -1;
let lastRandom: number[] = [];

function randomIndices(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  // 256 é múltiplo exato de 32, então `% 32` não introduz viés de distribuição.
  return Array.from(bytes, (b) => b % ENCODING_LEN);
}

function increment(indices: readonly number[]): number[] {
  const out = indices.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const current = out[i] ?? 0;
    if (current < ENCODING_LEN - 1) {
      out[i] = current + 1;
      return out;
    }
    out[i] = 0;
  }
  // Estouro exigiria 32^16 IDs no mesmo milissegundo. Não acontece.
  return randomIndices();
}

function encodeTime(ms: number): string {
  let remaining = ms;
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = ENCODING.charAt(remaining % ENCODING_LEN) + out;
    remaining = Math.floor(remaining / ENCODING_LEN);
  }
  return out;
}

/**
 * Gera um novo ID.
 *
 * Usa o relógio real (`Date.now`) de propósito, não o relógio injetável de
 * `clock.ts`: congelar o tempo em teste não deve produzir IDs repetidos.
 */
export function newId(): string {
  const ms = Date.now();
  if (ms === lastMs) {
    lastRandom = increment(lastRandom);
  } else {
    lastMs = ms;
    lastRandom = randomIndices();
  }

  let id = encodeTime(ms);
  for (const index of lastRandom) {
    id += ENCODING.charAt(index);
  }
  return id;
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length === ID_LEN && ID_RE.test(value);
}

/** Extrai o instante de criação embutido no ID. Útil para depuração. */
export function idTimestamp(id: string): Date {
  if (!isId(id)) throw new Error(`ID inválido: "${id}"`);
  let ms = 0;
  for (const char of id.slice(0, TIME_LEN)) {
    const index = ENCODING.indexOf(char);
    if (index < 0) throw new Error(`ID inválido: "${id}"`);
    ms = ms * ENCODING_LEN + index;
  }
  return new Date(ms);
}

/**
 * Chave curta e estável derivada de um texto — usada em deduplicação de
 * importação e em fingerprint de insight.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // remove acentos (marcas combinantes, pós-NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
