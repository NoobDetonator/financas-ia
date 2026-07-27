/**
 * Contas: corrente, poupança, dinheiro, carteira digital, investimento e cartão.
 *
 * O cartão de crédito é uma conta como as outras, com uma linha extra em
 * `credit_cards` para fechamento e vencimento. A consequência é que o saldo da
 * conta-cartão **é** a dívida atual (negativo), e pagar a fatura é uma
 * transferência da conta corrente para o cartão. Isso mantém o cálculo de saldo
 * uniforme em vez de tratar cartão como um caso especial em todo relatório.
 */

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import { accounts, creditCards, transactions, type Account, type CreditCard } from '../db/schema.js';
import { conflict, notFound, ruleViolation } from '../core/errors.js';
import { today } from '../core/clock.js';
import { slugify } from '../core/ids.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { accountKindSchema, centsSchema, colorSchema, dayOfMonthSchema, idSchema, isoDateSchema } from './schemas.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

export const createAccountSchema = z.object({
  name: z.string().min(1).max(80),
  kind: accountKindSchema,
  institution: z.string().max(80).optional(),
  currency: z.string().length(3).default('BRL'),
  openingBalanceCents: centsSchema.default(0),
  openingDate: isoDateSchema.optional(),
  color: colorSchema,
  icon: z.string().max(40).optional(),
  notes: z.string().max(1000).optional(),
  /** Apelidos que a IA reconhece: `["nubank", "nu"]`. */
  aliases: z.array(z.string().min(1).max(40)).max(10).optional(),
  /** Cartão de débito vinculado (somente contas não-crédito). */
  hasDebitCard: z.boolean().default(false),
  debitIsVirtual: z.boolean().default(false),
  /** Obrigatório quando `kind` é `credit_card`. */
  card: z
    .object({
      limitCents: centsSchema.default(0),
      closingDay: dayOfMonthSchema,
      dueDay: dayOfMonthSchema,
      paymentAccountId: idSchema.optional(),
      isVirtual: z.boolean().default(false),
    })
    .optional(),
});

export type CreateAccountInput = z.input<typeof createAccountSchema>;

export const updateAccountSchema = createAccountSchema
  .omit({ kind: true, card: true })
  .partial()
  .extend({
    card: z
      .object({
        limitCents: centsSchema.optional(),
        closingDay: dayOfMonthSchema.optional(),
        dueDay: dayOfMonthSchema.optional(),
        paymentAccountId: idSchema.nullable().optional(),
        isVirtual: z.boolean().optional(),
      })
      .optional(),
  });

export type UpdateAccountInput = z.input<typeof updateAccountSchema>;

export interface AccountWithCard extends Account {
  card: CreditCard | null;
}

// ── Leitura ─────────────────────────────────────────────────────────────────

export function listAccounts(
  options: { includeArchived?: boolean; kind?: Account['kind']; db?: Db } = {},
): AccountWithCard[] {
  const db = options.db ?? getDb();

  const filters = [
    options.includeArchived ? undefined : eq(accounts.isArchived, false),
    options.kind ? eq(accounts.kind, options.kind) : undefined,
  ].filter((f) => f !== undefined);

  const rows = db
    .select()
    .from(accounts)
    .leftJoin(creditCards, eq(creditCards.accountId, accounts.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(accounts.sortOrder, accounts.name)
    .all();

  return rows.map((row) => ({ ...row.accounts, card: row.credit_cards }));
}

export function findAccount(id: string, db: Db = getDb()): AccountWithCard | undefined {
  const rows = db
    .select()
    .from(accounts)
    .leftJoin(creditCards, eq(creditCards.accountId, accounts.id))
    .where(eq(accounts.id, id))
    .all();

  const row = rows[0];
  return row ? { ...row.accounts, card: row.credit_cards } : undefined;
}

export function getAccount(id: string, db: Db = getDb()): AccountWithCard {
  const account = findAccount(id, db);
  if (!account) throw notFound('Conta', id);
  return account;
}

/** Exige que a conta seja um cartão de crédito com configuração completa. */
export function getCreditCard(id: string, db: Db = getDb()): AccountWithCard & { card: CreditCard } {
  const account = getAccount(id, db);
  if (account.kind !== 'credit_card' || !account.card) {
    throw ruleViolation(`A conta "${account.name}" não é um cartão de crédito.`, { accountId: id });
  }
  return account as AccountWithCard & { card: CreditCard };
}

/**
 * Resolve uma conta por ID, nome ou apelido — usado pela IA, que recebe
 * "nubank" e não um ULID.
 */
export function resolveAccount(reference: string, db: Db = getDb()): AccountWithCard {
  const direct = findAccount(reference, db);
  if (direct) return direct;

  const needle = slugify(reference);
  const candidates = listAccounts({ includeArchived: true, db });

  const byName = candidates.filter((a) => slugify(a.name) === needle);
  if (byName.length === 1) return byName[0]!;

  const byAlias = candidates.filter((a) => (a.aliases ?? []).some((alias) => slugify(alias) === needle));
  if (byAlias.length === 1) return byAlias[0]!;

  const partial = candidates.filter((a) => slugify(a.name).includes(needle));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw conflict(
      `"${reference}" é ambíguo — pode ser: ${partial.map((a) => a.name).join(', ')}.`,
      { candidates: partial.map((a) => ({ id: a.id, name: a.name })) },
    );
  }

  throw notFound('Conta', reference);
}

// ── Escrita ─────────────────────────────────────────────────────────────────

function assertNameAvailable(db: Db, name: string, exceptId?: string): void {
  const existing = db.select().from(accounts).where(eq(accounts.name, name)).all();
  if (existing.some((a) => a.id !== exceptId)) {
    throw conflict(`Já existe uma conta chamada "${name}".`, { name });
  }
}

export function createAccount(
  input: CreateAccountInput,
  options: WriteOptions = {},
): WriteResult<AccountWithCard> {
  const parsed = createAccountSchema.parse(input);
  const db = readDb(options);

  assertNameAvailable(db, parsed.name);

  if (parsed.kind === 'credit_card' && !parsed.card) {
    throw ruleViolation('Cartão de crédito exige dia de fechamento e de vencimento.');
  }
  if (parsed.kind !== 'credit_card' && parsed.card) {
    throw ruleViolation('Somente contas do tipo cartão de crédito aceitam configuração de fatura.');
  }
  if (parsed.kind === 'credit_card' && (parsed.hasDebitCard || parsed.debitIsVirtual)) {
    throw ruleViolation('Cartão de crédito não combina com cartão de débito na mesma conta.');
  }
  if (parsed.debitIsVirtual && !parsed.hasDebitCard) {
    throw ruleViolation('Marque hasDebitCard para definir débito virtual.');
  }
  if (parsed.card?.paymentAccountId) {
    getAccount(parsed.card.paymentAccountId, db);
  }

  return withMutate(
    options,
    (result) => `Criou conta "${result.name}"`,
    (ctx) => {
      const account = ctx.insert<Account>('accounts', {
        name: parsed.name,
        kind: parsed.kind,
        institution: parsed.institution ?? null,
        currency: parsed.currency,
        openingBalanceCents: parsed.openingBalanceCents,
        openingDate: parsed.openingDate ?? today(),
        color: parsed.color ?? null,
        icon: parsed.icon ?? null,
        notes: parsed.notes ?? null,
        aliases: parsed.aliases ?? null,
        hasDebitCard: parsed.hasDebitCard,
        debitIsVirtual: parsed.hasDebitCard ? parsed.debitIsVirtual : false,
      });

      let card: CreditCard | null = null;
      if (parsed.card) {
        card = ctx.insert<CreditCard>('credit_cards', {
          accountId: account.id,
          limitCents: parsed.card.limitCents,
          closingDay: parsed.card.closingDay,
          dueDay: parsed.card.dueDay,
          paymentAccountId: parsed.card.paymentAccountId ?? null,
          isVirtual: parsed.card.isVirtual,
        });
      }

      return { ...account, card };
    },
  );
}

export function updateAccount(
  id: string,
  input: UpdateAccountInput,
  options: WriteOptions = {},
): WriteResult<AccountWithCard> {
  const parsed = updateAccountSchema.parse(input);
  const db = readDb(options);
  const current = getAccount(id, db);

  if (parsed.name && parsed.name !== current.name) {
    assertNameAvailable(db, parsed.name, id);
  }
  if (parsed.card && current.kind !== 'credit_card') {
    throw ruleViolation('Somente cartão de crédito aceita configuração de fatura.');
  }
  if (current.kind === 'credit_card' && (parsed.hasDebitCard || parsed.debitIsVirtual)) {
    throw ruleViolation('Cartão de crédito não combina com cartão de débito na mesma conta.');
  }
  if (parsed.debitIsVirtual === true && parsed.hasDebitCard === false) {
    throw ruleViolation('Marque hasDebitCard para definir débito virtual.');
  }

  return withMutate(
    options,
    (result) => `Alterou conta "${result.name}"`,
    (ctx) => {
      const { card: cardPatch, ...accountPatch } = parsed;
      if (accountPatch.hasDebitCard === false) {
        accountPatch.debitIsVirtual = false;
      }

      const account =
        Object.keys(accountPatch).length > 0
          ? ctx.update<Account>('accounts', id, accountPatch)
          : current;

      let card = current.card;
      if (cardPatch && Object.keys(cardPatch).length > 0) {
        card = ctx.update<CreditCard>('credit_cards', id, cardPatch);
      }

      return { ...account, card };
    },
  );
}

/**
 * Arquiva a conta. Preferido a excluir: o histórico continua íntegro e a conta
 * some das listagens.
 */
export function archiveAccount(id: string, options: WriteOptions = {}): WriteResult<Account> {
  const db = readDb(options);
  const current = getAccount(id, db);

  return withMutate(
    options,
    `Arquivou conta "${current.name}"`,
    (ctx) => ctx.update<Account>('accounts', id, { isArchived: true }),
  );
}

export function unarchiveAccount(id: string, options: WriteOptions = {}): WriteResult<Account> {
  const db = readDb(options);
  const current = getAccount(id, db);

  return withMutate(
    options,
    `Reativou conta "${current.name}"`,
    (ctx) => ctx.update<Account>('accounts', id, { isArchived: false }),
  );
}

/**
 * Exclui a conta em definitivo. Só é permitido se ela nunca teve movimento —
 * caso contrário, apagar reescreveria o histórico. Use `archiveAccount`.
 */
export function deleteAccount(id: string, options: WriteOptions = {}): WriteResult<{ id: string }> {
  const db = readDb(options);
  const current = getAccount(id, db);

  const [{ count = 0 } = { count: 0 }] = db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.accountId, id))
    .all();

  if (count > 0) {
    throw ruleViolation(
      `A conta "${current.name}" tem ${count} transação(ões) e não pode ser excluída. Arquive-a em vez disso.`,
      { accountId: id, transactionCount: count },
    );
  }

  return withMutate(
    options,
    `Excluiu conta "${current.name}"`,
    (ctx) => {
      // A linha de cartão é apagada explicitamente para entrar no audit log —
      // o cascade do SQLite não é auditado e quebraria o undo.
      if (current.card) ctx.remove('credit_cards', id);
      ctx.remove('accounts', id);
      return { id };
    },
  );
}
