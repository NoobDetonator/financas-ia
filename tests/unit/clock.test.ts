import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  today,
  currentMonth,
  setClock,
  resetClock,
  addDays,
  addMonths,
  lastDayOfMonth,
  clampDay,
  makeDateClamped,
  startOfMonth,
  endOfMonth,
  diffDays,
  diffMonths,
  compareDate,
  monthKey,
  addMonthKey,
  monthRange,
  monthsBetween,
  weekday,
  formatDateBr,
  formatMonthBr,
  isIsoDate,
  parseDate,
  DateError,
} from '../../src/core/clock.js';

afterEach(() => resetClock());

describe('today / relógio injetável', () => {
  test('usa o fuso da aplicação, não UTC', () => {
    // 03:30 UTC de 1º de março = 00:30 em São Paulo (UTC-3), ainda dia 1º.
    setClock(new Date('2026-03-01T03:30:00Z'));
    assert.equal(today(), '2026-03-01');

    // 02:00 UTC de 1º de março = 23:00 do dia 28/02 em São Paulo.
    // Tratar como UTC jogaria o lançamento para o mês errado.
    setClock(new Date('2026-03-01T02:00:00Z'));
    assert.equal(today(), '2026-02-28');
    assert.equal(currentMonth(), '2026-02');
  });
});

describe('lastDayOfMonth', () => {
  test('meses comuns', () => {
    assert.equal(lastDayOfMonth(2026, 1), 31);
    assert.equal(lastDayOfMonth(2026, 4), 30);
  });

  test('fevereiro em ano comum e bissexto', () => {
    assert.equal(lastDayOfMonth(2026, 2), 28);
    assert.equal(lastDayOfMonth(2028, 2), 29);
    assert.equal(lastDayOfMonth(2000, 2), 29); // divisível por 400
    assert.equal(lastDayOfMonth(1900, 2), 28); // divisível por 100, não por 400
  });
});

describe('clampDay', () => {
  test('encaixa dia 31 em meses curtos', () => {
    assert.equal(clampDay(2026, 2, 31), 28);
    assert.equal(clampDay(2028, 2, 31), 29);
    assert.equal(clampDay(2026, 4, 31), 30);
    assert.equal(clampDay(2026, 1, 31), 31);
  });

  test('-1 significa último dia do mês', () => {
    assert.equal(clampDay(2026, 2, -1), 28);
    assert.equal(clampDay(2026, 12, -1), 31);
  });
});

describe('addMonths', () => {
  test('preserva o dia quando cabe', () => {
    assert.equal(addMonths('2026-01-15', 1), '2026-02-15');
    assert.equal(addMonths('2026-01-15', 12), '2027-01-15');
  });

  test('encaixa o dia no mês de destino', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
  });

  test('anda para trás e vira o ano', () => {
    assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
    assert.equal(addMonths('2026-01-31', -13), '2024-12-31');
  });
});

describe('addDays', () => {
  test('atravessa mês, ano e 29 de fevereiro', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2026-02-28', 1), '2026-03-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });

  test('não sofre com horário de verão', () => {
    // Em fusos com DST, aritmética por hora local pularia ou repetiria um dia.
    // Passando por todo o ano, cada passo tem exatamente 1 dia.
    let date = '2026-01-01';
    for (let i = 0; i < 365; i += 1) {
      const next = addDays(date, 1);
      assert.equal(diffDays(date, next), 1, `falhou em ${date}`);
      date = next;
    }
    assert.equal(date, '2027-01-01');
  });
});

describe('makeDateClamped', () => {
  test('encaixa o dia e normaliza mês fora de 1..12', () => {
    assert.equal(makeDateClamped(2026, 2, 31), '2026-02-28');
    assert.equal(makeDateClamped(2026, 13, 10), '2027-01-10');
    assert.equal(makeDateClamped(2026, 0, 10), '2025-12-10');
    assert.equal(makeDateClamped(2026, -1, 10), '2025-11-10');
  });
});

describe('início e fim de mês', () => {
  test('startOfMonth / endOfMonth', () => {
    assert.equal(startOfMonth('2026-07-26'), '2026-07-01');
    assert.equal(endOfMonth('2026-07-26'), '2026-07-31');
    assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
    assert.equal(endOfMonth('2028-02-10'), '2028-02-29');
  });
});

describe('diferenças e comparação', () => {
  test('diffDays', () => {
    assert.equal(diffDays('2026-01-01', '2026-01-31'), 30);
    assert.equal(diffDays('2026-01-31', '2026-01-01'), -30);
    assert.equal(diffDays('2026-01-01', '2026-01-01'), 0);
  });

  test('diffDays conta o dia bissexto quando ele está no intervalo', () => {
    // 2028 é bissexto: fev/mar tem um dia a mais do que em 2026.
    assert.equal(diffDays('2028-02-28', '2028-03-01'), 2);
    assert.equal(diffDays('2026-02-28', '2026-03-01'), 1);
    // Ano bissexto inteiro tem 366 dias.
    assert.equal(diffDays('2028-01-01', '2029-01-01'), 366);
    assert.equal(diffDays('2026-01-01', '2027-01-01'), 365);
  });

  test('diffMonths ignora o dia', () => {
    assert.equal(diffMonths('2026-01-31', '2026-02-01'), 1);
    assert.equal(diffMonths('2026-01-01', '2027-01-01'), 12);
  });

  test('compareDate', () => {
    assert.equal(compareDate('2026-01-01', '2026-01-02'), -1);
    assert.equal(compareDate('2026-01-02', '2026-01-01'), 1);
    assert.equal(compareDate('2026-01-01', '2026-01-01'), 0);
  });
});

describe('mês de referência', () => {
  test('monthKey e aritmética', () => {
    assert.equal(monthKey('2026-07-26'), '2026-07');
    assert.equal(addMonthKey('2026-12', 1), '2027-01');
    assert.equal(addMonthKey('2026-01', -1), '2025-12');
    assert.equal(addMonthKey('2026-01', -13), '2024-12');
  });

  test('monthRange cobre o mês inteiro', () => {
    assert.deepEqual(monthRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
    assert.deepEqual(monthRange('2028-02'), { start: '2028-02-01', end: '2028-02-29' });
  });

  test('monthsBetween é inclusivo e vazio quando invertido', () => {
    assert.deepEqual(monthsBetween('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
    assert.deepEqual(monthsBetween('2026-05', '2026-05'), ['2026-05']);
    assert.deepEqual(monthsBetween('2026-05', '2026-04'), []);
  });
});

describe('validação', () => {
  test('isIsoDate rejeita datas impossíveis', () => {
    assert.ok(isIsoDate('2026-07-26'));
    assert.ok(!isIsoDate('2026-02-30'));
    assert.ok(!isIsoDate('2026-13-01'));
    assert.ok(!isIsoDate('26/07/2026'));
    assert.ok(!isIsoDate('2026-7-6'));
    assert.ok(!isIsoDate(''));
    assert.ok(!isIsoDate(null));
  });

  test('parseDate lança em entrada inválida', () => {
    assert.throws(() => parseDate('2026-02-30'), DateError);
    assert.throws(() => parseDate('ontem'), DateError);
  });
});

describe('formatação e dia da semana', () => {
  test('formatDateBr / formatMonthBr', () => {
    assert.equal(formatDateBr('2026-07-26'), '26/07/2026');
    assert.equal(formatMonthBr('2026-03'), 'março de 2026');
  });

  test('weekday: 26/07/2026 é domingo', () => {
    assert.equal(weekday('2026-07-26'), 0);
    assert.equal(weekday('2026-07-27'), 1);
  });
});
