// Stage 4 rehearsal stack: lane A's Fake Runtime SERVER on a temporary Unix
// socket, lane A's real client (createDriver) over it, lane E's real app,
// lane D's real handlers and lane B's SQLite ledger on a temp file. Only the
// recognizer is scripted. Nothing here reaches a real application, screen or
// pointer: the Fake Runtime's "dispatch" is a receipt and an event.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { ManualScheduler, type AppConfig, type Application as RealApplication } from '@wechat-agent/app';
import { createDriver, FakeRuntime, type FakeRuntimeOptions, type LoggedRequest } from '@wechat-agent/driver';
import { createHandlers } from '@wechat-agent/handlers';
import { openLedger } from '@wechat-agent/ledger';
import type { AgentDesktopDriver, AppSnapshot, Ledger, PageFacts, TaskView } from '@wechat-agent/ports';
import { GatedRecognizer } from './fixtures.ts';
import { createSlice, type RealDriverSlice } from './wiring.ts';

export const REHEARSAL_CLIENT = { name: 'wechat-agent-rehearsal', version: '0.1.0' };

export interface FakeStackOptions {
  fake?: FakeRuntimeOptions;
  facts?: PageFacts[];
  appConfig?: Partial<AppConfig>;
  requestTimeoutMs?: number;
  /** Confirm the test account before start (default true). */
  account?: boolean;
}

export interface FakeStack {
  fake: FakeRuntime;
  driver: AgentDesktopDriver;
  slice: RealDriverSlice;
  ledger: Ledger;
  recognizer: GatedRecognizer;
  app: RealApplication;
  scheduler: ManualScheduler;
  /** Requests the Fake Runtime logged since `mark()` was last called. */
  since(): LoggedRequest[];
  mark(): void;
  methods(requests?: LoggedRequest[]): string[];
}

/** Fake Runtime + real driver + real app/handlers/ledger; torn down after the test. */
export async function startFakeStack(t: TestContext, options: FakeStackOptions = {}): Promise<FakeStack> {
  const fake = await FakeRuntime.start({ principal: { clientId: 'local:501', role: 'owner' }, ...options.fake });
  const driver = createDriver({ endpoint: fake.endpoint, client: REHEARSAL_CLIENT, requestTimeoutMs: options.requestTimeoutMs ?? 2_000, connectTimeoutMs: 2_000 });
  const ledger = await openLedger(path.join(mkdtempSync(path.join(tmpdir(), 'wechat-agent-stage4-')), 'ledger.sqlite'));
  const scheduler = new ManualScheduler();
  const slice = await createSlice({
    app: 'real', driver, ledger, handlers: createHandlers(), facts: options.facts ?? [], scheduler, account: options.account,
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
    fake, driver, slice, ledger, recognizer: slice.recognizer, app, scheduler,
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
