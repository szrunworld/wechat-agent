// Lane H's minimal application core. It has the same shape as lane E's
// `createApplication(deps): Application` and speaks only the typed IPC of
// packages/ports/src/ipc.ts, so the slice tests drive it exactly as they
// will drive the real one. It implements just enough of 方案 §08:
// intake by operationId, a serial dispatcher, approval wait, write gate,
// pause/stop with quiescence, recovery by request.show, reconcile without
// re-dispatch, and a snapshot projection. No lock file, no patrol, no UI.
import { createHash, randomUUID } from 'node:crypto';
import {
  canTransition, DriverError, IpcFailure, LedgerConflictError, LedgerUnavailableError, TERMINAL_TASK_STATES, WriteGateClosedError,
} from '@wechat-agent/ports';
import type {
  AccountBinding, AgentDesktopDriver, ApplicationService, ApprovalDecision, ApprovalRequest, AppSnapshot, BusinessApproval, ConnectionState,
  DomainReasonCode, DomainResult, EventStream, FeatureKey, FeatureState, HandlerRegistry, Id, InputGateState, IpcMethod, IpcMethods, Ledger,
  QuotaReservation, Recognizer, Revision, SetupStep, TaskState, TaskView, Timestamp, WeChatTask,
} from '@wechat-agent/ports';

export interface StubApplicationDeps {
  driver: AgentDesktopDriver;
  ledger: Ledger;
  recognizer: Recognizer;
  handlers: HandlerRegistry;
  now?: () => Timestamp;
  /** How long app.pause waits for quiescence. */
  quiescenceTimeoutMs?: number;
}

/** Same shape as lane E's Application. */
export interface Application {
  service: ApplicationService;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const stable = (v: unknown): string => JSON.stringify(v, Object.keys(v as object).sort());

interface Pending { request: ApprovalRequest; resolve: (d: ApprovalDecision) => void }

interface TaskExtras {
  timeline: { at: Timestamp; label: string }[];
  runId?: Id;
  requestId?: Id;
  delivery?: string;
  execution?: string;
  quiescence?: string;
  contentHash?: string;
  approval?: BusinessApproval;
  reservation?: QuotaReservation;
}

export function createStubApplication(deps: StubApplicationDeps): Application {
  return new StubApp(deps);
}

class StubApp implements Application {
  readonly service: ApplicationService;
  private readonly driver: AgentDesktopDriver;
  private readonly ledger: Ledger;
  private readonly recognizer: Recognizer;
  private readonly handlers: HandlerRegistry;
  private readonly now: () => Timestamp;
  private readonly quiescenceTimeoutMs: number;

  private connection: ConnectionState = 'disconnected';
  private principal?: { clientId: string; role: string };
  private apiVersion?: string;
  private methods: string[] = [];
  private desktopId?: Id;
  private account?: AccountBinding;

  private gateOpen = false;
  private gateWhy: WriteGateClosedError['why'] = 'disconnected';
  private paused = false;
  private stopping = false;
  private quiescenceUnconfirmed = false;
  private ledgerBroken = false;

  private activeRun?: { sessionId: Id; runId: Id; taskId: Id };
  /** Runs this app started on previous connections; they are never resumed. */
  readonly staleRuns: Id[] = [];
  /** Stale runs whose quiescence the platform has not yet confirmed to us. */
  private readonly unsettled = new Map<Id, Id>();
  private readonly pending = new Map<Id, Pending>();
  private readonly controllers = new Map<Id, AbortController>();
  private readonly extras = new Map<Id, TaskExtras>();
  private queue: Promise<void> = Promise.resolve();
  readonly errors: unknown[] = [];
  private events?: EventStream;
  private eventCursor = 0;
  private readonly listeners = new Set<(s: AppSnapshot) => void>();
  private revision = 0;

  constructor(deps: StubApplicationDeps) {
    this.driver = deps.driver;
    this.ledger = deps.ledger;
    this.recognizer = deps.recognizer;
    this.handlers = deps.handlers;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.quiescenceTimeoutMs = deps.quiescenceTimeoutMs ?? 2000;
    this.service = {
      call: (method, params) => this.call(method, params),
      subscribe: (listener) => { this.listeners.add(listener); void this.snapshot().then(listener); return () => { this.listeners.delete(listener); }; },
    };
  }

  // ---- lifecycle -------------------------------------------------------

  async start(): Promise<void> {
    this.account = await this.ledger.getAccount();
    await this.connect();
    await this.recover();
    this.refreshGate();
  }

  async stop(): Promise<void> {
    this.closeGate('stopping');
    for (const c of this.controllers.values()) c.abort();
    for (const [taskId, p] of this.pending) { p.resolve({ kind: 'cancelled' }); this.pending.delete(taskId); }
    await this.queue.catch(() => undefined);
    await this.events?.close();
    if (this.driver.state === 'connected') await this.driver.close();
  }

  private async connect(): Promise<void> {
    try {
      const hs = await this.driver.connect();
      this.principal = hs.principal ? { clientId: hs.principal.clientId, role: hs.principal.role } : undefined;
      this.apiVersion = hs.identity.apiVersion;
      const caps = await this.driver.capabilities();
      this.methods = caps.interface.methods.map((m) => m.method);
      const desktops = await this.driver.listDesktops();
      this.desktopId = desktops[0]?.desktopId;
      this.connection = this.principal?.role === 'paired' ? 'ready' : 'unpaired';
      await this.subscribeEvents(this.eventCursor || undefined);
    } catch (e) {
      this.connection = e instanceof DriverError && e.error.code === 'version_mismatch' ? 'incompatible' : 'disconnected';
      this.closeGate('disconnected');
    }
  }

  /** Events ride their own connection; a lost cursor means re-sync through run.show/list, never a GUI redo (T37). */
  private async subscribeEvents(after?: number): Promise<void> {
    try {
      this.events = await this.driver.subscribe(after !== undefined ? { after } : undefined);
    } catch (e) {
      if (e instanceof DriverError && e.error.code === 'events_cursor_expired') {
        const runs = await this.driver.listRuns();
        for (const run of runs) if (this.staleRuns.includes(run.runId) || this.activeRun?.runId === run.runId) await this.driver.showRun(run.runId);
        this.eventCursor = 0;
        this.events = await this.driver.subscribe();
        return;
      }
      throw e;
    }
  }

  /** Attempts left open by a crash are settled by request.show; nothing is re-dispatched, and not_found is not "not sent". */
  private async recover(): Promise<void> {
    const open = await this.ledger.findOpenAttempts();
    const settled = new Set<Id>();
    for (const attempt of open) {
      const task = await this.ledger.getTask(attempt.taskId);
      if (!task) continue;
      let platformState: string | null = null;
      let code: string | null = null;
      try {
        if (!attempt.requestId) throw new Error('no requestId');
        platformState = (await this.driver.showRequest(attempt.requestId)).state;
      } catch (e) {
        code = e instanceof DriverError ? e.error.code : 'unavailable';
      }
      await this.ledger.markUnknown(attempt.attemptId, code ? `recovery:${code}` : `recovery:${platformState}`, this.now());
      await this.ledger.appendFact({
        taskId: task.taskId, factKind: 'reconciliation', outcome: 'needs_reconciliation', evidenceIds: [], observedAt: this.now(), confidence: 1,
        reason: code ? `platform_unknown:${code}` : `platform:${platformState}`,
        data: { attemptId: attempt.attemptId, requestId: attempt.requestId ?? null, platformState, code, notSentProven: false },
      });
      this.extra(task.taskId).requestId = attempt.requestId;
      this.extra(task.taskId).runId = attempt.runId;
      this.note(task.taskId, `recovered by request.show: ${code ?? platformState}`);
      if (canTransition(task.state, 'needs_reconciliation')) await this.ledger.transitionTask(task.taskId, 'needs_reconciliation', task.revision, this.now(), 'recovery');
      settled.add(task.taskId);
    }
    // Tasks interrupted before any requestId was persisted were never sent: they fail and may be planned again.
    const { tasks } = await this.ledger.listTasks({ states: ['preparing', 'ready', 'executing', 'verifying', 'stopping'] });
    for (const task of tasks) {
      if (settled.has(task.taskId)) continue;
      const to: TaskState = canTransition(task.state, 'failed') ? 'failed' : 'cancelled';
      await this.ledger.transitionTask(task.taskId, to, task.revision, this.now(), 'app restarted before dispatch');
      this.note(task.taskId, 'restarted before dispatch: not sent, plan again');
    }
  }

  // ---- gates -----------------------------------------------------------

  private closeGate(why: WriteGateClosedError['why']): void {
    this.gateOpen = false;
    this.gateWhy = why;
  }

  private refreshGate(): void {
    if (this.paused) return this.closeGate('paused');
    if (this.stopping) return this.closeGate('stopping');
    if (this.ledgerBroken) return this.closeGate('policy');
    if (this.connection !== 'ready' || this.driver.state !== 'connected') return this.closeGate('disconnected');
    if (!this.account || this.account.status !== 'confirmed') return this.closeGate('account_changed');
    this.gateOpen = true;
  }

  private get inputGate(): InputGateState {
    if (this.stopping) return 'stopping';
    if (this.quiescenceUnconfirmed) return 'quiescence_unconfirmed';
    return this.gateOpen ? 'open' : 'closed';
  }

  private noteDisconnected(): void {
    if (this.driver.state === 'connected') return;
    this.connection = 'disconnected';
    if (this.activeRun) { this.unsettled.set(this.activeRun.runId, this.activeRun.taskId); this.quiescenceUnconfirmed = true; }
    this.closeGate('disconnected');
  }

  // ---- IPC -------------------------------------------------------------

  private async call<M extends IpcMethod>(method: M, params: IpcMethods[M]['params']): Promise<IpcMethods[M]['result']> {
    try {
      return (await this.dispatchCall(method, params)) as IpcMethods[M]['result'];
    } catch (e) {
      if (e instanceof IpcFailure) throw e;
      if (e instanceof LedgerUnavailableError) { this.ledgerBroken = true; this.refreshGate(); throw new IpcFailure({ code: 'unavailable', message: e.message }); }
      if (e instanceof LedgerConflictError) throw new IpcFailure({ code: e.kind === 'revision' ? 'revision_conflict' : e.kind === 'operation_fingerprint' ? 'operation_conflict' : 'invalid_state', message: e.message });
      throw new IpcFailure({ code: 'internal', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async dispatchCall(method: IpcMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'app.getSnapshot': return this.snapshot();
      case 'connection.check': return this.connectionCheck();
      case 'account.confirm': return this.accountConfirm(params as IpcMethods['account.confirm']['params']);
      case 'task.create': return this.taskCreate(params as IpcMethods['task.create']['params']);
      case 'task.list': { const { tasks, next } = await this.ledger.listTasks(params as IpcMethods['task.list']['params']); return { tasks: await Promise.all(tasks.map((t) => this.view(t))), next }; }
      case 'task.show': return this.view(await this.mustTask((params as IpcMethods['task.show']['params']).taskId));
      case 'task.approve': return this.taskApprove(params as IpcMethods['task.approve']['params']);
      case 'task.skip': return this.taskStop((params as IpcMethods['task.skip']['params']).taskId, (params as IpcMethods['task.skip']['params']).expectedRevision, 'skipped');
      case 'task.cancel': return this.taskStop((params as IpcMethods['task.cancel']['params']).taskId, (params as IpcMethods['task.cancel']['params']).expectedRevision, 'cancelled');
      case 'app.pause': return this.pause();
      case 'app.resume': return this.resume();
      case 'task.reconcile': return this.reconcile((params as IpcMethods['task.reconcile']['params']).taskId);
      case 'task.concludeManually': return this.concludeManually(params as IpcMethods['task.concludeManually']['params']);
      case 'window.requestHandback':
        if (this.stopping) throw new IpcFailure({ code: 'invalid_state', message: 'stopping: quiescence not confirmed' });
        return { mode: 'manual', instructions: 'platform handback not available (CR03); release the window by hand' };
      default:
        throw new IpcFailure({ code: 'unavailable', message: `stub application does not implement ${method}` });
    }
  }

  private async connectionCheck(): Promise<IpcMethods['connection.check']['result']> {
    if (this.driver.state !== 'connected') {
      // A new connection: old runs are not resumed. Their quiescence is settled by cancelling them, then they are left behind.
      this.activeRun = undefined;
      await this.connect();
      if (this.isConnected()) {
        let allConfirmed = true;
        for (const [runId, taskId] of this.unsettled) {
          try {
            const receipt = await this.driver.cancelRun(runId);
            this.extra(taskId).quiescence = receipt.execution.quiescence;
            if (receipt.execution.quiescence !== 'confirmed') allConfirmed = false;
          } catch (e) {
            if (!(e instanceof DriverError && e.error.code === 'not_found')) allConfirmed = false;
          }
          this.unsettled.delete(runId);
        }
        this.quiescenceUnconfirmed = !allConfirmed;
      }
    } else {
      await this.subscribeEvents(this.eventCursor || undefined);
    }
    this.refreshGate();
    return { state: this.connection, apiVersion: this.apiVersion, methods: this.methods, missingCapabilities: this.missing() };
  }

  private isConnected(): boolean {
    return this.driver.state === 'connected';
  }

  private missing(): string[] {
    const needed = new Set<string>();
    for (const h of this.handlers.all()) for (const m of h.requires.methods) needed.add(m);
    return [...needed].filter((m) => !this.methods.includes(m));
  }

  private async accountConfirm(params: IpcMethods['account.confirm']['params']): Promise<AccountBinding> {
    const binding = await this.ledger.confirmAccount({
      accountId: this.account?.accountId ?? randomUUID(), visibleLabel: `account:${params.bindingEvidenceId}`, evidenceIds: [params.bindingEvidenceId],
      confirmedAt: this.now(), status: 'confirmed',
    }, params.expectedRevision);
    const changed = this.account !== undefined && this.account.revision !== binding.revision;
    this.account = binding;
    if (changed) {
      // A different account: approvals under the old revision stop matching; the write gate closes until a person re-checks.
      this.paused = true;
      this.closeGate('account_changed');
      for (const [taskId] of this.pending) this.note(taskId, 'account changed while waiting for approval');
    } else {
      this.refreshGate();
    }
    return binding;
  }

  private async taskCreate(params: IpcMethods['task.create']['params']): Promise<TaskView> {
    if (!this.account || this.account.revision !== params.expectedAccountRevision) throw new IpcFailure({ code: 'revision_conflict', message: 'account revision differs' });
    const payloadHash = sha(stable(params.payload));
    const fingerprint = sha(`${params.type}|${params.targetId ?? ''}|${payloadHash}`);
    const { task, created } = await this.ledger.intake({
      operationId: params.operationId, fingerprint, type: params.type, accountRevision: this.account.revision, targetId: params.targetId,
      targetRevision: params.targetId ? 1 : undefined, payload: params.payload, payloadHash,
    }, this.now());
    if (created) {
      this.note(task.taskId, `created by ${params.operationId}`);
      const queued = await this.ledger.transitionTask(task.taskId, 'queued', task.revision, this.now());
      this.enqueue(queued.taskId);
      return this.view(queued);
    }
    this.note(task.taskId, `same operationId again: ${params.operationId}`);
    return this.view(task);
  }

  private async taskApprove(params: IpcMethods['task.approve']['params']): Promise<BusinessApproval> {
    const task = await this.mustTask(params.taskId);
    const pending = this.pending.get(task.taskId);
    if (task.state !== 'waiting_approval' || !pending) throw new IpcFailure({ code: 'invalid_state', message: `task is ${task.state}, not waiting for approval` });
    if (params.approvalRevision !== task.revision) throw new IpcFailure({ code: 'revision_conflict', message: `task is at revision ${task.revision}` });
    if (params.approvedContentHash !== pending.request.contentHash) throw new IpcFailure({ code: 'invalid_state', message: 'approved content differs from what was shown' });
    const approval = await this.ledger.recordApproval({
      taskId: task.taskId, accountRevision: pending.request.accountRevision, targetRevision: pending.request.targetRevision, draftRevision: pending.request.draftRevision,
      contentHash: pending.request.contentHash, allowedAction: pending.request.allowedAction, expiresAt: params.expiresAt, createdAt: this.now(),
    });
    this.extra(task.taskId).approval = approval;
    const ready = await this.ledger.transitionTask(task.taskId, 'ready', task.revision, this.now(), 'approved');
    await this.ledger.transitionTask(task.taskId, 'executing', ready.revision, this.now());
    this.note(task.taskId, 'approved');
    this.pending.delete(task.taskId);
    pending.resolve({ kind: 'approved', approval });
    return approval;
  }

  private async taskStop(taskId: Id, expectedRevision: Revision, how: 'skipped' | 'cancelled'): Promise<TaskView> {
    const task = await this.mustTask(taskId);
    if (TERMINAL_TASK_STATES.includes(task.state)) throw new IpcFailure({ code: 'invalid_state', message: `task is already ${task.state}` });
    if (task.revision !== expectedRevision) throw new IpcFailure({ code: 'revision_conflict', message: `task is at revision ${task.revision}` });
    this.controllers.get(taskId)?.abort();
    const pending = this.pending.get(taskId);
    if (pending) { this.pending.delete(taskId); pending.resolve({ kind: how }); }
    if (task.state === 'executing' || task.state === 'verifying') {
      const stopping = await this.ledger.transitionTask(taskId, 'stopping', task.revision, this.now(), how);
      this.note(taskId, 'stopping: waiting for quiescence');
      await this.settleRun(taskId);
      return this.view(await this.finishStopping(stopping));
    }
    this.note(taskId, how);
    return this.view(await this.ledger.transitionTask(taskId, 'cancelled', task.revision, this.now(), how));
  }

  /** Cancel the active run and wait for quiescence; `stopping` stays until the platform confirms it. */
  private async settleRun(taskId: Id): Promise<void> {
    const run = this.activeRun;
    if (!run || run.taskId !== taskId) return;
    if (this.driver.state !== 'connected') { this.quiescenceUnconfirmed = true; return; }
    try {
      const receipt = await this.driver.cancelRun(run.runId);
      this.extra(taskId).quiescence = receipt.execution.quiescence;
      const waited = await this.driver.waitRun(run.runId, this.quiescenceTimeoutMs);
      this.extra(taskId).quiescence = waited.quiescence;
      this.stopping = waited.quiescence !== 'confirmed';
    } catch (e) {
      if (e instanceof DriverError && (e.error.code === 'wait_timeout' || e.error.code === 'deadline_exceeded')) { this.stopping = true; return; }
      if (e instanceof DriverError && e.error.code === 'not_found') { this.stopping = false; return; }
      this.quiescenceUnconfirmed = true;
      this.noteDisconnected();
    }
  }

  private async finishStopping(task: WeChatTask): Promise<WeChatTask> {
    if (task.state !== 'stopping') return task;
    if (this.stopping || this.quiescenceUnconfirmed) return task;
    const open = (await this.ledger.findOpenAttempts()).some((a) => a.taskId === task.taskId);
    const facts = await this.ledger.listFacts(task.taskId);
    const unknown = facts.some((f) => f.outcome === 'needs_reconciliation');
    return this.ledger.transitionTask(task.taskId, open || unknown ? 'needs_reconciliation' : 'cancelled', task.revision, this.now(), 'quiescence confirmed');
  }

  private async pause(): Promise<{ inputGate: InputGateState }> {
    this.paused = true;
    this.closeGate('paused');
    const run = this.activeRun;
    if (run) {
      this.controllers.get(run.taskId)?.abort();
      const task = await this.ledger.getTask(run.taskId);
      if (task && (task.state === 'executing' || task.state === 'verifying')) {
        await this.ledger.transitionTask(task.taskId, 'stopping', task.revision, this.now(), 'paused');
        this.note(task.taskId, 'paused while executing: stopping');
      }
      await this.settleRun(run.taskId);
      const after = await this.ledger.getTask(run.taskId);
      if (after) await this.finishStopping(after);
    }
    return { inputGate: this.inputGate };
  }

  private async resume(): Promise<{ inputGate: InputGateState }> {
    if (this.stopping || this.quiescenceUnconfirmed) throw new IpcFailure({ code: 'invalid_state', message: `cannot resume while ${this.inputGate}` });
    this.paused = false;
    this.refreshGate();
    // Nothing is replayed: unknown attempts stay unknown, held quota stays held.
    return { inputGate: this.inputGate };
  }

  private async reconcile(taskId: Id): Promise<TaskView> {
    const task = await this.mustTask(taskId);
    if (this.driver.state !== 'connected') throw new IpcFailure({ code: 'unavailable', message: 'platform offline: reconcile later' });
    const facts = await this.ledger.listFacts(taskId);
    const requestIds = [...new Set(facts.map((f) => f.data?.requestId).filter((r): r is string => typeof r === 'string'))];
    for (const requestId of requestIds) {
      let state: string | null = null;
      let code: string | null = null;
      try { state = (await this.driver.showRequest(requestId)).state; } catch (e) { code = e instanceof DriverError ? e.error.code : 'unavailable'; }
      await this.ledger.appendFact({
        taskId, factKind: 'reconciliation', outcome: code || state === 'unknown' ? 'needs_reconciliation' : 'observed', evidenceIds: [], observedAt: this.now(), confidence: 1,
        reason: code ? `platform_unknown:${code}` : `platform:${state}`, data: { requestId, platformState: state, code, notSentProven: false },
      });
      this.note(taskId, `reconcile ${requestId}: ${code ?? state}`);
    }
    return this.view(task);
  }

  private async concludeManually(params: IpcMethods['task.concludeManually']['params']): Promise<TaskView> {
    const task = await this.mustTask(params.taskId);
    if (task.revision !== params.expectedRevision) throw new IpcFailure({ code: 'revision_conflict', message: `task is at revision ${task.revision}` });
    await this.ledger.appendFact({ taskId: task.taskId, factKind: 'manual_conclusion', outcome: 'observed', evidenceIds: params.evidenceIds, observedAt: this.now(), confidence: 1, reason: params.conclusion });
    return this.view(task);
  }

  // ---- dispatcher ------------------------------------------------------

  private enqueue(taskId: Id): void {
    this.queue = this.queue.then(() => this.runTask(taskId)).catch((e) => { this.errors.push(e); });
  }

  private async block(task: WeChatTask, reason: DomainReasonCode): Promise<void> {
    this.note(task.taskId, `blocked: ${reason}`);
    const current = await this.ledger.getTask(task.taskId);
    if (!current || !canTransition(current.state, 'blocked')) return;
    await this.ledger.transitionTask(current.taskId, 'blocked', current.revision, this.now(), reason);
    this.setReason(task.taskId, reason);
  }

  private async runTask(taskId: Id): Promise<void> {
    let task = await this.ledger.getTask(taskId);
    if (!task || task.state !== 'queued') return;
    const handler = this.handlers.get(task.type);
    task = await this.ledger.transitionTask(taskId, 'preparing', task.revision, this.now());
    if (!handler) return this.block(task, 'capability_missing');
    if (this.ledgerBroken) return this.block(task, 'policy_disabled');
    if (this.stopping) return this.block(task, 'write_gate_closed');
    if (this.driver.state !== 'connected') return this.block(task, 'disconnected');
    const outbound = handler.requires.actions.some((a) => a !== 'read' && a !== 'navigate');
    const policy = await this.ledger.getPolicy();
    let reservation: QuotaReservation | undefined;
    if (outbound) {
      if (this.principal?.role !== 'paired') return this.block(task, 'pairing_missing');
      if (handler.requires.methods.some((m) => !this.methods.includes(m))) return this.block(task, 'capability_missing');
      if (!this.gateOpen) return this.block(task, this.gateWhy === 'account_changed' ? 'account_changed' : 'write_gate_closed');
      if (handler.requires.actions.some((a) => !policy.allowedActions.includes(a))) return this.block(task, 'policy_disabled');
      const quota = await this.ledger.reserveQuota({ accountId: this.account!.accountId, actionKind: handler.requires.actions[0], intentId: task.fingerprint }, policy, this.now());
      if (!quota.ok) return this.block(task, quota.reason === 'action_not_allowed' ? 'policy_disabled' : 'rate_limited');
      // A held reservation means an earlier attempt for this intent is unreconciled: never send it again (T40).
      if (quota.reservation.state === 'held' || quota.reservation.state === 'consumed') return this.block(task, 'platform_unknown');
      reservation = quota.reservation;
      this.extra(taskId).reservation = reservation;
    }

    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    let session: { sessionId: Id; runId: Id } | undefined;
    let result: DomainResult;
    try {
      const opened = await this.driver.openSession(this.desktopId ?? 'desk_fake');
      // Delegated run: only the sessionId goes over the wire (ADR-05, T36).
      const run = await this.driver.startRun(opened.sessionId);
      session = { sessionId: opened.sessionId, runId: run.runId };
      this.activeRun = { ...session, taskId };
      this.extra(taskId).runId = run.runId;
      result = await handler.run(task, {
        driver: this.driver, recognizer: this.recognizer, ledger: this.ledger, policy, account: this.account!,
        // A task that was stopped stays stopped: a later resume never reopens the gate for its in-flight handler.
        writeGate: {
          isOpen: () => this.gateOpen && !controller.signal.aborted,
          ensureOpen: () => {
            if (controller.signal.aborted) throw new WriteGateClosedError('stopping');
            if (!this.gateOpen) throw new WriteGateClosedError(this.gateWhy);
          },
        },
        session: { desktopId: this.desktopId ?? 'desk_fake', ...session },
        requestApproval: (request) => this.awaitApproval(taskId, request),
        newId: () => randomUUID(),
        now: this.now,
        log: (line) => this.note(taskId, line),
        signal: controller.signal,
      });
    } catch (e) {
      result = this.resultFromError(e);
      if (e instanceof LedgerUnavailableError) {
        // The ledger refused a write: stop all outbound work; the task cannot even be marked, which is the point.
        this.ledgerBroken = true;
        this.closeGate('policy');
        await this.releaseRun(session, 'failed');
        this.controllers.delete(taskId);
        this.errors.push(e);
        return;
      }
    }
    this.controllers.delete(taskId);
    this.noteDisconnected();
    await this.releaseRun(session, result.outcome === 'confirmed' ? 'success' : result.outcome === 'failed' && result.reasonCode === 'cancelled' ? 'cancelled' : 'failed');
    await this.finalize(taskId, result, reservation);
  }

  private resultFromError(e: unknown): DomainResult {
    if (e instanceof WriteGateClosedError) return { outcome: 'blocked', reasonCode: 'write_gate_closed', reason: e.why, facts: [], evidenceIds: [] };
    if (e instanceof DriverError) return { outcome: 'blocked', reasonCode: ['connection_lost', 'runtime_offline'].includes(e.error.code) ? 'disconnected' : 'platform_unknown', reason: e.error.code, facts: [], evidenceIds: [] };
    if (e instanceof LedgerUnavailableError) return { outcome: 'blocked', reasonCode: 'policy_disabled', reason: e.message, facts: [], evidenceIds: [] };
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e), facts: [], evidenceIds: [] };
  }

  private async releaseRun(session: { sessionId: Id; runId: Id } | undefined, outcome: 'success' | 'failed' | 'cancelled'): Promise<void> {
    if (!session) return;
    if (this.activeRun?.runId === session.runId) this.activeRun = undefined;
    if (this.driver.state !== 'connected') { this.staleRuns.push(session.runId); return; }
    this.unsettled.delete(session.runId);
    try {
      const run = await this.driver.showRun(session.runId);
      if (run.phase !== 'ended') await this.driver.finishRun(session.runId, outcome);
      await this.driver.closeSession(session.sessionId);
    } catch (e) {
      this.errors.push(e);
    }
  }

  private async awaitApproval(taskId: Id, request: ApprovalRequest): Promise<ApprovalDecision> {
    const task = await this.mustTask(taskId);
    if (task.state !== 'preparing') return { kind: 'cancelled' };
    await this.ledger.transitionTask(taskId, 'waiting_approval', task.revision, this.now());
    this.extra(taskId).contentHash = request.contentHash;
    this.note(taskId, `waiting for approval: ${request.summary.targetLabel}`);
    return new Promise<ApprovalDecision>((resolve) => { this.pending.set(taskId, { request, resolve }); });
  }

  private async finalize(taskId: Id, result: DomainResult, reservation?: QuotaReservation): Promise<void> {
    const current = await this.ledger.getTask(taskId);
    if (!current) return;
    for (const fact of result.facts) {
      const requestId = fact.data?.requestId;
      if (typeof requestId === 'string') this.extra(taskId).requestId = requestId;
      if (typeof fact.data?.delivery === 'string') this.extra(taskId).delivery = fact.data.delivery;
      if (typeof fact.data?.execution === 'string') this.extra(taskId).execution = fact.data.execution;
    }
    if (result.reasonCode) this.setReason(taskId, result.reasonCode);
    this.note(taskId, `handler: ${result.outcome}${result.reasonCode ? ` (${result.reasonCode})` : ''}`);
    if (reservation) {
      if (result.outcome === 'confirmed') await this.ledger.consumeQuota(reservation.reservationId);
      else if (result.outcome === 'needs_reconciliation' || result.outcome === 'sent_unconfirmed') await this.ledger.holdQuota(reservation.reservationId);
      else await this.ledger.releaseQuota(reservation.reservationId);
    }
    if (TERMINAL_TASK_STATES.includes(current.state)) return;
    const target = this.targetState(current.state, result);
    if (!target) return;
    let task = current;
    for (const step of target) {
      if (!canTransition(task.state, step)) break;
      task = await this.ledger.transitionTask(taskId, step, task.revision, this.now(), result.reasonCode ?? result.outcome);
    }
    if (TERMINAL_TASK_STATES.includes(task.state)) {
      await this.ledger.enqueueOutbox({ taskId, revision: task.revision, payloadHash: sha(stable({ outcome: result.outcome })), payload: { outcome: result.outcome, reasonCode: result.reasonCode ?? null } });
    }
    this.emit();
  }

  /** Which states to walk from the current one for a handler result; null leaves it alone. */
  private targetState(from: TaskState, result: DomainResult): TaskState[] | null {
    if (from === 'stopping') {
      if (this.stopping || this.quiescenceUnconfirmed) return null;
      return [result.outcome === 'confirmed' ? 'confirmed' : result.outcome === 'needs_reconciliation' || result.outcome === 'sent_unconfirmed' ? 'needs_reconciliation' : 'cancelled'];
    }
    switch (result.outcome) {
      case 'confirmed': return from === 'executing' ? ['verifying', 'confirmed'] : ['ready', 'executing', 'verifying', 'confirmed'];
      case 'no_op': return from === 'executing' ? ['verifying', 'no_op'] : ['no_op'];
      case 'failed': return from === 'executing' ? ['failed'] : ['failed'];
      case 'ambiguous': return ['failed'];
      case 'needs_reconciliation':
      case 'sent_unconfirmed': return ['needs_reconciliation'];
      case 'waiting_user': return ['waiting_user'];
      case 'blocked':
        if (from === 'preparing' || from === 'waiting_approval' || from === 'ready') return ['blocked'];
        // After approval a verify-before-write failure needs a person: waiting_user, not a silent retry.
        return ['waiting_user'];
    }
  }

  // ---- projection ------------------------------------------------------

  private async mustTask(taskId: Id): Promise<WeChatTask> {
    const task = await this.ledger.getTask(taskId);
    if (!task) throw new IpcFailure({ code: 'not_found', message: `no task ${taskId}` });
    return task;
  }

  private extra(taskId: Id): TaskExtras {
    let e = this.extras.get(taskId);
    if (!e) { e = { timeline: [] }; this.extras.set(taskId, e); }
    return e;
  }

  private readonly reasons = new Map<Id, DomainReasonCode>();
  private setReason(taskId: Id, reason: DomainReasonCode): void { this.reasons.set(taskId, reason); }

  private note(taskId: Id, label: string): void {
    this.extra(taskId).timeline.push({ at: this.now(), label });
  }

  private async view(task: WeChatTask): Promise<TaskView> {
    const e = this.extra(task.taskId);
    const pending = this.pending.get(task.taskId);
    return {
      taskId: task.taskId, type: task.type, state: task.state, stateReason: task.stateReason ?? this.reasons.get(task.taskId), revision: task.revision,
      target: pending ? { displayName: pending.request.summary.targetLabel, visibleIdentifier: pending.request.summary.visibleIdentifier, kind: 'friend_request', confidence: pending.request.summary.identityConfidence, evidenceIds: pending.request.summary.evidenceIds } : undefined,
      approval: pending
        ? { approvalId: 'pending', contentHash: pending.request.contentHash, expiresAt: '', consumed: false }
        : e.approval ? { approvalId: e.approval.approvalId, contentHash: e.approval.contentHash, expiresAt: e.approval.expiresAt, consumed: e.approval.consumedAt !== undefined } : undefined,
      platform: e.runId || e.requestId ? { runId: e.runId, requestId: e.requestId, delivery: e.delivery, execution: e.execution, quiescence: e.quiescence } : undefined,
      facts: await this.ledger.listFacts(task.taskId),
      timeline: [...e.timeline],
      createdAt: task.createdAt, updatedAt: task.updatedAt,
    };
  }

  private features(): Record<FeatureKey, FeatureState> {
    const connected = this.driver.state === 'connected';
    const read: FeatureState = connected ? { enabled: true } : { enabled: false, reason: 'platform_offline' };
    const outbound = (): FeatureState => {
      if (!connected) return { enabled: false, reason: 'platform_offline' };
      if (this.principal?.role !== 'paired') return { enabled: false, reason: 'pairing_missing' };
      if (!this.methods.includes('act')) return { enabled: false, reason: 'capability_missing', detail: 'act' };
      if (!this.account || this.account.status !== 'confirmed') return { enabled: false, reason: 'account_unconfirmed' };
      if (!this.gateOpen) return { enabled: false, reason: 'input_gate_closed', detail: this.gateWhy };
      return { enabled: true };
    };
    return { read_list: read, accept_request: outbound(), add_friend: outbound(), reply_draft: read, send_message: outbound(), handback: { enabled: false, reason: 'capability_missing', detail: 'CR03' } };
  }

  private async snapshot(): Promise<AppSnapshot> {
    const { tasks } = await this.ledger.listTasks({ limit: 200 });
    const views = await Promise.all(tasks.map((t) => this.view(t)));
    const policy = await this.ledger.getPolicy();
    this.revision += 1;
    const stepState = (done: boolean): SetupStep['state'] => (done ? 'done' : 'pending');
    return {
      revision: this.revision,
      connection: {
        state: this.connection, endpoint: 'fake', product: this.connection === 'disconnected' ? undefined : 'AgentDesktop', apiVersion: this.apiVersion, principal: this.principal,
        missingCapabilities: this.missing(),
        steps: [
          { key: 'discover', state: stepState(this.connection !== 'disconnected') },
          { key: 'contract', state: this.connection === 'incompatible' ? 'failed' : stepState(this.connection !== 'disconnected') },
          { key: 'pairing', state: this.connection === 'unpaired' ? 'blocked' : stepState(this.connection === 'ready') },
          { key: 'window', state: stepState(this.desktopId !== undefined) },
          { key: 'account', state: stepState(this.account?.status === 'confirmed') },
          { key: 'baseline', state: 'pending' },
        ],
      },
      account: this.account ?? null,
      inputGate: this.inputGate,
      patrol: { enabled: false, intervalSeconds: policy.patrolIntervalSeconds },
      counts: {
        waitingApproval: views.filter((v) => v.state === 'waiting_approval').length,
        needsReconciliation: views.filter((v) => v.state === 'needs_reconciliation').length,
        confirmed: views.filter((v) => v.state === 'confirmed').length,
      },
      activeTask: this.activeRun ? views.find((v) => v.taskId === this.activeRun!.taskId) : undefined,
      tasks: views,
      features: this.features(),
      policy: { allowlistCount: policy.allowlist.length, approvalPerAction: true, modelUpload: policy.modelUpload, patrolIntervalSeconds: policy.patrolIntervalSeconds, approvalTtlSeconds: 600, evidenceRetentionDays: 1 },
    };
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    void this.snapshot().then((s) => { for (const l of this.listeners) l(s); });
  }
}
