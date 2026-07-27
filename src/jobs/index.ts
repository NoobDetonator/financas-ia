/**
 * Tarefas periódicas.
 *
 * Rodam no mesmo processo do servidor. Para um app de um usuário, um worker
 * separado seria infraestrutura sem retorno: o trabalho aqui é medido em
 * milissegundos.
 *
 * Toda tarefa é **idempotente** — rodar duas vezes não causa efeito duplicado.
 * Isso importa porque elas rodam na partida (para cobrir o tempo em que a máquina
 * ficou desligada) e depois no horário agendado.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { materializeAll, promoteDueOccurrences } from '../services/recurrences.js';
import { refreshInvoiceStatuses } from '../services/cards.js';
import { checkIntegrity } from '../services/balances.js';

export interface JobResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Rotina diária.
 *
 * A ordem importa: primeiro promove o que venceu, depois materializa novas
 * ocorrências (para o horizonte andar junto com o tempo), depois reavalia as
 * faturas.
 */
export function runDailyJobs(logger?: FastifyBaseLogger): JobResult[] {
  const results: JobResult[] = [];

  const step = (name: string, fn: () => string): void => {
    try {
      results.push({ name, ok: true, detail: fn() });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail });
      logger?.error({ err: error, job: name }, 'Tarefa diária falhou');
    }
  };

  step('promover_ocorrencias', () => {
    const { data } = promoteDueOccurrences({ source: 'job', actor: 'system' });
    return `${data.cleared} efetivada(s), ${data.pending} aguardando confirmação`;
  });

  step('materializar_recorrencias', () => {
    const { data } = materializeAll({ source: 'job', actor: 'system' });
    return `${data.created} ocorrência(s) criada(s) de ${data.recurrences} recorrência(s)`;
  });

  step('atualizar_faturas', () => {
    const { data } = refreshInvoiceStatuses({ source: 'job', actor: 'system' });
    return `${data.changed} fatura(s) com status atualizado`;
  });

  step('verificar_integridade', () => {
    const issues = checkIntegrity();
    if (issues.length > 0) {
      // Não é fatal, mas precisa aparecer: indica escrita fora do `mutate()`.
      logger?.warn({ issues }, 'Verificação de integridade encontrou problemas');
      return `${issues.length} problema(s): ${issues.map((i) => i.check).join(', ')}`;
    }
    return 'nenhum problema';
  });

  return results;
}

let scheduled: ScheduledTask[] = [];

/**
 * Agenda as tarefas e roda a rotina uma vez agora.
 *
 * Rodar na partida cobre o caso normal de uso pessoal: o PC fica desligado à
 * noite, então um agendamento para 03:00 nunca dispararia.
 */
export function startScheduler(logger: FastifyBaseLogger): void {
  const summary = runDailyJobs(logger);
  for (const result of summary) {
    logger.info(`[partida] ${result.name}: ${result.detail}`);
  }

  // 03:10 todos os dias, no fuso da aplicação.
  scheduled.push(
    cron.schedule(
      '10 3 * * *',
      () => {
        logger.info('Executando rotina diária.');
        for (const result of runDailyJobs(logger)) {
          logger.info(`[diária] ${result.name}: ${result.detail}`);
        }
      },
      { timezone: env.TZ },
    ),
  );

  logger.info('Tarefas periódicas agendadas (diária às 03:10).');
}

export function stopScheduler(): void {
  for (const task of scheduled) task.stop();
  scheduled = [];
}
