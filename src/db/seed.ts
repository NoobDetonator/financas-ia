/**
 * Dados de demonstração: 12 meses de movimento realista.
 *
 * Existe para exercitar relatórios e insights sem esperar um ano de uso real — sem
 * histórico, "gasto 77% acima da mediana" não tem como ser testado.
 *
 * Os valores seguem um padrão brasileiro plausível (salário, aluguel, mercado,
 * cartão com parcelamento) e incluem de propósito algumas anomalias: um mês de
 * gasto alto, uma cobrança duplicada e uma fatura atrasada — para os analisadores
 * terem o que encontrar.
 *
 * Determinístico: o gerador de números aleatórios tem semente fixa, então rodar de
 * novo produz o mesmo cenário e um bug encontrado é reproduzível.
 */

import { createDb, closeDb, getDb, type Db } from './client.js';
import { runMigrations } from './migrate.js';
import { bootstrap } from './bootstrap.js';
import { accounts, transactions } from './schema.js';
import { addDays, addMonths, currentMonth, monthRange, setClock, today, type IsoDate } from '../core/clock.js';
import { createAccount } from '../services/accounts.js';
import { resolveCategory } from '../services/categories.js';
import { createTransaction } from '../services/transactions.js';
import { createTransfer } from '../services/transfers.js';
import { createInstallmentPlan, payInvoice } from '../services/cards.js';
import { findInvoiceByMonth } from '../services/invoices.js';
import { createRecurrence } from '../services/recurrences.js';
import { createBudget } from '../services/budgets.js';
import { contribute, createGoal } from '../services/goals.js';
import { createDebt, debtSchedule, payInstallment } from '../services/debts.js';
import { createHolding, recordSnapshot, registerTrade } from '../services/investments.js';
import { createRule } from '../services/rules.js';

/** Gerador com semente fixa, para o cenário ser reproduzível. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

const random = seededRandom(20_260_726);

/** Valor aleatório numa faixa, em centavos, arredondado para os 10 centavos. */
function between(minCents: number, maxCents: number): number {
  return Math.round((minCents + random() * (maxCents - minCents)) / 10) * 10;
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

const MARKETS = ['Supermercado Extra', 'Assaí Atacadista', 'Mercado São Luiz', 'Hortifruti da esquina'];
const RESTAURANTS = ['Restaurante do Zé', 'iFood pedido', 'Padaria Central', 'Sushi Yama', 'Bar do Alfredo'];
const TRANSPORT = ['Uber viagem', 'Posto Ipiranga', '99 corrida', 'Estacionamento shopping'];
const SHOPPING = ['Amazon compra', 'Renner', 'Mercado Livre', 'Farmácia Pacheco'];

export interface SeedResult {
  accounts: number;
  transactions: number;
  months: number;
}

/**
 * Popula o banco com o cenário de demonstração.
 *
 * Recusa rodar num banco que já tem movimento — perder dados reais por causa de um
 * comando de seed rodado sem pensar seria inaceitável.
 */
export function seed(options: { db?: Db; force?: boolean } = {}): SeedResult {
  const db = options.db ?? getDb();

  const existing = db.select().from(transactions).all();
  if (existing.length > 0 && !options.force) {
    throw new Error(
      `O banco já tem ${existing.length} transação(ões). O seed foi interrompido para não misturar ` +
        'dados de demonstração com dados reais. Use --force se for realmente isso que você quer.',
    );
  }

  bootstrap(db);

  const write = { db, source: 'seed' as const, actor: 'system' as const };
  const reference = today();
  const startMonth = addMonths(reference, -11);

  // ── Contas ────────────────────────────────────────────────────────────────
  const checking = createAccount(
    {
      name: 'Conta Corrente',
      kind: 'checking',
      institution: 'Banco do Brasil',
      openingBalanceCents: 350_000,
      openingDate: startMonth,
      aliases: ['cc', 'corrente', 'bb'],
    },
    write,
  ).data.id;

  const savings = createAccount(
    {
      name: 'Poupança',
      kind: 'savings',
      institution: 'Banco do Brasil',
      openingBalanceCents: 800_000,
      openingDate: startMonth,
      aliases: ['poupanca'],
    },
    write,
  ).data.id;

  const wallet = createAccount(
    { name: 'Carteira', kind: 'cash', openingBalanceCents: 15_000, openingDate: startMonth },
    write,
  ).data.id;

  const card = createAccount(
    {
      name: 'Cartão Nubank',
      kind: 'credit_card',
      institution: 'Nubank',
      openingDate: startMonth,
      aliases: ['nubank', 'nu', 'roxinho'],
      card: { limitCents: 800_000, closingDay: 20, dueDay: 28, paymentAccountId: checking },
    },
    write,
  ).data.id;

  const broker = createAccount(
    { name: 'Corretora', kind: 'investment', institution: 'XP', openingDate: startMonth },
    write,
  ).data.id;

  // ── Categorias ────────────────────────────────────────────────────────────
  const cat = {
    salary: resolveCategory('Salário > Salário', db).id,
    freelance: resolveCategory('Freelance', db).id,
    rent: resolveCategory('Aluguel', db).id,
    power: resolveCategory('Luz', db).id,
    internet: resolveCategory('Internet', db).id,
    market: resolveCategory('Supermercado', db).id,
    restaurant: resolveCategory('Restaurante', db).id,
    delivery: resolveCategory('Delivery', db).id,
    fuel: resolveCategory('Combustível', db).id,
    rideApp: resolveCategory('Aplicativo de transporte', db).id,
    streaming: resolveCategory('Streaming', db).id,
    health: resolveCategory('Plano de saúde', db).id,
    pharmacy: resolveCategory('Farmácia', db).id,
    gym: resolveCategory('Academia', db).id,
    clothes: resolveCategory('Roupas', db).id,
    electronics: resolveCategory('Eletrônicos', db).id,
    dividends: resolveCategory('Dividendos', db).id,
  };

  // ── Recorrências ──────────────────────────────────────────────────────────
  createRecurrence(
    { name: 'Salário', accountId: checking, type: 'income', amountCents: 780_000, categoryId: cat.salary, freq: 'monthly', dayOfMonth: 5, startDate: startMonth, autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'Aluguel', accountId: checking, type: 'expense', amountCents: 195_000, categoryId: cat.rent, freq: 'monthly', dayOfMonth: 10, startDate: startMonth, autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'Conta de luz', accountId: checking, type: 'expense', estimatedCents: 18_500, categoryId: cat.power, freq: 'monthly', dayOfMonth: 15, startDate: startMonth, autoPost: false },
    write,
  );
  createRecurrence(
    { name: 'Internet', accountId: checking, type: 'expense', amountCents: 12_990, categoryId: cat.internet, freq: 'monthly', dayOfMonth: 8, startDate: startMonth, autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'Plano de saúde', accountId: checking, type: 'expense', amountCents: 42_000, categoryId: cat.health, freq: 'monthly', dayOfMonth: 12, startDate: startMonth, autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'Netflix', accountId: card, type: 'expense', amountCents: 5_590, categoryId: cat.streaming, freq: 'monthly', dayOfMonth: 14, startDate: startMonth, autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'Academia', accountId: checking, type: 'expense', amountCents: 12_000, categoryId: cat.gym, freq: 'monthly', dayOfMonth: 5, startDate: startMonth, autoPost: true },
    write,
  );

  // ── Histórico mês a mês ───────────────────────────────────────────────────
  // O ano é reconstruído lançamento por lançamento, com o relógio "viajando" para
  // cada mês — assim as faturas de cartão caem nos ciclos corretos.
  let transactionCount = 0;

  for (let monthOffset = 11; monthOffset >= 0; monthOffset -= 1) {
    const monthDate = addMonths(reference, -monthOffset);
    const { start, end } = monthRange(monthDate.slice(0, 7));
    const isCurrentMonth = monthOffset === 0;
    const lastDay = isCurrentMonth ? reference : end;

    // Salário e contas fixas: as recorrências materializam apenas o **futuro**, então
    // o passado é lançado explicitamente aqui — incluindo os dias do mês corrente que
    // já passaram. Sem isso o mês atual apareceria com receita zero, que é justamente
    // o número mais visível do painel.
    const fixedItems: Array<{ day: number; type: 'income' | 'expense'; amountCents: number; description: string; categoryId: string; account: string }> = [
      { day: 4, type: 'income', amountCents: 780_000, description: 'Salário', categoryId: cat.salary, account: checking },
      { day: 9, type: 'expense', amountCents: 195_000, description: 'Aluguel', categoryId: cat.rent, account: checking },
      { day: 14, type: 'expense', amountCents: between(15_000, 24_000), description: 'Conta de luz', categoryId: cat.power, account: checking },
      { day: 7, type: 'expense', amountCents: 12_990, description: 'Internet Vivo Fibra', categoryId: cat.internet, account: checking },
      { day: 11, type: 'expense', amountCents: 42_000, description: 'Plano de saúde Unimed', categoryId: cat.health, account: checking },
      { day: 4, type: 'expense', amountCents: 12_000, description: 'Academia Smart Fit', categoryId: cat.gym, account: checking },
      { day: 13, type: 'expense', amountCents: 5_590, description: 'NETFLIX.COM', categoryId: cat.streaming, account: card },
    ];

    if (isCurrentMonth) {
      // Só o que já venceu: uma conta com vencimento no dia 28 não pode aparecer
      // como paga no dia 26.
      for (const item of fixedItems) {
        const date = shiftDay(start, item.day);
        if (date > lastDay) continue;
        createTransaction(
          { accountId: item.account, type: item.type, date, amountCents: item.amountCents, description: item.description, categoryId: item.categoryId },
          write,
        );
        transactionCount += 1;
      }
    }

    if (monthOffset > 0) {
      createTransaction(
        { accountId: checking, type: 'income', date: shiftDay(start, 4), amountCents: 780_000, description: 'Salário', categoryId: cat.salary },
        write,
      );
      createTransaction(
        { accountId: checking, type: 'expense', date: shiftDay(start, 9), amountCents: 195_000, description: 'Aluguel', categoryId: cat.rent },
        write,
      );
      createTransaction(
        { accountId: checking, type: 'expense', date: shiftDay(start, 14), amountCents: between(15_000, 24_000), description: 'Conta de luz', categoryId: cat.power },
        write,
      );
      createTransaction(
        { accountId: checking, type: 'expense', date: shiftDay(start, 7), amountCents: 12_990, description: 'Internet Vivo Fibra', categoryId: cat.internet },
        write,
      );
      createTransaction(
        { accountId: checking, type: 'expense', date: shiftDay(start, 11), amountCents: 42_000, description: 'Plano de saúde Unimed', categoryId: cat.health },
        write,
      );
      createTransaction(
        { accountId: checking, type: 'expense', date: shiftDay(start, 4), amountCents: 12_000, description: 'Academia Smart Fit', categoryId: cat.gym },
        write,
      );
      createTransaction(
        { accountId: card, type: 'expense', date: shiftDay(start, 13), amountCents: 5_590, description: 'NETFLIX.COM', categoryId: cat.streaming },
        write,
      );
      transactionCount += 7;
    }

    // Mercado: 4 compras por mês. O mês -3 tem gasto anormalmente alto, para os
    // analisadores terem uma anomalia real para encontrar.
    const marketMultiplier = monthOffset === 3 ? 1.85 : 1;
    for (let i = 0; i < 4; i += 1) {
      const day = shiftDay(start, 2 + i * 7);
      if (day > lastDay) break;
      createTransaction(
        {
          accountId: card,
          type: 'expense',
          date: day,
          amountCents: Math.round(between(28_000, 52_000) * marketMultiplier),
          description: pick(MARKETS),
          categoryId: cat.market,
        },
        write,
      );
      transactionCount += 1;
    }

    // Restaurante e delivery.
    for (let i = 0; i < 6; i += 1) {
      const day = shiftDay(start, 3 + i * 4);
      if (day > lastDay) break;
      const isDelivery = random() > 0.5;
      createTransaction(
        {
          accountId: random() > 0.3 ? card : checking,
          type: 'expense',
          date: day,
          amountCents: between(3_500, 14_000),
          description: pick(RESTAURANTS),
          categoryId: isDelivery ? cat.delivery : cat.restaurant,
        },
        write,
      );
      transactionCount += 1;
    }

    // Transporte.
    for (let i = 0; i < 5; i += 1) {
      const day = shiftDay(start, 1 + i * 5);
      if (day > lastDay) break;
      const isFuel = random() > 0.6;
      createTransaction(
        {
          accountId: isFuel ? checking : card,
          type: 'expense',
          date: day,
          amountCents: isFuel ? between(18_000, 28_000) : between(1_500, 4_500),
          description: isFuel ? pick(TRANSPORT.slice(1, 2)) : pick([TRANSPORT[0]!, TRANSPORT[2]!]),
          categoryId: isFuel ? cat.fuel : cat.rideApp,
        },
        write,
      );
      transactionCount += 1;
    }

    // Compras avulsas.
    if (random() > 0.4) {
      const day = shiftDay(start, 16);
      if (day <= lastDay) {
        createTransaction(
          {
            accountId: card,
            type: 'expense',
            date: day,
            amountCents: between(8_000, 45_000),
            description: pick(SHOPPING),
            categoryId: random() > 0.5 ? cat.clothes : cat.pharmacy,
          },
          write,
        );
        transactionCount += 1;
      }
    }

    // Freelance esporádico.
    if (monthOffset % 4 === 1) {
      createTransaction(
        { accountId: checking, type: 'income', date: shiftDay(start, 20), amountCents: between(120_000, 280_000), description: 'Projeto freelance', categoryId: cat.freelance },
        write,
      );
      transactionCount += 1;
    }

    // Aporte na poupança.
    if (monthOffset > 0 && random() > 0.25) {
      createTransfer(
        { fromAccountId: checking, toAccountId: savings, amountCents: between(50_000, 150_000), date: shiftDay(start, 6), description: 'Aporte na poupança' },
        write,
      );
      transactionCount += 2;
    }

    // Dinheiro na carteira.
    if (monthOffset % 3 === 0 && monthOffset > 0) {
      createTransfer(
        { fromAccountId: checking, toAccountId: wallet, amountCents: 20_000, date: shiftDay(start, 2), description: 'Saque' },
        write,
      );
      transactionCount += 2;
    }

    // Pagamento das faturas passadas. A fatura do mês -1 fica de propósito sem
    // pagar, para gerar um insight de atraso.
    if (monthOffset >= 2) {
      const invoiceMonth = addMonths(monthDate, 0).slice(0, 7);
      const invoice = findInvoiceByMonth(card, invoiceMonth, db);
      if (invoice && invoice.totalCents > 0 && invoice.paidCents === 0) {
        payInvoice(invoice.id, { date: invoice.dueDate }, write);
        transactionCount += 2;
      }
    }
  }

  // ── Cobrança duplicada, para o detector encontrar ──────────────────────────
  const duplicateDate = addDays(reference, -9);
  for (let i = 0; i < 2; i += 1) {
    createTransaction(
      { accountId: card, type: 'expense', date: addDays(duplicateDate, i), amountCents: 8_990, description: 'SPOTIFY PREMIUM', categoryId: cat.streaming },
      write,
    );
    transactionCount += 2;
  }

  // ── Parcelamento em andamento ─────────────────────────────────────────────
  createInstallmentPlan(
    {
      accountId: card,
      description: 'Notebook Dell',
      totalCents: 420_000,
      installments: 10,
      purchaseDate: addMonths(reference, -3),
      categoryId: cat.electronics,
    },
    write,
  );
  transactionCount += 10;

  // ── Orçamentos ────────────────────────────────────────────────────────────
  createBudget({ categoryId: resolveCategory('Alimentação', db).id, amountCents: 180_000, startMonth: addMonths(reference, -5).slice(0, 7), rollover: false }, write);
  createBudget({ categoryId: resolveCategory('Transporte', db).id, amountCents: 60_000, startMonth: addMonths(reference, -5).slice(0, 7), rollover: true }, write);
  createBudget({ categoryId: resolveCategory('Lazer', db).id, amountCents: 30_000, startMonth: addMonths(reference, -5).slice(0, 7), rollover: false }, write);

  // ── Metas ─────────────────────────────────────────────────────────────────
  const emergency = createGoal(
    { name: 'Reserva de emergência', targetCents: 3_000_000, accountId: savings, notes: 'Seis meses de despesas' },
    write,
  ).data.id;
  for (let i = 6; i >= 1; i -= 1) {
    contribute(emergency, { amountCents: between(80_000, 160_000), date: addMonths(reference, -i) }, write);
  }

  const trip = createGoal(
    { name: 'Viagem para o Chile', targetCents: 1_200_000, targetDate: addMonths(reference, 8) },
    write,
  ).data.id;
  contribute(trip, { amountCents: 150_000, date: addMonths(reference, -2) }, write);
  contribute(trip, { amountCents: 100_000, date: addMonths(reference, -1) }, write);

  // ── Dívida ────────────────────────────────────────────────────────────────
  const financing = createDebt(
    {
      name: 'Financiamento do carro',
      kind: 'financing',
      principalCents: 4_500_000,
      annualRateBps: 1650,
      termMonths: 36,
      system: 'price',
      firstDueDate: addMonths(reference, -8),
      accountId: checking,
      categoryId: resolveCategory('Financiamento', db).id,
    },
    write,
  ).data.id;
  // Oito parcelas pagas; a nona fica vencida, gerando o insight.
  //
  // Cada pagamento é datado no **vencimento da parcela**, não em hoje: sem isso,
  // `payInstallment` usaria a data atual e as oito parcelas cairiam todas no mês
  // corrente, inflando a despesa do mês em mais de R$ 12 mil e distorcendo todo
  // relatório de fluxo de caixa.
  for (const payment of debtSchedule(financing, db).slice(0, 8)) {
    payInstallment(financing, payment.installmentNo, { date: payment.dueDate }, write);
    transactionCount += 1;
  }

  // ── Investimentos ─────────────────────────────────────────────────────────
  const itausa = createHolding({ name: 'Itaúsa', ticker: 'ITSA4', assetClass: 'stock', accountId: broker }, write).data.id;
  registerTrade(itausa, { op: 'buy', quantity: 300, amountCents: 300_000, feeCents: 500, cashAccountId: broker, date: addMonths(reference, -10) }, write);
  registerTrade(itausa, { op: 'dividend', amountCents: 8_400, cashAccountId: broker, date: addMonths(reference, -6) }, write);
  registerTrade(itausa, { op: 'dividend', amountCents: 9_100, cashAccountId: broker, date: addMonths(reference, -2) }, write);
  recordSnapshot(itausa, { marketValueCents: 342_000 }, write);

  const fii = createHolding({ name: 'FII Maxi Renda', ticker: 'MXRF11', assetClass: 'fii', accountId: broker }, write).data.id;
  registerTrade(fii, { op: 'buy', quantity: 200, amountCents: 200_000, cashAccountId: broker, date: addMonths(reference, -9) }, write);
  recordSnapshot(fii, { marketValueCents: 208_000 }, write);

  const treasury = createHolding({ name: 'Tesouro Selic 2029', assetClass: 'fixed_income', accountId: broker }, write).data.id;
  registerTrade(treasury, { op: 'buy', quantity: 1, amountCents: 1_000_000, cashAccountId: broker, date: addMonths(reference, -11) }, write);
  recordSnapshot(treasury, { marketValueCents: 1_118_000 }, write);

  const bitcoin = createHolding({ name: 'Bitcoin', ticker: 'BTC', assetClass: 'crypto', accountId: broker }, write).data.id;
  registerTrade(bitcoin, { op: 'buy', quantity: 0.0035, amountCents: 180_000, feeCents: 900, cashAccountId: broker, date: addMonths(reference, -5) }, write);
  recordSnapshot(bitcoin, { marketValueCents: 215_000 }, write);

  // ── Regras de auto-categorização ──────────────────────────────────────────
  createRule({ name: 'Netflix → Streaming', conditions: { descriptionContains: 'netflix' }, actions: { categoryId: cat.streaming } }, write);
  createRule({ name: 'Uber → Transporte', conditions: { descriptionContains: 'uber' }, actions: { categoryId: cat.rideApp } }, write);
  createRule({ name: 'Supermercado → Alimentação', conditions: { descriptionContains: 'supermercado' }, actions: { categoryId: cat.market } }, write);
  createRule({ name: 'iFood → Delivery', conditions: { descriptionContains: 'ifood' }, actions: { categoryId: cat.delivery } }, write);

  const accountCount = db.select().from(accounts).all().length;
  const finalCount = db.select().from(transactions).all().length;

  return { accounts: accountCount, transactions: finalCount, months: 12 };
}

/** Desloca o dia dentro do mês, sem passar do último dia. */
function shiftDay(monthStart: IsoDate, days: number): IsoDate {
  return addDays(monthStart, days);
}

// Executado por `npm run db:seed`.
if (import.meta.filename === process.argv[1]) {
  const force = process.argv.includes('--force');
  const handle = createDb();

  try {
    runMigrations(handle.db);

    if (force) {
      // Limpa o movimento antes de repopular, mantendo o schema.
      for (const table of [
        'goal_contributions', 'goals', 'debt_payments', 'debts',
        'position_snapshots', 'investment_transactions', 'holdings',
        'import_rows', 'import_batches', 'rules', 'budgets',
        'transaction_tags', 'transaction_splits', 'attachments',
        'card_invoices', 'installment_plans', 'recurrences', 'transactions',
        'ai_actions', 'ai_messages', 'ai_conversations',
        'insights', 'reports', 'audit_log', 'change_sets',
        'credit_cards', 'accounts', 'payees', 'tags',
      ]) {
        handle.sqlite.exec(`delete from "${table}"`);
      }
      console.log('Dados anteriores removidos (--force).');
    }

    const result = seed({ db: handle.db, force });
    console.log(
      `Seed concluído: ${result.accounts} contas, ${result.transactions} transações, ${result.months} meses.`,
    );
    console.log('Rode `npm run chat` e pergunte "como estão minhas finanças?".');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    handle.close();
    closeDb();
  }
}

export { setClock, currentMonth };
