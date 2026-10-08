// Ledger smoke for spike mode (packaging/SQLITE-ABI.md): proves the running
// process can load better-sqlite3 for its own ABI and drive the real ledger.
// Opens a ledger file under `dir` (never the user's data directory), checks
// health(), writes one legacy suppression and reads it back, closes. Pure
// apart from the file it creates, so it runs under tsx (Node ABI) in tests and
// inside the packaged app (Electron ABI) from packaging/verify-install.sh.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteLedger } from '@wechat-agent/ledger';

export interface LedgerSmokeReport {
  ok: boolean;
  path: string;
  modules: string;
  node: string;
  electron?: string;
  ms: number;
  steps: Record<string, unknown>;
  error?: string;
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** Everything the smoke must have seen for `ok` to be true. */
export function evaluateLedgerSmoke(steps: Record<string, unknown>): boolean {
  const health = steps.health as { writable?: boolean } | undefined;
  const after = steps.healthAfterClose as { writable?: boolean; reason?: string } | undefined;
  return Boolean(
    steps.fileIsSqlite === true
    && health?.writable === true
    && steps.quickCheck === 'ok'
    && steps.added === 1
    && steps.suppressed === true
    && steps.otherSuppressed === false
    && steps.readBackAfterReopen === true
    && after?.writable === false && after?.reason === 'closed',
  );
}

export async function runLedgerSmoke(dir: string): Promise<LedgerSmokeReport> {
  const t0 = Date.now();
  const path = join(dir, 'ledger-smoke.sqlite');
  const steps: Record<string, unknown> = {};
  const base = { path, modules: process.versions.modules, node: process.versions.node, electron: process.versions.electron };
  try {
    const ledger = SqliteLedger.open(path);
    steps.health = await ledger.health();
    const diag = ledger.diagnostics();
    steps.quickCheck = diag.quickCheck;
    steps.schemaVersion = diag.schemaVersion;
    const key = `smoke:${randomUUID()}`;
    steps.added = await ledger.importLegacySuppressions([{ key, sourceHash: 'ledger-smoke' }], new Date().toISOString());
    steps.suppressed = await ledger.isSuppressed(key);
    steps.otherSuppressed = await ledger.isSuppressed(`${key}:other`);
    await ledger.close();
    steps.healthAfterClose = await ledger.health();
    // Durability: a second connection sees the row.
    const again = SqliteLedger.open(path);
    steps.readBackAfterReopen = await again.isSuppressed(key);
    steps.rows = again.diagnostics().rows?.legacy_suppression;
    await again.close();
    steps.fileIsSqlite = existsSync(path) && readFileSync(path).subarray(0, 16).toString('latin1') === SQLITE_MAGIC;
    return { ...base, ok: evaluateLedgerSmoke(steps), ms: Date.now() - t0, steps };
  } catch (error) {
    return { ...base, ok: false, ms: Date.now() - t0, steps, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}
