/**
 * Backup do banco.
 *
 * Usa `VACUUM INTO`, que produz uma cópia **consistente** do SQLite mesmo com o
 * servidor rodando — copiar o arquivo com `cp` durante uma escrita pode gerar um
 * backup corrompido, porque o conteúdo do WAL não estaria incluído.
 *
 * Numa base de finanças pessoais o arquivo tem alguns megabytes, então o backup é
 * instantâneo e pode rodar todo dia sem incomodar.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getSqlite } from '../db/client.js';
import { backupsDir } from '../config/env.js';
import { nowIso, today } from '../core/clock.js';

export interface BackupResult {
  path: string;
  sizeBytes: number;
  createdAt: string;
  removedOld: number;
}

/**
 * Cria um backup e limpa os antigos.
 *
 * O nome inclui a data, então rodar duas vezes no mesmo dia sobrescreve — o que é
 * o comportamento desejado: um backup por dia é suficiente e evita encher o disco.
 */
export function createBackup(options: { retentionDays?: number } = {}): BackupResult {
  const retention = options.retentionDays ?? 30;

  mkdirSync(backupsDir, { recursive: true });

  const filename = `finance-${today()}.db`;
  const path = join(backupsDir, filename);

  // `VACUUM INTO` falha se o destino já existir.
  rmSync(path, { force: true });

  const sqlite = getSqlite();
  // O caminho vai como literal escapado: `VACUUM INTO` não aceita parâmetro.
  sqlite.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

  const removedOld = pruneOldBackups(retention);

  return {
    path,
    sizeBytes: statSync(path).size,
    createdAt: nowIso(),
    removedOld,
  };
}

/** Remove backups mais antigos que a retenção. */
export function pruneOldBackups(retentionDays: number): number {
  let removed = 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;

  let entries: string[];
  try {
    entries = readdirSync(backupsDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.startsWith('finance-') || !entry.endsWith('.db')) continue;

    const path = join(backupsDir, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed += 1;
      }
    } catch {
      // Arquivo pode ter sido removido por fora; ignorar.
    }
  }

  return removed;
}

export interface BackupInfo {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

export function listBackups(): BackupInfo[] {
  try {
    return readdirSync(backupsDir)
      .filter((entry) => entry.startsWith('finance-') && entry.endsWith('.db'))
      .map((filename) => {
        const stats = statSync(join(backupsDir, filename));
        return {
          filename,
          sizeBytes: stats.size,
          modifiedAt: new Date(stats.mtimeMs).toISOString(),
        };
      })
      .sort((a, b) => (a.filename < b.filename ? 1 : -1));
  } catch {
    return [];
  }
}
