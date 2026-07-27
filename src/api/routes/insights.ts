import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  analyze,
  listInsights,
  markInsight,
  persistFindings,
  summarizeFindings,
} from '../../insights/analyzers.js';
import { generateReport, getReport, listReports } from '../../insights/narrator.js';
import { createBackup, listBackups } from '../../jobs/backup.js';
import { runDailyJobs } from '../../jobs/index.js';
import { notFound } from '../../core/errors.js';
import { errorResponseDto, idParamDto, insightDto, reportDto } from '../dto.js';

const findingDto = z.object({
  kind: z.string(),
  severity: z.enum(['info', 'warn', 'critical']),
  title: z.string(),
  data: z.record(z.string(), z.unknown()),
  fingerprint: z.string(),
  period: z.string().optional(),
});

export async function registerInsightRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/insights/analyze',
    {
      schema: {
        tags: ['insights'],
        summary: 'Roda os analisadores agora, sem gravar',
        description:
          'Determinístico — não usa IA. Cada achado traz os números e os IDs das transações que o ' +
          'sustentam, então dá para conferir. Ordenado do mais grave para o menos.\n\n' +
          'Funciona sem chave de API configurada.',
        response: {
          200: z.object({
            findings: z.array(findingDto),
            summary: z.string().describe('Resumo em texto simples, sem IA'),
            errors: z.array(z.object({ analyzer: z.string(), message: z.string() })),
          }),
        },
      },
    },
    () => {
      const { findings, errors } = analyze();
      return { findings, summary: summarizeFindings(findings), errors };
    },
  );

  route.post(
    '/insights/detect',
    {
      schema: {
        tags: ['insights'],
        summary: 'Roda os analisadores e grava os achados novos',
        description: 'O `fingerprint` com índice único impede o mesmo alerta de ser gravado duas vezes.',
        response: {
          200: z.object({ created: z.number().int(), existing: z.number().int(), total: z.number().int() }),
        },
      },
    },
    () => {
      const { findings } = analyze();
      const result = persistFindings(findings);
      return { ...result, total: findings.length };
    },
  );

  route.get(
    '/insights',
    {
      schema: {
        tags: ['insights'],
        summary: 'Lista os insights gravados',
        querystring: z.object({
          status: z.enum(['new', 'seen', 'dismissed']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.array(insightDto) },
      },
    },
    (request) => listInsights(request.query),
  );

  route.post(
    '/insights/:id/:action',
    {
      schema: {
        tags: ['insights'],
        summary: 'Marca um insight como visto ou descartado',
        params: z.object({ id: z.string(), action: z.enum(['seen', 'dismissed']) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    (request) => {
      markInsight(request.params.id, request.params.action);
      return { ok: true as const };
    },
  );

  route.post(
    '/reports/generate',
    {
      schema: {
        tags: ['insights'],
        summary: 'Gera o relatório narrado',
        description:
          'Os analisadores determinísticos calculam; a IA apenas redige. Sem chave de API, o ' +
          'relatório sai em formato simples — os insights continuam valendo, só perdem a redação.',
        body: z.object({
          kind: z.enum(['weekly', 'monthly', 'adhoc']).default('adhoc'),
          persist: z.boolean().default(true),
        }),
        response: {
          200: z.object({
            reportId: z.string().nullable(),
            bodyMd: z.string(),
            findings: z.array(findingDto),
            narrated: z.boolean().describe('false quando o texto saiu sem IA'),
            model: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => generateReport(request.body),
  );

  route.get(
    '/reports',
    {
      schema: {
        tags: ['insights'],
        summary: 'Lista os relatórios gerados',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: { 200: z.array(reportDto) },
      },
    },
    (request) => listReports(request.query),
  );

  route.get(
    '/reports/:id',
    {
      schema: {
        tags: ['insights'],
        summary: 'Lê um relatório',
        params: idParamDto,
        response: { 200: reportDto, 404: errorResponseDto },
      },
    },
    (request) => {
      const report = getReport(request.params.id);
      if (!report) throw notFound('Relatório', request.params.id);
      return report;
    },
  );

  // ── Operação ──────────────────────────────────────────────────────────────

  route.post(
    '/system/backup',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Cria um backup do banco',
        description:
          'Usa `VACUUM INTO`, que gera uma cópia consistente mesmo com o servidor rodando — copiar ' +
          'o arquivo à mão durante uma escrita pode produzir backup corrompido.',
        body: z.object({ retentionDays: z.number().int().min(1).max(365).default(30) }),
        response: {
          200: z.object({
            path: z.string(),
            sizeBytes: z.number().int(),
            createdAt: z.string(),
            removedOld: z.number().int(),
          }),
        },
      },
    },
    (request) => createBackup(request.body),
  );

  route.get(
    '/system/backups',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Lista os backups existentes',
        response: {
          200: z.array(
            z.object({
              filename: z.string(),
              sizeBytes: z.number().int(),
              modifiedAt: z.string(),
            }),
          ),
        },
      },
    },
    () => listBackups(),
  );

  route.post(
    '/system/run-jobs',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Roda a rotina diária agora',
        description:
          'Promove ocorrências vencidas, materializa recorrências, reavalia faturas e verifica ' +
          'integridade. Idempotente — rodar duas vezes não causa efeito duplicado.',
        response: {
          200: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
        },
      },
    },
    (request) => runDailyJobs(request.log),
  );
}
