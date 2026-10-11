import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RUNTIME_ENDPOINT } from '@wechat-agent/ports';
import type { PairingConfig } from './connector.ts';

export interface AppConfig {
  /** runtime.sock the driver was built for; shown in the snapshot, never probed elsewhere. */
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
  /** Outbox delivery: exponential backoff for retryable sink failures, the cap, the per-delivery timeout. */
  outbox: { baseMs: number; maxMs: number; maxAttempts: number; deliverTimeoutMs: number };
  client: { name: string; version: string };
  /** What this app asks AgentDesktop for when the person pairs it (A4). */
  pairing: PairingConfig;
}

/** WeChat for Mac. Pairing asks for this app only; the grant decides, the app never widens it. */
export const WECHAT_BUNDLE = 'com.tencent.xinWeChat';

export const DEFAULT_CONFIG: AppConfig = {
  endpoint: DEFAULT_RUNTIME_ENDPOINT,
  dataDir: path.join(os.tmpdir(), 'wechat-agent'),
  lockPath: null,
  reconnect: { baseMs: 1_000, maxMs: 60_000 },
  cancelWaitMs: 5_000,
  patrolEnabled: true,
  evidenceRetentionDays: 30,
  approvalTtlSeconds: 600,
  baselineOnConnect: true,
  outbox: { baseMs: 1_000, maxMs: 300_000, maxAttempts: 12, deliverTimeoutMs: 10_000 },
  client: { name: 'wechat-agent', version: '0.1.0' },
  pairing: {
    agentName: 'WeChat Agent',
    // observe: window and Desktop lists, observe, artifacts; act: session.open (observe needs a session) and
    // act; desktop.manage: window.bind; run: Delegated Runs and their events. Desktops: only ones this app
    // created ("created"); the owner may name others when approving. One day, then the owner renews.
    requested: { capabilities: ['observe', 'act', 'desktop.manage', 'run'], desktops: ['created'], apps: [WECHAT_BUNDLE], durationSeconds: 86_400 },
    pollMs: 2_000,
  },
};

export function resolveConfig(partial: Partial<AppConfig> = {}): AppConfig {
  const merged: AppConfig = {
    ...DEFAULT_CONFIG, ...partial, reconnect: { ...DEFAULT_CONFIG.reconnect, ...partial.reconnect }, outbox: { ...DEFAULT_CONFIG.outbox, ...partial.outbox },
    client: { ...DEFAULT_CONFIG.client, ...partial.client },
    pairing: { ...DEFAULT_CONFIG.pairing, ...partial.pairing },
  };
  if (partial.lockPath === undefined) merged.lockPath = partial.dataDir ? path.join(merged.dataDir, 'instance.lock') : null;
  return merged;
}
