import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  createCategorySchema,
  updateCategorySchema,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategory,
  listCategories,
  categoryTree,
  countCategoryUsage,
  recategorize,
} from '../../services/categories.js';
import {
  createPayee,
  createPayeeSchema,
  createTag,
  createTagSchema,
  deletePayee,
  deleteTag,
  getPayee,
  listPayees,
  listTags,
  updatePayee,
} from '../../services/payees.js';
import { categoryKindSchema, idSchema } from '../../services/schemas.js';
import {
  categoryDto,
  categoryTreeDto,
  errorResponseDto,
  idParamDto,
  payeeDto,
  tagDto,
  writeResponse,
} from '../dto.js';

export async function registerCategoryRoutes(app: FastifyInstance): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  const listQuery = z.object({
    kind: categoryKindSchema.optional(),
    includeArchived: z.coerce.boolean().default(false),
  });

  route.get(
    '/categories',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Lista as categorias (plano)',
        querystring: listQuery,
        response: { 200: z.array(categoryDto) },
      },
    },
    (request) => listCategories(request.query),
  );

  route.get(
    '/categories/tree',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Lista as categorias em árvore de dois níveis',
        querystring: listQuery,
        response: { 200: z.array(categoryTreeDto) },
      },
    },
    (request) => categoryTree(request.query),
  );

  route.get(
    '/categories/:id',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Detalha uma categoria',
        params: idParamDto,
        response: {
          200: categoryDto.extend({ usageCount: z.number().int() }),
          404: errorResponseDto,
        },
      },
    },
    (request) => ({
      ...getCategory(request.params.id),
      usageCount: countCategoryUsage(request.params.id),
    }),
  );

  route.post(
    '/categories',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Cria uma categoria',
        description: 'A hierarquia tem no máximo dois níveis. Informe `parentId` para criar uma subcategoria.',
        body: createCategorySchema,
        response: { 200: writeResponse(categoryDto), 409: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => createCategory(request.body, { requestId: request.id }),
  );

  route.patch(
    '/categories/:id',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Altera uma categoria',
        params: idParamDto,
        body: updateCategorySchema,
        response: { 200: writeResponse(categoryDto), 404: errorResponseDto, 422: errorResponseDto },
      },
    },
    (request) => updateCategory(request.params.id, request.body, { requestId: request.id }),
  );

  route.delete(
    '/categories/:id',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Exclui uma categoria não utilizada',
        description:
          'Recusa se a categoria for do sistema, tiver subcategorias ou estiver em uso. ' +
          'Use `/categories/{id}/recategorize` para liberar os lançamentos antes.',
        params: idParamDto,
        response: {
          200: writeResponse(z.object({ id: z.string() })),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => deleteCategory(request.params.id, { requestId: request.id }),
  );

  route.post(
    '/categories/:id/recategorize',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Move todos os lançamentos para outra categoria',
        params: idParamDto,
        body: z.object({ toCategoryId: idSchema }),
        response: {
          200: writeResponse(z.object({ moved: z.number().int() })),
          404: errorResponseDto,
          422: errorResponseDto,
        },
      },
    },
    (request) => recategorize(request.params.id, request.body.toCategoryId, { requestId: request.id }),
  );

  // ── Favorecidos ───────────────────────────────────────────────────────────

  route.get(
    '/payees',
    {
      schema: { tags: ['categorias'], summary: 'Lista os favorecidos', response: { 200: z.array(payeeDto) } },
    },
    () => listPayees(),
  );

  route.get(
    '/payees/:id',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Detalha um favorecido',
        params: idParamDto,
        response: { 200: payeeDto, 404: errorResponseDto },
      },
    },
    (request) => getPayee(request.params.id),
  );

  route.post(
    '/payees',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Cria um favorecido',
        body: createPayeeSchema,
        response: { 200: writeResponse(payeeDto), 409: errorResponseDto },
      },
    },
    (request) => createPayee(request.body, { requestId: request.id }),
  );

  route.patch(
    '/payees/:id',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Altera um favorecido',
        params: idParamDto,
        body: createPayeeSchema.partial(),
        response: { 200: writeResponse(payeeDto), 404: errorResponseDto, 409: errorResponseDto },
      },
    },
    (request) => updatePayee(request.params.id, request.body, { requestId: request.id }),
  );

  route.delete(
    '/payees/:id',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Exclui um favorecido',
        description: 'As transações são preservadas, apenas perdem o vínculo.',
        params: idParamDto,
        response: { 200: writeResponse(z.object({ id: z.string() })), 404: errorResponseDto },
      },
    },
    (request) => deletePayee(request.params.id, { requestId: request.id }),
  );

  // ── Tags ──────────────────────────────────────────────────────────────────

  route.get(
    '/tags',
    { schema: { tags: ['categorias'], summary: 'Lista as tags', response: { 200: z.array(tagDto) } } },
    () => listTags(),
  );

  route.post(
    '/tags',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Cria uma tag',
        body: createTagSchema,
        response: { 200: writeResponse(tagDto), 409: errorResponseDto },
      },
    },
    (request) => createTag(request.body, { requestId: request.id }),
  );

  route.delete(
    '/tags/:id',
    {
      schema: {
        tags: ['categorias'],
        summary: 'Exclui uma tag e seus vínculos',
        params: idParamDto,
        response: { 200: writeResponse(z.object({ id: z.string() })), 404: errorResponseDto },
      },
    },
    (request) => deleteTag(request.params.id, { requestId: request.id }),
  );
}
