// The composition root of the integration slice. Tests never construct a
// driver, ledger, recognizer, handler or application themselves; they ask
// for a slice and talk to it through the ports. Each dependency has one
// swap point below. The default is lane H's stub application over whatever
// ledger/handlers the test passes in; `app: 'real'` wires lane E's
// createApplication (stage 3 of docs/plan/00-parallel-work-plan.md §5).
//
//   WECHAT_AGENT_SLICE=ledger,handlers,app   also selects the real packages
//   (exploratory only; the acceptance path is the explicit options below)
//
// The driver stays FakeDriver until lane A's Fake Runtime server lands (its
// start/stop API is not frozen in ports); the recognizer stays scripted
// because the slice is about flows, not pixels.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDesktopDriver, HandlerRegistry, Ledger, PageFacts, Recognizer, Timestamp } from '@wechat-agent/ports';
import { FakeDriver, InMemoryLedger, type FakeDriverOptions } from '@wechat-agent/ports/fakes';
import { openLedger } from '@wechat-agent/ledger';
import { createHandlers } from '@wechat-agent/handlers';
import { createApplication, MemorySink, type AppConfig, type OutboxSink } from '@wechat-agent/app';
import { GatedRecognizer, T0, clock, observation } from './fixtures.ts';
import { createStubApplication, type Application } from './stub-app.ts';
import { createStubHandlers } from './stub-handlers.ts';

export interface SliceOptions {
  driver?: FakeDriverOptions;
  /** Scripted PageFacts, in order; the last repeats. */
  facts?: PageFacts[];
  /** Confirm a test account before start (revision 1). Default true. */
  account?: boolean;
  ledger?: Ledger;
  /** A handler registry to use instead of the default (e.g. lane D's createHandlers()). */
  handlers?: HandlerRegistry;
  /**
   * Which application core runs the slice: lane H's stub (default) or lane E's createApplication.
   * The real app is wired with baseline and patrol off, so the scripted facts belong to the test's
   * own tasks; pass `appConfig` to turn either back on (and script their observations first).
   */
  app?: 'real' | 'stub';
  appConfig?: Partial<AppConfig>;
  /** Real app only: where outbox events are delivered. Default: a MemorySink the test can inspect as `slice.outbox`. */
  outboxSink?: OutboxSink;
  now?: () => Timestamp;
  quiescenceTimeoutMs?: number;
}

export interface Slice {
  driver: FakeDriver;
  ledger: Ledger;
  recognizer: GatedRecognizer;
  handlers: HandlerRegistry;
  app: Application;
  now: () => Timestamp;
  /** The real app's outbox sink (a MemorySink unless the test passed its own); undefined for the stub app. */
  outbox?: OutboxSink;
}

/** Four bytes stand in for the screenshot; the scripted recognizer never looks at them. */
const FIXTURE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const real = new Set((process.env.WECHAT_AGENT_SLICE ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/** The real app's defaults for the slice: no setup-time observations outside the test's script, no timers. */
export const REAL_APP_SLICE_CONFIG: Partial<AppConfig> = { baselineOnConnect: false, patrolEnabled: false, cancelWaitMs: 50 };

export async function createSlice(options: SliceOptions = {}): Promise<Slice> {
  const now = options.now ?? clock(T0).now;

  // Driver: lane A's createDriver + Fake Runtime once its server API exists; FakeDriver until then.
  const driver = new FakeDriver({ principalRole: 'paired', observations: [observation()], artifacts: { art_fixture: FIXTURE_PNG }, ...options.driver });

  // Ledger: lane B's SQLite ledger on a temp path, or the in-memory reference.
  const ledger = options.ledger ?? (real.has('ledger') ? await openLedger(join(mkdtempSync(join(tmpdir(), 'wechat-agent-slice-')), 'ledger.sqlite')) : new InMemoryLedger());

  // Recognizer: scripted facts with a timing hook (lane C's recognizer reads real pixels; the slice does not).
  const recognizer = new GatedRecognizer(options.facts ?? []);

  // Handlers: lane D's registry or the stubs.
  const handlers = options.handlers ?? (real.has('handlers') ? createHandlers() : createStubHandlers());

  if (options.account !== false) {
    await ledger.confirmAccount({ accountId: 'acct_test_a', visibleLabel: '测试账号甲', evidenceIds: ['ev_account_fixture'], confirmedAt: now(), status: 'confirmed' }, undefined);
  }

  // Application: lane E's createApplication or the stub; both return { service, start, stop }.
  const appKind = options.app ?? (real.has('app') ? 'real' : 'stub');
  const outbox = appKind === 'real' ? options.outboxSink ?? new MemorySink() : undefined;
  const app: Application = appKind === 'real'
    ? createApplication({ driver, ledger, recognizer, handlers, now, outboxSink: outbox, config: { ...REAL_APP_SLICE_CONFIG, ...options.appConfig } })
    : createStubApplication({ driver, ledger, recognizer, handlers, now, quiescenceTimeoutMs: options.quiescenceTimeoutMs });

  return { driver, ledger, recognizer, handlers, app, now, outbox };
}

export type { AgentDesktopDriver, Recognizer };
