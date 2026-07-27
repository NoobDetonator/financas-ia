/**
 * Ponto de entrada da interface.
 *
 * Ordem obrigatória: autenticar → carregar dados → construir a aplicação.
 *
 * O `KakeiboApp` copia arrays em inicializadores de campo, então precisa ser
 * construído **depois** de `loadAll()`. Instanciar antes deixaria a tela vazia
 * sem erro visível, que é o pior tipo de bug de boot.
 */

import { auth, onAuthChange, ApiError } from './api/client';
import { loadAll } from './scripts/data';
import { KakeiboApp } from './scripts/app';

const BOOT_EL = 'boot-screen';
const LOGIN_EL = 'login-screen';

let app: KakeiboApp | null = null;

function show(id: string): void {
  document.getElementById(id)?.classList.remove('hidden');
}

function hide(id: string): void {
  document.getElementById(id)?.classList.add('hidden');
}

function setBootStatus(text: string, isError = false): void {
  const el = document.getElementById('boot-status');
  if (!el) return;
  el.textContent = text;
  el.className = isError ? 'boot-status txt-pink' : 'boot-status txt-cyan';
}

function setLoginError(text: string): void {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('hidden', text === '');
}

/** Sequência de boot em estilo POST de máquina antiga, mas com passos reais. */
async function boot(): Promise<void> {
  show(BOOT_EL);
  setBootStatus('VERIFICANDO SESSÃO...');

  let status;
  try {
    status = await withRetry(() => auth.status(), 5, 400);
  } catch (error) {
    setBootStatus(
      error instanceof ApiError && error.code === 'NETWORK'
        ? 'SERVIDOR NÃO RESPONDE — inicie o backend com `npm run dev` (ou `npm start` após o build)'
        : `FALHA: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
    return;
  }

  if (status.authEnabled && !status.authenticated) {
    hide(BOOT_EL);
    show(LOGIN_EL);
    document.getElementById('login-password')?.focus();
    return;
  }

  await loadAndStart();
}

/** Retenta falhas transitórias (API ainda subindo / 5xx momentâneo). */
async function withRetry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof ApiError &&
        (error.code === 'NETWORK' || error.code === 'INTERNAL' || error.message.includes('500'));
      if (!retryable || i === attempts - 1) throw error;
      setBootStatus(`AGUARDANDO SERVIDOR (${i + 1}/${attempts})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastError;
}

async function loadAndStart(): Promise<void> {
  hide(LOGIN_EL);
  show(BOOT_EL);
  setBootStatus('CARREGANDO DADOS FINANCEIROS...');

  let report;
  try {
    report = await loadAll();
  } catch (error) {
    setBootStatus(`FALHA AO CARREGAR: ${error instanceof Error ? error.message : String(error)}`, true);
    return;
  }

  setBootStatus(`DADOS CARREGADOS EM ${report.elapsedMs}ms — INICIANDO INTERFACE...`);

  // Uma falha parcial não impede o uso: avisa e segue.
  if (!report.ok) {
    console.warn('[boot] blocos que falharam:', report.failed);
  }

  // Deixa o navegador pintar a mensagem antes do trabalho síncrono de render.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    app = new KakeiboApp();
  } catch (error) {
    setBootStatus(`FALHA NA INTERFACE: ${error instanceof Error ? error.message : String(error)}`, true);
    console.error(error);
    return;
  }

  hide(BOOT_EL);
  document.getElementById('app-viewport')?.classList.remove('hidden');

  if (!report.ok) {
    app.notify(
      `Alguns dados não carregaram: ${report.failed.join(', ')}. O resto está utilizável.`,
      'warn',
    );
  }
}

function initLoginForm(): void {
  const form = document.getElementById('login-form') as HTMLFormElement | null;
  const input = document.getElementById('login-password') as HTMLInputElement | null;
  const button = document.getElementById('login-submit') as HTMLButtonElement | null;
  if (!form || !input || !button) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setLoginError('');

    const password = input.value;
    if (!password) {
      setLoginError('Informe a senha.');
      return;
    }

    button.disabled = true;
    button.textContent = '[VERIFICANDO...]';

    try {
      await auth.login(password);
      input.value = '';
      await loadAndStart();
    } catch (error) {
      if (error instanceof ApiError) {
        setLoginError(
          error.status === 429
            ? 'Muitas tentativas. Espere um minuto.'
            : error.status === 401
              ? 'Senha incorreta.'
              : error.message,
        );
      } else {
        setLoginError('Falha ao entrar.');
      }
      input.select();
    } finally {
      button.disabled = false;
      button.textContent = '[ENTRAR]';
    }
  });
}

// Sessão caiu no meio do uso: volta para o login sem perder o estado da tela.
onAuthChange((authenticated) => {
  if (authenticated) return;
  document.getElementById('app-viewport')?.classList.add('hidden');
  hide(BOOT_EL);
  show(LOGIN_EL);
  setLoginError('Sua sessão expirou. Entre novamente.');
  document.getElementById('login-password')?.focus();
});

document.addEventListener('DOMContentLoaded', () => {
  initLoginForm();
  void boot();
});
