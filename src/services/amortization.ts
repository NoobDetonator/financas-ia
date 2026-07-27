/**
 * Tabelas de amortização SAC e Price.
 *
 * Função pura, testada isoladamente: são os dois sistemas usados em
 * financiamento imobiliário e de veículo no Brasil, e errar a conta significa
 * mostrar um saldo devedor que não bate com o do banco.
 *
 * **SAC** — amortização constante. A parcela começa alta e diminui, porque os
 * juros incidem sobre um saldo que cai de forma linear. Total de juros menor.
 *
 * **Price** — parcela constante. Os juros são altos no começo e a amortização
 * cresce ao longo do tempo. Total de juros maior, mas previsível no orçamento.
 *
 * Toda aritmética é feita em centavos inteiros, com a última parcela absorvendo
 * a diferença de arredondamento — assim a soma das amortizações é **exatamente**
 * o principal, e o saldo devedor final é exatamente zero.
 */

import { roundHalf } from '../core/money.js';
import { validation } from '../core/errors.js';
import { addMonths, type IsoDate } from '../core/clock.js';
import type { AmortizationSystem } from '../db/schema.js';

export interface AmortizationInput {
  principalCents: number;
  /** Taxa **anual** em basis points: 1250 = 12,50% a.a. */
  annualRateBps: number;
  termMonths: number;
  system: AmortizationSystem;
  /** Data da primeira parcela. */
  firstDueDate: IsoDate;
}

export interface AmortizationRow {
  installmentNo: number;
  dueDate: IsoDate;
  /** Parcela total = amortização + juros. */
  amountCents: number;
  principalCents: number;
  interestCents: number;
  /** Saldo devedor depois desta parcela. Zero na última. */
  balanceAfterCents: number;
}

export interface AmortizationSchedule {
  rows: AmortizationRow[];
  totalPaidCents: number;
  totalInterestCents: number;
  /** Taxa mensal efetiva, em basis points, derivada da anual. */
  monthlyRateBps: number;
}

/**
 * Converte taxa anual em mensal **equivalente** (juros compostos):
 * `(1 + i_a)^(1/12) − 1`.
 *
 * Não divide por 12: 12% ao ano não é 1% ao mês. Dividir superestima os juros e
 * a projeção de dívida fica errada para cima.
 */
export function monthlyRateFromAnnual(annualRateBps: number): number {
  if (annualRateBps === 0) return 0;
  const annual = annualRateBps / 10_000;
  return Math.pow(1 + annual, 1 / 12) - 1;
}

function assertInput(input: AmortizationInput): void {
  if (!Number.isInteger(input.principalCents) || input.principalCents <= 0) {
    throw validation(`Principal inválido: ${input.principalCents}. Informe centavos inteiros positivos.`);
  }
  if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 600) {
    throw validation(`Prazo inválido: ${input.termMonths}. Use de 1 a 600 meses.`);
  }
  if (input.annualRateBps < 0) {
    throw validation(`Taxa não pode ser negativa: ${input.annualRateBps}.`);
  }
}

/**
 * Gera a tabela de amortização.
 *
 * Invariantes garantidas (e testadas):
 *  • soma das amortizações = principal, exatamente;
 *  • saldo devedor após a última parcela = 0;
 *  • parcela = amortização + juros em toda linha.
 */
export function buildSchedule(input: AmortizationInput): AmortizationSchedule {
  assertInput(input);

  const monthlyRate = monthlyRateFromAnnual(input.annualRateBps);
  const monthlyRateBps = Math.round(monthlyRate * 10_000);
  const rows: AmortizationRow[] = [];

  let balance = input.principalCents;

  if (input.system === 'sac') {
    const basePrincipal = Math.floor(input.principalCents / input.termMonths);

    for (let n = 1; n <= input.termMonths; n += 1) {
      const interestCents = roundHalf(balance * monthlyRate);
      // A última parcela amortiza todo o saldo restante, absorvendo a sobra da
      // divisão inteira.
      const principalCents = n === input.termMonths ? balance : basePrincipal;
      balance -= principalCents;

      rows.push({
        installmentNo: n,
        dueDate: addMonths(input.firstDueDate, n - 1),
        amountCents: principalCents + interestCents,
        principalCents,
        interestCents,
        balanceAfterCents: balance,
      });
    }
  } else {
    // Price: parcela fixa PMT = PV × i / (1 − (1+i)^−n).
    const payment =
      monthlyRate === 0
        ? Math.floor(input.principalCents / input.termMonths)
        : roundHalf(
            (input.principalCents * monthlyRate) /
              (1 - Math.pow(1 + monthlyRate, -input.termMonths)),
          );

    for (let n = 1; n <= input.termMonths; n += 1) {
      const interestCents = roundHalf(balance * monthlyRate);
      const isLast = n === input.termMonths;

      // Na última parcela, amortiza o saldo inteiro: o arredondamento das
      // anteriores deixa uma diferença de centavos que precisa ser absorvida.
      const principalCents = isLast ? balance : Math.min(payment - interestCents, balance);
      const amountCents = principalCents + interestCents;
      balance -= principalCents;

      rows.push({
        installmentNo: n,
        dueDate: addMonths(input.firstDueDate, n - 1),
        amountCents,
        principalCents,
        interestCents,
        balanceAfterCents: balance,
      });
    }
  }

  const totalPaidCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
  const totalInterestCents = rows.reduce((sum, row) => sum + row.interestCents, 0);

  return { rows, totalPaidCents, totalInterestCents, monthlyRateBps };
}

export interface EarlyPayoffSimulation {
  /** Parcela a partir da qual a simulação vale. */
  fromInstallmentNo: number;
  /** Saldo devedor a quitar agora. */
  payoffCents: number;
  /** Juros que deixariam de ser pagos. */
  interestSavedCents: number;
  /** Parcelas que deixariam de existir. */
  installmentsRemoved: number;
  /** Total que seria pago sem antecipar. */
  originalRemainingCents: number;
}

/**
 * Simula quitar a dívida antecipadamente.
 *
 * Responde "vale a pena adiantar?": compara o saldo devedor hoje com a soma das
 * parcelas restantes. A diferença são os juros economizados.
 */
export function simulateEarlyPayoff(
  schedule: AmortizationSchedule,
  fromInstallmentNo: number,
): EarlyPayoffSimulation {
  if (fromInstallmentNo < 1 || fromInstallmentNo > schedule.rows.length) {
    throw validation(
      `Parcela ${fromInstallmentNo} fora da faixa (1 a ${schedule.rows.length}).`,
    );
  }

  // Saldo devedor imediatamente antes da parcela informada.
  const previous = schedule.rows[fromInstallmentNo - 2];
  const payoffCents = previous ? previous.balanceAfterCents : schedule.rows[0]!.principalCents + schedule.rows[0]!.balanceAfterCents;

  const remaining = schedule.rows.slice(fromInstallmentNo - 1);
  const originalRemainingCents = remaining.reduce((sum, row) => sum + row.amountCents, 0);

  return {
    fromInstallmentNo,
    payoffCents,
    interestSavedCents: originalRemainingCents - payoffCents,
    installmentsRemoved: remaining.length,
    originalRemainingCents,
  };
}

/**
 * Simula amortizar um valor extra, reduzindo o prazo.
 *
 * É a estratégia que economiza mais juros: manter a parcela e encurtar o prazo,
 * em vez de reduzir a parcela e manter o prazo.
 */
export function simulateExtraPayment(
  input: AmortizationInput,
  extraCents: number,
  atInstallmentNo: number,
): { newTermMonths: number; interestSavedCents: number; originalInterestCents: number } {
  const original = buildSchedule(input);
  if (extraCents <= 0) {
    return {
      newTermMonths: input.termMonths,
      interestSavedCents: 0,
      originalInterestCents: original.totalInterestCents,
    };
  }

  const previous = original.rows[atInstallmentNo - 2];
  const balanceBefore = previous ? previous.balanceAfterCents : input.principalCents;
  const remainingPrincipal = Math.max(0, balanceBefore - extraCents);

  if (remainingPrincipal === 0) {
    const paidSoFar = original.rows
      .slice(0, atInstallmentNo - 1)
      .reduce((sum, row) => sum + row.interestCents, 0);
    return {
      newTermMonths: atInstallmentNo - 1,
      interestSavedCents: original.totalInterestCents - paidSoFar,
      originalInterestCents: original.totalInterestCents,
    };
  }

  // Refaz o cronograma do saldo restante, mantendo a parcela original.
  const monthlyRate = monthlyRateFromAnnual(input.annualRateBps);
  const originalPayment = original.rows[atInstallmentNo - 1]?.amountCents ?? original.rows[0]!.amountCents;

  let balance = remainingPrincipal;
  let months = 0;
  let interestAfter = 0;

  while (balance > 0 && months < 600) {
    const interest = roundHalf(balance * monthlyRate);
    const principal = Math.min(originalPayment - interest, balance);
    if (principal <= 0) break; // parcela não cobre os juros: dívida não amortiza
    balance -= principal;
    interestAfter += interest;
    months += 1;
  }

  const interestPaidBefore = original.rows
    .slice(0, atInstallmentNo - 1)
    .reduce((sum, row) => sum + row.interestCents, 0);

  return {
    newTermMonths: atInstallmentNo - 1 + months,
    interestSavedCents: original.totalInterestCents - (interestPaidBefore + interestAfter),
    originalInterestCents: original.totalInterestCents,
  };
}
