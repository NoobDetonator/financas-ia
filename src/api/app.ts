/**
 * Montagem do servidor HTTP.
 *
 * A API é fina de propósito: cada rota valida a entrada, chama um serviço e
 * devolve o resultado. Nenhuma regra de negócio mora aqui — é o que garante que
 * a IA, que chama os mesmos serviços, se comporte exatamente como a interface.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import { env, isProduction } from '../config/env.js';
import { AppError, isAppError } from '../core/errors.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerCategoryRoutes } from './routes/categories.js';
import { registerTransactionRoutes } from './routes/transactions.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerCardRoutes } from './routes/cards.js';
import { registerRecurrenceRoutes } from './routes/recurrences.js';
import { registerPlanningRoutes } from './routes/planning.js';
import { registerDataRoutes } from './routes/data.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerInsightRoutes } from './routes/insights.js';
import { authPlugin } from './auth.js';
import { registerWeb, isWebPath } from './web.js';
import { registerChangeSetRoutes } from './routes/change-sets.js';
import { registerSystemRoutes } from './routes/system.js';

export type App = FastifyInstance;

export async function buildApp(): Promise<App> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(isProduction
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
    },
    // O corpo de uma importação de extrato pode ser grande.
    bodyLimit: 10 * 1024 * 1024,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ── Tratamento de erro ────────────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    // Erro de validação do zod: devolve o caminho do campo que falhou.
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: 'VALIDATION',
        message: 'Dados inválidos na requisição.',
        details: {
          issues: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
        },
      });
    }

    if (isAppError(error)) {
      // 4xx é erro de uso, não do servidor: não poluir o log com stack trace.
      if (error.status >= 500) request.log.error({ err: error }, 'Erro de domínio');
      else request.log.info({ code: error.code, message: error.message }, 'Requisição recusada');
      return reply.status(error.status).send(error.toJSON());
    }

    // Nem tudo que chega aqui é um `Error` — código de terceiros pode lançar
    // qualquer coisa, e ler `.message` de um throw de string quebraria o handler
    // que deveria estar tratando o erro.
    const message = error instanceof Error ? error.message : String(error);

    // Erros do próprio Fastify e de plugins já trazem o status correto — o
    // limitador de tentativas usa 429, por exemplo. Sem respeitar isso, um
    // bloqueio por excesso de tentativas apareceria como falha do servidor.
    const frameworkStatus = (error as { statusCode?: unknown }).statusCode;
    if (typeof frameworkStatus === 'number' && frameworkStatus >= 400 && frameworkStatus < 500) {
      request.log.info({ statusCode: frameworkStatus, message }, 'Requisição recusada pelo framework');
      return reply.status(frameworkStatus).send({
        error: frameworkStatus === 429 ? 'TOO_MANY_REQUESTS' : 'BAD_REQUEST',
        message,
      });
    }

    // Violação de constraint do SQLite que escapou da validação do serviço.
    if (message.includes('SQLITE_CONSTRAINT')) {
      request.log.warn({ err: error }, 'Constraint do banco violada');
      return reply.status(409).send({
        error: 'CONFLICT',
        message: 'A operação viola uma restrição do banco de dados.',
        details: { sqlite: message },
      });
    }

    request.log.error({ err: error }, 'Erro não tratado');
    return reply.status(500).send({
      error: 'INTERNAL',
      message: isProduction ? 'Erro interno.' : message,
    });
  });

  // O `notFoundHandler` fica no fim de `buildApp`: o Fastify aceita apenas um por
  // instância, e ele precisa conhecer o fallback da interface.

  // ── Documentação ──────────────────────────────────────────────────────────
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Finanças',
        version: '0.1.0',
        description:
          'API de controle de finanças pessoais. Valores monetários são **inteiros em centavos** ' +
          '(`4590` = R$ 45,90). Datas usam o formato `AAAA-MM-DD`. Toda rota de escrita devolve um ' +
          '`changeSetId` que pode ser revertido em `POST /change-sets/{id}/undo`.',
      },
      tags: [
        { name: 'contas', description: 'Contas, cartões e saldos' },
        { name: 'categorias', description: 'Categorias, favorecidos e tags' },
        { name: 'transações', description: 'Lançamentos, rateios e recategorização' },
        { name: 'transferências', description: 'Movimentação entre contas próprias' },
        { name: 'cartão', description: 'Faturas, ciclos, parcelamentos e pagamento' },
        { name: 'recorrências', description: 'Contas fixas, assinaturas e confirmação de ocorrências' },
        { name: 'projeção', description: 'Saldo futuro, comprometimento e evolução patrimonial' },
        { name: 'orçamentos', description: 'Limites por categoria, com rollover' },
        { name: 'metas', description: 'Objetivos de economia e reservas' },
        { name: 'dívidas', description: 'Financiamentos, amortização e simulações' },
        { name: 'investimentos', description: 'Carteira, aportes e rentabilidade' },
        { name: 'relatórios', description: 'Análises por categoria, período e favorecido' },
        { name: 'regras', description: 'Auto-categorização e aprendizado do histórico' },
        { name: 'importação', description: 'Extratos CSV e OFX' },
        { name: 'ia', description: 'Conversa, autonomia e histórico de ações da IA' },
        { name: 'insights', description: 'Achados automáticos e relatórios narrados' },
        { name: 'auditoria', description: 'Histórico de alterações e desfazer' },
        { name: 'sistema', description: 'Saúde, configuração e integridade' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  // @fastify/swagger v9 não publica a rota JSON por conta própria.
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: { url: '/openapi.json', title: 'Finanças — API' },
  });

  // Autenticação vem antes das rotas: o hook precisa estar registrado primeiro.
  await app.register(authPlugin);

  // ── Rotas ─────────────────────────────────────────────────────────────────
  await app.register(registerSystemRoutes);
  await app.register(registerAccountRoutes);
  await app.register(registerCategoryRoutes);
  await app.register(registerTransactionRoutes);
  await app.register(registerTransferRoutes);
  await app.register(registerCardRoutes);
  await app.register(registerRecurrenceRoutes);
  await app.register(registerPlanningRoutes);
  await app.register(registerDataRoutes);
  await app.register(registerAiRoutes);
  await app.register(registerInsightRoutes);
  await app.register(registerChangeSetRoutes);

  // Por último: o fallback da interface substitui o notFoundHandler, então precisa
  // vir depois de todas as rotas da API estarem registradas.
  const web = await registerWeb(app);
  if (web.reason) app.log.info(web.reason);

  // Um único notFoundHandler — o Fastify não aceita dois na mesma instância.
  // Com a interface compilada, caminho que não é da API devolve o index, para
  // recarregar o navegador em qualquer tela funcionar.
  app.setNotFoundHandler((request, reply) => {
    if (web.enabled && request.method === 'GET' && isWebPath(request.url)) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({
      error: 'NOT_FOUND',
      message: `Rota ${request.method} ${request.url} não existe.`,
    });
  });

  return app;
}

export { AppError };
