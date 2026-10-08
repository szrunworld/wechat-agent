// Lane B: the SQLite ledger. See docs/lanes/lane-b.md. The contract tests it
// passes live in packages/ports/test/ledger-contract.ts.
import type { Ledger } from '@wechat-agent/ports';
import { SqliteLedger } from './sqlite-ledger.ts';
import type { OpenOptions } from './sqlite-ledger.ts';

export { SqliteLedger, DEFAULT_POLICY, peekSchemaVersion } from './sqlite-ledger.ts';
export type { OpenOptions, FaultInjection, LedgerDiagnostics } from './sqlite-ledger.ts';
export { readLegacyState, LegacyStateError } from './legacy.ts';
export type { LegacyState } from './legacy.ts';
export { MIGRATIONS, SUPPORTED_SCHEMA_VERSION } from './migrations.ts';
export type { Migration } from './migrations.ts';

/** Opens (or creates) the ledger at `path`. Throws LedgerUnavailableError instead of ever starting over with an empty file. */
export async function openLedger(path: string, options: OpenOptions = {}): Promise<Ledger> {
  return SqliteLedger.open(path, options);
}
