import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchedule,
  monthlyRateFromAnnual,
  simulateEarlyPayoff,
  simulateExtraPayment,
  type AmortizationInput,
} from '../../src/services/amortization.js';
import { sumCents } from '../../src/core/money.js';
import { AppError } from '../../src/core/errors.js';

const base: AmortizationInput = {
  principalCents: 10_000_000, // R$ 100.000
  annualRateBps: 1200, // 12% a.a.
  termMonths: 12,
  system: 'price',
  firstDueDate: '2026-08-10',
};

describe('taxa mensal equivalente', () => {
  test('não divide a anual por 12', () => {
    // 12% a.a. equivale a ~0,9489% ao mês, não 1%.
    const monthly = monthlyRateFromAnnual(1200);
    assert.ok(monthly > 0.0094 && monthly < 0.0095, `esperado ~0,00949, obtido ${monthly}`);

    // Confirma que compõe de volta para 12% ao ano.
    assert.ok(Math.abs(Math.pow(1 + monthly, 12) - 1.12) < 1e-9);
  });

  test('taxa zero', () => {
    assert.equal(monthlyRateFromAnnual(0), 0);
  });
});

describe('invariantes das duas tabelas', () => {
  const cases: AmortizationInput[] = [
    base,
    { ...base, system: 'sac' },
    { ...base, termMonths: 1 },
    { ...base, termMonths: 360, annualRateBps: 950 }, // financiamento imobiliário
    { ...base, system: 'sac', termMonths: 360, annualRateBps: 950 },
    { ...base, annualRateBps: 0 }, // sem juros
    { ...base, system: 'sac', annualRateBps: 0 },
    { ...base, principalCents: 100_001, termMonths: 7 }, // não divide redondo
    { ...base, system: 'sac', principalCents: 100_001, termMonths: 7 },
    { ...base, principalCents: 1, termMonths: 3 }, // 1 centavo em 3x
  ];

  test('soma das amortizações é exatamente o principal', () => {
    for (const input of cases) {
      const schedule = buildSchedule(input);
      assert.equal(
        sumCents(schedule.rows.map((r) => r.principalCents)),
        input.principalCents,
        `${input.system} ${input.termMonths}m ${input.annualRateBps}bps`,
      );
    }
  });

  test('saldo devedor termina exatamente em zero', () => {
    for (const input of cases) {
      const schedule = buildSchedule(input);
      assert.equal(
        schedule.rows.at(-1)!.balanceAfterCents,
        0,
        `${input.system} ${input.termMonths}m deixou saldo residual`,
      );
    }
  });

  test('parcela = amortização + juros em toda linha', () => {
    for (const input of cases) {
      for (const row of buildSchedule(input).rows) {
        assert.equal(
          row.amountCents,
          row.principalCents + row.interestCents,
          `${input.system} parcela ${row.installmentNo}`,
        );
      }
    }
  });

  test('saldo cai monotonicamente e nunca fica negativo', () => {
    for (const input of cases) {
      const rows = buildSchedule(input).rows;
      let previous = input.principalCents;
      for (const row of rows) {
        assert.ok(row.balanceAfterCents >= 0, `saldo negativo em ${input.system} parcela ${row.installmentNo}`);
        assert.ok(row.balanceAfterCents <= previous, `saldo subiu em ${input.system} parcela ${row.installmentNo}`);
        previous = row.balanceAfterCents;
      }
    }
  });

  test('total pago = principal + juros', () => {
    for (const input of cases) {
      const schedule = buildSchedule(input);
      assert.equal(schedule.totalPaidCents, input.principalCents + schedule.totalInterestCents);
    }
  });

  test('vencimentos são mensais e consecutivos', () => {
    const rows = buildSchedule({ ...base, termMonths: 5, firstDueDate: '2026-12-31' }).rows;
    // Dia 31 encaixa nos meses curtos.
    assert.deepEqual(
      rows.map((r) => r.dueDate),
      ['2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'],
    );
  });
});

describe('Price: parcela constante', () => {
  test('todas as parcelas iguais, exceto a última', () => {
    const rows = buildSchedule(base).rows;
    const amounts = rows.slice(0, -1).map((r) => r.amountCents);
    assert.equal(new Set(amounts).size, 1, `parcelas deveriam ser iguais: ${[...new Set(amounts)]}`);

    // A última absorve o arredondamento, então pode diferir em centavos.
    const diff = Math.abs(rows.at(-1)!.amountCents - amounts[0]!);
    assert.ok(diff < 100, `última parcela difere demais: ${diff} centavos`);
  });

  test('amortização cresce e juros caem ao longo do tempo', () => {
    const rows = buildSchedule({ ...base, termMonths: 24 }).rows;
    for (let i = 1; i < rows.length - 1; i += 1) {
      assert.ok(rows[i]!.principalCents > rows[i - 1]!.principalCents, `amortização não cresceu na parcela ${i + 1}`);
      assert.ok(rows[i]!.interestCents < rows[i - 1]!.interestCents, `juros não caíram na parcela ${i + 1}`);
    }
  });

  test('sem juros, a parcela é o principal dividido pelo prazo', () => {
    const schedule = buildSchedule({ ...base, annualRateBps: 0, principalCents: 120_000, termMonths: 12 });
    assert.equal(schedule.totalInterestCents, 0);
    assert.ok(schedule.rows.every((r) => r.amountCents === 10_000));
  });
});

describe('SAC: amortização constante', () => {
  test('amortização igual em todas as parcelas', () => {
    const rows = buildSchedule({ ...base, system: 'sac', principalCents: 12_000_000, termMonths: 12 }).rows;
    assert.ok(rows.every((r) => r.principalCents === 1_000_000));
  });

  test('parcela decresce', () => {
    const rows = buildSchedule({ ...base, system: 'sac', termMonths: 24 }).rows;
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i]!.amountCents < rows[i - 1]!.amountCents, `parcela não caiu em ${i + 1}`);
    }
  });

  test('SAC paga menos juros que Price no mesmo cenário', () => {
    // A razão pela qual SAC é recomendado quando a parcela inicial cabe.
    const sac = buildSchedule({ ...base, system: 'sac', termMonths: 360, annualRateBps: 950 });
    const price = buildSchedule({ ...base, system: 'price', termMonths: 360, annualRateBps: 950 });
    assert.ok(
      sac.totalInterestCents < price.totalInterestCents,
      `SAC ${sac.totalInterestCents} deveria ser menor que Price ${price.totalInterestCents}`,
    );
  });

  test('primeira parcela do SAC é maior que a do Price', () => {
    const sac = buildSchedule({ ...base, system: 'sac', termMonths: 360, annualRateBps: 950 });
    const price = buildSchedule({ ...base, system: 'price', termMonths: 360, annualRateBps: 950 });
    assert.ok(sac.rows[0]!.amountCents > price.rows[0]!.amountCents);
  });
});

describe('simulação de quitação antecipada', () => {
  test('economiza os juros das parcelas restantes', () => {
    const schedule = buildSchedule({ ...base, termMonths: 12 });
    const simulation = simulateEarlyPayoff(schedule, 7);

    assert.equal(simulation.installmentsRemoved, 6);
    // Quitar o saldo custa menos que pagar as parcelas até o fim.
    assert.ok(simulation.payoffCents < simulation.originalRemainingCents);
    assert.ok(simulation.interestSavedCents > 0);
    assert.equal(
      simulation.interestSavedCents,
      simulation.originalRemainingCents - simulation.payoffCents,
    );
  });

  test('quitar na primeira parcela economiza todos os juros', () => {
    const schedule = buildSchedule({ ...base, termMonths: 12 });
    const simulation = simulateEarlyPayoff(schedule, 1);
    assert.equal(simulation.payoffCents, base.principalCents);
    assert.equal(simulation.interestSavedCents, schedule.totalInterestCents);
  });

  test('quitar na última economiza apenas os juros dela', () => {
    const schedule = buildSchedule({ ...base, termMonths: 12 });
    const simulation = simulateEarlyPayoff(schedule, 12);
    assert.equal(simulation.installmentsRemoved, 1);
    assert.equal(simulation.interestSavedCents, schedule.rows.at(-1)!.interestCents);
  });

  test('parcela fora da faixa é recusada', () => {
    const schedule = buildSchedule(base);
    assert.throws(() => simulateEarlyPayoff(schedule, 0), AppError);
    assert.throws(() => simulateEarlyPayoff(schedule, 99), AppError);
  });
});

describe('simulação de amortização extra', () => {
  test('encurta o prazo e economiza juros', () => {
    const input = { ...base, termMonths: 60, annualRateBps: 1500 };
    const result = simulateExtraPayment(input, 2_000_000, 13);

    assert.ok(result.newTermMonths < input.termMonths, 'o prazo deveria encurtar');
    assert.ok(result.interestSavedCents > 0);
    assert.ok(result.interestSavedCents < result.originalInterestCents);
  });

  test('valor extra que cobre o saldo quita a dívida', () => {
    const input = { ...base, termMonths: 12 };
    const result = simulateExtraPayment(input, 100_000_000, 3);
    assert.equal(result.newTermMonths, 2);
  });

  test('extra zero não muda nada', () => {
    const input = { ...base, termMonths: 24 };
    const result = simulateExtraPayment(input, 0, 5);
    assert.equal(result.newTermMonths, 24);
    assert.equal(result.interestSavedCents, 0);
  });
});

describe('validação', () => {
  test('recusa entrada inválida', () => {
    assert.throws(() => buildSchedule({ ...base, principalCents: 0 }), AppError);
    assert.throws(() => buildSchedule({ ...base, principalCents: -100 }), AppError);
    assert.throws(() => buildSchedule({ ...base, principalCents: 100.5 }), AppError);
    assert.throws(() => buildSchedule({ ...base, termMonths: 0 }), AppError);
    assert.throws(() => buildSchedule({ ...base, termMonths: 601 }), AppError);
    assert.throws(() => buildSchedule({ ...base, annualRateBps: -1 }), AppError);
  });
});
