/**
 * Dados de demonstração: 12 meses de movimento realista e denso.
 *
 * Existe para exercitar relatórios, gráficos e insights sem esperar um ano de
 * uso real — sem histórico, "gasto 77% acima da mediana" não tem como ser testado.
 *
 * Os valores seguem um padrão brasileiro plausível (salário, aluguel, mercado,
 * cartão com parcelamentos, corretora) e incluem de propósito anomalias: um mês
 * de gasto alto, cobrança duplicada, fatura atrasada, meta apertada e orçamentos
 * mistos (estourado / no limite / folgado) — para os analisadores e o painel
 * terem o que mostrar.
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

const MARKETS = [
  'Supermercado Extra',
  'Assaí Atacadista',
  'Mercado São Luiz',
  'Hortifruti da esquina',
  'Carrefour Express',
  'Pão de Açúcar',
];
const RESTAURANTS = [
  'Restaurante do Zé',
  'iFood pedido',
  'Padaria Central',
  'Sushi Yama',
  'Bar do Alfredo',
  'Outback Steakhouse',
  'Starbucks',
];
const TRANSPORT = ['Uber viagem', 'Posto Ipiranga', '99 corrida', 'Estacionamento shopping', 'Shell Box'];
const SHOPPING = ['Amazon compra', 'Renner', 'Mercado Livre', 'Farmácia Pacheco', 'Magazine Luiza', 'Shein'];
const EDUCATION = ['Udemy curso', 'Alura mensalidade', 'Livraria Cultura', 'Coursera'];
const PERSONAL = ['Barbearia Vintage', 'Farmácia Dermato', 'Sephora'];
const PETS = ['Petz ração', 'Veterinário Amigo', 'Banho e tosa PetLove'];
const LEISURE = ['Cinema Cinemark', 'Steam jogo', 'Ingresso Rock in Rio', 'Parque Ibirapuera café'];

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
    bonus: resolveCategory('Bônus', db).id,
    freelance: resolveCategory('Freelance', db).id,
    rent: resolveCategory('Aluguel', db).id,
    power: resolveCategory('Luz', db).id,
    water: resolveCategory('Água', db).id,
    internet: resolveCategory('Internet', db).id,
    market: resolveCategory('Supermercado', db).id,
    restaurant: resolveCategory('Restaurante', db).id,
    delivery: resolveCategory('Delivery', db).id,
    fuel: resolveCategory('Combustível', db).id,
    rideApp: resolveCategory('Aplicativo de transporte', db).id,
    parking: resolveCategory('Estacionamento', db).id,
    streaming: resolveCategory('Streaming', db).id,
    cinema: resolveCategory('Cinema', db).id,
    games: resolveCategory('Jogos', db).id,
    health: resolveCategory('Plano de saúde', db).id,
    pharmacy: resolveCategory('Farmácia', db).id,
    dentist: resolveCategory('Dentista', db).id,
    gym: resolveCategory('Academia', db).id,
    clothes: resolveCategory('Roupas', db).id,
    electronics: resolveCategory('Eletrônicos', db).id,
    gifts: resolveCategory('Presentes', db).id,
    courses: resolveCategory('Cursos', db).id,
    books: resolveCategory('Livros', db).id,
    hair: resolveCategory('Cabelo', db).id,
    phone: resolveCategory('Telefonia', db).id,
    software: resolveCategory('Software', db).id,
    petFood: resolveCategory('Ração', db).id,
    petVet: resolveCategory('Veterinário', db).id,
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
  createRecurrence(
    { name: 'Spotify', accountId: card, type: 'expense', amountCents: 2_190, categoryId: cat.streaming, freq: 'monthly', dayOfMonth: 3, startDate: startMonth, autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'Disney+', accountId: card, type: 'expense', amountCents: 4_390, categoryId: cat.streaming, freq: 'monthly', dayOfMonth: 18, startDate: addMonths(startMonth, 2), autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'Celular Vivo', accountId: checking, type: 'expense', amountCents: 6_990, categoryId: cat.phone, freq: 'monthly', dayOfMonth: 6, startDate: startMonth, autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'iCloud / Google One', accountId: card, type: 'expense', amountCents: 1_990, categoryId: cat.software, freq: 'monthly', dayOfMonth: 22, startDate: startMonth, autoPost: true },
    write,
  );
  createRecurrence(
    { name: 'Água Sabesp', accountId: checking, type: 'expense', estimatedCents: 7_800, categoryId: cat.water, freq: 'monthly', dayOfMonth: 16, startDate: startMonth, autoPost: false },
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
      { day: 15, type: 'expense', amountCents: between(6_500, 9_500), description: 'Água Sabesp', categoryId: cat.water, account: checking },
      { day: 7, type: 'expense', amountCents: 12_990, description: 'Internet Vivo Fibra', categoryId: cat.internet, account: checking },
      { day: 11, type: 'expense', amountCents: 42_000, description: 'Plano de saúde Unimed', categoryId: cat.health, account: checking },
      { day: 4, type: 'expense', amountCents: 12_000, description: 'Academia Smart Fit', categoryId: cat.gym, account: checking },
      { day: 5, type: 'expense', amountCents: 6_990, description: 'Vivo Conta Digital', categoryId: cat.phone, account: checking },
      { day: 13, type: 'expense', amountCents: 5_590, description: 'NETFLIX.COM', categoryId: cat.streaming, account: card },
      { day: 2, type: 'expense', amountCents: 2_190, description: 'SPOTIFY PREMIUM', categoryId: cat.streaming, account: card },
      { day: 17, type: 'expense', amountCents: 4_390, description: 'DISNEYPLUS.COM', categoryId: cat.streaming, account: card },
      { day: 21, type: 'expense', amountCents: 1_990, description: 'APPLE.COM/BILL', categoryId: cat.software, account: card },
    ];

    // Disney+ só a partir do 3º mês do cenário.
    const activeFixed = fixedItems.filter((item) => {
      if (item.description === 'DISNEYPLUS.COM' && monthOffset > 9) return false;
      return true;
    });

    if (isCurrentMonth) {
      // Só o que já venceu: uma conta com vencimento no dia 28 não pode aparecer
      // como paga no dia 26.
      for (const item of activeFixed) {
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
      for (const item of activeFixed) {
        createTransaction(
          {
            accountId: item.account,
            type: item.type,
            date: shiftDay(start, item.day),
            amountCents: item.amountCents,
            description: item.description,
            categoryId: item.categoryId,
          },
          write,
        );
        transactionCount += 1;
      }
    }

    // Mercado: 5–6 compras por mês. O mês -3 tem gasto anormalmente alto, para os
    // analisadores terem uma anomalia real para encontrar.
    const marketMultiplier = monthOffset === 3 ? 1.85 : 1;
    const marketCount = isCurrentMonth ? 5 : 5;
    for (let i = 0; i < marketCount; i += 1) {
      const day = shiftDay(start, 2 + i * 5);
      if (day > lastDay) break;
      createTransaction(
        {
          accountId: card,
          type: 'expense',
          date: day,
          amountCents: Math.round(between(28_000, 55_000) * marketMultiplier),
          description: pick(MARKETS),
          categoryId: cat.market,
        },
        write,
      );
      transactionCount += 1;
    }

    // Restaurante e delivery — densos o bastante para o donut/waterfall.
    const foodOutCount = isCurrentMonth ? 8 : 7;
    for (let i = 0; i < foodOutCount; i += 1) {
      const day = shiftDay(start, 3 + i * 3);
      if (day > lastDay) break;
      const isDelivery = random() > 0.45;
      createTransaction(
        {
          accountId: random() > 0.3 ? card : checking,
          type: 'expense',
          date: day,
          amountCents: between(3_500, 16_000),
          description: pick(RESTAURANTS),
          categoryId: isDelivery ? cat.delivery : cat.restaurant,
        },
        write,
      );
      transactionCount += 1;
    }

    // Transporte.
    for (let i = 0; i < 6; i += 1) {
      const day = shiftDay(start, 1 + i * 4);
      if (day > lastDay) break;
      const roll = random();
      const isFuel = roll > 0.55;
      const isParking = !isFuel && roll < 0.2;
      createTransaction(
        {
          accountId: isFuel ? checking : card,
          type: 'expense',
          date: day,
          amountCents: isFuel ? between(18_000, 30_000) : between(1_500, 5_500),
          description: isFuel
            ? pick([TRANSPORT[1]!, TRANSPORT[4]!])
            : isParking
              ? TRANSPORT[3]!
              : pick([TRANSPORT[0]!, TRANSPORT[2]!]),
          categoryId: isFuel ? cat.fuel : isParking ? cat.parking : cat.rideApp,
        },
        write,
      );
      transactionCount += 1;
    }

    // Compras avulsas (roupas / farmácia / presentes).
    for (let i = 0; i < (random() > 0.35 ? 2 : 1); i += 1) {
      const day = shiftDay(start, 12 + i * 8);
      if (day > lastDay) break;
      const kind = random();
      createTransaction(
        {
          accountId: card,
          type: 'expense',
          date: day,
          amountCents: between(8_000, 55_000),
          description: pick(SHOPPING),
          categoryId: kind > 0.66 ? cat.clothes : kind > 0.33 ? cat.pharmacy : cat.gifts,
        },
        write,
      );
      transactionCount += 1;
    }

    // Educação / lazer / pets / cuidados — diversidade pro analytics.
    if (random() > 0.35) {
      const day = shiftDay(start, 19);
      if (day <= lastDay) {
        createTransaction(
          {
            accountId: card,
            type: 'expense',
            date: day,
            amountCents: between(4_900, 29_000),
            description: pick(EDUCATION),
            categoryId: random() > 0.4 ? cat.courses : cat.books,
          },
          write,
        );
        transactionCount += 1;
      }
    }
    if (random() > 0.4) {
      const day = shiftDay(start, 22);
      if (day <= lastDay) {
        createTransaction(
          {
            accountId: card,
            type: 'expense',
            date: day,
            amountCents: between(3_500, 18_000),
            description: pick(LEISURE),
            categoryId: random() > 0.5 ? cat.cinema : cat.games,
          },
          write,
        );
        transactionCount += 1;
      }
    }
    if (monthOffset % 2 === 0) {
      const day = shiftDay(start, 10);
      if (day <= lastDay) {
        createTransaction(
          {
            accountId: checking,
            type: 'expense',
            date: day,
            amountCents: between(8_000, 22_000),
            description: pick(PETS),
            categoryId: random() > 0.5 ? cat.petFood : cat.petVet,
          },
          write,
        );
        transactionCount += 1;
      }
    }
    if (random() > 0.5) {
      const day = shiftDay(start, 25);
      if (day <= lastDay) {
        createTransaction(
          {
            accountId: checking,
            type: 'expense',
            date: day,
            amountCents: between(4_500, 12_000),
            description: pick(PERSONAL),
            categoryId: cat.hair,
          },
          write,
        );
        transactionCount += 1;
      }
    }

    // Dentista trimestral — empurra Saúde no radar/orçamento.
    if (monthOffset % 3 === 1) {
      const day = shiftDay(start, 18);
      if (day <= lastDay) {
        createTransaction(
          {
            accountId: card,
            type: 'expense',
            date: day,
            amountCents: between(28_000, 45_000),
            description: 'Consulta odontológica',
            categoryId: cat.dentist,
          },
          write,
        );
        transactionCount += 1;
      }
    }

    // Freelance mais frequente + bônus no mês -1.
    if (monthOffset % 3 === 1 || monthOffset === 5) {
      createTransaction(
        {
          accountId: checking,
          type: 'income',
          date: shiftDay(start, 20),
          amountCents: between(120_000, 320_000),
          description: 'Projeto freelance',
          categoryId: cat.freelance,
        },
        write,
      );
      transactionCount += 1;
    }
    if (monthOffset === 1) {
      createTransaction(
        {
          accountId: checking,
          type: 'income',
          date: shiftDay(start, 8),
          amountCents: 390_000,
          description: 'Bônus trimestral',
          categoryId: cat.bonus,
        },
        write,
      );
      transactionCount += 1;
    }

    // Aporte na poupança.
    if (monthOffset > 0 && random() > 0.2) {
      createTransfer(
        {
          fromAccountId: checking,
          toAccountId: savings,
          amountCents: between(50_000, 180_000),
          date: shiftDay(start, 6),
          description: 'Aporte na poupança',
        },
        write,
      );
      transactionCount += 2;
    }

    // Dinheiro na carteira.
    if (monthOffset % 2 === 0 && monthOffset > 0) {
      createTransfer(
        {
          fromAccountId: checking,
          toAccountId: wallet,
          amountCents: between(15_000, 35_000),
          date: shiftDay(start, 2),
          description: 'Saque',
        },
        write,
      );
      transactionCount += 2;
    }

    // Aporte na corretora a cada 2 meses (para o patrimônio crescer).
    if (monthOffset > 0 && monthOffset % 2 === 0) {
      createTransfer(
        {
          fromAccountId: checking,
          toAccountId: broker,
          amountCents: between(80_000, 200_000),
          date: shiftDay(start, 7),
          description: 'Aporte corretora XP',
        },
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
      {
        accountId: card,
        type: 'expense',
        date: addDays(duplicateDate, i),
        amountCents: 8_990,
        description: 'SPOTIFY PREMIUM',
        categoryId: cat.streaming,
      },
      write,
    );
    transactionCount += 1;
  }

  // ── Parcelamentos em andamento ────────────────────────────────────────────
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

  createInstallmentPlan(
    {
      accountId: card,
      description: 'iPhone 15',
      totalCents: 600_000,
      installments: 12,
      purchaseDate: addMonths(reference, -2),
      categoryId: cat.electronics,
    },
    write,
  );
  transactionCount += 12;

  // ── Orçamentos (mistura: estourado / no limite / folgado) ──────────────────
  const budgetStart = addMonths(reference, -5).slice(0, 7);
  createBudget(
    { categoryId: resolveCategory('Alimentação', db).id, amountCents: 180_000, startMonth: budgetStart, rollover: false },
    write,
  );
  createBudget(
    { categoryId: resolveCategory('Transporte', db).id, amountCents: 100_000, startMonth: budgetStart, rollover: false },
    write,
  );
  createBudget(
    { categoryId: resolveCategory('Lazer', db).id, amountCents: 45_000, startMonth: budgetStart, rollover: false },
    write,
  );
  createBudget(
    { categoryId: resolveCategory('Saúde', db).id, amountCents: 70_000, startMonth: budgetStart, rollover: false },
    write,
  );
  createBudget(
    { categoryId: resolveCategory('Compras', db).id, amountCents: 40_000, startMonth: budgetStart, rollover: false },
    write,
  );
  createBudget(
    { categoryId: resolveCategory('Serviços', db).id, amountCents: 25_000, startMonth: budgetStart, rollover: true },
    write,
  );

  // ── Metas ─────────────────────────────────────────────────────────────────
  const emergency = createGoal(
    {
      name: 'Reserva de emergência',
      targetCents: 3_000_000,
      accountId: savings,
      notes: 'Seis meses de despesas',
      color: '#41A6F6',
    },
    write,
  ).data.id;
  for (let i = 8; i >= 1; i -= 1) {
    contribute(
      emergency,
      { amountCents: between(90_000, 180_000), date: addMonths(reference, -i), fromAccountId: checking },
      write,
    );
  }

  const trip = createGoal(
    {
      name: 'Viagem para o Chile',
      targetCents: 1_200_000,
      targetDate: addMonths(reference, 8),
      color: '#B8F14A',
    },
    write,
  ).data.id;
  contribute(trip, { amountCents: 150_000, date: addMonths(reference, -4) }, write);
  contribute(trip, { amountCents: 120_000, date: addMonths(reference, -2) }, write);
  contribute(trip, { amountCents: 100_000, date: addMonths(reference, -1) }, write);

  // Meta atrasada de propósito: prazo curto + pouco aporte → goal_behind + gauge.
  const notebookGoal = createGoal(
    {
      name: 'Troca de notebook',
      targetCents: 800_000,
      targetDate: addMonths(reference, 2),
      color: '#FF6B9D',
      notes: 'Prazo apertado — útil para testar alerta de meta atrasada',
    },
    write,
  ).data.id;
  contribute(notebookGoal, { amountCents: 80_000, date: addMonths(reference, -3) }, write);
  contribute(notebookGoal, { amountCents: 50_000, date: addMonths(reference, -1) }, write);

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

  // ── Investimentos (posições + histórico de snapshots) ─────────────────────
  const itausa = createHolding(
    { name: 'Itaúsa', ticker: 'ITSA4', assetClass: 'stock', accountId: broker },
    write,
  ).data.id;
  registerTrade(
    itausa,
    { op: 'buy', quantity: 300, amountCents: 300_000, feeCents: 500, cashAccountId: broker, date: addMonths(reference, -10) },
    write,
  );
  registerTrade(
    itausa,
    { op: 'buy', quantity: 100, amountCents: 112_000, feeCents: 300, cashAccountId: broker, date: addMonths(reference, -4) },
    write,
  );
  registerTrade(itausa, { op: 'dividend', amountCents: 8_400, cashAccountId: broker, date: addMonths(reference, -6) }, write);
  registerTrade(itausa, { op: 'dividend', amountCents: 9_100, cashAccountId: broker, date: addMonths(reference, -2) }, write);
  for (let i = 8; i >= 0; i -= 1) {
    const base = 320_000 + (8 - i) * 4_500 + between(-3_000, 6_000);
    recordSnapshot(itausa, { marketValueCents: base, date: addMonths(reference, -i) }, write);
  }

  const fii = createHolding(
    { name: 'FII Maxi Renda', ticker: 'MXRF11', assetClass: 'fii', accountId: broker },
    write,
  ).data.id;
  registerTrade(
    fii,
    { op: 'buy', quantity: 200, amountCents: 200_000, cashAccountId: broker, date: addMonths(reference, -9) },
    write,
  );
  registerTrade(
    fii,
    { op: 'buy', quantity: 80, amountCents: 82_000, cashAccountId: broker, date: addMonths(reference, -3) },
    write,
  );
  registerTrade(fii, { op: 'dividend', amountCents: 2_400, cashAccountId: broker, date: addMonths(reference, -5) }, write);
  registerTrade(fii, { op: 'dividend', amountCents: 2_600, cashAccountId: broker, date: addMonths(reference, -1) }, write);
  for (let i = 6; i >= 0; i -= 1) {
    recordSnapshot(
      fii,
      { marketValueCents: 205_000 + (6 - i) * 2_200 + between(-1_500, 2_000), date: addMonths(reference, -i) },
      write,
    );
  }

  const treasury = createHolding(
    { name: 'Tesouro Selic 2029', assetClass: 'fixed_income', accountId: broker },
    write,
  ).data.id;
  registerTrade(
    treasury,
    { op: 'buy', quantity: 1, amountCents: 1_000_000, cashAccountId: broker, date: addMonths(reference, -11) },
    write,
  );
  registerTrade(
    treasury,
    { op: 'buy', quantity: 0.4, amountCents: 420_000, cashAccountId: broker, date: addMonths(reference, -5) },
    write,
  );
  for (let i = 10; i >= 0; i -= 1) {
    recordSnapshot(
      treasury,
      { marketValueCents: 1_000_000 + (10 - i) * 12_000, date: addMonths(reference, -i) },
      write,
    );
  }

  const bitcoin = createHolding(
    { name: 'Bitcoin', ticker: 'BTC', assetClass: 'crypto', accountId: broker },
    write,
  ).data.id;
  registerTrade(
    bitcoin,
    { op: 'buy', quantity: 0.0035, amountCents: 180_000, feeCents: 900, cashAccountId: broker, date: addMonths(reference, -5) },
    write,
  );
  registerTrade(
    bitcoin,
    { op: 'buy', quantity: 0.0012, amountCents: 78_000, feeCents: 400, cashAccountId: broker, date: addMonths(reference, -2) },
    write,
  );
  for (let i = 5; i >= 0; i -= 1) {
    recordSnapshot(
      bitcoin,
      { marketValueCents: 190_000 + (5 - i) * 9_000 + between(-8_000, 12_000), date: addMonths(reference, -i) },
      write,
    );
  }

  const etf = createHolding(
    { name: 'IVVB11', ticker: 'IVVB11', assetClass: 'etf', accountId: broker },
    write,
  ).data.id;
  registerTrade(
    etf,
    { op: 'buy', quantity: 15, amountCents: 450_000, feeCents: 600, cashAccountId: broker, date: addMonths(reference, -7) },
    write,
  );
  for (let i = 6; i >= 0; i -= 1) {
    recordSnapshot(
      etf,
      { marketValueCents: 440_000 + (6 - i) * 7_500 + between(-5_000, 8_000), date: addMonths(reference, -i) },
      write,
    );
  }

  // ── Regras de auto-categorização ──────────────────────────────────────────
  createRule(
    { name: 'Netflix → Streaming', conditions: { descriptionContains: 'netflix' }, actions: { categoryId: cat.streaming } },
    write,
  );
  createRule(
    { name: 'Spotify → Streaming', conditions: { descriptionContains: 'spotify' }, actions: { categoryId: cat.streaming } },
    write,
  );
  createRule(
    { name: 'Disney → Streaming', conditions: { descriptionContains: 'disney' }, actions: { categoryId: cat.streaming } },
    write,
  );
  createRule(
    { name: 'Uber → Transporte', conditions: { descriptionContains: 'uber' }, actions: { categoryId: cat.rideApp } },
    write,
  );
  createRule(
    { name: 'Supermercado → Alimentação', conditions: { descriptionContains: 'supermercado' }, actions: { categoryId: cat.market } },
    write,
  );
  createRule(
    { name: 'iFood → Delivery', conditions: { descriptionContains: 'ifood' }, actions: { categoryId: cat.delivery } },
    write,
  );
  createRule(
    { name: 'Petz → Pets', conditions: { descriptionContains: 'petz' }, actions: { categoryId: cat.petFood } },
    write,
  );
  createRule(
    { name: 'Udemy → Cursos', conditions: { descriptionContains: 'udemy' }, actions: { categoryId: cat.courses } },
    write,
  );

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
