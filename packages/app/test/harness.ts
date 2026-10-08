// Test harness for lane E: fakes from @wechat-agent/ports/fakes, minimal
// scripted handlers (never the real packages/handlers), a manual scheduler.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DriverError, IpcFailure, WriteGateClosedError } from '@wechat-agent/ports';
import type {
  AcceptRequestPayload, ActionKind, ActionReceipt, AppSnapshot, CancelReceipt, DomainFact, DomainResult, Handler, HandlerContext, HandlerRegistry, Id, Run,
  SendMessagePayload, TaskType, WeChatTask,
} from '@wechat-agent/ports';
import { FakeDriver, FakeRecognizer, InMemoryLedger, type FakeDriverOptions } from '@wechat-agent/ports/fakes';
import { createApplication, hashContent, ManualScheduler, type AppConfig, type Application } from '../src/index.ts';

export const T0 = '2026-10-08T10:00:00+08:00';

/** A clock that moves one second per read, so createdAt orders tasks. */
export function makeClock(start = T0) {
  let t = Date.parse(start);
  return {
    now: () => { t += 1000; return new Date(t).toISOString(); },
    advance: (ms: number) => { t += ms; },
    peek: () => new Date(t).toISOString(),
  };
}

export const noFacts = (outcome: DomainResult['outcome'], extra: Partial<DomainResult> = {}): DomainResult => ({ outcome, facts: [], evidenceIds: [], ...extra });

export function stub<T extends TaskType>(type: T, actions: ActionKind[], run: (task: WeChatTask, ctx: HandlerContext) => Promise<DomainResult>, methods: string[] = ['observe', 'act']): Handler<T> {
  return { type, requires: { methods, actions }, run: run as Handler<T>['run'] };
}

export function registry(...handlers: Handler[]): HandlerRegistry {
  return { get: <T extends TaskType>(type: T) => handlers.find((h) => h.type === type) as Handler<T> | undefined, all: () => handlers };
}

/** Parks a handler: `wait` blocks until `release`; `reached` resolves once the handler is parked. */
export class Gate {
  private resolveWait: (() => void) | undefined;
  private resolveReached: () => void = () => undefined;
  readonly reached: Promise<void>;
  constructor() {
    this.reached = new Promise<void>((r) => { this.resolveReached = r; });
  }
  readonly wait = (): Promise<void> => new Promise<void>((r) => { this.resolveWait = r; this.resolveReached(); });
  release(): void { this.resolveWait?.(); }
}

/** A read handler reporting scripted rows through a request_read fact (the patrol convention). */
export function readStub(rows: () => { rowKey: string; status: string; name?: string }[], coverage = 'end_confirmed'): Handler<'read_requests'> {
  return stub('read_requests', ['read', 'navigate'], async (task, ctx) => {
    await ctx.driver.observe({ sessionId: ctx.session.sessionId, runId: ctx.session.runId }, { screenshot: true });
    const fact = await ctx.ledger.appendFact({ taskId: task.taskId, factKind: 'request_read', outcome: 'observed', evidenceIds: [], observedAt: ctx.now(), confidence: 0.9, data: { requests: rows(), coverage, visibleSingleChats: 3 } });
    return { outcome: 'confirmed', facts: [fact], evidenceIds: [] };
  }, ['observe']);
}

export interface ActStubOptions {
  /** Parks the handler after approval, before any write. */
  beforeAct?: () => Promise<void>;
  contentHash?: (task: WeChatTask) => string;
  actionKind?: ActionKind;
  /** A misbehaving handler that never checks the write gate itself. */
  ignoreGate?: boolean;
  /** Counts handler runs. */
  runs?: { count: number };
}

/** approval → consume → attempt → act → receipt → verified → confirmed. The dangerous path of 方案 §09, scripted. */
function actingStub<T extends 'accept_request' | 'send_message' | 'add_friend'>(type: T, actionKind: ActionKind, label: (task: WeChatTask) => string, options: ActStubOptions): Handler<T> {
  return stub(type, ['navigate', actionKind], async (task, ctx) => {
    if (options.runs) options.runs.count += 1;
    const contentHash = options.contentHash?.(task) ?? `${type}:${label(task)}`;
    const decision = await ctx.requestApproval({
      taskId: task.taskId, allowedAction: actionKind, accountRevision: ctx.account.revision, targetRevision: 1, draftRevision: 0, contentHash,
      summary: { targetLabel: label(task), evidenceIds: [], identityConfidence: 0.9 },
    });
    if (decision.kind !== 'approved') return noFacts('blocked', { reasonCode: decision.kind === 'rejected' ? 'approval_invalid' : 'cancelled', reason: `decision ${decision.kind}` });
    if (options.beforeAct) await options.beforeAct();
    if (!options.ignoreGate) ctx.writeGate.ensureOpen();
    await ctx.ledger.consumeApproval(decision.approval.approvalId, { taskId: task.taskId, contentHash, targetRevision: 1, accountRevision: ctx.account.revision }, ctx.now());
    const observation = await ctx.driver.observe({ sessionId: ctx.session.sessionId, runId: ctx.session.runId }, { screenshot: true });
    const attempt = await ctx.ledger.prepareAttempt({ taskId: task.taskId, stepId: actionKind, sessionId: ctx.session.sessionId, runId: ctx.session.runId }, ctx.now());
    const requestId = ctx.newId();
    if (!options.ignoreGate) ctx.writeGate.ensureOpen();
    await ctx.ledger.markDispatching(attempt.attemptId, { requestId, canonicalDigest: contentHash, snapshotId: observation.snapshotId, sessionId: ctx.session.sessionId, runId: ctx.session.runId }, ctx.now());
    let receipt: ActionReceipt;
    try {
      receipt = await ctx.driver.act({ sessionId: ctx.session.sessionId, runId: ctx.session.runId }, { snapshotId: observation.snapshotId, action: { kind: 'click', target: { imagePoint: { x: 10, y: 10 } } } }, requestId);
    } catch (error) {
      if (error instanceof DriverError && error.error.notSent === true) await ctx.ledger.markNotSent(attempt.attemptId, error.error.code, ctx.now());
      else if (error instanceof DriverError) await ctx.ledger.markUnknown(attempt.attemptId, error.error.code, ctx.now());
      throw error;
    }
    await ctx.ledger.recordReceipt(attempt.attemptId, receipt.receiptId, receipt as unknown as Record<string, unknown>, ctx.now());
    await ctx.ledger.markVerified(attempt.attemptId, ctx.now());
    const fact: DomainFact = await ctx.ledger.appendFact({ taskId: task.taskId, factKind: actionKind === 'send_message' ? 'message_sent' : 'request_status', outcome: 'confirmed', evidenceIds: [], observedAt: ctx.now(), confidence: 0.95 });
    return { outcome: 'confirmed', facts: [fact], evidenceIds: [] };
  });
}

export const acceptStub = (options: ActStubOptions = {}) => actingStub('accept_request', 'accept_request', (t) => (t.payload as AcceptRequestPayload).requestKey, options);
export const sendStub = (options: ActStubOptions = {}) => actingStub('send_message', 'send_message', (t) => (t.payload as SendMessagePayload).conversationTargetId, { contentHash: (t) => (t.payload as SendMessagePayload).contentHash, ...options });

/** A fake whose run.cancel is accepted but whose quiescence stays pending until `confirmStop`. */
export class PendingCancelDriver extends FakeDriver {
  readonly cancelled: Id[] = [];
  override async cancelRun(runId: Id): Promise<CancelReceipt> {
    this.calls.push({ method: 'cancelRun', args: [runId] });
    this.cancelled.push(runId);
    const run = this.runs.get(runId);
    if (!run) throw new DriverError({ code: 'not_found', message: runId, phase: 'handler', retryable: false });
    Object.assign(run, { phase: 'stopping', quiescence: 'pending', revision: run.revision + 1 });
    return { cancelRequest: { accepted: true, scope: { kind: 'run', id: runId } }, execution: { phase: 'stopping', quiescence: 'pending', outcome: null, revision: run.revision } };
  }
  override async waitRun(runId: Id, timeoutMs: number): Promise<Run> {
    this.calls.push({ method: 'waitRun', args: [runId, timeoutMs] });
    return this.runs.get(runId)!;
  }
  confirmStop(runId: Id): void {
    const run = this.runs.get(runId)!;
    Object.assign(run, { phase: 'ended', outcome: 'cancelled', quiescence: 'confirmed', revision: run.revision + 1, endedAt: new Date().toISOString() });
  }
}

export interface Harness {
  app: Application;
  driver: FakeDriver;
  ledger: InMemoryLedger;
  recognizer: FakeRecognizer;
  scheduler: ManualScheduler;
  clock: ReturnType<typeof makeClock>;
  dataDir: string;
  call: Application['service']['call'];
  snapshot(): Promise<AppSnapshot>;
  /** Confirms the account from the evidence the setup captured. */
  confirmAccount(): Promise<void>;
  acts(): number;
  calls(method: string): number;
  idle(): Promise<void>;
}

export async function makeHarness(options: {
  handlers?: Handler[];
  driver?: FakeDriver;
  driverOptions?: FakeDriverOptions;
  ledger?: InMemoryLedger;
  config?: Partial<AppConfig>;
  start?: boolean;
} = {}): Promise<Harness> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wechat-agent-e-'));
  const driver = options.driver ?? new FakeDriver({ principalRole: 'paired', ...options.driverOptions });
  const ledger = options.ledger ?? new InMemoryLedger();
  const recognizer = new FakeRecognizer();
  const scheduler = new ManualScheduler();
  const clock = makeClock();
  const app = createApplication({
    driver, ledger, recognizer, handlers: registry(...(options.handlers ?? [])), now: clock.now, scheduler,
    config: { dataDir, lockPath: null, reconnect: { baseMs: 0, maxMs: 0 }, cancelWaitMs: 5, patrolEnabled: false, baselineOnConnect: false, ...options.config },
  });
  if (options.start !== false) await app.start();
  const harness: Harness = {
    app, driver, ledger, recognizer, scheduler, clock, dataDir,
    call: (method, params) => app.service.call(method, params),
    snapshot: () => app.service.call('app.getSnapshot', {}),
    confirmAccount: async () => {
      const snap = await harness.snapshot();
      assert.equal(snap.account?.status, 'unconfirmed', 'setup should have captured binding evidence');
      await harness.call('account.confirm', { bindingEvidenceId: snap.account!.evidenceIds[0]!, expectedRevision: undefined });
    },
    acts: () => driver.calls.filter((c) => c.method === 'act').length,
    calls: (method) => driver.calls.filter((c) => c.method === method).length,
    idle: () => app.internals.idle(),
  };
  return harness;
}

export async function waitFor(condition: () => boolean | Promise<boolean>, what = 'condition', tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await condition()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function waitState(h: Harness, taskId: Id, state: string): Promise<void> {
  await waitFor(async () => (await h.ledger.getTask(taskId))?.state === state, `task ${taskId} → ${state} (now ${(await h.ledger.getTask(taskId))?.state})`);
}

export function expectIpc(code: IpcFailure['error']['code']) {
  return (error: unknown) => {
    assert.ok(error instanceof IpcFailure, `expected IpcFailure, got ${String(error)}`);
    assert.equal(error.error.code, code, `expected ${code}, got ${error.error.code}: ${error.error.message}`);
    return true;
  };
}

export { hashContent, WriteGateClosedError };
