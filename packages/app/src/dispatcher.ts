// Dispatcher (方案 E03): UI and patrol intents enter one queue; writes on the
// one account run serially; the task state machine drives the handler; the
// approval flow releases the platform run while a person decides; the cancel
// domain stops a run and only settles after the platform confirms quiescence.
import { DriverError, IpcFailure, LedgerConflictError, WriteGateClosedError } from '@wechat-agent/ports';
import type {
  AccountBinding, ActionReceipt, AgentDesktopDriver, ApprovalDecision, ApprovalRequest, BusinessApproval, DomainReasonCode, DomainResult,
  Handler, HandlerContext, HandlerRegistry, Id, IpcMethods, Ledger, Policy, Recognizer, RequestRecord, Run, TaskState, Timestamp, WeChatTask, WriteGate,
} from '@wechat-agent/ports';
import type { AppConfig } from './config.ts';
import type { RuntimeConnector } from './connector.ts';
import { describeRefusal, isPlatformLost } from './connector.ts';
import type { FeatureMap } from './features.ts';
import type { InputGate } from './gate.ts';
import { KEY_FACT_KINDS, taskFinalDraft, type OutboxWriter } from './outbox.ts';
import { PolicyGate, type Verdict } from './policy.ts';
import { canonicalJson, Deferred, errorMessage, hashContent, Mutex, newId, sha256 } from './support.ts';
import {
  isTerminal, newRuntime, OPEN_TASK_STATES, pathTo, projectTask, RUNNING_STATES, targetKindFor, targetRefFor,
  type PendingApproval, type TaskOrigin, type TaskRuntime,
} from './tasks.ts';

export interface DispatcherDeps {
  driver: AgentDesktopDriver;
  ledger: Ledger;
  recognizer: Recognizer;
  handlers: HandlerRegistry;
  gate: InputGate;
  connector: RuntimeConnector;
  config: AppConfig;
  /** Writes the outbox event of every terminal transition and key business fact (plan §8: App core owns the outbox). */
  outbox: OutboxWriter;
  now(): Timestamp;
  features(): Promise<FeatureMap>;
  log(line: string): void;
  onChange(): void;
}

export interface FinishedEvent { task: WeChatTask; runtime: TaskRuntime; result: DomainResult }

const OUTCOME_TARGET: Record<DomainResult['outcome'], { target: TaskState; reason: DomainReasonCode | undefined; fallbacks: TaskState[] }> = {
  confirmed: { target: 'confirmed', reason: undefined, fallbacks: [] },
  failed: { target: 'failed', reason: undefined, fallbacks: [] },
  no_op: { target: 'no_op', reason: undefined, fallbacks: [] },
  needs_reconciliation: { target: 'needs_reconciliation', reason: 'platform_unknown', fallbacks: [] },
  sent_unconfirmed: { target: 'needs_reconciliation', reason: 'verification_missing', fallbacks: [] },
  ambiguous: { target: 'blocked', reason: 'target_ambiguous', fallbacks: ['waiting_user', 'failed'] },
  waiting_user: { target: 'waiting_user', reason: undefined, fallbacks: ['blocked'] },
  blocked: { target: 'blocked', reason: 'policy_disabled', fallbacks: ['waiting_user', 'failed'] },
};

const APPROVAL_VIA: readonly TaskState[] = ['preparing', 'ready', 'executing', 'verifying', 'waiting_user'];

function blockedFailure(reasonCode: DomainReasonCode, message: string): IpcFailure {
  return new IpcFailure({ code: 'blocked', message, details: { reasonCode } });
}

export class Dispatcher {
  readonly runtimes = new Map<Id, TaskRuntime>();
  readonly policyGate: PolicyGate;
  private queue: Id[] = [];
  private readonly lock = new Mutex();
  private readonly inFlight = new Set<Id>();
  private pumping = false;
  private changed = new Deferred<void>();
  private readonly finishedListeners = new Set<(event: FinishedEvent) => void>();
  private readonly skipListeners = new Set<(task: WeChatTask) => void>();

  constructor(private readonly deps: DispatcherDeps) {
    this.policyGate = new PolicyGate(deps.ledger);
  }

  // ---- observation -------------------------------------------------------

  onFinished(listener: (event: FinishedEvent) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  onSkipped(listener: (task: WeChatTask) => void): () => void {
    this.skipListeners.add(listener);
    return () => this.skipListeners.delete(listener);
  }

  /** A stop the platform has not confirmed: nothing else starts until it is settled. */
  get stopUnconfirmed(): boolean {
    for (const rt of this.runtimes.values()) if (rt.stopUnconfirmed) return true;
    return false;
  }

  private canStart(): boolean {
    return !this.stopUnconfirmed && this.deps.gate.reason === undefined;
  }

  private busy(): boolean {
    return this.inFlight.size > 0 || (this.queue.length > 0 && this.canStart());
  }

  /** Resolves once no handler is running and nothing startable is queued. */
  async idle(): Promise<void> {
    while (this.busy()) await this.changed.promise;
  }

  notify(): void {
    const previous = this.changed;
    this.changed = new Deferred<void>();
    previous.resolve();
    this.deps.onChange();
  }

  // ---- runtime bookkeeping -------------------------------------------------

  runtimeFor(taskId: Id, origin: TaskOrigin = 'ui', label = '载入任务'): TaskRuntime {
    let rt = this.runtimes.get(taskId);
    if (!rt) {
      rt = newRuntime(taskId, origin, this.deps.now(), label);
      this.runtimes.set(taskId, rt);
    }
    return rt;
  }

  private async withTask<T>(rt: TaskRuntime, fn: () => Promise<T>): Promise<T> {
    const release = await rt.lock.acquire();
    try { return await fn(); } finally { release(); }
  }

  private async load(taskId: Id): Promise<WeChatTask> {
    const task = await this.deps.ledger.getTask(taskId);
    if (!task) throw new IpcFailure({ code: 'not_found', message: `没有任务 ${taskId}` });
    return task;
  }

  private mark(rt: TaskRuntime, label: string): void {
    rt.timeline.push({ at: this.deps.now(), label });
  }

  async transition(rt: TaskRuntime, task: WeChatTask, to: TaskState, reasonCode?: DomainReasonCode, detail?: string): Promise<WeChatTask> {
    const audit = reasonCode ? `${reasonCode}${detail ? `: ${detail}` : ''}` : detail;
    let updated: WeChatTask;
    if (isTerminal(to)) {
      // The terminal state and its outbox event are one ledger write (SQLite); the event's revision is the task's new one.
      const keyFactIds = (await this.deps.ledger.listFacts(task.taskId)).filter((f) => KEY_FACT_KINDS.includes(f.factKind)).map((f) => f.factId);
      const outcome = rt.finalOutcome;
      const result = await this.deps.outbox.finalize(task.taskId, to, task.revision, this.deps.now(), audit, (final) => taskFinalDraft(final, { stateReason: reasonCode, reason: detail, outcome, keyFactIds }));
      updated = result.task;
      if (result.event) this.mark(rt, `外发事件已入账（${result.event.eventId}）`);
    } else {
      updated = await this.deps.ledger.transitionTask(task.taskId, to, task.revision, this.deps.now(), audit);
    }
    if (reasonCode) { rt.stateReason = reasonCode; rt.stateDetail = detail; }
    else if (to === 'queued' || to === 'preparing' || to === 'ready' || to === 'executing' || to === 'verifying') { rt.stateReason = undefined; rt.stateDetail = undefined; }
    this.notify();
    return updated;
  }

  /** Walks the legal path to `target` (or the first reachable fallback). */
  async settle(rt: TaskRuntime, task: WeChatTask, target: TaskState, reasonCode?: DomainReasonCode, detail?: string, fallbacks: TaskState[] = [], via?: readonly TaskState[]): Promise<WeChatTask> {
    for (const candidate of [target, ...fallbacks]) {
      const path = pathTo(task.state, candidate, via);
      if (!path) continue;
      for (const state of path) task = await this.transition(rt, task, state, state === candidate ? reasonCode : undefined, state === candidate ? detail : undefined);
      return task;
    }
    this.deps.log(`dispatcher: no path from ${task.state} to ${target} for ${task.taskId}`);
    return task;
  }

  private dispatchedUnverified(rt: TaskRuntime): boolean {
    for (const attempt of rt.attempts.values()) if (attempt.state === 'dispatching' || attempt.state === 'receipt_received' || attempt.state === 'unknown') return true;
    return false;
  }

  private async settleQuota(rt: TaskRuntime, state: TaskState): Promise<void> {
    if (!rt.reservationId) return;
    const id = rt.reservationId;
    try {
      if (state === 'confirmed') { await this.deps.ledger.consumeQuota(id); rt.reservationId = undefined; }
      else if (state === 'needs_reconciliation' || this.dispatchedUnverified(rt)) { await this.deps.ledger.holdQuota(id); rt.reservationId = undefined; }
      else if (isTerminal(state)) { await this.deps.ledger.releaseQuota(id); rt.reservationId = undefined; }
    } catch (error) {
      this.deps.log(`quota: ${errorMessage(error)}`);
    }
  }

  // ---- intake --------------------------------------------------------------

  async create(params: IpcMethods['task.create']['params'], origin: TaskOrigin): Promise<WeChatTask> {
    const { ledger, now } = this.deps;
    const account = await ledger.getAccount();
    if (!account || account.status !== 'confirmed') throw blockedFailure('identity_unproven', '账号未确认');
    if (params.expectedAccountRevision !== account.revision) {
      throw new IpcFailure({ code: 'revision_conflict', message: `账号版本已变化：当前 ${account.revision}`, details: { accountRevision: account.revision } });
    }
    if (params.payload.kind !== params.type) throw new IpcFailure({ code: 'invalid_state', message: `payload.kind ${params.payload.kind} 与 type ${params.type} 不一致` });
    const payloadHash = sha256(canonicalJson(params.payload));
    const fingerprint = sha256(canonicalJson({ type: params.type, targetId: params.targetId ?? null, payloadHash }));

    // Same intent, one task (T05): an open task with this fingerprint is the task, and an intent that
    // was confirmed or is still unresolved on the platform is never executed again.
    // Only intents of the current account revision count; a task blocked by an account change is not "the same intent".
    const open = (await ledger.listTasks({ states: [...OPEN_TASK_STATES], limit: 1000 })).tasks.filter((t) => t.accountRevision === account.revision);
    const outbound = params.type === 'accept_request' || params.type === 'add_friend' || params.type === 'send_message';
    const done = outbound ? (await ledger.listTasks({ states: ['confirmed', 'needs_reconciliation'], limit: 1000 })).tasks : [];
    const same = open.find((t) => t.fingerprint === fingerprint) ?? done.find((t) => t.fingerprint === fingerprint);
    if (same) { this.runtimeFor(same.taskId, origin); return same; }

    // A newer context for the same conversation supersedes the older send intent (T28).
    if (params.payload.kind === 'send_message') {
      const payload = params.payload;
      for (const other of open) {
        if (other.payload.kind !== 'send_message' || other.payload.conversationTargetId !== payload.conversationTargetId) continue;
        if (other.payload.contextRevision >= payload.contextRevision) continue;
        await this.supersede(other.taskId, `会话上下文已更新到 ${payload.contextRevision}`);
      }
    }

    let intake: { task: WeChatTask; created: boolean };
    try {
      intake = await ledger.intake({
        operationId: params.operationId, fingerprint, type: params.type, accountRevision: account.revision, targetId: params.targetId,
        payload: params.payload, payloadHash,
      }, now());
    } catch (error) {
      if (error instanceof LedgerConflictError && error.kind === 'operation_fingerprint') throw new IpcFailure({ code: 'operation_conflict', message: error.message });
      throw error;
    }
    const rt = this.runtimeFor(intake.task.taskId, origin, origin === 'patrol' ? '巡检发现' : origin === 'baseline' ? '基线读取' : '创建任务');
    if (!intake.created) return intake.task;
    let task = intake.task;

    const features = await this.deps.features();
    const policy = await ledger.getPolicy();
    const verdict = this.policyGate.checkStatic(task, this.deps.handlers.get(task.type), account, policy, features);
    if (!verdict.ok) {
      task = await this.transition(rt, task, 'blocked', verdict.reasonCode, verdict.detail);
      this.mark(rt, `阻断：${verdict.detail}`);
      return task;
    }
    task = await this.transition(rt, task, 'queued');
    this.queue.push(task.taskId);
    this.pump();
    return task;
  }

  private async supersede(taskId: Id, detail: string): Promise<void> {
    const rt = this.runtimeFor(taskId);
    await this.withTask(rt, async () => {
      const task = await this.load(taskId);
      if (isTerminal(task.state) || task.state === 'stopping') return;
      if (RUNNING_STATES.includes(task.state)) { await this.cancelDomainLocked(rt, task, detail); return; }
      await this.cancelIdleLocked(rt, task, 'content_mismatch', detail, 'cancelled');
    });
  }

  // ---- the queue -------------------------------------------------------------

  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      void this.drain().finally(() => { this.pumping = false; this.notify(); if (this.queue.length && this.canStart()) this.pump(); });
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length && this.canStart()) {
      const release = await this.lock.acquire();
      if (!this.canStart()) { release(); return; }
      const taskId = this.queue.shift();
      if (!taskId) { release(); return; }
      void this.execute(taskId, release);
      // Loop: the next acquire waits until this execution ends or parks for approval.
    }
  }

  private dequeue(taskId: Id): void {
    this.queue = this.queue.filter((id) => id !== taskId);
  }

  private async execute(taskId: Id, release: () => void): Promise<void> {
    const rt = this.runtimeFor(taskId);
    let releaseLock = release;
    this.inFlight.add(taskId);
    try {
      let task = await this.deps.ledger.getTask(taskId);
      if (!task || task.state !== 'queued') return;
      const handler = this.deps.handlers.get(task.type);
      const account = await this.deps.ledger.getAccount();
      const policy = await this.deps.ledger.getPolicy();
      const features = await this.deps.features();
      const verdict = await this.policyGate.preflight(task, handler, account, policy, features, this.deps.now());
      if (!verdict.ok || !handler || !account) {
        const why: Verdict = verdict.ok ? { ok: false, reasonCode: 'capability_missing', detail: '处理器未注册' } : verdict;
        if (!why.ok) await this.withTask(rt, async () => { task = await this.settle(rt, task!, 'blocked', why.reasonCode, why.detail); this.mark(rt, `阻断：${why.detail}`); });
        return;
      }
      rt.reservationId = verdict.reservationId;
      task = await this.withTask(rt, () => this.transition(rt, task!, 'preparing'));
      let session: HandlerContext['session'];
      try {
        session = await this.acquireRun(rt);
      } catch (error) {
        this.observeDriverError(rt, error);
        await this.withTask(rt, async () => {
          task = await this.settle(rt, task!, 'blocked', rt.disconnected ? 'disconnected' : 'not_found', `无法获取平台会话：${errorMessage(error)}`);
          await this.settleQuota(rt, task.state);
        });
        return;
      }
      this.mark(rt, '获取平台会话');
      const context = this.makeContext(task, rt, handler, policy, account, session, () => releaseLock(), (r) => { releaseLock = r; });
      let result: DomainResult;
      let failure: unknown;
      try {
        result = await handler.run(task, context);
      } catch (error) {
        failure = error;
        result = this.resultFromError(rt, error);
      }
      await this.finish(rt, result, failure);
    } catch (error) {
      this.deps.log(`dispatcher: task ${taskId} crashed: ${errorMessage(error)}`);
    } finally {
      this.inFlight.delete(taskId);
      releaseLock();
      this.notify();
    }
  }

  private resultFromError(rt: TaskRuntime, error: unknown): DomainResult {
    const empty = { facts: [], evidenceIds: [] };
    if (error instanceof WriteGateClosedError) return { outcome: 'blocked', reasonCode: 'write_gate_closed', reason: error.message, ...empty };
    // Refused by the grant (A4): a clear permission error, not a failure of the task's content.
    if (error instanceof DriverError && error.error.code === 'grant_missing' && !isPlatformLost(error)) {
      return { outcome: 'blocked', reasonCode: 'grant_missing', reason: describeRefusal(error), ...empty };
    }
    if (isPlatformLost(error) || rt.disconnected) {
      return this.dispatchedUnverified(rt)
        ? { outcome: 'needs_reconciliation', reasonCode: 'platform_unknown', reason: errorMessage(error), ...empty }
        : { outcome: 'blocked', reasonCode: 'disconnected', reason: errorMessage(error), ...empty };
    }
    if (error instanceof Error && error.name === 'AbortError') return { outcome: 'blocked', reasonCode: 'cancelled', reason: error.message, ...empty };
    return { outcome: 'failed', reason: errorMessage(error), ...empty };
  }

  private async finish(rt: TaskRuntime, result: DomainResult, failure?: unknown): Promise<void> {
    await this.withTask(rt, async () => {
      let task = await this.load(rt.taskId);
      if (isTerminal(task.state)) { await this.releaseRun(rt, 'cancelled'); return; }
      if (task.state === 'stopping') return; // the cancel domain settles it
      if (rt.disconnected) { await this.parkAfterDisconnect(rt, task); return; }
      const stopArtifact = failure instanceof WriteGateClosedError || result.reasonCode === 'write_gate_closed' || result.reasonCode === 'cancelled';
      if (rt.abort.signal.aborted && stopArtifact) return; // the cancel domain is on its way
      if (rt.reReview) {
        rt.reReview = false;
        await this.releaseRun(rt, 'cancelled');
        task = await this.settle(rt, task, 'blocked', 'approval_invalid', '审批内容已变化，重新准备');
        task = await this.transition(rt, task, 'queued');
        this.mark(rt, '重新准备（内容已变化）');
        this.queue.push(task.taskId);
        this.pump();
        return;
      }
      const stored = new Set((await this.deps.ledger.listFacts(task.taskId)).map((f) => f.factId));
      for (const fact of result.facts) {
        if (stored.has(fact.factId)) continue;
        const { factId: _ignored, ...rest } = fact;
        const saved = await this.deps.ledger.appendFact({ ...rest, taskId: task.taskId });
        await this.deps.outbox.recordFact(saved);
      }
      await this.releaseRun(rt, result.outcome === 'confirmed' || result.outcome === 'no_op' ? 'success' : 'failed');
      const mapping = OUTCOME_TARGET[result.outcome];
      rt.finalOutcome = result.outcome;
      try {
        task = await this.settle(rt, task, mapping.target, result.reasonCode ?? mapping.reason, result.reason, mapping.fallbacks);
      } finally {
        rt.finalOutcome = undefined;
      }
      await this.settleQuota(rt, task.state);
      this.mark(rt, `结果：${result.outcome}${result.reasonCode ? `（${result.reasonCode}）` : ''}`);
      const event: FinishedEvent = { task, runtime: rt, result };
      for (const listener of this.finishedListeners) {
        try { listener(event); } catch (error) { this.deps.log(`finished listener: ${errorMessage(error)}`); }
      }
    });
  }

  /** The platform dropped under a running handler: the run is parked as stopping, never resumed. */
  private async parkAfterDisconnect(rt: TaskRuntime, task: WeChatTask): Promise<void> {
    rt.sessionId = undefined;
    rt.runOpen = false;
    rt.platform = { ...rt.platform, quiescence: 'not_confirmed' };
    if (task.state === 'executing' || task.state === 'verifying') {
      task = await this.transition(rt, task, 'stopping', 'disconnected', '连接中断，等待平台确认静止');
      rt.stopUnconfirmed = true;
      this.deps.gate.quiescenceUnconfirmed = true;
      this.mark(rt, '连接中断');
    } else {
      task = await this.settle(rt, task, 'blocked', 'disconnected', '连接中断', ['failed']);
      this.mark(rt, '连接中断');
    }
    await this.settleQuota(rt, task.state);
    this.deps.gate.pause('disconnected');
    this.notify();
  }

  // ---- platform run ----------------------------------------------------------

  private async acquireRun(rt: TaskRuntime): Promise<HandlerContext['session']> {
    const desktopId = this.deps.connector.desktopId;
    if (!desktopId) throw new Error('微信窗口未绑定');
    const session = await this.deps.driver.openSession(desktopId);
    rt.sessionId = session.sessionId;
    try {
      const run = await this.deps.driver.startRun(session.sessionId);
      rt.runId = run.runId;
      rt.runOpen = true;
      rt.platform = { ...rt.platform, runId: run.runId, quiescence: run.quiescence };
      return { desktopId, sessionId: session.sessionId, runId: run.runId };
    } catch (error) {
      await this.deps.driver.closeSession(session.sessionId).catch(() => undefined);
      rt.sessionId = undefined;
      throw error;
    }
  }

  private async releaseRun(rt: TaskRuntime, outcome: 'success' | 'failed' | 'cancelled'): Promise<void> {
    if (rt.disconnected) { rt.runOpen = false; rt.sessionId = undefined; return; }
    if (rt.runId && rt.runOpen) {
      rt.runOpen = false;
      try {
        const run = await this.deps.driver.finishRun(rt.runId, outcome);
        rt.platform = { ...rt.platform, quiescence: run.quiescence };
      } catch (error) {
        if (!this.observeDriverError(rt, error)) this.deps.log(`run.finish ${rt.runId}: ${errorMessage(error)}`);
      }
    }
    if (rt.sessionId) {
      const sessionId = rt.sessionId;
      rt.sessionId = undefined;
      if (!rt.disconnected) await this.deps.driver.closeSession(sessionId).catch((error: unknown) => { this.observeDriverError(rt, error); });
    }
  }

  private observeDriverError(rt: TaskRuntime, error: unknown): boolean {
    if (!isPlatformLost(error)) return false;
    rt.disconnected = true;
    rt.abort.abort();
    this.deps.connector.observeError(error);
    return true;
  }

  /** From the connector: the control connection is gone. Synchronous flags only. */
  onDisconnected(): void {
    for (const taskId of this.inFlight) {
      const rt = this.runtimes.get(taskId);
      if (!rt) continue;
      rt.disconnected = true;
      rt.abort.abort();
    }
    this.notify();
  }

  /** After a reconnect: look at parked runs once (observation only). Nothing is resumed. */
  async reviewParkedRuns(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      if (!rt.stopUnconfirmed) continue;
      await this.withTask(rt, async () => {
        const task = await this.load(rt.taskId);
        if (task.state !== 'stopping') { rt.stopUnconfirmed = false; return; }
        const run = rt.runId ? await this.deps.driver.showRun(rt.runId).catch((error: unknown) => { this.deps.connector.observeError(error); return undefined; }) : undefined;
        if (run) rt.platform = { ...rt.platform, quiescence: run.quiescence };
        if (run && run.quiescence === 'confirmed') await this.settleStopped(rt, task);
      });
    }
    this.notify();
  }

  // ---- handler context ----------------------------------------------------------

  private makeContext(
    task: WeChatTask, rt: TaskRuntime, handler: Handler, policy: Policy, account: AccountBinding, session: HandlerContext['session'],
    releaseLock: () => void, setRelease: (release: () => void) => void,
  ): HandlerContext {
    const gate: WriteGate = {
      isOpen: () => this.deps.gate.isOpen() && !rt.abort.signal.aborted,
      ensureOpen: () => {
        if (rt.abort.signal.aborted) throw new WriteGateClosedError(rt.disconnected ? 'disconnected' : 'stopping');
        this.deps.gate.ensureOpen();
      },
    };
    const context: HandlerContext = {
      driver: this.guardDriver(rt, gate),
      recognizer: this.deps.recognizer,
      ledger: this.observeLedger(rt),
      policy, account,
      target: targetRefFor(task, account.accountId),
      writeGate: gate,
      session,
      requestApproval: (request) => this.requestApproval(rt, handler, session, releaseLock, setRelease, request),
      newId: () => newId('rq'),
      now: () => this.deps.now(),
      log: (line) => this.deps.log(`[${task.taskId}] ${line}`),
      signal: rt.abort.signal,
    };
    return context;
  }

  /** `act` checks the gate right before dispatch; every call reports connection loss. */
  private guardDriver(rt: TaskRuntime, gate: WriteGate): AgentDesktopDriver {
    const driver = this.deps.driver;
    const observe = (error: unknown) => { this.observeDriverError(rt, error); };
    return new Proxy(driver, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        const fn = value as (...args: unknown[]) => Promise<unknown>;
        if (prop === 'act') {
          return async (...args: unknown[]) => {
            gate.ensureOpen();
            try { return await fn.apply(target, args); } catch (error) { observe(error); throw error; }
          };
        }
        return async (...args: unknown[]) => {
          try { return await fn.apply(target, args); } catch (error) { observe(error); throw error; }
        };
      },
    }) as AgentDesktopDriver;
  }

  /** Mirrors the attempt lifecycle into the runtime so the view can show platform ids. */
  private observeLedger(rt: TaskRuntime): Ledger {
    const ledger = this.deps.ledger;
    const overrides: Partial<Ledger> = {
      appendFact: async (fact) => {
        const saved = await ledger.appendFact(fact);
        await this.deps.outbox.recordFact(saved);
        return saved;
      },
      prepareAttempt: async (input, now) => {
        const attempt = await ledger.prepareAttempt(input, now);
        rt.attempts.set(attempt.attemptId, { state: attempt.state });
        return attempt;
      },
      markDispatching: async (attemptId, dispatch, now) => {
        const attempt = await ledger.markDispatching(attemptId, dispatch, now);
        rt.attempts.set(attemptId, { requestId: dispatch.requestId, state: attempt.state });
        rt.platform = { ...rt.platform, requestId: dispatch.requestId, delivery: 'dispatching' };
        this.mark(rt, '平台派发');
        this.notify();
        return attempt;
      },
      recordReceipt: async (attemptId, receiptId, receipt, now) => {
        const attempt = await ledger.recordReceipt(attemptId, receiptId, receipt, now);
        const entry = rt.attempts.get(attemptId) ?? {};
        rt.attempts.set(attemptId, { ...entry, state: attempt.state });
        const r = receipt as Partial<ActionReceipt>;
        rt.platform = { ...rt.platform, delivery: typeof r.delivery === 'string' ? r.delivery : rt.platform?.delivery, execution: typeof r.execution === 'string' ? r.execution : rt.platform?.execution };
        this.mark(rt, '平台回执');
        this.notify();
        return attempt;
      },
      markVerified: async (attemptId, now) => {
        const attempt = await ledger.markVerified(attemptId, now);
        rt.attempts.set(attemptId, { ...(rt.attempts.get(attemptId) ?? {}), state: attempt.state });
        return attempt;
      },
      markNotSent: async (attemptId, reason, now) => {
        const attempt = await ledger.markNotSent(attemptId, reason, now);
        rt.attempts.set(attemptId, { ...(rt.attempts.get(attemptId) ?? {}), state: attempt.state });
        rt.platform = { ...rt.platform, delivery: 'not_dispatched' };
        this.mark(rt, `未送达（平台证实未收到）：${reason}`);
        this.notify();
        return attempt;
      },
      markUnknown: async (attemptId, reason, now) => {
        const attempt = await ledger.markUnknown(attemptId, reason, now);
        rt.attempts.set(attemptId, { ...(rt.attempts.get(attemptId) ?? {}), state: attempt.state });
        rt.platform = { ...rt.platform, delivery: rt.platform?.delivery ?? 'unknown', execution: 'unknown' };
        this.mark(rt, `结果未知：${reason}`);
        this.notify();
        return attempt;
      },
    };
    return new Proxy(ledger, {
      get: (target, prop) => {
        const override = (overrides as Record<PropertyKey, unknown>)[prop];
        if (override) return override;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as Ledger;
  }

  // ---- approval flow ----------------------------------------------------------

  private async requestApproval(
    rt: TaskRuntime, handler: Handler, session: HandlerContext['session'], releaseLock: () => void, setRelease: (release: () => void) => void, request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    if (rt.abort.signal.aborted) return { kind: 'cancelled' };
    if (!handler.requires.actions.includes(request.allowedAction)) {
      this.deps.log(`[${rt.taskId}] handler asked approval for ${request.allowedAction}, outside its declared actions`);
      return { kind: 'rejected' };
    }
    const pending: PendingApproval = { decision: new Deferred<ApprovalDecision>(), stale: false };
    const entered = await this.withTask(rt, async () => {
      let task = await this.load(rt.taskId);
      if (isTerminal(task.state) || task.state === 'stopping' || rt.abort.signal.aborted) return false;
      rt.target = {
        displayName: request.summary.targetLabel, visibleIdentifier: request.summary.visibleIdentifier, kind: targetKindFor(task.type),
        confidence: request.summary.identityConfidence, evidenceIds: request.summary.evidenceIds,
      };
      task = await this.settle(rt, task, 'waiting_approval', undefined, undefined, [], APPROVAL_VIA);
      if (task.state !== 'waiting_approval') return false;
      rt.approvalRequest = { ...request, taskRevision: task.revision, requestedAt: this.deps.now() };
      rt.approval = undefined;
      rt.pending = pending;
      this.mark(rt, '等待审批');
      return true;
    });
    if (!entered) return { kind: 'cancelled' };

    // Release the platform run and the writer slot while the person decides.
    await this.releaseRun(rt, 'cancelled');
    this.inFlight.delete(rt.taskId);
    releaseLock();
    this.notify();

    const decision = await pending.decision.promise;
    if (decision.kind !== 'approved') return decision;

    const release = await this.lock.acquire();
    setRelease(release);
    this.inFlight.add(rt.taskId);
    const resumed = await this.withTask(rt, async () => {
      const task = await this.load(rt.taskId);
      if (task.state !== 'ready' || rt.abort.signal.aborted) return false;
      if (!this.deps.gate.isOpen()) {
        await this.settle(rt, task, 'blocked', 'write_gate_closed', `写门已关闭（${this.deps.gate.why()}）`);
        return false;
      }
      try {
        Object.assign(session, await this.acquireRun(rt));
      } catch (error) {
        this.observeDriverError(rt, error);
        await this.settle(rt, task, 'blocked', rt.disconnected ? 'disconnected' : 'not_found', `无法重新获取平台会话：${errorMessage(error)}`);
        return false;
      }
      await this.transition(rt, task, 'executing');
      this.mark(rt, '重新获取会话，开始执行');
      return true;
    });
    return resumed ? decision : { kind: 'cancelled' };
  }

  async approve(params: IpcMethods['task.approve']['params']): Promise<BusinessApproval> {
    const rt = this.runtimeFor(params.taskId);
    return this.withTask(rt, async () => {
      let task = await this.load(params.taskId);
      if (task.state !== 'waiting_approval' || !rt.pending || !rt.approvalRequest) {
        throw new IpcFailure({ code: 'invalid_state', message: `任务处于 ${task.state}，没有等待中的审批` });
      }
      if (params.approvalRevision !== task.revision) {
        throw new IpcFailure({ code: 'revision_conflict', message: `任务版本已变化：当前 ${task.revision}`, details: { revision: task.revision } });
      }
      const request = rt.approvalRequest;
      const now = this.deps.now();
      const draftHash = rt.draft ? hashContent(rt.draft.text) : undefined;
      const stale = rt.pending.stale || params.approvedContentHash !== request.contentHash || (draftHash !== undefined && draftHash !== request.contentHash);
      if (stale) {
        const pending = rt.pending;
        rt.pending = undefined;
        rt.reReview = true;
        this.mark(rt, '审批内容与当前内容不一致，重新审批');
        pending.decision.resolve({ kind: 'rejected' });
        this.notify();
        throw blockedFailure('approval_invalid', '审批内容与当前内容不一致，任务将重新准备后再次请求审批');
      }
      if (params.expiresAt <= now) throw blockedFailure('approval_expired', '审批有效期已过');
      const account = await this.deps.ledger.getAccount();
      const policy = await this.deps.ledger.getPolicy();
      const features = await this.deps.features();
      const verdict = this.policyGate.checkStatic(task, this.deps.handlers.get(task.type), account, policy, features);
      if (!verdict.ok) {
        if (verdict.reasonCode === 'account_changed') {
          const pending = rt.pending;
          rt.pending = undefined;
          pending.decision.resolve({ kind: 'rejected' });
          await this.settle(rt, task, 'blocked', 'account_changed', verdict.detail);
          await this.settleQuota(rt, 'blocked');
        }
        throw blockedFailure(verdict.reasonCode, verdict.detail);
      }
      if (!account || request.accountRevision !== account.revision) throw blockedFailure('account_changed', '审批请求绑定的账号版本已失效');
      const approval = await this.deps.ledger.recordApproval({
        taskId: task.taskId, accountRevision: request.accountRevision, targetRevision: request.targetRevision, draftRevision: request.draftRevision,
        contentHash: request.contentHash, allowedAction: request.allowedAction, expiresAt: params.expiresAt, createdAt: now,
      });
      rt.approval = approval;
      task = await this.transition(rt, task, 'ready');
      this.mark(rt, '业务批准');
      const pending = rt.pending;
      rt.pending = undefined;
      pending.decision.resolve({ kind: 'approved', approval });
      this.notify();
      return approval;
    });
  }

  async draft(params: IpcMethods['task.draft']['params']): Promise<WeChatTask> {
    const rt = this.runtimeFor(params.taskId);
    return this.withTask(rt, async () => {
      const task = await this.load(params.taskId);
      if (isTerminal(task.state) || task.state === 'stopping') throw new IpcFailure({ code: 'invalid_state', message: `任务已 ${task.state}，草稿不再接受` });
      if (task.type !== 'reply_draft' && task.type !== 'send_message') throw new IpcFailure({ code: 'invalid_state', message: `${task.type} 没有草稿` });
      const current = rt.draft?.revision ?? 0;
      if (params.expectedDraftRevision !== current) {
        throw new IpcFailure({ code: 'revision_conflict', message: `草稿版本已变化：当前 ${current}`, details: { draftRevision: current } });
      }
      rt.draft = { text: params.text, revision: current + 1, source: 'manual' };
      if (task.state === 'waiting_approval' && rt.pending && rt.approvalRequest && hashContent(params.text) !== rt.approvalRequest.contentHash) {
        rt.pending.stale = true;
        this.mark(rt, '草稿已修改，待审批内容失效');
      } else {
        this.mark(rt, '手写草稿');
      }
      this.notify();
      return task;
    });
  }

  // ---- cancel domain ----------------------------------------------------------

  private async cancelIdleLocked(rt: TaskRuntime, task: WeChatTask, reasonCode: DomainReasonCode, detail: string, label: string): Promise<WeChatTask> {
    this.dequeue(task.taskId);
    rt.abort.abort();
    const pending = rt.pending;
    rt.pending = undefined;
    pending?.decision.resolve({ kind: label === 'skipped' ? 'skipped' : 'cancelled' });
    task = await this.settle(rt, task, 'cancelled', reasonCode, detail);
    await this.settleQuota(rt, task.state);
    this.mark(rt, label === 'skipped' ? '跳过' : `取消：${detail}`);
    this.notify();
    return task;
  }

  /** Lock held. Stops the platform run; settles only after quiescence is confirmed. */
  private async cancelDomainLocked(rt: TaskRuntime, task: WeChatTask, detail: string): Promise<WeChatTask> {
    rt.abort.abort();
    if (task.state === 'executing' || task.state === 'verifying') task = await this.transition(rt, task, 'stopping', 'cancelled', detail);
    this.mark(rt, `停止请求：${detail}`);
    this.deps.gate.beginStopping();
    let confirmed = false;
    try {
      if (rt.runId && rt.runOpen && !rt.disconnected) {
        try {
          const receipt = await this.deps.driver.cancelRun(rt.runId);
          rt.runOpen = false;
          rt.platform = { ...rt.platform, quiescence: receipt.execution.quiescence };
          confirmed = receipt.execution.quiescence === 'confirmed';
          if (!confirmed) {
            const run: Run = await this.deps.driver.waitRun(rt.runId, this.deps.config.cancelWaitMs);
            rt.platform = { ...rt.platform, quiescence: run.quiescence };
            confirmed = run.quiescence === 'confirmed';
          }
        } catch (error) {
          this.observeDriverError(rt, error);
          confirmed = false;
        }
      } else {
        confirmed = !rt.disconnected || !rt.runId;
      }
    } finally {
      this.deps.gate.endStopping(confirmed);
    }
    task = await this.load(task.taskId);
    if (confirmed) {
      task = await this.settleStopped(rt, task);
    } else {
      rt.stopUnconfirmed = true;
      this.mark(rt, '停止未确认：等待平台静止');
    }
    this.notify();
    this.pump();
    return task;
  }

  /** Lock held, quiescence confirmed: cancelled when nothing was dispatched, otherwise needs_reconciliation. */
  private async settleStopped(rt: TaskRuntime, task: WeChatTask): Promise<WeChatTask> {
    rt.stopUnconfirmed = false;
    rt.runOpen = false;
    if (!this.stopUnconfirmed) this.deps.gate.confirmQuiescence();
    if (rt.sessionId && !rt.disconnected) {
      const sessionId = rt.sessionId;
      rt.sessionId = undefined;
      await this.deps.driver.closeSession(sessionId).catch(() => undefined);
    }
    if (isTerminal(task.state)) return task;
    const dispatched = this.dispatchedUnverified(rt);
    task = dispatched
      ? await this.settle(rt, task, 'needs_reconciliation', 'platform_unknown', '已派发的动作结果未知', ['cancelled'])
      : await this.settle(rt, task, 'cancelled', 'cancelled', '停止已确认', ['needs_reconciliation']);
    await this.settleQuota(rt, task.state);
    this.mark(rt, '停止确认');
    this.notify();
    return task;
  }

  async cancel(params: IpcMethods['task.cancel']['params']): Promise<WeChatTask> {
    const rt = this.runtimeFor(params.taskId);
    return this.withTask(rt, async () => {
      const task = await this.load(params.taskId);
      if (task.revision !== params.expectedRevision) throw new IpcFailure({ code: 'revision_conflict', message: `任务版本已变化：当前 ${task.revision}`, details: { revision: task.revision } });
      if (isTerminal(task.state)) throw new IpcFailure({ code: 'invalid_state', message: `任务已 ${task.state}` });
      if (task.state === 'stopping') return task;
      if (RUNNING_STATES.includes(task.state) && this.inFlight.has(task.taskId)) return this.cancelDomainLocked(rt, task, '用户取消');
      return this.cancelIdleLocked(rt, task, 'cancelled', '用户取消', 'cancelled');
    });
  }

  async skip(params: IpcMethods['task.skip']['params']): Promise<WeChatTask> {
    const rt = this.runtimeFor(params.taskId);
    return this.withTask(rt, async () => {
      let task = await this.load(params.taskId);
      if (task.revision !== params.expectedRevision) throw new IpcFailure({ code: 'revision_conflict', message: `任务版本已变化：当前 ${task.revision}`, details: { revision: task.revision } });
      if (isTerminal(task.state) || task.state === 'stopping' || (RUNNING_STATES.includes(task.state) && this.inFlight.has(task.taskId))) {
        throw new IpcFailure({ code: 'invalid_state', message: `任务处于 ${task.state}，不能跳过（执行中请用取消）` });
      }
      task = await this.cancelIdleLocked(rt, task, 'cancelled', '用户跳过', 'skipped');
      for (const listener of this.skipListeners) listener(task);
      return task;
    });
  }

  /** app.pause: close the gate, stop whatever runs, wait for quiescence. */
  async pauseAll(): Promise<void> {
    this.deps.gate.pause('paused');
    const running = [...this.inFlight];
    await Promise.all(running.map(async (taskId) => {
      const rt = this.runtimes.get(taskId);
      if (!rt) return;
      await this.withTask(rt, async () => {
        const task = await this.load(taskId);
        if (isTerminal(task.state) || task.state === 'stopping') return;
        if (RUNNING_STATES.includes(task.state)) await this.cancelDomainLocked(rt, task, '用户暂停');
      });
    }));
    this.notify();
  }

  /** app.resume: parked runs are looked at once more, then given up as unknown. Nothing is replayed. */
  async resumeAll(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      if (!rt.stopUnconfirmed) continue;
      await this.withTask(rt, async () => {
        let task = await this.load(rt.taskId);
        if (task.state !== 'stopping') { rt.stopUnconfirmed = false; return; }
        const run = rt.runId ? await this.deps.driver.showRun(rt.runId).catch(() => undefined) : undefined;
        if (run) rt.platform = { ...rt.platform, quiescence: run.quiescence };
        if (run && run.quiescence === 'confirmed') { await this.settleStopped(rt, task); return; }
        rt.stopUnconfirmed = false;
        rt.runOpen = false;
        task = await this.settle(rt, task, 'needs_reconciliation', 'platform_unknown', '恢复时平台未确认静止，旧 Run 不再跟踪');
        await this.settleQuota(rt, task.state);
        this.mark(rt, '恢复：旧 Run 不再跟踪，结果待核实');
      });
    }
    this.deps.gate.resume();
    this.notify();
    this.pump();
  }

  /** account.confirm with a previous binding: every task of the old revision loses its approval. */
  async blockForAccountChange(newRevision: number): Promise<void> {
    const open = (await this.deps.ledger.listTasks({ states: [...OPEN_TASK_STATES], limit: 1000 })).tasks;
    for (const task of open) {
      if (task.accountRevision === newRevision) continue;
      const rt = this.runtimeFor(task.taskId);
      await this.withTask(rt, async () => {
        const current = await this.load(task.taskId);
        if (isTerminal(current.state) || current.state === 'stopping') return;
        if (RUNNING_STATES.includes(current.state) && this.inFlight.has(current.taskId)) { await this.cancelDomainLocked(rt, current, '账号已变化'); return; }
        this.dequeue(current.taskId);
        rt.abort.abort();
        const pending = rt.pending;
        rt.pending = undefined;
        pending?.decision.resolve({ kind: 'rejected' });
        await this.settle(rt, current, 'blocked', 'account_changed', '账号已变化，旧审批失效', ['cancelled']);
        await this.settleQuota(rt, 'blocked');
        this.mark(rt, '账号已变化，旧审批失效');
      });
    }
    this.notify();
  }

  // ---- reconciliation -----------------------------------------------------------

  async reconcile(params: IpcMethods['task.reconcile']['params']): Promise<WeChatTask> {
    const rt = this.runtimeFor(params.taskId);
    return this.withTask(rt, async () => {
      let task = await this.load(params.taskId);
      if (task.revision !== params.expectedRevision) throw new IpcFailure({ code: 'revision_conflict', message: `任务版本已变化：当前 ${task.revision}`, details: { revision: task.revision } });
      if (!this.deps.connector.ready) throw new IpcFailure({ code: 'unavailable', message: '平台不可达，无法核实' });
      const { driver, ledger, now } = this.deps;
      const records: Record<string, unknown>[] = [];
      for (const stored of await ledger.listAttempts(task.taskId)) rt.attempts.set(stored.attemptId, { requestId: stored.requestId, state: stored.state });
      if (!rt.runId) rt.runId = (await ledger.listAttempts(task.taskId)).map((a) => a.runId).filter((id): id is Id => id !== undefined).at(-1);
      for (const [attemptId, attempt] of rt.attempts) {
        if (!attempt.requestId) continue;
        let record: RequestRecord | undefined;
        let error: string | undefined;
        try { record = await driver.showRequest(attempt.requestId); } catch (e) { error = e instanceof DriverError ? e.error.code : errorMessage(e); }
        records.push({ attemptId, requestId: attempt.requestId, state: record?.state ?? 'not_found', error, outcome: record?.outcome });
        if (record) rt.platform = { ...rt.platform, requestId: attempt.requestId, delivery: record.state === 'completed' ? 'dispatched' : record.state };
      }
      const run = rt.runId ? await driver.showRun(rt.runId).catch(() => undefined) : undefined;
      if (run) rt.platform = { ...rt.platform, quiescence: run.quiescence };
      await ledger.appendFact({
        taskId: task.taskId, factKind: 'reconciliation', outcome: 'observed', evidenceIds: [], observedAt: now(), confidence: records.some((r) => r.state !== 'not_found') ? 1 : 0,
        reason: 'request.show / run.show 核实', data: { requests: records, run: run ? { phase: run.phase, outcome: run.outcome, quiescence: run.quiescence } : null },
      });
      this.mark(rt, '核实平台记录');
      if (task.state === 'stopping' && run?.quiescence === 'confirmed') task = await this.settleStopped(rt, task);
      this.notify();
      return task;
    });
  }

  async concludeManually(params: IpcMethods['task.concludeManually']['params']): Promise<WeChatTask> {
    const rt = this.runtimeFor(params.taskId);
    return this.withTask(rt, async () => {
      let task = await this.load(params.taskId);
      if (task.revision !== params.expectedRevision) throw new IpcFailure({ code: 'revision_conflict', message: `任务版本已变化：当前 ${task.revision}`, details: { revision: task.revision } });
      if (task.state !== 'needs_reconciliation' && task.state !== 'waiting_user' && task.state !== 'stopping') {
        throw new IpcFailure({ code: 'invalid_state', message: `任务处于 ${task.state}，不需要人工结论` });
      }
      await this.deps.ledger.appendFact({
        taskId: task.taskId, factKind: 'manual_conclusion', outcome: 'observed', evidenceIds: params.evidenceIds, observedAt: this.deps.now(), confidence: 1, reason: params.conclusion,
      });
      if (task.state === 'waiting_user' || task.state === 'stopping') {
        rt.stopUnconfirmed = false;
        task = await this.settle(rt, task, 'needs_reconciliation', 'platform_unknown', params.conclusion);
        await this.settleQuota(rt, task.state);
      }
      this.mark(rt, `人工结论：${params.conclusion}`);
      this.notify();
      return task;
    });
  }

  // ---- projection --------------------------------------------------------------

  async view(task: WeChatTask) {
    const rt = this.runtimes.get(task.taskId);
    const facts = await this.deps.ledger.listFacts(task.taskId);
    if (rt?.approval) {
      // The handler consumes the approval in the ledger; the copy taken at task.approve does not learn of it by itself.
      const stored = await this.deps.ledger.getApproval(rt.approval.approvalId);
      if (stored) rt.approval = stored;
    }
    let platform = rt?.platform;
    if (!platform?.requestId) {
      // Attempts outlive this process: the ledger says which requestId a task dispatched.
      const attempts = await this.deps.ledger.listAttempts(task.taskId);
      const last = attempts.filter((a) => a.requestId !== undefined).at(-1);
      if (last) {
        const delivery = last.state === 'not_sent' ? 'not_dispatched' : last.state === 'unknown' ? 'unknown' : last.state === 'dispatching' ? 'dispatching' : 'dispatched';
        platform = { ...platform, runId: platform?.runId ?? last.runId, requestId: last.requestId, delivery: platform?.delivery ?? delivery };
      }
    }
    return projectTask(task, rt ? { ...rt, platform } : rt, facts, platform);
  }

  /** Aborts in-flight handlers on app stop; the platform runs are left to recovery. */
  abortAll(): void {
    for (const rt of this.runtimes.values()) rt.abort.abort();
    this.queue = [];
    this.notify();
  }
}
