/**
 * Provedor de modelo (DeepSeek).
 *
 * Isolado num módulo próprio. Outros provedores saem do escopo até haver
 * pacote instalado e uso real — YAGNI.
 */

import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import { aiApiKey, env, hasAiKey } from '../config/env.js';
import { AppError } from '../core/errors.js';

export interface ModelInfo {
  provider: string;
  model: string;
  configured: boolean;
}

export function modelInfo(): ModelInfo {
  return { provider: 'deepseek', model: env.AI_MODEL, configured: hasAiKey() };
}

/**
 * Devolve o modelo configurado.
 *
 * Falha com mensagem clara quando não há chave — o erro genérico do SDK
 * (`401 Unauthorized`) não diz o que fazer a respeito.
 */
export function getModel(overrideModel?: string): LanguageModel {
  if (!hasAiKey()) {
    throw new AppError(
      'VALIDATION',
      'Nenhuma chave de API configurada para o DeepSeek. Preencha DEEPSEEK_API_KEY no arquivo .env.',
      { provider: 'deepseek', variable: 'DEEPSEEK_API_KEY' },
    );
  }

  const deepseek = createDeepSeek({ apiKey: aiApiKey() });
  return deepseek(overrideModel ?? env.AI_MODEL);
}
