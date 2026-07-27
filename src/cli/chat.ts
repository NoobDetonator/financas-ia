/**
 * REPL de conversa no terminal.
 *
 * É a forma de usar a IA antes de existir interface gráfica — e continua sendo a
 * mais rápida para lançar um gasto depois que ela existir.
 *
 * Quando uma operação precisa de confirmação, o REPL mostra o resumo e espera um
 * "sim". A confirmação é reenviada como token, não como nova instrução em texto,
 * para não haver ambiguidade sobre o que está sendo aprovado.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chatStream, createConversation, aiStatus } from '../ai/agent.js';
import { getDb, closeDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { bootstrap } from '../db/bootstrap.js';
import { materializeAll, promoteDueOccurrences } from '../services/recurrences.js';
import { hasAiKey } from '../config/env.js';
import { isAppError } from '../core/errors.js';

const RESET = '[0m';
const DIM = '[2m';
const BOLD = '[1m';
const CYAN = '[36m';
const YELLOW = '[33m';
const GREEN = '[32m';
const RED = '[31m';

const AFFIRMATIVE = new Set(['s', 'sim', 'y', 'yes', 'ok', 'confirma', 'confirmar', 'pode', 'isso']);

async function main(): Promise<void> {
  // Garante saída UTF-8: o console do Windows pode estar em outra página de código
  // e os acentos sairiam quebrados.
  if (stdout.isTTY) stdout.write('[?25h');

  const db = getDb();
  runMigrations(db);
  bootstrap(db);

  const status = aiStatus(db);

  console.log(`${BOLD}Finanças — conversa${RESET}`);
  console.log(`${DIM}Modelo: ${status.provider}/${status.model} · ${status.toolCount} ferramentas${RESET}`);

  if (!hasAiKey()) {
    console.log(`\n${RED}Nenhuma chave de API configurada.${RESET}`);
    console.log(`Preencha ${BOLD}DEEPSEEK_API_KEY${RESET} no arquivo .env e rode de novo.`);
    closeDb();
    process.exit(1);
  }

  // Mantém as previsões em dia antes de conversar, para o retrato estar correto.
  promoteDueOccurrences({ source: 'cli', actor: 'system' });
  materializeAll({ source: 'cli', actor: 'system' });

  console.log(`${DIM}Comandos: /sair, /nova, /status. Enter em branco sai.${RESET}\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  let conversationId = createConversation({ title: 'Conversa no terminal' }).id;
  let pendingTokens: string[] = [];

  try {
    for (;;) {
      const prompt = pendingTokens.length > 0 ? `${YELLOW}confirmar? ${RESET}` : `${CYAN}você ${RESET}`;
      const input = (await rl.question(prompt)).trim();

      if (input === '' || input === '/sair' || input === '/exit') break;

      if (input === '/nova') {
        conversationId = createConversation({ title: 'Conversa no terminal' }).id;
        pendingTokens = [];
        console.log(`${DIM}Nova conversa iniciada.${RESET}\n`);
        continue;
      }

      if (input === '/status') {
        const current = aiStatus(db);
        console.log(
          `${DIM}${current.conversationCount} conversa(s), ${current.actionCount} ação(ões) registrada(s).${RESET}\n`,
        );
        continue;
      }

      // Resposta a uma confirmação pendente.
      let approvedTokens: string[] = [];
      let message = input;

      if (pendingTokens.length > 0) {
        if (AFFIRMATIVE.has(input.toLowerCase())) {
          approvedTokens = pendingTokens;
          message = 'Confirmado, pode executar.';
        } else {
          console.log(`${DIM}Operação descartada.${RESET}`);
        }
        pendingTokens = [];
      }

      try {
        const { stream, collected } = await chatStream(message, {
          conversationId,
          approvedTokens,
        });

        stdout.write(`${GREEN}ia   ${RESET}`);
        for await (const chunk of stream.textStream) {
          stdout.write(chunk);
        }
        stdout.write('\n');

        // Espera o fim do stream para as ferramentas terem terminado.
        await stream.finishReason;

        if (collected.pending.length > 0) {
          console.log('');
          for (const pending of collected.pending) {
            console.log(`${YELLOW}⚠ Precisa da sua confirmação:${RESET} ${pending.summary}`);
            console.log(`${DIM}  ${pending.reason}${RESET}`);
          }
          pendingTokens = collected.pending.map((p) => p.token);
        }

        if (collected.changeSetIds.length > 0) {
          console.log(
            `${DIM}  ${collected.changeSetIds.length} alteração(ões) registrada(s). Para desfazer: ` +
              `POST /change-sets/${collected.changeSetIds[0]}/undo${RESET}`,
          );
        }

        console.log('');
      } catch (error) {
        const message = isAppError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
        console.log(`${RED}erro:${RESET} ${message}\n`);
      }
    }
  } finally {
    rl.close();
    closeDb();
  }

  console.log(`${DIM}Até logo.${RESET}`);
}

main().catch((error: unknown) => {
  console.error('Falha no REPL:', error);
  closeDb();
  process.exit(1);
});
