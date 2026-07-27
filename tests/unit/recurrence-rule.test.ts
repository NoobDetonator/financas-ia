import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  occurrencesBetween,
  nextOccurrence,
  describeRule,
  type RecurrenceRule,
} from '../../src/services/recurrence-rule.js';
import { AppError } from '../../src/core/errors.js';

const monthly = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  freq: 'monthly',
  interval: 1,
  startDate: '2026-01-10',
  ...overrides,
});

describe('mensal', () => {
  test('gera o mesmo dia de cada mês', () => {
    assert.deepEqual(occurrencesBetween(monthly(), '2026-01-01', '2026-04-30'), [
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
      '2026-04-10',
    ]);
  });

  test('dia 31 encaixa nos meses curtos sem ficar preso', () => {
    // O bug clássico: depois de encaixar em 28/02, a regra passaria a gerar dia 28
    // para sempre. Aqui março volta para 31.
    assert.deepEqual(
      occurrencesBetween(monthly({ startDate: '2026-01-31', dayOfMonth: 31 }), '2026-01-01', '2026-06-30'),
      ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'],
    );
  });

  test('dia 31 em fevereiro de ano bissexto', () => {
    assert.deepEqual(
      occurrencesBetween(monthly({ startDate: '2028-01-31', dayOfMonth: 31 }), '2028-02-01', '2028-02-29'),
      ['2028-02-29'],
    );
  });

  test('dayOfMonth = -1 é o último dia do mês', () => {
    assert.deepEqual(
      occurrencesBetween(monthly({ startDate: '2026-01-01', dayOfMonth: -1 }), '2026-01-01', '2026-04-30'),
      ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'],
    );
  });

  test('primeira ocorrência pode não ser a data inicial', () => {
    // Começa em 20/01 mas cobra no dia 10: a primeira é 10/02.
    assert.deepEqual(
      occurrencesBetween(monthly({ startDate: '2026-01-20', dayOfMonth: 10 }), '2026-01-01', '2026-03-31'),
      ['2026-02-10', '2026-03-10'],
    );
  });

  test('trimestral', () => {
    assert.deepEqual(
      occurrencesBetween(monthly({ interval: 3 }), '2026-01-01', '2026-12-31'),
      ['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10'],
    );
  });

  test('atravessa a virada de ano', () => {
    assert.deepEqual(
      occurrencesBetween(monthly({ startDate: '2026-11-15' }), '2026-11-01', '2027-02-28'),
      ['2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15'],
    );
  });
});

describe('diária e semanal', () => {
  test('diária', () => {
    assert.deepEqual(
      occurrencesBetween({ freq: 'daily', interval: 1, startDate: '2026-07-01' }, '2026-07-01', '2026-07-04'),
      ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'],
    );
  });

  test('a cada 3 dias', () => {
    assert.deepEqual(
      occurrencesBetween({ freq: 'daily', interval: 3, startDate: '2026-07-01' }, '2026-07-01', '2026-07-10'),
      ['2026-07-01', '2026-07-04', '2026-07-07', '2026-07-10'],
    );
  });

  test('semanal cai sempre no mesmo dia da semana', () => {
    // 2026-07-27 é uma segunda-feira.
    const dates = occurrencesBetween(
      { freq: 'weekly', interval: 1, startDate: '2026-07-27' },
      '2026-07-01',
      '2026-08-31',
    );
    assert.deepEqual(dates, ['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31']);
  });

  test('semanal ajusta para o dia da semana pedido', () => {
    // Começa domingo 26/07 mas quer sexta (5): primeira é 31/07.
    const dates = occurrencesBetween(
      { freq: 'weekly', interval: 1, startDate: '2026-07-26', weekday: 5 },
      '2026-07-01',
      '2026-08-15',
    );
    assert.deepEqual(dates, ['2026-07-31', '2026-08-07', '2026-08-14']);
  });

  test('quinzenal', () => {
    assert.deepEqual(
      occurrencesBetween({ freq: 'weekly', interval: 2, startDate: '2026-07-06' }, '2026-07-01', '2026-08-31'),
      ['2026-07-06', '2026-07-20', '2026-08-03', '2026-08-17', '2026-08-31'],
    );
  });
});

describe('anual', () => {
  test('gera uma por ano', () => {
    assert.deepEqual(
      occurrencesBetween({ freq: 'yearly', interval: 1, startDate: '2026-03-15' }, '2026-01-01', '2029-12-31'),
      ['2026-03-15', '2027-03-15', '2028-03-15', '2029-03-15'],
    );
  });

  test('29 de fevereiro cai para 28 em ano comum', () => {
    assert.deepEqual(
      occurrencesBetween({ freq: 'yearly', interval: 1, startDate: '2028-02-29' }, '2028-01-01', '2031-12-31'),
      ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28'],
    );
  });
});

describe('limites de fim', () => {
  test('endDate corta a série', () => {
    assert.deepEqual(
      occurrencesBetween(monthly({ endDate: '2026-03-15' }), '2026-01-01', '2026-12-31'),
      ['2026-01-10', '2026-02-10', '2026-03-10'],
    );
  });

  test('maxOccurrences conta desde a primeira ocorrência, não desde a janela', () => {
    const rule = monthly({ maxOccurrences: 3 });

    assert.deepEqual(occurrencesBetween(rule, '2026-01-01', '2026-12-31'), [
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
    ]);

    // Consultar uma janela posterior não pode "renovar" as 3 ocorrências.
    assert.deepEqual(occurrencesBetween(rule, '2026-04-01', '2026-12-31'), []);
    // E consultar do meio devolve apenas o que resta da série original.
    assert.deepEqual(occurrencesBetween(rule, '2026-02-01', '2026-12-31'), ['2026-02-10', '2026-03-10']);
  });

  test('janela invertida devolve vazio', () => {
    assert.deepEqual(occurrencesBetween(monthly(), '2026-12-31', '2026-01-01'), []);
  });

  test('janela antes do início devolve vazio', () => {
    assert.deepEqual(occurrencesBetween(monthly(), '2025-01-01', '2025-12-31'), []);
  });
});

describe('nextOccurrence', () => {
  test('encontra a próxima a partir de uma data', () => {
    assert.equal(nextOccurrence(monthly(), '2026-02-11'), '2026-03-10');
    assert.equal(nextOccurrence(monthly(), '2026-02-10'), '2026-02-10', 'inclui o próprio dia');
  });

  test('devolve null quando a série terminou', () => {
    assert.equal(nextOccurrence(monthly({ endDate: '2026-03-31' }), '2026-04-01'), null);
    assert.equal(nextOccurrence(monthly({ maxOccurrences: 2 }), '2026-04-01'), null);
  });
});

describe('validação', () => {
  test('recusa regra malformada', () => {
    assert.throws(() => occurrencesBetween(monthly({ interval: 0 }), '2026-01-01', '2026-12-31'), AppError);
    assert.throws(() => occurrencesBetween(monthly({ dayOfMonth: 45 }), '2026-01-01', '2026-12-31'), AppError);
    assert.throws(
      () => occurrencesBetween({ freq: 'weekly', interval: 1, startDate: '2026-01-01', weekday: 9 }, '2026-01-01', '2026-12-31'),
      AppError,
    );
    assert.throws(
      () => occurrencesBetween(monthly({ startDate: '2026-06-01', endDate: '2026-01-01' }), '2026-01-01', '2026-12-31'),
      AppError,
    );
  });
});

describe('descrição legível', () => {
  test('gera texto em português', () => {
    assert.equal(describeRule(monthly()), 'todo mês no dia 10');
    assert.equal(describeRule(monthly({ dayOfMonth: -1 })), 'todo mês no último dia do mês');
    assert.equal(describeRule(monthly({ interval: 3, dayOfMonth: 5 })), 'no dia 5 a cada 3 meses');
    assert.equal(describeRule({ freq: 'daily', interval: 1, startDate: '2026-01-01' }), 'todos os dias');
    assert.equal(describeRule({ freq: 'weekly', interval: 1, startDate: '2026-07-27' }), 'toda segunda');
    assert.equal(
      describeRule({ freq: 'yearly', interval: 1, startDate: '2026-03-15' }),
      'todo ano em 15 de março',
    );
  });
});

describe('propriedades gerais', () => {
  test('datas sempre em ordem crescente e sem repetição', () => {
    const rules: RecurrenceRule[] = [
      monthly(),
      monthly({ dayOfMonth: 31, startDate: '2026-01-31' }),
      monthly({ dayOfMonth: -1 }),
      monthly({ interval: 2 }),
      { freq: 'weekly', interval: 1, startDate: '2026-01-05' },
      { freq: 'weekly', interval: 2, startDate: '2026-01-05' },
      { freq: 'daily', interval: 5, startDate: '2026-01-01' },
      // 2028 é bissexto — 29/02 só existe como data inicial num ano bissexto.
      { freq: 'yearly', interval: 1, startDate: '2028-02-29' },
    ];

    for (const rule of rules) {
      const dates = occurrencesBetween(rule, '2026-01-01', '2029-12-31');
      assert.ok(dates.length > 0, `regra ${JSON.stringify(rule)} não gerou nada`);
      assert.equal(new Set(dates).size, dates.length, `data repetida em ${JSON.stringify(rule)}`);
      for (let i = 1; i < dates.length; i += 1) {
        assert.ok(dates[i]! > dates[i - 1]!, `fora de ordem em ${JSON.stringify(rule)}: ${dates.slice(i - 1, i + 1)}`);
      }
    }
  });

  test('consultar em pedaços dá o mesmo resultado que de uma vez', () => {
    // Propriedade que garante idempotência do materializador: ele consulta
    // janelas parciais conforme o horizonte avança.
    const rule = monthly({ dayOfMonth: 31, startDate: '2026-01-31' });
    const whole = occurrencesBetween(rule, '2026-01-01', '2026-12-31');
    const chunked = [
      ...occurrencesBetween(rule, '2026-01-01', '2026-04-30'),
      ...occurrencesBetween(rule, '2026-05-01', '2026-08-31'),
      ...occurrencesBetween(rule, '2026-09-01', '2026-12-31'),
    ];
    assert.deepEqual(chunked, whole);
  });
});
