// Stage 4 rehearsal stack: lane A's Fake Runtime SERVER on a temporary Unix
// socket, lane A's real client (createDriver) over it, lane E's real app,
// lane D's real handlers and lane B's SQLite ledger on a temp file. Only the
// recognizer is scripted. Nothing here reaches a real application, screen or
// pointer: the Fake Runtime's "dispatch" is a receipt and an event.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { ManualScheduler, MemoryCredentialStore, type AppConfig, type Application as RealApplication } from '@wechat-agent/app';
import { createDriver, FakeRuntime, type FakeRuntimeOptions, type LoggedRequest } from '@wechat-agent/driver';
import { createHandlers } from '@wechat-agent/handlers';
import { openLedger } from '@wechat-agent/ledger';
import type { AgentDesktopDriver, AppSnapshot, GrantRequest, Ledger, PageFacts, TaskView } from '@wechat-agent/ports';
import { GatedRecognizer, T0, clock } from './fixtures.ts';
import { createSlice, type RealDriverSlice } from './wiring.ts';

export const REHEARSAL_CLIENT = { name: 'wechat-agent-rehearsal', version: '0.1.0' };

export interface FakeStackOptions {
  fake?: FakeRuntimeOptions;
  facts?: PageFacts[];
  appConfig?: Partial<AppConfig>;
  requestTimeoutMs?: number;
  /** Confirm the test account before start (default true). */
  account?: boolean;
  /**
   * The Fake Runtime enforces A4. By default the app starts already paired (the person approved it before
   * the test) with this grant; `null` starts it unpaired with an empty credential store.
   */
  grant?: GrantRequest | null;
}

/** What the rehearsals run under: the app's own request, scoped to the Fake Runtime's Desktop. */
export const REHEARSAL_GRANT: GrantRequest = { capabilities: ['observe', 'act', 'desktop.manage', 'run'], desktops: ['desk_1'], apps: ['com.tencent.xinWeChat'], durationSeconds: 3600 };

export interface FakeStack {
  fake: FakeRuntime;
  /** The app's credential store (pre-paired unless `grant: null`). */
  credentials: MemoryCredentialStore;
  /** The pre-approved client, when there is one. */
  clientId?: string;
  driver: AgentDesktopDriver;
  slice: RealDriverSlice;
  ledger: Ledger;
  recognizer: GatedRecognizer;
  app: RealApplication;
  scheduler: ManualScheduler;
  /** The app's clock (each read ticks one second; `advance` jumps). */
  clock: ReturnType<typeof clock>;
  /** Requests the Fake Runtime logged since `mark()` was last called. */
  since(): LoggedRequest[];
  mark(): void;
  methods(requests?: LoggedRequest[]): string[];
}

/** Fake Runtime + real driver + real app/handlers/ledger; torn down after the test. */
export async function startFakeStack(t: TestContext, options: FakeStackOptions = {}): Promise<FakeStack> {
  const fake = await FakeRuntime.start({ a4: true, ...options.fake });
  const grant = options.grant === undefined ? REHEARSAL_GRANT : options.grant;
  const paired = grant ? fake.hub.preapprove(grant) : undefined;
  const credentials = new MemoryCredentialStore(paired ? { ...paired.credential, grant: paired.grant, pairedAt: new Date().toISOString() } : null);
  const driver = createDriver({ endpoint: fake.endpoint, client: REHEARSAL_CLIENT, requestTimeoutMs: options.requestTimeoutMs ?? 2_000, connectTimeoutMs: 2_000 });
  const ledger = await openLedger(path.join(mkdtempSync(path.join(tmpdir(), 'wechat-agent-stage4-')), 'ledger.sqlite'));
  const scheduler = new ManualScheduler();
  const appClock = clock(T0);
  const slice = await createSlice({
    now: appClock.now,
    app: 'real', driver, ledger, handlers: createHandlers(), facts: options.facts ?? [], scheduler, account: options.account, credentials,
    appConfig: { reconnect: { baseMs: 10, maxMs: 10 }, ...options.appConfig },
  });
  const app = slice.app as RealApplication;
  let cursor = 0;
  t.after(async () => {
    await app.stop().catch(() => undefined);
    await driver.close().catch(() => undefined);
    await ledger.close().catch(() => undefined);
    await fake.close();
  });
  return {
    fake, driver, slice, ledger, recognizer: slice.recognizer, app, scheduler, credentials, clientId: paired?.credential.clientId, clock: appClock,
    since: () => fake.requests.slice(cursor),
    mark: () => { cursor = fake.requests.length; },
    methods: (requests = fake.requests) => requests.map((r) => r.method),
  };
}

export async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, what: string, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: never matched; last ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const snapshotOf = (stack: FakeStack): Promise<AppSnapshot> => stack.app.service.call('app.getSnapshot', {});
export const viewOf = (stack: FakeStack, taskId: string): Promise<TaskView> => stack.app.service.call('task.show', { taskId });
export const timeline = (view: TaskView): string => view.timeline.map((x) => x.label).join(' > ');
