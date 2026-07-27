/**
 * Narrador de insights.
 *
 * Recebe os achados **já calculados** pelos analisadores e escreve o relatório em
 * português. O modelo não vê transação crua nem faz conta: os números chegam
 * prontos e formatados, e ele apenas os organiza numa leitura útil.
 *
 * Se não houver chave de API, o relatório sai em formato simples, sem LLM — os
 * insights continuam valendo, só perdem a redação.
 */

import { generateText } from 'ai';
import { desc, eq } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { reports, type Report } from '../db/schema.js';
import { addMonthKey, currentMonth, formatMonthBr, monthRange, today, addDays } from '../core/clock.js';
import { hasAiKey, env } from '../config/env.js';
import { getModel } from '../ai/provider.js';
import { analyze, persistFindings, summarizeFindings, type Finding } from './analyzers.js';
import { monthOverview } from '../services/reports.js';
import { formatMoney } from '../core/money.js';

const NARRATOR_SYSTEM = `Você escreve o relatório financeiro periódico do usuário, em português do Brasil.

Você recebe achados **já calculados** por analisadores determinísticos. Todos os
números vêm prontos e formatados nos campos que terminam em "Formatted".

## Regras

1. **Use exatamente os valores fornecidos.** Nunca recalcule, some ou converta nada.
   Se um número não está nos dados, ele não entra no relatório.

2. **Não invente consequências.** O sistema registra valores, datas e categorias —
   ele não calcula juros de rotativo, multa por atraso, rendimento nem imposto. Se um
   achado tem \`interestNotTracked: true\`, você pode dizer que a fatura está vencida
   e há quantos dias, mas **não** afirme quanto de juros acumulou.

3. **Ordene por gravidade.** Comece pelo que precisa de ação hoje.

4. **Seja concreto e curto.** Cada ponto em duas ou três frases, com o número e o que
   fazer a respeito. Sem introdução genérica, sem "é importante lembrar que".

5. **Termine com uma recomendação só.** A ação mais importante, uma frase.

6. **Se houver algo bom, diga em uma linha.** Um relatório que só aponta problema
   deixa de ser lido.

Formato: markdown com \`###\` para cada ponto. Sem título geral — ele já é adicionado.`;

export interface NarratedReport {
  bodyMd: string;
  findings: Finding[];
  /** `false` quando não havia chave de API e o texto saiu do formato simples. */
  narrated: boolean;
  model: string | null;
}

/**
 * Monta o pacote de dados que vai ao modelo.
 *
 * Compacto de propósito: só os achados e um cabeçalho do período. Enviar mais
 * contexto do que isso convidaria o modelo a tirar conclusões próprias em cima de
 * números que ele não deveria manipular.
 */
function buildDataPack(findings: readonly Finding[], period: string, db: Db): string {
  const overview = monthOverview(currentMonth(), { db });

  const lines = [
    `Período do relatório: ${period}`,
    '',
    'Resumo do mês corrente (números já calculados):',
    `- Receita: ${formatMoney(overview.incomeCents)}`,
    `- Despesa: ${formatMoney(overview.expenseCents)}`,
    `- Saldo: ${formatMoney(overview.netCents)}`,
    overview.savingsRatePercent !== null
      ? `- Taxa de poupança: ${overview.savingsRatePercent}%`
      : '- Taxa de poupança: sem receita registrada no período',
    '',
    `Achados (${findings.length}), do mais grave para o menos:`,
    '',
  ];

  for (const [index, finding] of findings.entries()) {
    lines.push(`### Achado ${index + 1} — ${finding.severity.toUpperCase()}: ${finding.title}`);
    lines.push(`Tipo: \`${finding.kind}\``);
    lines.push('```json');
    lines.push(JSON.stringify(finding.data, null, 1));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

/** Relatório sem LLM: lista os achados em formato simples. */
function fallbackReport(findings: readonly Finding[], db: Db): string {
  const overview = monthOverview(currentMonth(), { db });
  const lines = [
    `Receita ${formatMoney(overview.incomeCents)} · Despesa ${formatMoney(overview.expenseCents)} · ` +
      `Saldo ${formatMoney(overview.netCents)}`,
    '',
    summarizeFindings(findings),
  ];

  if (!hasAiKey()) {
    lines.push('');
    lines.push('_(Configure DEEPSEEK_API_KEY no .env para receber o relatório narrado.)_');
  }

  return lines.join('\n');
}

/**
 * Gera o relatório de um período.
 *
 * Os analisadores rodam sempre; o LLM entra apenas para redigir. Assim os insights
 * existem mesmo sem chave configurada, e a narração é um acréscimo — não um
 * requisito.
 */
export async function generateReport(
  options: {
    kind?: 'weekly' | 'monthly' | 'adhoc';
    db?: Db;
    /** Persiste o relatório e os achados. Padrão: `true`. */
    persist?: boolean;
  } = {},
): Promise<NarratedReport & { reportId: string | null }> {
  const db = options.db ?? getDb();
  const kind = options.kind ?? 'adhoc';

  const { findings, errors } = analyze(db);
  if (errors.length > 0) {
    // Não interrompe: um analisador com problema não deve impedir o relatório.
    console.warn('Analisadores com erro:', errors);
  }

  const { periodStart, periodEnd, label } = periodFor(kind);

  if (options.persist !== false) {
    persistFindings(findings, db);
  }

  let bodyMd: string;
  let narrated = false;
  let model: string | null = null;

  if (hasAiKey() && findings.length > 0) {
    try {
      const result = await generateText({
        model: getModel(),
        system: NARRATOR_SYSTEM,
        prompt: buildDataPack(findings, label, db),
      });
      bodyMd = result.text;
      narrated = true;
      model = env.AI_MODEL;
    } catch (error) {
      // Falha de API não pode custar o relatório inteiro.
      bodyMd =
        fallbackReport(findings, db) +
        `\n\n_(A narração falhou: ${error instanceof Error ? error.message : String(error)})_`;
    }
  } else {
    bodyMd = fallbackReport(findings, db);
  }

  let reportId: string | null = null;
  if (options.persist !== false) {
    const rows = db
      .insert(reports)
      .values({
        kind,
        periodStart,
        periodEnd,
        bodyMd,
        insightIds: findings.map((f) => f.fingerprint),
        model,
      })
      .returning()
      .all();
    reportId = rows[0]?.id ?? null;
  }

  return { bodyMd, findings, narrated, model, reportId };
}

function periodFor(kind: 'weekly' | 'monthly' | 'adhoc'): {
  periodStart: string;
  periodEnd: string;
  label: string;
} {
  const reference = today();

  if (kind === 'weekly') {
    return {
      periodStart: addDays(reference, -7),
      periodEnd: reference,
      label: `últimos 7 dias (até ${reference})`,
    };
  }

  if (kind === 'monthly') {
    const previous = addMonthKey(currentMonth(), -1);
    const range = monthRange(previous);
    return { periodStart: range.start, periodEnd: range.end, label: formatMonthBr(previous) };
  }

  const range = monthRange(currentMonth());
  return { periodStart: range.start, periodEnd: reference, label: `${formatMonthBr(currentMonth())} até hoje` };
}

export function listReports(options: { limit?: number; db?: Db } = {}): Report[] {
  const db = options.db ?? getDb();
  return db.select().from(reports).orderBy(desc(reports.createdAt)).limit(options.limit ?? 20).all();
}

export function getReport(id: string, db: Db = getDb()): Report | undefined {
  return db.select().from(reports).where(eq(reports.id, id)).all()[0];
}
