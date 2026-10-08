import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONTROL_ENDPOINT } from '@wechat-agent/ports';

export interface AppConfig {
  /** control.sock the driver was built for; shown in the snapshot, never probed elsewhere. */
  endpoint: string;
  /**
   * App-owned directory for the instance lock and diagnostics exports. The shell passes its userData
   * directory; without one the app uses a temp directory and takes no instance lock (library/test use).
   */
  dataDir: string;
  /** `null` disables the single-instance lock. Default: `<dataDir>/instance.lock` when `dataDir` is given, else null. */
  lockPath: string | null;
  reconnect: { baseMs: number; maxMs: number };
  /** run.wait timeout after run.cancel before a stop is reported as unconfirmed. */
  cancelWaitMs: number;
  patrolEnabled: boolean;
  evidenceRetentionDays: number;
  /** Default validity the UI is offered for a business approval. */
  approvalTtlSeconds: number;
  /** One read-only ReadRequests task after the account is confirmed (setup step `baseline`). */
  baselineOnConnect: boolean;
  client: { name: string; version: string };
}

export const DEFAULT_CONFIG: AppConfig = {
  endpoint: DEFAULT_CONTROL_ENDPOINT,
  dataDir: path.join(os.tmpdir(), 'wechat-agent'),
  lockPath: null,
  reconnect: { baseMs: 1_000, maxMs: 60_000 },
  cancelWaitMs: 5_000,
  patrolEnabled: true,
  evidenceRetentionDays: 30,
  approvalTtlSeconds: 600,
  baselineOnConnect: true,
  client: { name: 'wechat-agent', version: '0.1.0' },
};

export function resolveConfig(partial: Partial<AppConfig> = {}): AppConfig {
  const merged: AppConfig = { ...DEFAULT_CONFIG, ...partial, reconnect: { ...DEFAULT_CONFIG.reconnect, ...partial.reconnect }, client: { ...DEFAULT_CONFIG.client, ...partial.client } };
  if (partial.lockPath === undefined) merged.lockPath = partial.dataDir ? path.join(merged.dataDir, 'instance.lock') : null;
  return merged;
}
