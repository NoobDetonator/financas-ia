/**
 * Erros de domínio.
 *
 * Serviços lançam `AppError` com um código semântico; a camada HTTP traduz o
 * código em status, e a camada de IA transforma a mensagem em algo que o modelo
 * consegue explicar para você. Assim a regra de negócio não conhece HTTP.
 */

export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'RULE_VIOLATION',
  'CONFIRMATION_REQUIRED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  /** Requisição bem formada, mas viola uma regra do domínio. */
  RULE_VIOLATION: 422,
  CONFIRMATION_REQUIRED: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

// ── Atalhos ─────────────────────────────────────────────────────────────────

export function notFound(entity: string, id?: string): AppError {
  return new AppError('NOT_FOUND', id ? `${entity} "${id}" não encontrado.` : `${entity} não encontrado.`, {
    entity,
    ...(id ? { id } : {}),
  });
}

export function validation(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION', message, details);
}

export function conflict(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('CONFLICT', message, details);
}

/** A operação é possível, mas quebraria uma invariante contábil ou de negócio. */
export function ruleViolation(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('RULE_VIOLATION', message, details);
}

/** Já existe algo com este nome — usado onde a unicidade é validada no serviço. */
export function duplicateName(entity: string, name: string): AppError {
  return new AppError('CONFLICT', `Já existe ${entity} com o nome "${name}".`, { entity, name });
}
