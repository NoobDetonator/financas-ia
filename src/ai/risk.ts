/**
 * Classificação de risco das escritas da IA.
 *
 * Implementa a autonomia escolhida para o projeto: **automático para o leve,
 * confirmação para o pesado**. É o que torna razoável dar poder de escrita ao
 * modelo — ele resolve o dia a dia sozinho, e o que doeria errar passa por você.
 *
 * Os limites vêm de `settings`, então são ajustáveis sem mexer no código.
 *
 * Princípio de projeto: a classificação é **explícita por ferramenta**, nunca
 * inferida. Uma ferramenta nova sem classificação cai no padrão mais seguro
 * (`confirm`) — errar para o lado cauteloso é a única direção aceitável aqui.
 */

import { eq } from 'drizzle-orm';
import { getDb, type Db } from '../db/client.js';
import { settings, type RiskLevel } from '../db/schema.js';
import { formatMoney } from '../core/money.js';

/** Comportamento de risco de cada ferramenta de escrita. */
export type ToolRiskPolicy =
  /** Sempre automático: efeito pequeno e trivialmente reversível. */
  | { kind: 'always_auto' }
  /** Sempre exige confirmação, independentemente do valor. */
  | { kind: 'always_confirm'; reason: string }
  /** Automático abaixo do limite de valor; confirma acima. */
  | { kind: 'amount_threshold'; amountField: string }
  /** Automático abaixo do limite de linhas afetadas; confirma acima. */
  | { kind: 'row_threshold'; countField: string };

/**
 * Política por ferramenta.
 *
 * A leitura desta tabela é a resposta para "o que a IA pode fazer sem me pedir".
 */
/**
 * Só ferramentas de escrita reais de `buildTools`. Nomes fantasmas aqui
 * vazavam em `/ai/status` como se a IA pudesse fazê-los.
 */
export const TOOL_RISK: Record<string, ToolRiskPolicy> = {
  // ── Sempre automático ────────────────────────────────────────────────────
  categorize_transaction: { kind: 'always_auto' },
  confirm_occurrence: { kind: 'always_auto' },
  // Criar meta não movimenta dinheiro — é só um alvo, e apagar não afeta saldo.
  create_goal: { kind: 'always_auto' },

  // ── Depende do valor ─────────────────────────────────────────────────────
  create_transaction: { kind: 'amount_threshold', amountField: 'amountCents' },
  update_transaction: { kind: 'amount_threshold', amountField: 'amountCents' },
  create_transfer: { kind: 'amount_threshold', amountField: 'amountCents' },
  create_installment_plan: { kind: 'amount_threshold', amountField: 'totalCents' },
  contribute_to_goal: { kind: 'amount_threshold', amountField: 'amountCents' },
  pay_card_invoice: { kind: 'amount_threshold', amountField: 'amountCents' },

  // ── Depende da quantidade de linhas ──────────────────────────────────────
  bulk_categorize: { kind: 'row_threshold', countField: 'transactionIds' },
  apply_rules: { kind: 'row_threshold', countField: 'affectedCount' },

  // ── Sempre confirma ──────────────────────────────────────────────────────
  delete_transaction: {
    kind: 'always_confirm',
    reason: 'Exclusão de lançamento é sempre confirmada.',
  },
  set_budget: {
    kind: 'always_confirm',
    reason: 'Definir orçamento muda como o mês inteiro é avaliado.',
  },
};

export interface RiskThresholds {
  /** Acima deste valor, pede confirmação. */
  amountCents: number;
  /** Acima deste número de linhas, pede confirmação. */
  bulkRows: number;
}

export function loadThresholds(db: Db = getDb()): RiskThresholds {
  const row = db.select().from(settings).where(eq(settings.id, 'singleton')).all()[0];
  return {
    amountCents: row?.aiConfirmAmountCents ?? 50_000,
    bulkRows: row?.aiConfirmBulkRows ?? 5,
  };
}

export interface RiskAssessment {
  level: RiskLevel;
  /** Explicação em português, exibida quando a confirmação é necessária. */
  reason: string | null;
  /** Ferramenta sem política declarada — tratada como `confirm` por precaução. */
  unknownTool: boolean;
}

/**
 * Classifica uma chamada de ferramenta.
 *
 * Ferramentas de leitura não passam por aqui: elas não mudam nada e nunca
 * precisam de confirmação.
 */
export function assessRisk(
  tool: string,
  args: Record<string, unknown>,
  thresholds: RiskThresholds,
): RiskAssessment {
  const policy = TOOL_RISK[tool];

  if (!policy) {
    // Ferramenta desconhecida é sempre confirmada. Uma ferramenta nova que
    // esqueceram de classificar não pode ganhar autonomia por omissão.
    return {
      level: 'confirm',
      reason: `A ferramenta "${tool}" não tem política de risco declarada, então exige confirmação.`,
      unknownTool: true,
    };
  }

  switch (policy.kind) {
    case 'always_auto':
      return { level: 'auto', reason: null, unknownTool: false };

    case 'always_confirm':
      return { level: 'confirm', reason: policy.reason, unknownTool: false };

    case 'amount_threshold': {
      const raw = args[policy.amountField];
      const amount = typeof raw === 'number' ? Math.abs(raw) : null;

      // Valor ausente ou não numérico: confirma, porque não há como avaliar.
      if (amount === null) {
        return {
          level: 'confirm',
          reason: `Não consegui identificar o valor da operação (campo "${policy.amountField}"), então prefiro confirmar.`,
          unknownTool: false,
        };
      }
      if (amount > thresholds.amountCents) {
        return {
          level: 'confirm',
          reason: `O valor ${formatMoney(amount)} passa do limite de ${formatMoney(thresholds.amountCents)} definido para operações automáticas.`,
          unknownTool: false,
        };
      }
      return { level: 'auto', reason: null, unknownTool: false };
    }

    case 'row_threshold': {
      const raw = args[policy.countField];
      const count = Array.isArray(raw) ? raw.length : typeof raw === 'number' ? raw : null;

      if (count === null) {
        return {
          level: 'confirm',
          reason: 'Não consegui identificar quantas linhas seriam afetadas, então prefiro confirmar.',
          unknownTool: false,
        };
      }
      if (count > thresholds.bulkRows) {
        return {
          level: 'confirm',
          reason: `A operação afeta ${count} lançamentos, acima do limite de ${thresholds.bulkRows} para alterações automáticas.`,
          unknownTool: false,
        };
      }
      return { level: 'auto', reason: null, unknownTool: false };
    }
  }
}

/** Lista das ferramentas por nível, para exibir na configuração. */
export function riskOverview(): { alwaysAuto: string[]; conditional: string[]; alwaysConfirm: string[] } {
  const alwaysAuto: string[] = [];
  const conditional: string[] = [];
  const alwaysConfirm: string[] = [];

  for (const [tool, policy] of Object.entries(TOOL_RISK)) {
    if (policy.kind === 'always_auto') alwaysAuto.push(tool);
    else if (policy.kind === 'always_confirm') alwaysConfirm.push(tool);
    else conditional.push(tool);
  }

  return { alwaysAuto: alwaysAuto.sort(), conditional: conditional.sort(), alwaysConfirm: alwaysConfirm.sort() };
}
