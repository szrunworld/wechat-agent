// The application (方案 E02 + E03): wires connector, gate, dispatcher,
// patrol and recovery; owns the account and baseline setup steps; projects
// the AppSnapshot and serves the typed IPC.
import { DriverError, IpcFailure, LedgerConflictError, LedgerUnavailableError, WriteGateClosedError } from '@wechat-agent/ports';
import type {
  AccountBinding, AgentDesktopDriver, ApplicationService, AppSnapshot, HandlerRegistry, Id, IpcMethod, IpcMethods, Ledger, Recognizer, TaskView, Timestamp,
} from '@wechat-agent/ports';
import { resolveConfig, type AppConfig } from './config.ts';
import { RuntimeConnector } from './connector.ts';
import { exportDiagnostics } from './diagnostics.ts';
import { Dispatcher } from './dispatcher.ts';
import { computeFeatures, type FeatureMap } from './features.ts';
import { InputGate } from './gate.ts';
import { SingleInstanceLock } from './lock.ts';
import { Patrol } from './patrol.ts';
import { recoverOpenAttempts } from './recovery.ts';
import { errorMessage, newId, realScheduler, sha256, type Scheduler } from './support.ts';
import { RUNNING_STATES } from './tasks.ts';

export interface ApplicationDeps {
  driver: AgentDesktopDriver;
  ledger: Ledger;
  recognizer: Recognizer;
  handlers: HandlerRegistry;
  /** Either form; defaults to the wall clock in ISO 8601. */
  now?: () => Timestamp;
  clock?: { now(): Timestamp };
  config?: Partial<AppConfig>;
  scheduler?: Scheduler;
  log?: (line: string) => void;
}

export interface ApplicationInternals {
  config: AppConfig;
  connector: RuntimeConnector;
  gate: InputGate;
  dispatcher: Dispatcher;
  patrol: Patrol;
  /** Resolves when no handler runs and nothing startable is queued. */
  idle(): Promise<void>;
  snapshot(): Promise<AppSnapshot>;
  log: string[];
}

export interface Application {
  service: ApplicationService;
  start(): Promise<void>;
  stop(): Promise<void>;
  internals: ApplicationInternals;
}

const ACTIVE_ORDER: readonly string[] = ['executing', 'verifying', 'stopping', 'preparing', 'ready'];

export class WeChatAgentApplication implements Application {
  readonly service: ApplicationService;
  readonly internals: ApplicationInternals;
  private readonly config: AppConfig;
  private readonly connector: RuntimeConnector;
  private readonly gate: InputGate;
  private readonly dispatcher: Dispatcher;
  private readonly patrol: Patrol;
  private readonly scheduler: Scheduler;
  private readonly lock: SingleInstanceLock | undefined;
  private readonly listeners = new Set<(snapshot: AppSnapshot) => void>();
  private readonly logLines: string[] = [];
  private latest: AppSnapshot | undefined;
  private revision = 0;
  private publishing: Promise<void> = Promise.resolve();
  private publishScheduled = false;
  private pendingBindingEvidence: Id | undefined;
  private pendingBindingLabel = '微信';
  private baselineTaskId: Id | undefined;
  private started = false;
  private readonly now: () => Timestamp;

  constructor(private readonly deps: ApplicationDeps) {
    this.config = resolveConfig(deps.config);
    this.scheduler = deps.scheduler ?? realScheduler;
    this.now = deps.now ?? (deps.clock ? () => deps.clock!.now() : () => new Date().toISOString());
    const log = (line: string) => {
      this.logLines.push(`${this.now()} ${line}`);
      if (this.logLines.length > 500) this.logLines.shift();
      deps.log?.(line);
    };
    this.gate = new InputGate(() => this.scheduleSnapshot());
    this.connector = new RuntimeConnector(deps.driver, this.config.reconnect, this.scheduler, {
      onConnected: () => this.onConnected(),
      onDisconnected: (reason) => this.onDisconnected(reason),
      onEvent: () => this.scheduleSnapshot(),
      onChange: () => this.scheduleSnapshot(),
      log,
    });
    this.dispatcher = new Dispatcher({
      driver: deps.driver, ledger: deps.ledger, recognizer: deps.recognizer, handlers: deps.handlers, gate: this.gate, connector: this.connector,
      config: this.config, now: this.now, features: () => this.features(), log, onChange: () => this.scheduleSnapshot(),
    });
    this.patrol = new Patrol({
      ledger: deps.ledger, dispatcher: this.dispatcher, gate: this.gate, connector: this.connector, scheduler: this.scheduler,
      hasReadHandler: () => deps.handlers.get('read_requests') !== undefined, now: this.now, log, onChange: () => this.scheduleSnapshot(),
    });
    this.lock = this.config.lockPath ? new SingleInstanceLock(this.config.lockPath) : undefined;
    this.dispatcher.onFinished((event) => {
      if (event.task.taskId !== this.baselineTaskId) return;
      const ok = event.result.outcome === 'confirmed' || event.result.outcome === 'no_op';
      this.connector.steps.set('baseline', ok ? 'done' : 'failed', ok ? '基线读取完成' : `基线读取：${event.result.outcome}${event.result.reason ? `（${event.result.reason}）` : ''}`);
      this.scheduleSnapshot();
    });
    this.service = {
      call: (method, params) => this.call(method, params),
      subscribe: (listener) => this.subscribe(listener),
    };
    this.internals = {
      config: this.config, connector: this.connector, gate: this.gate, dispatcher: this.dispatcher, patrol: this.patrol,
      idle: () => this.dispatcher.idle(), snapshot: () => this.buildSnapshot(), log: this.logLines,
    };
  }

  // ---- lifecycle ---------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    if (this.lock) await this.lock.acquire();
    this.started = true;
    const account = await this.deps.ledger.getAccount();
    this.gate.setAccount(account?.status === 'confirmed');
    const policy = await this.deps.ledger.getPolicy();
    this.patrol.start(policy.patrolIntervalSeconds, this.config.patrolEnabled);
    await this.connector.connect();
    await this.publish();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.patrol.stop();
    this.dispatcher.abortAll();
    await this.connector.stop();
    if (this.lock) await this.lock.release();
    await this.publish();
  }

  // ---- connector hooks ----------------------------------------------------------

  private async onConnected(): Promise<void> {
    this.gate.setConnection(true);
    await this.setupAccount();
    await recoverOpenAttempts({ ledger: this.deps.ledger, driver: this.deps.driver, dispatcher: this.dispatcher, now: this.now, log: (l) => this.log(l) });
    await this.dispatcher.reviewParkedRuns();
    await this.setupBaseline();
    this.scheduleSnapshot();
  }

  private onDisconnected(reason: string): void {
    this.log(`connection lost: ${reason}`);
    this.gate.setConnection(false);
    this.dispatcher.onDisconnected();
    this.gate.pause('disconnected');
    this.pendingBindingEvidence = undefined;
    this.scheduleSnapshot();
  }

  private log(line: string): void {
    this.logLines.push(`${this.now()} ${line}`);
    this.deps.log?.(line);
  }

  // ---- setup steps owned by the app (account, baseline) --------------------------

  private async setupAccount(): Promise<boolean> {
    const steps = this.connector.steps;
    const account = await this.deps.ledger.getAccount();
    if (account?.status === 'confirmed') {
      steps.set('account', 'done', account.visibleLabel);
      this.gate.setAccount(true);
      return true;
    }
    this.gate.setAccount(false);
    const desktopId = this.connector.desktopId;
    if (!desktopId) { steps.set('account', 'blocked', '微信窗口未绑定，无法采集账号证据'); return false; }
    if (!this.pendingBindingEvidence) {
      try {
        const session = await this.deps.driver.openSession(desktopId);
        try {
          const observation = await this.deps.driver.observe({ sessionId: session.sessionId }, { screenshot: true, elements: false });
          const retention = new Date(Date.parse(observation.capturedAt) + this.config.evidenceRetentionDays * 86_400_000).toISOString();
          const evidence = await this.deps.ledger.putEvidence({
            artifactId: observation.image?.artifactId, sha256: observation.image?.sha256 ?? sha256(observation.snapshotId), captureTime: observation.capturedAt,
            coverage: 'current_viewport', retentionUntil: retention,
          });
          this.pendingBindingEvidence = evidence.evidenceId;
          this.pendingBindingLabel = observation.target?.title || this.connector.binding?.title || '微信';
        } finally {
          await this.deps.driver.closeSession(session.sessionId).catch(() => undefined);
        }
      } catch (error) {
        this.connector.observeError(error);
        steps.set('account', 'failed', `采集账号证据失败：${errorMessage(error)}`);
        return false;
      }
    }
    steps.set('account', 'blocked', '等待人工确认当前微信账号');
    return false;
  }

  private async setupBaseline(): Promise<void> {
    const steps = this.connector.steps;
    if (!this.config.baselineOnConnect) { steps.set('baseline', 'done', '已配置跳过'); return; }
    const account = await this.deps.ledger.getAccount();
    if (!account || account.status !== 'confirmed') { steps.set('baseline', 'pending'); return; }
    if (!this.deps.handlers.get('read_requests')) { steps.set('baseline', 'blocked', 'ReadRequests 处理器未注册'); return; }
    if (!this.connector.desktopId) { steps.set('baseline', 'blocked', '微信窗口未绑定'); return; }
    try {
      const task = await this.dispatcher.create({
        operationId: `baseline:${account.accountId}:${this.now()}`, type: 'read_requests', payload: { kind: 'read_requests' }, expectedAccountRevision: account.revision,
      }, 'baseline');
      this.baselineTaskId = task.taskId;
      steps.set('baseline', task.state === 'blocked' ? 'blocked' : 'pending', task.state === 'blocked' ? '基线读取被阻断' : '基线读取进行中');
    } catch (error) {
      steps.set('baseline', 'failed', errorMessage(error));
    }
  }

  private async confirmAccount(params: IpcMethods['account.confirm']['params']): Promise<AccountBinding> {
    const evidence = await this.deps.ledger.getEvidence(params.bindingEvidenceId);
    if (!evidence) throw new IpcFailure({ code: 'not_found', message: `没有证据 ${params.bindingEvidenceId}` });
    const previous = await this.deps.ledger.getAccount();
    if ((previous?.revision ?? undefined) !== params.expectedRevision) {
      throw new IpcFailure({ code: 'revision_conflict', message: `账号版本已变化：当前 ${previous?.revision ?? '无'}`, details: { revision: previous?.revision } });
    }
    const binding = await this.deps.ledger.confirmAccount({
      accountId: previous?.accountId ?? newId('acct'), visibleLabel: this.pendingBindingLabel, evidenceIds: [params.bindingEvidenceId], confirmedAt: this.now(), status: 'confirmed',
    }, params.expectedRevision);
    this.pendingBindingEvidence = undefined;
    this.connector.steps.set('account', 'done', binding.visibleLabel);
    this.gate.setAccount(true);
    if (previous) {
      // A re-confirmed binding is a new account revision: close the gate, void every older approval (T10).
      this.log(`account re-confirmed: revision ${previous.revision} → ${binding.revision}`);
      await this.dispatcher.blockForAccountChange(binding.revision);
      this.gate.pause('account_changed');
    } else if (this.connector.ready) {
      await this.setupBaseline();
    }
    this.scheduleSnapshot();
    return binding;
  }

  // ---- features and snapshot --------------------------------------------------------

  private async features(): Promise<FeatureMap> {
    const account = await this.deps.ledger.getAccount();
    const policy = await this.deps.ledger.getPolicy();
    return computeFeatures({
      connection: this.connector.state, paired: this.connector.paired, methods: this.connector.methods,
      accountConfirmed: account?.status === 'confirmed', gateOpen: this.gate.isOpen(), gateDetail: `写门：${this.gate.state}（${this.gate.why()}）`,
      policy, handlers: this.deps.handlers, handbackVerified: false,
    });
  }

  private async buildSnapshot(): Promise<AppSnapshot> {
    const { ledger } = this.deps;
    const account = await ledger.getAccount();
    const policy = await ledger.getPolicy();
    const { tasks } = await ledger.listTasks({ limit: 200 });
    const views: TaskView[] = [];
    for (const task of tasks) views.push(await this.dispatcher.view(task));
    views.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.taskId.localeCompare(a.taskId));
    const activeTask = ACTIVE_ORDER.map((s) => views.find((v) => v.state === s)).find((v) => v) ?? views.find((v) => v.state === 'waiting_approval');
    const features = await this.features();
    this.revision += 1;
    const identity = this.connector.handshake?.identity;
    return {
      revision: this.revision,
      connection: {
        state: this.connector.state, endpoint: this.config.endpoint, product: identity?.product, apiVersion: identity?.apiVersion,
        principal: this.connector.principal, missingCapabilities: [...this.connector.missingCapabilities], steps: this.connector.steps.snapshot(),
      },
      account: account ?? (this.pendingBindingEvidence
        ? { accountId: '', visibleLabel: '（待确认）', evidenceIds: [this.pendingBindingEvidence], confirmedAt: '', revision: 0, status: 'unconfirmed' }
        : null),
      inputGate: this.gate.state,
      patrol: {
        enabled: this.patrol.enabled, intervalSeconds: this.patrol.intervalSeconds, lastScanAt: this.patrol.lastScanAt,
        coverage: this.patrol.coverage, visibleSingleChats: this.patrol.visibleSingleChats,
      },
      counts: {
        waitingApproval: views.filter((v) => v.state === 'waiting_approval').length,
        needsReconciliation: views.filter((v) => v.state === 'needs_reconciliation').length,
        confirmed: views.filter((v) => v.state === 'confirmed').length,
      },
      activeTask,
      tasks: views,
      features,
      policy: {
        allowlistCount: policy.allowlist.length, approvalPerAction: true, modelUpload: policy.modelUpload, patrolIntervalSeconds: policy.patrolIntervalSeconds,
        approvalTtlSeconds: this.config.approvalTtlSeconds, evidenceRetentionDays: this.config.evidenceRetentionDays,
      },
    };
  }

  private scheduleSnapshot(): void {
    if (this.publishScheduled || !this.started) return;
    this.publishScheduled = true;
    queueMicrotask(() => { this.publishScheduled = false; void this.publish(); });
  }

  private publish(): Promise<void> {
    this.publishing = this.publishing.then(async () => {
      const snapshot = await this.buildSnapshot();
      this.latest = snapshot;
      for (const listener of this.listeners) {
        try { listener(snapshot); } catch (error) { this.log(`subscriber: ${errorMessage(error)}`); }
      }
    }).catch((error: unknown) => { this.log(`snapshot: ${errorMessage(error)}`); });
    return this.publishing;
  }

  private subscribe(listener: (snapshot: AppSnapshot) => void): () => void {
    this.listeners.add(listener);
    if (this.latest) listener(this.latest);
    else void this.publish();
    return () => { this.listeners.delete(listener); };
  }

  // ---- typed IPC ----------------------------------------------------------------------

  private async call<M extends IpcMethod>(method: M, params: IpcMethods[M]['params']): Promise<IpcMethods[M]['result']> {
    try {
      const result = await this.dispatch(method, params);
      this.scheduleSnapshot();
      return result as IpcMethods[M]['result'];
    } catch (error) {
      this.scheduleSnapshot();
      throw toIpcFailure(error);
    }
  }

  private async dispatch<M extends IpcMethod>(method: M, params: IpcMethods[M]['params']): Promise<IpcMethods[IpcMethod]['result']> {
    const p = params as never;
    switch (method) {
      case 'app.getSnapshot': {
        const snapshot = await this.buildSnapshot();
        this.latest = snapshot;
        return snapshot;
      }
      case 'connection.check': {
        if (!this.connector.ready) await this.connector.reconnectNow();
        return { state: this.connector.state, apiVersion: this.connector.handshake?.identity.apiVersion, methods: [...this.connector.methods], missingCapabilities: [...this.connector.missingCapabilities] };
      }
      case 'account.confirm':
        return this.confirmAccount(p as IpcMethods['account.confirm']['params']);
      case 'task.create':
        return this.dispatcher.view(await this.dispatcher.create(p as IpcMethods['task.create']['params'], 'ui'));
      case 'task.list': {
        const q = p as IpcMethods['task.list']['params'];
        const page = await this.deps.ledger.listTasks({ cursor: q.cursor, limit: q.limit });
        const views: TaskView[] = [];
        for (const task of page.tasks) views.push(await this.dispatcher.view(task));
        return { tasks: views, next: page.next };
      }
      case 'task.show': {
        const task = await this.deps.ledger.getTask((p as IpcMethods['task.show']['params']).taskId);
        if (!task) throw new IpcFailure({ code: 'not_found', message: '没有这个任务' });
        return this.dispatcher.view(task);
      }
      case 'task.draft':
        return this.dispatcher.view(await this.dispatcher.draft(p as IpcMethods['task.draft']['params']));
      case 'task.approve':
        return this.dispatcher.approve(p as IpcMethods['task.approve']['params']);
      case 'task.skip':
        return this.dispatcher.view(await this.dispatcher.skip(p as IpcMethods['task.skip']['params']));
      case 'task.cancel':
        return this.dispatcher.view(await this.dispatcher.cancel(p as IpcMethods['task.cancel']['params']));
      case 'app.pause': {
        this.checkSnapshotRevision((p as IpcMethods['app.pause']['params']).expectedRevision);
        await this.dispatcher.pauseAll();
        return { inputGate: this.gate.state };
      }
      case 'app.resume': {
        this.checkSnapshotRevision((p as IpcMethods['app.resume']['params']).expectedRevision);
        if (!this.connector.ready) throw new IpcFailure({ code: 'blocked', message: '平台不可达，无法恢复', details: { reasonCode: 'disconnected' } });
        const account = await this.deps.ledger.getAccount();
        if (!account || account.status !== 'confirmed') throw new IpcFailure({ code: 'blocked', message: '请先确认账号', details: { reasonCode: 'identity_unproven' } });
        await this.dispatcher.resumeAll();
        if (this.connector.steps.get('baseline').state === 'pending') await this.setupBaseline();
        return { inputGate: this.gate.state };
      }
      case 'task.reconcile':
        return this.dispatcher.view(await this.dispatcher.reconcile(p as IpcMethods['task.reconcile']['params']));
      case 'task.concludeManually':
        return this.dispatcher.view(await this.dispatcher.concludeManually(p as IpcMethods['task.concludeManually']['params']));
      case 'window.requestHandback':
        // CR03: no verified platform handback yet; the person gets the manual path.
        return { mode: 'manual', instructions: '平台归还能力未验证（CR03）。请在 AgentDesktop 中解除微信窗口绑定，或直接点击微信窗口恢复操作；本应用不会移动或点击你的窗口。' };
      case 'evidence.read':
        return this.readEvidence(p as IpcMethods['evidence.read']['params']);
      case 'diagnostics.export': {
        const q = p as IpcMethods['diagnostics.export']['params'];
        const snapshot = await this.buildSnapshot();
        return exportDiagnostics({
          snapshot, ledger: this.deps.ledger, dataDir: this.config.dataDir, includeEvidence: q.includeEvidence, selectedEvidenceIds: q.selectedEvidenceIds,
          now: this.now(), appVersion: this.config.client.version, log: this.logLines,
        });
      }
      default:
        throw new IpcFailure({ code: 'unavailable', message: `未知方法 ${String(method)}` });
    }
  }

  /** Read-only. Pixel redaction is not implemented yet: a redacted read is refused rather than served unredacted. */
  private async readEvidence(params: IpcMethods['evidence.read']['params']): Promise<IpcMethods['evidence.read']['result']> {
    const evidence = await this.deps.ledger.getEvidence(params.evidenceId);
    if (!evidence) throw new IpcFailure({ code: 'not_found', message: `没有证据 ${params.evidenceId}` });
    if (params.redacted !== false) throw new IpcFailure({ code: 'unavailable', message: '证据图片的脱敏渲染尚未实现；需要原图请显式传 redacted:false' });
    if (!evidence.artifactId) throw new IpcFailure({ code: 'not_found', message: '该证据没有可读的平台工件' });
    if (!this.connector.ready) throw new IpcFailure({ code: 'unavailable', message: '平台不可达，无法读取工件' });
    const bytes = await this.deps.driver.readArtifact(evidence.artifactId);
    const { width, height } = pngSize(bytes);
    return { dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`, width, height, crop: evidence.crop, redacted: false, captureTime: evidence.captureTime };
  }

  /** app.pause/resume carry the snapshot revision the UI acted on; 0 means "whatever is current". */
  private checkSnapshotRevision(expected: number): void {
    if (expected === 0 || !this.latest) return;
    if (expected !== this.latest.revision) {
      throw new IpcFailure({ code: 'revision_conflict', message: `快照已更新：当前 ${this.latest.revision}`, details: { revision: this.latest.revision } });
    }
  }
}

/** Width and height from a PNG IHDR chunk; 0×0 when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return { width: 0, height: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function toIpcFailure(error: unknown): IpcFailure {
  if (error instanceof IpcFailure) return error;
  if (error instanceof LedgerConflictError) {
    const code = error.kind === 'revision' ? 'revision_conflict' : error.kind === 'operation_fingerprint' ? 'operation_conflict' : 'invalid_state';
    return new IpcFailure({ code, message: error.message, details: { kind: error.kind } });
  }
  if (error instanceof LedgerUnavailableError) return new IpcFailure({ code: 'unavailable', message: error.message });
  if (error instanceof WriteGateClosedError) return new IpcFailure({ code: 'blocked', message: error.message, details: { reasonCode: 'write_gate_closed', why: error.why } });
  if (error instanceof DriverError) return new IpcFailure({ code: 'unavailable', message: error.message, details: { ...error.error } });
  return new IpcFailure({ code: 'internal', message: errorMessage(error) });
}

export { RUNNING_STATES };
