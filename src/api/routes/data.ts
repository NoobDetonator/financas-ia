/**
 * Rotas de investimentos, relatórios, regras e importação.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createHolding,
  createHoldingSchema,
  deleteHolding,
  getHolding,
  holdingTrades,
  listHoldings,
  portfolioSummary,
  recordSnapshot,
  registerTrade,
  tradeSchema,
} from '../../services/investments.js';
import {
  categoryTrends,
  compareMonths,
  findDuplicates,
  largestTransactions,
  monthOverview,
  monthlyFlow,
  spendByCategory,
  spendByParentCategory,
  topPayees,
} from '../../services/reports.js';
import {
  applyRules,
  createRule,
  createRuleSchema,
  deleteRule,
  listRules,
  previewApplyRules,
  suggestRules,
  updateRule,
} from '../../services/rules.js';
import {
  applyImport,
  importBatchRows,
  listImportBatches,
  parseImport,
  parseImportSchema,
  revertImport,
} from '../../services/import.js';
import { idSchema, isoDateSchema, monthKeySchema, positiveCentsSchema } from '../../services/schemas.js';
import {
  errorResponseDto,
  holdingDto,
  idParamDto,
  importBatchDto,
  importRowDto,
  investmentTransactionDto,
  positionSnapshotDto,
  ruleDto,
  transactionDto,
  writeResponse,
} from '../dto.js';

const positionDto = holdingDto.extend({
  quantity: z.number(),
  averageCostCents: z.number().int().nullable(),
  marketValueCents: z.number().int().nullable(),
  lastSnapshotDate: z.string().nullable(),
  gainCents: z.number().int().nullable(),
  gainPercent: z.number().nullable(),
  incomeCents: z.number().int(),
});

const categoryItemDto = z.object({
  categoryId: z.string().nullable(),
  categoryName: z.string(),
  parentId: z.string().nullable(),
  parentName: z.string().nullable(),
  amountCents: z.number().int(),
  transactionCount: z.number().int(),
  percentOfTotal: z.number(),
});

const payeeItemDto = z.object({
  payeeId: z.string().nullable(),
  payeeName: z.string(),
  amountCents: z.number().int(),
  transactionCount: z.number().int(),
  averageCents: z.number().int(),
});

export async function registerDataRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  // ── Investimentos ─────────────────────────────────────────────────────────

  route.get(
    '/holdings',
    {
      schema: {
        tags: ['investimentos'],
        summary: 'Lista os ativos da carteira',
        querystring: z.object({
          includeArchived: z.coerce.boolean().default(false),
          assetClass: z
            .enum(['stock', 'fii', 'etf', 'fixed_income', 'crypto', 'fund', 'pension', 'other'])
            .optional(),
        }),
        response: { 200: z.array(positionDto) },
      },
    },
    (request) => listHoldings(request.query),
  );

  route.get(
    '/portfolio',
    {
      schema: {
        tags: ['investimentos'],
        summary: 'Resumo da carteira',
        description:
          'Ativos sem snapshot de cotação entram no total pelo custo — a valorização não é inventada. ' +
          'Eles aparecem em `withoutSnapshot`.',
        response: {
          200: z.object({
            totalCostCents: z.number().int(),
            totalMarketValueCents: z.number().int(),
            totalGainCents: z.number().int(),
            totalGainPercent: z.number().nullable(),
            totalIncomeCents: z.number().int(),
            withoutSnapshot: z.array(z.string()),
            byAssetClass: z.array(
              z.object({
                assetClass: z.string(),
                costCents: z.number().int(),
                marketValueCents: z.number().int(),
                percentOfPortfolio: z.number(),
              }),
            ),
            positions: z.array(positionDto),
          }),
        },
      },
    },
    () => portfolioSummary(),
  );

  route.get(
    '/holdings/:id',
    {
      schema: {
        tags: ['investimentos'],
        summary: 'Detalha um ativo e suas operações',
        params: idParamDto,
        response: {
          200: positionDto.extend({ trades: z.array(investmentTransactionDto) }),
          404: errorResponseDto,
        },
      },
    },
    (request) => ({ ...getHolding(request.params.id), trades: holdingTrades(request.params.id) }),
  );

  route.post(
    '/holdings',
    {
      schema: {
        tags: ['investimentos'],
        summary: 'Cadastra um ativo',
        body: createHoldingSchema,
        response: { 200: writeResponse(positionDto), 404: errorResponseDto },
      },
    },
    (request) => createHolding(request.body, { requestId: request.id }),
  );

  route.post(
    '/holdings/:id/trades',
    {
      schema: {
        tags: ['investimentos'],
        summary: 'Registra uma operação',
        description:
          '`buy` soma ao custo; `sell` reduz a quantidade e o custo **proporcionalmente** (preserva o ' +
          'preço médio); `dividend`/`interest` entram como provento sem mexer no custo; `adjust` ' +
          'corrige a quantidade (desdobramento).\n\n' +
          'Com `cashAccountId`, lança também a movimentação na conta. A quantidade aceita fração — ' +
          'é guardada como inteiro na escala 1e-8, exata até para cripto.',
        params: idParamDto,
        body: tradeSchema,
        response: {
          200: writeResponse(
            z.object({
              trade: investmentTransactionDto,
              position: positionDto,
              transactionId: z.string().nullable(),
            }),
          ),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => registerTrade(request.params.id, request.body, { requestId: request.id }),
  );

  route.post(
    '/holdings/:id/snapshot',
    {
      schema: {
        tags: ['investimentos'],
        summary: 'Registra o valor de mercado numa data',
        description: 'Único por ativo e data — informar de novo no mesmo dia substitui o valor anterior.',
        params: idParamDto,
        body: z.object({
          marketValueCents: positiveCentsSchema,
          date: isoDateSchema.optional(),
          note: z.string().max(500).optional(),
        }),
        response: { 200: writeResponse(positionSnapshotDto), 404: errorResponseDto },
      },
    },
    (request) => recordSnapshot(request.params.id, request.body, { requestId: request.id }),
  );

  route.delete(
    '/holdings/:id',
    {
      schema: {
        tags: ['investimentos'],
        summary: 'Exclui um ativo',
        params: idParamDto,
        response: {
          200: writeResponse(
            z.object({ removedTrades: z.number().int(), removedSnapshots: z.number().int() }),
          ),
          404: errorResponseDto,
        },
      },
    },
    (request) => deleteHolding(request.params.id, { requestId: request.id }),
  );

  // ── Relatórios ────────────────────────────────────────────────────────────

  const periodQuery = z.object({ from: isoDateSchema, to: isoDateSchema });

  route.get(
    '/reports/by-category',
    {
      schema: {
        tags: ['relatórios'],
        summary: 'Gasto por categoria',
        description:
          'Rateios contribuem com a sua parte, não com o total da compra. `rollup=true` agrupa nas ' +
          'categorias mãe.',
        querystring: periodQuery.extend({
          kind: z.enum(['expense', 'income']).default('expense'),
          rollup: z.coerce.boolean().default(false),
        }),
        response: {
          200: z.object({ items: z.array(categoryItemDto), totalCents: z.number().int() }),
        },
      },
    },
    (request) => {
      const { from, to, kind, rollup } = request.query;
      return rollup
        ? spendByParentCategory(from, to, { kind })
        : spendByCategory(from, to, { kind });
    },
  );

  route.get(
    '/reports/monthly-flow',
    {
      schema: {
        tags: ['relatórios'],
        summary: 'Fluxo de caixa mês a mês',
        querystring: z.object({ fromMonth: monthKeySchema, toMonth: monthKeySchema }),
        response: {
          200: z.array(
            z.object({
              month: z.string(),
              incomeCents: z.number().int(),
              expenseCents: z.number().int(),
              netCents: z.number().int(),
              savingsRatePercent: z.number().nullable(),
            }),
          ),
        },
      },
    },
    (request) => monthlyFlow(request.query.fromMonth, request.query.toMonth),
  );

  route.get(
    '/reports/month-overview',
    {
      schema: {
        tags: ['relatórios'],
        summary: 'Panorama completo de um mês',
        description: 'Reúne o essencial numa chamada só — receita, despesa, top categorias e comparação.',
        querystring: z.object({ month: monthKeySchema.optional() }),
        response: {
          200: z.object({
            month: z.string(),
            from: z.string(),
            to: z.string(),
            incomeCents: z.number().int(),
            expenseCents: z.number().int(),
            netCents: z.number().int(),
            savingsRatePercent: z.number().nullable(),
            transactionCount: z.number().int(),
            topCategories: z.array(categoryItemDto),
            topPayees: z.array(payeeItemDto),
            largestExpenses: z.array(
              z.object({
                id: z.string(),
                description: z.string(),
                amountCents: z.number().int(),
                date: z.string(),
              }),
            ),
            comparedToPreviousMonth: z.object({
              expenseChangeCents: z.number().int(),
              expenseChangePercent: z.number().nullable(),
            }),
          }),
        },
      },
    },
    (request) => monthOverview(request.query.month),
  );

  route.get(
    '/reports/compare',
    {
      schema: {
        tags: ['relatórios'],
        summary: 'Compara dois meses',
        description: 'Destaca em quais categorias a diferença aconteceu, ordenadas pela variação.',
        querystring: z.object({ month: monthKeySchema, against: monthKeySchema.optional() }),
        response: { 200: z.any() },
      },
    },
    (request) => compareMonths(request.query.month, request.query.against),
  );

  route.get(
    '/reports/trends',
    {
      schema: {
        tags: ['relatórios'],
        summary: 'Histórico por categoria, com mediana',
        description:
          'A **mediana** é usada em vez da média porque um único mês atípico puxaria a média e o ' +
          'próprio pico passaria a ser considerado normal. `deviationPercent` mede o desvio do mês atual.',
        querystring: z.object({
          months: z.coerce.number().int().min(2).max(24).default(4),
          referenceMonth: monthKeySchema.optional(),
        }),
        response: { 200: z.any() },
      },
    },
    (request) => categoryTrends(request.query),
  );

  route.get(
    '/reports/top-payees',
    {
      schema: {
        tags: ['relatórios'],
        summary: 'Onde o dinheiro foi, por favorecido',
        querystring: periodQuery.extend({ limit: z.coerce.number().int().min(1).max(50).default(10) }),
        response: { 200: z.array(payeeItemDto) },
      },
    },
    (request) => topPayees(request.query.from, request.query.to, { limit: request.query.limit }),
  );

  route.get(
    '/reports/largest',
    {
      schema: {
        tags: ['relatórios'],
        summary: 'Maiores gastos de um período',
        querystring: periodQuery.extend({ limit: z.coerce.number().int().min(1).max(50).default(10) }),
        response: { 200: z.array(transactionDto) },
      },
    },
    (request) => largestTransactions(request.query.from, request.query.to, { limit: request.query.limit }),
  );

  route.get(
    '/reports/duplicates',
    {
      schema: {
        tags: ['relatórios'],
        summary: 'Cobranças possivelmente duplicadas',
        description:
          'Mesmo valor e descrição em dias próximos. Parcelamentos e recorrências são ignorados — ' +
          'eles repetem valor de propósito.',
        querystring: z.object({ withinDays: z.coerce.number().int().min(1).max(30).default(3) }),
        response: {
          200: z.array(
            z.object({
              description: z.string(),
              amountCents: z.number().int(),
              dates: z.array(z.string()),
              ids: z.array(z.string()),
            }),
          ),
        },
      },
    },
    (request) => findDuplicates(request.query),
  );

  // ── Regras ────────────────────────────────────────────────────────────────

  route.get(
    '/rules',
    {
      schema: {
        tags: ['regras'],
        summary: 'Lista as regras de auto-categorização',
        response: { 200: z.array(ruleDto) },
      },
    },
    () => listRules(),
  );

  route.get(
    '/rules/suggestions',
    {
      schema: {
        tags: ['regras'],
        summary: 'Sugere regras a partir do histórico',
        description:
          'Procura padrões de descrição que você categorizou consistentemente na mesma categoria. ' +
          'É como o sistema aprende sem modelo treinado — a evidência já está nos seus lançamentos. ' +
          'Padrões que já têm regra são omitidos.',
        querystring: z.object({
          minOccurrences: z.coerce.number().int().min(2).max(50).default(3),
          minConfidence: z.coerce.number().min(50).max(100).default(80),
        }),
        response: {
          200: z.array(
            z.object({
              descriptionPattern: z.string(),
              categoryId: z.string(),
              categoryName: z.string(),
              occurrences: z.number().int(),
              confidencePercent: z.number(),
              sampleDescriptions: z.array(z.string()),
            }),
          ),
        },
      },
    },
    (request) => suggestRules(request.query),
  );

  route.get(
    '/rules/preview',
    {
      schema: {
        tags: ['regras'],
        summary: 'Simula a aplicação das regras',
        description: 'Devolve o diff antes de escrever nada.',
        querystring: z.object({
          onlyUncategorized: z.coerce.boolean().default(true),
          limit: z.coerce.number().int().min(1).max(1000).default(500),
        }),
        response: {
          200: z.array(
            z.object({
              transactionId: z.string(),
              description: z.string(),
              currentCategoryId: z.string().nullable(),
              newCategoryId: z.string().nullable(),
              ruleNames: z.array(z.string()),
            }),
          ),
        },
      },
    },
    (request) => previewApplyRules(request.query),
  );

  route.post(
    '/rules',
    {
      schema: {
        tags: ['regras'],
        summary: 'Cria uma regra',
        description:
          'Avaliadas por prioridade crescente. `stopOnMatch` (padrão) para na primeira que casar, o ' +
          'que torna o resultado previsível. A comparação de descrição ignora acento e caixa.',
        body: createRuleSchema,
        response: { 200: writeResponse(ruleDto), 400: errorResponseDto, 404: errorResponseDto },
      },
    },
    (request) => createRule(request.body, { requestId: request.id }),
  );

  route.post(
    '/rules/apply',
    {
      schema: {
        tags: ['regras'],
        summary: 'Aplica as regras, gravando',
        description: 'Reversível como qualquer outra operação, via `POST /change-sets/{id}/undo`.',
        body: z.object({
          onlyUncategorized: z.boolean().default(true),
          limit: z.number().int().min(1).max(1000).default(500),
        }),
        response: { 200: writeResponse(z.object({ updated: z.number().int() })) },
      },
    },
    (request) => applyRules({ ...request.body, requestId: request.id }),
  );

  route.patch(
    '/rules/:id',
    {
      schema: {
        tags: ['regras'],
        summary: 'Altera uma regra',
        params: idParamDto,
        body: createRuleSchema.partial(),
        response: { 200: writeResponse(ruleDto), 404: errorResponseDto },
      },
    },
    (request) => updateRule(request.params.id, request.body, { requestId: request.id }),
  );

  route.delete(
    '/rules/:id',
    {
      schema: {
        tags: ['regras'],
        summary: 'Exclui uma regra',
        params: idParamDto,
        response: { 200: writeResponse(z.object({ id: z.string() })), 404: errorResponseDto },
      },
    },
    (request) => deleteRule(request.params.id, { requestId: request.id }),
  );

  // ── Importação ────────────────────────────────────────────────────────────

  route.get(
    '/imports',
    {
      schema: {
        tags: ['importação'],
        summary: 'Lista os lotes de importação',
        querystring: z.object({ accountId: idSchema.optional() }),
        response: { 200: z.array(importBatchDto) },
      },
    },
    (request) => listImportBatches(request.query),
  );

  route.get(
    '/imports/:id/rows',
    {
      schema: {
        tags: ['importação'],
        summary: 'Linhas de um lote',
        params: idParamDto,
        response: { 200: z.array(importRowDto) },
      },
    },
    (request) => importBatchRows(request.params.id),
  );

  route.post(
    '/imports/parse',
    {
      schema: {
        tags: ['importação'],
        summary: 'Analisa um extrato sem gravar nada',
        description:
          'Etapa 1 de 2. Detecta o formato (CSV ou OFX), interpreta datas em `DD/MM/AAAA` ou ISO, ' +
          'aceita `;` ou `,` como separador, colunas de débito/crédito separadas, e marca duplicatas ' +
          'por hash de `(conta, data, valor, descrição)` mais o `FITID` do OFX.\n\n' +
          'Reimportar o mesmo arquivo é recusado — reverta o lote anterior primeiro.',
        body: parseImportSchema,
        response: { 200: writeResponse(z.any()), 400: errorResponseDto, 409: errorResponseDto },
      },
    },
    (request) => parseImport(request.body, { source: 'import', requestId: request.id }),
  );

  route.post(
    '/imports/:id/apply',
    {
      schema: {
        tags: ['importação'],
        summary: 'Grava as linhas novas do lote',
        description:
          'Etapa 2 de 2. Tudo num único change set, então reverter a importação inteira é uma chamada. ' +
          'As regras de auto-categorização são aplicadas no caminho.',
        params: idParamDto,
        body: z.object({
          lineNumbers: z.array(z.number().int()).optional().describe('Importa só estas linhas'),
          includeDuplicates: z.boolean().default(false),
        }),
        response: {
          200: writeResponse(
            z.object({
              batchId: z.string(),
              created: z.number().int(),
              skipped: z.number().int(),
            }),
          ),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) =>
      applyImport(request.params.id, { ...request.body, source: 'import', requestId: request.id }),
  );

  route.post(
    '/imports/:id/revert',
    {
      schema: {
        tags: ['importação'],
        summary: 'Reverte um lote aplicado',
        params: idParamDto,
        response: {
          200: writeResponse(z.object({ batchId: z.string(), reverted: z.number().int() })),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => revertImport(request.params.id, { requestId: request.id }),
  );
}
