/**
 * Importação de extratos: CSV e OFX.
 *
 * Fluxo em duas etapas — **analisar** e depois **aplicar**:
 *
 *  1. `parseImport` lê o arquivo, detecta duplicatas e devolve o que seria criado,
 *     sem gravar transação nenhuma.
 *  2. `applyImport` grava, num único change set — então o lote inteiro é
 *     revertível com um `undo`.
 *
 * Separar as etapas é o que torna a importação segura: extrato de banco vem com
 * formato imprevisível, e conferir antes de gravar evita ter que limpar 200 linhas
 * erradas na mão.
 *
 * A deduplicação usa hash de `(conta, data, valor, descrição normalizada)`, mais o
 * identificador do banco (`FITID` no OFX) quando existe. Reimportar o mesmo mês —
 * o que acontece toda hora, porque os extratos se sobrepõem — não duplica nada.
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import {
  importBatches,
  importRows,
  transactions,
  type ImportBatch,
  type ImportRow,
} from '../db/schema.js';
import { conflict, notFound, ruleViolation, validation } from '../core/errors.js';
import { parseMoney } from '../core/money.js';
import { isIsoDate, makeDate, nowIso, type IsoDate } from '../core/clock.js';
import { slugify } from '../core/ids.js';
import { withMutate, readDb, type WriteOptions, type WriteResult } from '../mutate/write.js';
import { undoChangeSet } from '../mutate/index.js';
import { getAccount } from './accounts.js';
import { insertTransactionIn } from './transactions.js';
import { recordRuleHitsIn, resolveActions } from './rules.js';
import { getCategory } from './categories.js';
import { idSchema } from './schemas.js';

export interface ParsedEntry {
  date: IsoDate;
  amountCents: number;
  description: string;
  /** Identificador do lado do banco, quando o formato fornece. */
  externalId?: string;
  raw: Record<string, string>;
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Interpreta data em formato brasileiro ou ISO.
 *
 * Extratos brasileiros usam `DD/MM/AAAA`; alguns exportam `AAAA-MM-DD`. Assumir um
 * só formato inverteria dia e mês silenciosamente na metade dos casos.
 */
export function parseFlexibleDate(value: string): IsoDate {
  const text = value.trim();

  if (isIsoDate(text)) return text;

  const br = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (br) {
    const day = Number(br[1]);
    const month = Number(br[2]);
    let year = Number(br[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return makeDate(year, month, day);
  }

  // OFX: AAAAMMDD, às vezes com hora e fuso colados.
  const ofx = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (ofx) return makeDate(Number(ofx[1]), Number(ofx[2]), Number(ofx[3]));

  throw validation(`Não consegui interpretar a data "${value}".`);
}

export interface CsvMapping {
  date: string;
  description: string;
  /** Coluna com valor assinado. Use com `amount`, ou com `debit`/`credit`. */
  amount?: string;
  /** Colunas separadas para saída e entrada, comuns em extrato de banco. */
  debit?: string;
  credit?: string;
  externalId?: string;
}

/** Nomes de coluna comuns em extratos brasileiros, para detecção automática. */
const COLUMN_HINTS: Record<keyof CsvMapping, string[]> = {
  date: ['data', 'data lancamento', 'data movimento', 'date', 'data da compra'],
  description: ['descricao', 'historico', 'lancamento', 'description', 'memo', 'estabelecimento', 'titulo'],
  amount: ['valor', 'amount', 'value', 'valor (r$)', 'montante'],
  debit: ['debito', 'saida', 'debit'],
  credit: ['credito', 'entrada', 'credit'],
  externalId: ['id', 'identificador', 'fitid', 'documento'],
};

/** Descobre o mapeamento das colunas pelo cabeçalho. */
export function detectCsvMapping(headers: readonly string[]): CsvMapping {
  const normalized = headers.map((h) => slugify(h));

  const find = (field: keyof CsvMapping): string | undefined => {
    for (const hint of COLUMN_HINTS[field]) {
      const index = normalized.indexOf(slugify(hint));
      if (index >= 0) return headers[index];
    }
    return undefined;
  };

  const date = find('date');
  const description = find('description');
  if (!date || !description) {
    throw validation(
      `Não identifiquei as colunas de data e descrição. Cabeçalho encontrado: ${headers.join(', ')}. ` +
        'Informe o mapeamento manualmente.',
    );
  }

  const amount = find('amount');
  const debit = find('debit');
  const credit = find('credit');

  if (!amount && !debit && !credit) {
    throw validation(`Não identifiquei a coluna de valor. Cabeçalho: ${headers.join(', ')}.`);
  }

  return {
    date,
    description,
    ...(amount ? { amount } : {}),
    ...(debit ? { debit } : {}),
    ...(credit ? { credit } : {}),
    ...(find('externalId') ? { externalId: find('externalId')! } : {}),
  };
}

export function parseCsvStatement(content: string, mapping?: CsvMapping): ParsedEntry[] {
  // Extratos brasileiros costumam usar `;`. Detecta pela primeira linha.
  const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const records = parseCsv(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter,
    relax_column_count: true,
  }) as Array<Record<string, string>>;

  if (records.length === 0) throw validation('O arquivo CSV não tem linhas de dados.');

  const resolved = mapping ?? detectCsvMapping(Object.keys(records[0]!));
  const entries: ParsedEntry[] = [];

  for (const record of records) {
    const dateText = record[resolved.date];
    const description = record[resolved.description];
    if (!dateText || !description) continue;

    let amountCents: number;
    if (resolved.amount) {
      const raw = record[resolved.amount];
      if (!raw || raw.trim() === '') continue;
      amountCents = parseMoney(raw);
    } else {
      const debit = resolved.debit ? record[resolved.debit] : undefined;
      const credit = resolved.credit ? record[resolved.credit] : undefined;
      const debitCents = debit && debit.trim() !== '' ? Math.abs(parseMoney(debit)) : 0;
      const creditCents = credit && credit.trim() !== '' ? Math.abs(parseMoney(credit)) : 0;
      if (debitCents === 0 && creditCents === 0) continue;
      amountCents = creditCents - debitCents;
    }

    if (amountCents === 0) continue;

    entries.push({
      date: parseFlexibleDate(dateText),
      amountCents,
      description: description.trim().replace(/\s+/g, ' '),
      ...(resolved.externalId && record[resolved.externalId]
        ? { externalId: record[resolved.externalId] }
        : {}),
      raw: record,
    });
  }

  if (entries.length === 0) {
    throw validation('Nenhuma linha do CSV pôde ser interpretada. Confira o mapeamento das colunas.');
  }

  return entries;
}

/**
 * Interpreta OFX.
 *
 * OFX é SGML, não XML — tags podem não ter fechamento. Um parser XML falha nele.
 * Aqui só interessam os blocos `STMTTRN`, que é o que todo banco brasileiro emite.
 */
export function parseOfxStatement(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const blocks = content.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];

  const tag = (block: string, name: string): string | undefined => {
    // Aceita `<TAG>valor` (sem fechamento) e `<TAG>valor</TAG>`.
    const match = new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i').exec(block);
    return match?.[1]?.trim() || undefined;
  };

  for (const block of blocks) {
    const dateText = tag(block, 'DTPOSTED');
    const amountText = tag(block, 'TRNAMT');
    if (!dateText || !amountText) continue;

    // MEMO é o campo mais informativo; NAME é o fallback.
    const description = tag(block, 'MEMO') ?? tag(block, 'NAME') ?? 'Lançamento importado';
    const amountCents = parseMoney(amountText.replace(',', '.'));
    if (amountCents === 0) continue;

    entries.push({
      date: parseFlexibleDate(dateText),
      amountCents,
      description: description.replace(/\s+/g, ' ').trim(),
      ...(tag(block, 'FITID') ? { externalId: tag(block, 'FITID')! } : {}),
      raw: { block },
    });
  }

  if (entries.length === 0) {
    throw validation('Nenhuma transação (STMTTRN) encontrada no arquivo OFX.');
  }

  return entries;
}

// ── Deduplicação ────────────────────────────────────────────────────────────

/**
 * Hash de identidade de um lançamento.
 *
 * Usa a descrição **normalizada** (sem acento, caixa ou espaço extra) porque o
 * mesmo lançamento vem com grafia ligeiramente diferente em exportações distintas.
 */
export function dedupeHash(accountId: string, date: IsoDate, amountCents: number, description: string): string {
  return createHash('sha256')
    .update(`${accountId}|${date}|${amountCents}|${slugify(description)}`)
    .digest('hex')
    .slice(0, 32);
}

// ── Análise ─────────────────────────────────────────────────────────────────

export const parseImportSchema = z.object({
  accountId: idSchema,
  filename: z.string().min(1).max(255),
  content: z.string().min(1),
  source: z.enum(['csv', 'ofx']).optional(),
  mapping: z
    .object({
      date: z.string(),
      description: z.string(),
      amount: z.string().optional(),
      debit: z.string().optional(),
      credit: z.string().optional(),
      externalId: z.string().optional(),
    })
    .optional(),
});

export type ParseImportInput = z.input<typeof parseImportSchema>;

export interface ImportPreviewRow {
  lineNo: number;
  date: IsoDate;
  amountCents: number;
  description: string;
  status: 'new' | 'duplicate';
  /** Transação existente que causou a marcação de duplicata. */
  duplicateOfId?: string;
  /** Categoria que as regras aplicariam. */
  suggestedCategoryId?: string;
  suggestedCategoryName?: string;
  matchedRuleNames?: string[];
}

export interface ImportPreview {
  batchId: string;
  accountId: string;
  accountName: string;
  filename: string;
  source: 'csv' | 'ofx';
  totalRows: number;
  newRows: number;
  duplicateRows: number;
  /** Soma das linhas novas. */
  netCents: number;
  dateRange: { from: IsoDate; to: IsoDate } | null;
  rows: ImportPreviewRow[];
}

/**
 * Analisa o arquivo e registra o lote, **sem criar transações**.
 *
 * O lote fica gravado com status `parsed` para que a aplicação possa acontecer
 * depois, com a conferência já feita.
 */
export function parseImport(
  input: ParseImportInput,
  options: WriteOptions = {},
): WriteResult<ImportPreview> {
  const parsed = parseImportSchema.parse(input);
  const db = readDb(options);
  const account = getAccount(parsed.accountId, db);

  const source =
    parsed.source ??
    (parsed.filename.toLowerCase().endsWith('.ofx') || parsed.content.includes('<STMTTRN>')
      ? 'ofx'
      : 'csv');

  const entries =
    source === 'ofx'
      ? parseOfxStatement(parsed.content)
      : parseCsvStatement(parsed.content, parsed.mapping as CsvMapping | undefined);

  const fileHash = createHash('sha256').update(parsed.content).digest('hex').slice(0, 32);

  // Reimportar o mesmo arquivo é comum e não é erro — mas avisar evita retrabalho.
  const previousBatch = db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.fileHash, fileHash), eq(importBatches.status, 'applied')))
    .all()[0];

  if (previousBatch) {
    throw conflict(
      `Este arquivo já foi importado em ${previousBatch.appliedAt ?? previousBatch.createdAt}. ` +
        'Se quiser reimportar, reverta o lote anterior primeiro.',
      { previousBatchId: previousBatch.id },
    );
  }

  // Hashes já existentes na conta, para marcar duplicatas.
  const hashes = new Map<string, string>();
  for (const row of db
    .select({ id: transactions.id, hash: transactions.dedupeHash, externalId: transactions.externalId })
    .from(transactions)
    .where(eq(transactions.accountId, parsed.accountId))
    .all()) {
    if (row.hash) hashes.set(row.hash, row.id);
    if (row.externalId) hashes.set(`ext:${row.externalId}`, row.id);
  }

  // Transações lançadas manualmente também precisam ser detectadas, mesmo sem hash.
  for (const row of db
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, parsed.accountId))
    .all()) {
    const hash = dedupeHash(parsed.accountId, row.date, row.amountCents, row.description);
    if (!hashes.has(hash)) hashes.set(hash, row.id);
  }

  return withMutate(
    options,
    (result) =>
      `Analisou "${result.filename}": ${result.newRows} novo(s), ${result.duplicateRows} duplicado(s)`,
    (ctx) => {
      const batch = ctx.insert<ImportBatch>('import_batches', {
        source,
        filename: parsed.filename,
        accountId: parsed.accountId,
        fileHash,
        status: 'parsed',
        stats: { total: entries.length },
      });

      const rows: ImportPreviewRow[] = [];
      const seenInFile = new Set<string>();
      let newRows = 0;
      let netCents = 0;

      for (const [index, entry] of entries.entries()) {
        const hash = dedupeHash(parsed.accountId, entry.date, entry.amountCents, entry.description);
        const externalKey = entry.externalId ? `ext:${entry.externalId}` : null;

        const duplicateOfId =
          (externalKey ? hashes.get(externalKey) : undefined) ??
          hashes.get(hash) ??
          // Linha repetida dentro do próprio arquivo.
          (seenInFile.has(hash) ? 'mesma-importacao' : undefined);

        const isDuplicate = duplicateOfId !== undefined;
        seenInFile.add(hash);

        const suggestion = isDuplicate
          ? undefined
          : resolveActions(
              {
                description: entry.description,
                amountCents: entry.amountCents,
                accountId: parsed.accountId,
                type: entry.amountCents < 0 ? 'expense' : 'income',
              },
              ctx.tx,
            );

        const suggestedCategory =
          suggestion?.categoryId !== undefined ? getCategory(suggestion.categoryId, ctx.tx) : undefined;

        const previewRow: ImportPreviewRow = {
          lineNo: index + 1,
          date: entry.date,
          amountCents: entry.amountCents,
          description: entry.description,
          status: isDuplicate ? 'duplicate' : 'new',
          ...(duplicateOfId ? { duplicateOfId } : {}),
          ...(suggestedCategory
            ? { suggestedCategoryId: suggestedCategory.id, suggestedCategoryName: suggestedCategory.name }
            : {}),
        };

        rows.push(previewRow);

        if (!isDuplicate) {
          newRows += 1;
          netCents += entry.amountCents;
        }

        ctx.insert('import_rows', {
          batchId: batch.id,
          lineNo: index + 1,
          raw: entry.raw,
          parsed: {
            date: entry.date,
            amountCents: entry.amountCents,
            description: entry.description,
            ...(entry.externalId ? { externalId: entry.externalId } : {}),
            ...(suggestion?.categoryId ? { categoryId: suggestion.categoryId } : {}),
          },
          dedupeHash: hash,
          status: isDuplicate ? 'duplicate' : 'new',
        });
      }

      const dates = entries.map((e) => e.date).sort();

      return {
        batchId: batch.id,
        accountId: parsed.accountId,
        accountName: account.name,
        filename: parsed.filename,
        source,
        totalRows: entries.length,
        newRows,
        duplicateRows: entries.length - newRows,
        netCents,
        dateRange: dates.length > 0 ? { from: dates[0]!, to: dates.at(-1)! } : null,
        rows,
      };
    },
  );
}

// ── Aplicação ───────────────────────────────────────────────────────────────

export interface ImportResult {
  batchId: string;
  created: number;
  skipped: number;
}

/**
 * Grava as linhas novas do lote como transações.
 *
 * Tudo num único change set: reverter a importação inteira é uma chamada de
 * `undo`. Pode-se restringir a linhas específicas com `lineNumbers`, para o caso
 * de conferir e querer só parte do extrato.
 */
export function applyImport(
  batchId: string,
  options: WriteOptions & { lineNumbers?: number[]; includeDuplicates?: boolean } = {},
): WriteResult<ImportResult> {
  const db = readDb(options);
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).all()[0];
  if (!batch) throw notFound('Lote de importação', batchId);

  if (batch.status === 'applied') {
    throw ruleViolation('Este lote já foi aplicado.', { batchId });
  }
  if (batch.status === 'reverted') {
    throw ruleViolation('Este lote foi revertido e não pode ser reaplicado.', { batchId });
  }

  const allRows = db
    .select()
    .from(importRows)
    .where(eq(importRows.batchId, batchId))
    .orderBy(importRows.lineNo)
    .all();

  const selected = allRows.filter((row) => {
    if (options.lineNumbers && !options.lineNumbers.includes(row.lineNo)) return false;
    if (row.status === 'duplicate') return options.includeDuplicates === true;
    return row.status === 'new';
  });

  return withMutate(
    options,
    (result) => `Importou ${result.created} lançamento(s) de "${batch.filename}"`,
    (ctx) => {
      let created = 0;
      const ruleHits: string[] = [];

      for (const row of selected) {
        const parsedRow = row.parsed as {
          date: IsoDate;
          amountCents: number;
          description: string;
          externalId?: string;
          categoryId?: string;
        } | null;
        if (!parsedRow) continue;

        const type = parsedRow.amountCents < 0 ? 'expense' : 'income';
        const resolved = resolveActions(
          {
            description: parsedRow.description,
            amountCents: parsedRow.amountCents,
            accountId: batch.accountId,
            type,
          },
          ctx.tx,
        );

        // A categoria sugerida só é usada se o tipo casar.
        let categoryId: string | undefined;
        if (resolved.categoryId) {
          const category = getCategory(resolved.categoryId, ctx.tx);
          if (category.kind === type) categoryId = category.id;
        }

        const transaction = insertTransactionIn(ctx, {
          accountId: batch.accountId,
          type,
          date: parsedRow.date,
          amountCents: Math.abs(parsedRow.amountCents),
          description: resolved.setDescription ?? parsedRow.description,
          ...(categoryId ? { categoryId } : {}),
          ...(resolved.payeeId ? { payeeId: resolved.payeeId } : {}),
          ...(resolved.setNotes ? { notes: resolved.setNotes } : {}),
          links: {
            importRowId: row.id,
            dedupeHash: row.dedupeHash,
            ...(parsedRow.externalId ? { externalId: parsedRow.externalId } : {}),
            createdBy: 'system',
          },
        });

        ctx.update('import_rows', row.id, { status: 'imported', transactionId: transaction.id });
        ruleHits.push(...resolved.ruleIds);
        created += 1;
      }

      recordRuleHitsIn(ctx, ruleHits);

      ctx.update('import_batches', batchId, {
        status: 'applied',
        appliedAt: nowIso(),
        changeSetId: ctx.changeSetId,
        stats: { total: allRows.length, created, skipped: allRows.length - created },
      });

      return { batchId, created, skipped: allRows.length - created };
    },
  );
}

/**
 * Reverte um lote aplicado.
 *
 * Delega ao `undo` do change set da aplicação — o mesmo mecanismo usado em
 * qualquer outra operação, então não há um caminho de reversão especial que
 * poderia divergir.
 */
export function revertImport(
  batchId: string,
  options: WriteOptions = {},
): WriteResult<{ batchId: string; reverted: number }> {
  const db = readDb(options);
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).all()[0];
  if (!batch) throw notFound('Lote de importação', batchId);

  if (batch.status !== 'applied') {
    throw ruleViolation('Só é possível reverter um lote que foi aplicado.', { batchId, status: batch.status });
  }
  if (!batch.changeSetId) {
    throw ruleViolation('Este lote não registrou o change set da aplicação.', { batchId });
  }

  const outcome = undoChangeSet(batch.changeSetId, {
    actor: options.actor ?? 'user',
    source: 'import',
    ...(options.db ? { db: options.db } : {}),
  });

  // O `undo` já reverteu as transações e as linhas; falta marcar o lote.
  return withMutate(
    options,
    `Reverteu a importação de "${batch.filename}"`,
    (ctx) => {
      ctx.update('import_batches', batchId, { status: 'reverted', revertedAt: nowIso() });
      return { batchId, reverted: outcome.result.reverted };
    },
  );
}

export function listImportBatches(options: { accountId?: string; db?: Db } = {}): ImportBatch[] {
  const db = options.db ?? getDb();
  return db
    .select()
    .from(importBatches)
    .where(options.accountId ? eq(importBatches.accountId, options.accountId) : undefined)
    .orderBy(importBatches.createdAt)
    .all();
}

export function importBatchRows(batchId: string, db: Db = getDb()): ImportRow[] {
  return db.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(importRows.lineNo).all();
}

export { inArray };
