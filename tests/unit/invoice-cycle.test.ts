import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveInvoiceCycle,
  cycleForReferenceMonth,
  nextCycles,
} from '../../src/services/invoice-cycle.js';
import { diffDays, isAfter, isSameOrBefore } from '../../src/core/clock.js';
import { AppError } from '../../src/core/errors.js';

/** Cartão comum: fecha dia 20, vence dia 28 do mesmo mês. */
const closes20Due28 = { closingDay: 20, dueDay: 28 };
/** Vencimento antes do fechamento: fecha dia 28, vence dia 5 do mês seguinte. */
const closes28Due05 = { closingDay: 28, dueDay: 5 };
/** Fechamento no fim do mês, onde o encaixe de dia importa. */
const closes31Due10 = { closingDay: 31, dueDay: 10 };

describe('atribuição da compra ao ciclo', () => {
  test('compra antes do fechamento entra na fatura que fecha neste mês', () => {
    const cycle = resolveInvoiceCycle('2026-07-15', closes20Due28);
    assert.equal(cycle.closingDate, '2026-07-20');
    assert.equal(cycle.dueDate, '2026-07-28');
    assert.equal(cycle.referenceMonth, '2026-07');
  });

  test('compra NO dia do fechamento vai para a fatura seguinte', () => {
    // O fechamento consolida o que veio até o dia anterior. Errar isso joga a
    // compra um mês para trás e o total não bate com o do banco.
    const cycle = resolveInvoiceCycle('2026-07-20', closes20Due28);
    assert.equal(cycle.closingDate, '2026-08-20');
    assert.equal(cycle.referenceMonth, '2026-08');
  });

  test('compra um dia antes do fechamento ainda entra na fatura atual', () => {
    const cycle = resolveInvoiceCycle('2026-07-19', closes20Due28);
    assert.equal(cycle.closingDate, '2026-07-20');
  });

  test('compra depois do fechamento entra na fatura seguinte', () => {
    const cycle = resolveInvoiceCycle('2026-07-25', closes20Due28);
    assert.equal(cycle.closingDate, '2026-08-20');
    assert.equal(cycle.dueDate, '2026-08-28');
  });
});

describe('vencimento em dia menor que o fechamento', () => {
  test('vence no mês seguinte ao fechamento', () => {
    const cycle = resolveInvoiceCycle('2026-07-10', closes28Due05);
    assert.equal(cycle.closingDate, '2026-07-28');
    assert.equal(cycle.dueDate, '2026-08-05', 'fecha em julho, vence em agosto');
    assert.equal(cycle.referenceMonth, '2026-08', 'referência é o mês do vencimento');
  });

  test('vencimento é sempre posterior ao fechamento', () => {
    for (const config of [closes20Due28, closes28Due05, closes31Due10, { closingDay: 1, dueDay: 1 }]) {
      for (let month = 1; month <= 12; month += 1) {
        const date = `2026-${String(month).padStart(2, '0')}-10`;
        const cycle = resolveInvoiceCycle(date, config);
        assert.ok(
          isAfter(cycle.dueDate, cycle.closingDate),
          `vencimento ${cycle.dueDate} deveria vir depois do fechamento ${cycle.closingDate} (config ${JSON.stringify(config)})`,
        );
      }
    }
  });
});

describe('fechamento dia 31 e meses curtos', () => {
  test('fevereiro em ano comum encaixa no dia 28', () => {
    const cycle = resolveInvoiceCycle('2026-02-10', closes31Due10);
    assert.equal(cycle.closingDate, '2026-02-28');
  });

  test('fevereiro em ano bissexto encaixa no dia 29', () => {
    const cycle = resolveInvoiceCycle('2028-02-10', closes31Due10);
    assert.equal(cycle.closingDate, '2028-02-29');
  });

  test('abril, com 30 dias, encaixa no dia 30', () => {
    const cycle = resolveInvoiceCycle('2026-04-10', closes31Due10);
    assert.equal(cycle.closingDate, '2026-04-30');
  });

  test('compra no dia 28 de fevereiro (dia do fechamento encaixado) vai para março', () => {
    const cycle = resolveInvoiceCycle('2026-02-28', closes31Due10);
    assert.equal(cycle.closingDate, '2026-03-31');
  });

  test('closingDay = -1 significa último dia do mês', () => {
    assert.equal(resolveInvoiceCycle('2026-02-10', { closingDay: -1, dueDay: 10 }).closingDate, '2026-02-28');
    assert.equal(resolveInvoiceCycle('2026-01-10', { closingDay: -1, dueDay: 10 }).closingDate, '2026-01-31');
  });
});

describe('virada de ano', () => {
  test('compra em dezembro depois do fechamento cai na fatura de janeiro', () => {
    const cycle = resolveInvoiceCycle('2026-12-25', closes20Due28);
    assert.equal(cycle.closingDate, '2027-01-20');
    assert.equal(cycle.dueDate, '2027-01-28');
    assert.equal(cycle.referenceMonth, '2027-01');
  });

  test('fecha em dezembro e vence em janeiro', () => {
    const cycle = resolveInvoiceCycle('2026-12-10', closes28Due05);
    assert.equal(cycle.closingDate, '2026-12-28');
    assert.equal(cycle.dueDate, '2027-01-05');
    assert.equal(cycle.referenceMonth, '2027-01');
  });
});

describe('período coberto pela fatura', () => {
  test('vai do fechamento anterior até o dia antes do fechamento', () => {
    const cycle = resolveInvoiceCycle('2026-07-15', closes20Due28);
    assert.equal(cycle.periodStart, '2026-06-20');
    assert.equal(cycle.periodEnd, '2026-07-19');
  });

  test('a compra sempre cai dentro do período do seu ciclo', () => {
    // Invariante central: se falhasse, a fatura mostraria um total diferente da
    // soma das compras que ela lista.
    const configs = [closes20Due28, closes28Due05, closes31Due10, { closingDay: 1, dueDay: 15 }];
    for (const config of configs) {
      for (let month = 1; month <= 12; month += 1) {
        for (const day of [1, 5, 15, 20, 27, 28]) {
          const purchase = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const cycle = resolveInvoiceCycle(purchase, config);
          assert.ok(
            isSameOrBefore(cycle.periodStart, purchase) && isSameOrBefore(purchase, cycle.periodEnd),
            `compra ${purchase} fora do período ${cycle.periodStart}..${cycle.periodEnd} (config ${JSON.stringify(config)})`,
          );
        }
      }
    }
  });

  test('períodos consecutivos não têm lacuna nem sobreposição', () => {
    // Um dia de lacuna significaria uma compra que não entra em fatura nenhuma.
    for (const config of [closes20Due28, closes28Due05, closes31Due10]) {
      const cycles = nextCycles('2026-01-05', config, 15);
      for (let i = 1; i < cycles.length; i += 1) {
        const previous = cycles[i - 1]!;
        const current = cycles[i]!;
        assert.equal(
          diffDays(previous.periodEnd, current.periodStart),
          1,
          `lacuna entre ${previous.periodEnd} e ${current.periodStart} (config ${JSON.stringify(config)})`,
        );
      }
    }
  });
});

describe('ciclos consecutivos', () => {
  test('gera meses seguidos, sem repetir referência', () => {
    const cycles = nextCycles('2026-07-15', closes20Due28, 6);
    assert.deepEqual(
      cycles.map((c) => c.referenceMonth),
      ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'],
    );
  });

  test('atravessa a virada de ano', () => {
    const cycles = nextCycles('2026-11-15', closes20Due28, 4);
    assert.deepEqual(
      cycles.map((c) => c.referenceMonth),
      ['2026-11', '2026-12', '2027-01', '2027-02'],
    );
  });

  test('meses curtos não fazem o ciclo repetir nem pular', () => {
    const cycles = nextCycles('2026-01-05', closes31Due10, 14);
    const months = cycles.map((c) => c.referenceMonth);
    assert.equal(new Set(months).size, months.length, `referência repetida em ${months.join(', ')}`);
  });

  test('count zero ou negativo devolve lista vazia', () => {
    assert.deepEqual(nextCycles('2026-07-15', closes20Due28, 0), []);
    assert.deepEqual(nextCycles('2026-07-15', closes20Due28, -3), []);
  });
});

describe('ciclo por mês de referência', () => {
  test('reencontra o mesmo ciclo da compra', () => {
    const fromPurchase = resolveInvoiceCycle('2026-07-15', closes20Due28);
    const fromMonth = cycleForReferenceMonth('2026-07', closes20Due28);
    assert.deepEqual(fromMonth, fromPurchase);
  });

  test('funciona quando o vencimento é no mês seguinte ao fechamento', () => {
    const fromPurchase = resolveInvoiceCycle('2026-07-10', closes28Due05);
    const fromMonth = cycleForReferenceMonth('2026-08', closes28Due05);
    assert.deepEqual(fromMonth, fromPurchase);
  });

  test('ida e volta é consistente para todos os meses', () => {
    for (const config of [closes20Due28, closes28Due05, closes31Due10]) {
      for (const cycle of nextCycles('2026-01-05', config, 24)) {
        const roundTrip = cycleForReferenceMonth(cycle.referenceMonth, config);
        assert.deepEqual(
          roundTrip,
          cycle,
          `ida e volta divergiu em ${cycle.referenceMonth} (config ${JSON.stringify(config)})`,
        );
      }
    }
  });

  test('mês de referência inválido é recusado', () => {
    assert.throws(() => cycleForReferenceMonth('2026-13', closes20Due28), AppError);
    assert.throws(() => cycleForReferenceMonth('julho', closes20Due28), AppError);
  });
});

describe('configuração inválida', () => {
  test('dia fora de faixa é recusado', () => {
    assert.throws(() => resolveInvoiceCycle('2026-07-15', { closingDay: 0, dueDay: 10 }), AppError);
    assert.throws(() => resolveInvoiceCycle('2026-07-15', { closingDay: 32, dueDay: 10 }), AppError);
    assert.throws(() => resolveInvoiceCycle('2026-07-15', { closingDay: 20, dueDay: 40 }), AppError);
    assert.throws(() => resolveInvoiceCycle('2026-07-15', { closingDay: 1.5, dueDay: 10 }), AppError);
  });
});
