/**
 * Serve a interface compilada.
 *
 * Em produção o Fastify entrega os arquivos de `web/dist`, então tudo roda em um
 * processo e uma porta só: `npm start` sobe a API e a interface juntas, e o
 * acesso pelo celular é um endereço único.
 *
 * Em desenvolvimento isto fica **desligado** — o Vite serve a interface na 3000
 * com recarga automática e faz proxy de `/api` para cá.
 *
 * Usa `@fastify/static` na versão 10, que corrigiu a falha de path traversal das
 * versões 9.x. Servir arquivo à mão seria uma dependência a menos, mas normalizar
 * caminho corretamente é exatamente o tipo de código que erra em silêncio — e aqui
 * o erro exporia o arquivo do banco.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { isProduction } from '../config/env.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const webDist = resolve(projectRoot, 'web', 'dist');

/** Rotas que pertencem à API e nunca devem cair no fallback da interface. */
const API_PREFIXES = [
  '/accounts', '/balances', '/net-worth', '/categories', '/payees', '/tags',
  '/transactions', '/transfers', '/invoices', '/cards', '/installment-plans',
  '/recurrences', '/occurrences', '/bills', '/projection', '/commitments',
  '/budgets', '/goals', '/debts', '/holdings', '/portfolio', '/reports',
  '/rules', '/imports', '/insights', '/change-sets', '/ai', '/auth',
  '/health', '/settings', '/integrity', '/system', '/cash-flow',
  '/openapi.json', '/docs',
  // O prefixo `/api` só existe no proxy do Vite, em desenvolvimento. Listá-lo aqui
  // faz uma chamada equivocada a `/api/...` em produção devolver 404 em JSON, em
  // vez do HTML da página única — que produziria o erro confuso "resposta não é
  // JSON" em quem chamou.
  '/api',
];

/**
 * O caminho pertence à API?
 *
 * Usado por dois lugares: o `notFoundHandler` (para decidir entre index e 404) e o
 * hook de autenticação (para saber o que proteger).
 */
export function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface WebSetupResult {
  enabled: boolean;
  reason?: string;
}

/**
 * Registra o serviço da interface, se houver build.
 *
 * Sem `web/dist`, apenas avisa e segue: a API continua funcionando, e a mensagem
 * diz o que fazer — melhor que falhar a partida por causa do frontend.
 */
export async function registerWeb(app: FastifyInstance): Promise<WebSetupResult> {
  if (!isProduction) {
    return {
      enabled: false,
      reason: 'Em desenvolvimento a interface é servida pelo Vite (npm run dev na pasta web).',
    };
  }

  if (!existsSync(resolve(webDist, 'index.html'))) {
    return {
      enabled: false,
      reason: `Interface não compilada. Rode: cd web && npm run build`,
    };
  }

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    index: ['index.html'],
    // Os assets do Vite têm hash no nome, então podem ser cacheados agressivamente.
    // O index.html não: é ele que aponta para os hashes novos.
    setHeaders: (reply, path) => {
      if (path.endsWith('index.html')) {
        reply.header('Cache-Control', 'no-cache');
      } else if (path.includes('assets')) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  return { enabled: true };
}

/**
 * O caminho pertence à interface (e não à API)?
 *
 * Usado pelo `notFoundHandler` único do app: a interface é uma página só, então
 * qualquer rota que não seja da API precisa devolver o index — sem isso, apertar
 * F5 em qualquer tela daria 404.
 *
 * O Fastify aceita **um** `setNotFoundHandler` por instância, então a decisão fica
 * aqui e o handler mora em `app.ts`.
 */
export function isWebPath(url: string): boolean {
  if (isApiPath(url)) return false;

  // Caminho com extensão de arquivo que não existe deve dar 404, não o index.
  // Devolver HTML no lugar de um `.js` faz o navegador tentar interpretar a página
  // como script — o erro que aparece é "Unexpected token '<'", que não diz nada
  // sobre a causa real (o arquivo não existe).
  const path = url.split('?')[0] ?? url;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  const looksLikeFile = /\.[a-z0-9]{2,6}$/i.test(lastSegment);

  return !looksLikeFile;
}
