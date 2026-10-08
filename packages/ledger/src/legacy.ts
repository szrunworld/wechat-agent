// Reads the legacy state file (legacy/src/store.ts: `{ handled: string[], wechatPid? }`)
// into suppression entries. Nothing else survives: no task is created, the
// old `wechatPid` is dropped, and no auto mode is inherited.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LegacySuppression } from '@wechat-agent/ports';

export interface LegacyState {
  entries: LegacySuppression[];
  /** sha256 of the file as read; every entry carries it as sourceHash. */
  sourceHash: string;
  /** Fields the old file had that the ledger does not take over. */
  droppedFields: string[];
}

export class LegacyStateError extends Error {
  constructor(readonly path: string, message: string) {
    super(`legacy state ${path}: ${message}`);
    this.name = 'LegacyStateError';
  }
}

/** Missing file → no entries. Malformed file → LegacyStateError (never silently empty). */
export function readLegacyState(path: string): LegacyState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], sourceHash: '', droppedFields: [] };
    throw new LegacyStateError(path, (error as Error).message);
  }
  const sourceHash = createHash('sha256').update(raw).digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LegacyStateError(path, 'not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new LegacyStateError(path, 'not an object');
  const record = parsed as Record<string, unknown>;
  const handled = record.handled;
  if (handled !== undefined && !Array.isArray(handled)) throw new LegacyStateError(path, '`handled` is not an array');
  const seen = new Set<string>();
  const entries: LegacySuppression[] = [];
  for (const key of (handled ?? []) as unknown[]) {
    if (typeof key !== 'string' || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, sourceHash });
  }
  const droppedFields = Object.keys(record).filter((k) => k !== 'handled');
  return { entries, sourceHash, droppedFields };
}
