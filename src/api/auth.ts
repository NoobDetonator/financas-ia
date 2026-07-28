/**
 * Autenticação de usuário único.
 *
 * O modelo de uso previsto inclui lançar gastos pelo celular no Wi-Fi de casa —
 * então o servidor fica exposto na rede local, e senha não é opcional.
 *
 * A senha é verificada contra o hash derivado por `scrypt` (`node:crypto`), sem
 * dependência nativa: esta máquina não compila addons, e um pacote como `argon2`
 * quebraria o `npm install`. `scrypt` com os parâmetros usados aqui é adequado —
 * é o que o próprio Node recomenda para derivação de senha.
 *
 * A sessão é um cookie assinado com HMAC. Sem servidor de sessão, sem JWT: para um
 * usuário, um cookie assinado com expiração resolve e não tem o que dar errado.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authConfig, env, isProduction } from '../config/env.js';
import { isApiPath } from './web.js';
import { AppError } from '../core/errors.js';

const SESSION_COOKIE = 'financas_session';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

/** Rotas de API acessíveis sem sessão. */
const PUBLIC_ROUTES = new Set(['/health', '/auth/login', '/auth/status', '/openapi.json']);

/**
 * A requisição dispensa sessão?
 *
 * **O que é protegido são os dados, não a casca.** A interface compilada
 * (`index.html`, JS, CSS) é servida sem sessão porque ela é um shell vazio: todo
 * dado financeiro vem depois, por chamadas de API que exigem autenticação.
 *
 * Sem isso, a tela de **login** — que é o próprio `index.html` — voltava 401, e
 * não havia como entrar no sistema. Foi exatamente o que aconteceu ao subir em
 * produção pela primeira vez.
 */
function isPublic(url: string): boolean {
  const path = url.split('?')[0] ?? url;

  if (PUBLIC_ROUTES.has(path)) return true;
  // A documentação fica aberta: ela não expõe dado nenhum, só o formato da API.
  if (path.startsWith('/docs')) return true;

  // Qualquer caminho que não seja de API é a interface: shell e assets estáticos.
  return !isApiPath(path);
}

/** Deriva o hash da senha configurada. */
function hashPassword(password: string, salt: string): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN);
}

/**
 * Compara a senha em tempo constante.
 *
 * `timingSafeEqual` evita que o tempo de resposta revele quantos caracteres
 * estavam certos.
 */
function passwordMatches(candidate: string): boolean {
  const expected = env.APP_PASSWORD;
  if (expected === '') return false;

  // Salt fixo derivado do segredo de sessão: não há banco de usuários, e o que
  // importa aqui é o custo computacional do scrypt, não o salt por usuário.
  const salt = env.SESSION_SECRET || 'financas-salt-padrao';
  const a = hashPassword(candidate, salt);
  const b = hashPassword(expected, salt);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionSecret(): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  // Sem segredo configurado, gera um por execução: as sessões caem a cada
  // reinício, o que é inconveniente mas seguro. Melhor que um segredo fixo
  // previsível no código.
  return fallbackSecret;
}

const fallbackSecret = randomBytes(32).toString('hex');

/** Cria um token de sessão assinado: `expiraEm.assinatura`. */
function issueToken(): string {
  const expiresAt = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = String(expiresAt);
  const signature = createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expected = createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/**
 * Plugin de autenticação.
 *
 * Registra o hook de verificação, as rotas de login/logout e o limitador de
 * tentativas — sem o limitador, uma senha curta cairia por força bruta na rede
 * local em minutos.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  const config = authConfig();

  await app.register(cookie, { secret: sessionSecret() });

  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: '1 minute',
  });

  const route = app.withTypeProvider<ZodTypeProvider>();

  route.get(
    '/auth/status',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Situação da autenticação',
        response: {
          200: z.object({
            authEnabled: z.boolean(),
            authenticated: z.boolean(),
            passwordConfigured: z.boolean(),
            warning: z.string().optional(),
          }),
        },
      },
    },
    (request) => ({
      authEnabled: config.enabled,
      authenticated: !config.enabled || verifyToken(request.cookies[SESSION_COOKIE]),
      passwordConfigured: env.APP_PASSWORD !== '' && env.APP_PASSWORD !== 'troque-esta-senha',
      ...(config.reason ? { warning: config.reason } : {}),
    }),
  );

  route.post(
    '/auth/login',
    {
      config: {
        // Cinco tentativas por minuto: suficiente para erro de digitação,
        // inviável para força bruta.
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['sistema'],
        summary: 'Entra com a senha',
        body: z.object({ password: z.string().min(1).max(200) }),
        response: {
          200: z.object({ ok: z.literal(true), expiresInDays: z.number().int() }),
          401: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply): Promise<void> => {
      if (!passwordMatches(request.body.password)) {
        // Log sem a senha, obviamente — e sem revelar se a senha existe.
        request.log.warn({ ip: request.ip }, 'Tentativa de login recusada');
        await reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Senha incorreta.' });
        return;
      }

      reply.setCookie(SESSION_COOKIE, issueToken(), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_DAYS * 86_400,
        // `secure` só com HTTPS; na rede local o acesso é por http.
        secure: isProduction && env.HOST !== '0.0.0.0',
      });

      await reply.send({ ok: true as const, expiresInDays: SESSION_DAYS });
    },
  );

  route.post(
    '/auth/logout',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Encerra a sessão',
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (_request, reply): Promise<void> => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      await reply.send({ ok: true as const });
    },
  );

  if (!config.enabled) {
    app.log.warn(
      'Autenticação desligada. O servidor só deve estar acessível em 127.0.0.1 nesta configuração.',
    );
    return;
  }

  if (env.APP_PASSWORD === '' || env.APP_PASSWORD === 'troque-esta-senha') {
    throw new AppError(
      'VALIDATION',
      'APP_PASSWORD não foi definida (ou continua com o valor de exemplo). ' +
        'Defina uma senha no .env antes de subir o servidor com autenticação ativa.',
    );
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    if (isPublic(request.url)) return;
    if (verifyToken(request.cookies[SESSION_COOKIE])) return;

    return reply.status(401).send({
      error: 'UNAUTHORIZED',
      message: 'Sessão ausente ou expirada. Faça login em POST /auth/login.',
    });
  });
});

export { SESSION_COOKIE };
