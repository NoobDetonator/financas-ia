/**
 * Provedor de modelo.
 *
 * Isolado num módulo próprio para que trocar de provedor seja mudar uma variável
 * de ambiente, não caçar chamadas espalhadas pelo código. O DeepSeek é o padrão
 * por custo e por ser competente em tool calling; a mesma interface serve
 * Anthropic e OpenAI.
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
  return { provider: env.AI_PROVIDER, model: env.AI_MODEL, configured: hasAiKey() };
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
      `Nenhuma chave de API configurada para o provedor "${env.AI_PROVIDER}". ` +
        `Preencha ${keyVariableName()} no arquivo .env.`,
      { provider: env.AI_PROVIDER, variable: keyVariableName() },
    );
  }

  const model = overrideModel ?? env.AI_MODEL;

  switch (env.AI_PROVIDER) {
    case 'deepseek': {
      const deepseek = createDeepSeek({ apiKey: aiApiKey() });
      return deepseek(model);
    }
    // Anthropic e OpenAI usam a mesma interface do AI SDK; o pacote do provedor
    // é carregado sob demanda para não obrigar a instalar o que não se usa.
    case 'anthropic':
    case 'openai':
      throw new AppError(
        'VALIDATION',
        `O provedor "${env.AI_PROVIDER}" está previsto mas o pacote correspondente não está instalado. ` +
          `Rode: npm install @ai-sdk/${env.AI_PROVIDER}`,
        { provider: env.AI_PROVIDER },
      );
  }
}

function keyVariableName(): string {
  return {
    deepseek: 'DEEPSEEK_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
  }[env.AI_PROVIDER];
}

/** Modelos conhecidos do DeepSeek, para referência na configuração. */
export const DEEPSEEK_MODELS = {
  /** Rápido e barato. Padrão para chat e lançamentos. */
  chat: 'deepseek-chat',
  /** Raciocínio mais longo. Útil para análise de insights. */
  reasoner: 'deepseek-reasoner',
} as const;
