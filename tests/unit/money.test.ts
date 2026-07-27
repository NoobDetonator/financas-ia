import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoney,
  formatMoney,
  splitEvenly,
  splitByWeights,
  sumCents,
  applyBps,
  MoneyError,
} from '../../src/core/money.js';

describe('parseMoney', () => {
  test('aceita número e string simples', () => {
    assert.equal(parseMoney(45), 4500);
    assert.equal(parseMoney('45'), 4500);
    assert.equal(parseMoney(45.9), 4590);
    assert.equal(parseMoney(0), 0);
  });

  test('vírgula é sempre decimal (pt-BR)', () => {
    assert.equal(parseMoney('45,90'), 4590);
    assert.equal(parseMoney('45,9'), 4590);
    assert.equal(parseMoney('0,05'), 5);
  });

  test('ponto seguido de 3 dígitos é separador de milhar', () => {
    assert.equal(parseMoney('1.500'), 150_000);
    assert.equal(parseMoney('1.234.567'), 123_456_700);
  });

  test('ponto seguido de 1 ou 2 dígitos é decimal', () => {
    assert.equal(parseMoney('45.9'), 4590);
    assert.equal(parseMoney('45.90'), 4590);
  });

  test('com os dois separadores, o último é o decimal', () => {
    assert.equal(parseMoney('1.234,56'), 123_456);
    assert.equal(parseMoney('1,234.56'), 123_456);
  });

  test('ignora símbolo de moeda e espaços', () => {
    assert.equal(parseMoney('R$ 1.234,56'), 123_456);
    assert.equal(parseMoney('  r$45,90  '), 4590);
  });

  test('trata negativos, inclusive o sinal ao final', () => {
    assert.equal(parseMoney('-45,90'), -4590);
    assert.equal(parseMoney('45,90-'), -4590);
    assert.equal(parseMoney(-45.9), -4590);
  });

  test('arredonda além da segunda casa decimal', () => {
    assert.equal(parseMoney('45,999'), 4600);
    assert.equal(parseMoney('45,994'), 4599);
    assert.equal(parseMoney('0,005'), 1);
  });

  test('recusa entrada sem dígitos', () => {
    assert.throws(() => parseMoney(''), MoneyError);
    assert.throws(() => parseMoney('abc'), MoneyError);
    assert.throws(() => parseMoney('R$'), MoneyError);
    assert.throws(() => parseMoney(Number.NaN), MoneyError);
  });
});

describe('formatMoney', () => {
  test('formata em pt-BR', () => {
    assert.equal(formatMoney(123_456), 'R$ 1.234,56');
    assert.equal(formatMoney(4590), 'R$ 45,90');
    assert.equal(formatMoney(5), 'R$ 0,05');
    assert.equal(formatMoney(0), 'R$ 0,00');
  });

  test('sinal negativo vem antes do símbolo', () => {
    assert.equal(formatMoney(-4590), '-R$ 45,90');
  });

  test('opções de sinal e símbolo', () => {
    assert.equal(formatMoney(4590, { showSign: true }), '+R$ 45,90');
    assert.equal(formatMoney(4590, { symbol: false }), '45,90');
  });

  test('não perde centavo em valor alto', () => {
    // Divisão em float (99999999.99) já erraria a última casa.
    assert.equal(formatMoney(9_999_999_999), 'R$ 99.999.999,99');
  });

  test('recusa valor não inteiro', () => {
    assert.throws(() => formatMoney(45.5), MoneyError);
  });
});

describe('splitEvenly', () => {
  test('divisão exata', () => {
    assert.deepEqual(splitEvenly(30_000, 3), [10_000, 10_000, 10_000]);
  });

  test('sobra de centavos vai para as primeiras parcelas', () => {
    assert.deepEqual(splitEvenly(10_000, 3), [3334, 3333, 3333]);
    assert.deepEqual(splitEvenly(10_001, 3), [3334, 3334, 3333]);
  });

  test('preserva o sinal', () => {
    assert.deepEqual(splitEvenly(-10_000, 3), [-3334, -3333, -3333]);
  });

  test('parcela única devolve o total', () => {
    assert.deepEqual(splitEvenly(4590, 1), [4590]);
  });

  test('a soma das parcelas é sempre exatamente o total', () => {
    // A invariante que impede o clássico "fatura fecha 1 centavo diferente".
    for (let total = 0; total <= 5000; total += 7) {
      for (let parts = 1; parts <= 24; parts += 1) {
        const slices = splitEvenly(total, parts);
        assert.equal(sumCents(slices), total, `total=${total} parts=${parts}`);
        assert.equal(slices.length, parts);
        const max = Math.max(...slices);
        const min = Math.min(...slices);
        assert.ok(max - min <= 1, `parcelas desbalanceadas: total=${total} parts=${parts}`);
      }
    }
  });

  test('recusa número de parcelas inválido', () => {
    assert.throws(() => splitEvenly(1000, 0), MoneyError);
    assert.throws(() => splitEvenly(1000, -3), MoneyError);
    assert.throws(() => splitEvenly(1000, 2.5), MoneyError);
  });
});

describe('splitByWeights', () => {
  test('rateia proporcionalmente', () => {
    assert.deepEqual(splitByWeights(10_000, [1, 1]), [5000, 5000]);
    assert.deepEqual(splitByWeights(10_000, [3, 1]), [7500, 2500]);
  });

  test('sobra vai para o maior peso e a soma fecha', () => {
    const slices = splitByWeights(10_000, [1, 1, 1]);
    assert.equal(sumCents(slices), 10_000);
    assert.deepEqual(slices, [3334, 3333, 3333]);
  });

  test('a soma fecha para qualquer combinação', () => {
    const cases: number[][] = [[1, 2, 3], [7, 11], [1, 1, 1, 1, 1, 1, 1], [99, 1], [5]];
    for (const weights of cases) {
      for (let total = 1; total <= 999; total += 13) {
        assert.equal(sumCents(splitByWeights(total, weights)), total, `total=${total} w=${weights}`);
      }
    }
  });

  test('recusa pesos inválidos', () => {
    assert.throws(() => splitByWeights(1000, []), MoneyError);
    assert.throws(() => splitByWeights(1000, [0, 0]), MoneyError);
    assert.throws(() => splitByWeights(1000, [-1, 2]), MoneyError);
  });
});

describe('applyBps', () => {
  test('aplica taxa em basis points', () => {
    assert.equal(applyBps(100_000, 1000), 10_000); // 10%
    assert.equal(applyBps(100_000, 125), 1250); // 1,25%
  });

  test('arredonda simetricamente para negativos', () => {
    assert.equal(applyBps(-100_000, 1000), -10_000);
  });
});

describe('sumCents', () => {
  test('soma exata', () => {
    assert.equal(sumCents([1, 2, 3]), 6);
    assert.equal(sumCents([]), 0);
    assert.equal(sumCents([-4590, 4590]), 0);
  });

  test('recusa valor fracionário na lista', () => {
    assert.throws(() => sumCents([1, 2.5]), MoneyError);
  });
});
