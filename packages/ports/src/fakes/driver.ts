import { DriverError, RUNTIME_API_VERSION } from '../driver.ts';
import type {
  Action, ActionReceipt, AgentDesktopDriver, Artifact, Capabilities, CancelReceipt, Desktop, DriverState, EventFrame, EventStream,
  HandshakeResult, Observation, RequestRecord, Run, RuntimeError, Session, WaitCondition, WaitResult, Window,
} from '../driver.ts';
import type { Id } from '../domain.ts';

export interface FaultSpec {
  /** Which method the fault applies to. */
  method: string;
  /** Fire on the nth call of that method (1-based); default 1. */
  onCall?: number;
  error: Partial<RuntimeError> & { code: string };
  /** After throwing, flip the driver to disconnected (simulates a dropped control connection). */
  disconnect?: boolean;
}

export interface FakeDriverOptions {
  /** Observations handed out in order; the last one repeats. */
  observations?: Observation[];
  /** Receipt fields to override for every act. */
  receipt?: Partial<ActionReceipt>;
  faults?: FaultSpec[];
  principalRole?: 'owner' | 'paired';
  methods?: string[];
  artifacts?: Record<Id, Uint8Array>;
}

const now = () => new Date().toISOString();

export class FakeDriver implements AgentDesktopDriver {
  state: DriverState = 'disconnected';
  /** Every call, in order, for assertions. */
  readonly calls: { method: string; args: unknown[] }[] = [];
  /** act requests by requestId, to assert idempotency and "no re-dispatch". */
  readonly acts = new Map<Id, { params: { snapshotId: Id; action: Action }; receipt: ActionReceipt }>();
  readonly runs = new Map<Id, Run>();
  readonly requests = new Map<Id, RequestRecord>();
  private counters = new Map<string, number>();
  private seq = 0;
  private observeIndex = 0;

  constructor(readonly options: FakeDriverOptions = {}) {}

  private id(prefix: string): Id {
    this.seq += 1;
    return `${prefix}_${this.seq.toString(36)}`;
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const n = (this.counters.get(method) ?? 0) + 1;
    this.counters.set(method, n);
    for (const fault of this.options.faults ?? []) {
      if (fault.method === method && (fault.onCall ?? 1) === n) {
        if (fault.disconnect) this.state = 'disconnected';
        throw new DriverError({ message: fault.error.code, phase: 'request', retryable: false, ...fault.error });
      }
    }
    if (this.state !== 'connected' && method !== 'connect') {
      throw new DriverError({ code: 'connection_lost', message: 'fake driver is not connected', phase: 'transport', retryable: false, notSent: true });
    }
  }

  async connect(): Promise<HandshakeResult> {
    this.record('connect');
    this.state = 'connected';
    return {
      identity: { product: 'AgentDesktop', productVersion: '0.0.0-fake', apiVersion: RUNTIME_API_VERSION, apiVersions: [RUNTIME_API_VERSION], instanceId: 'inst_fake', pid: 1, startedAt: now(), endpoint: 'fake', platform: {}, build: { source: 'fake' } },
      principal: { clientId: this.options.principalRole === 'paired' ? 'app:wechat-agent' : 'local:501', role: this.options.principalRole ?? 'owner', connectionId: 'conn_fake' },
      raw: {},
    };
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close', args: [] });
    this.state = 'closed';
  }

  async capabilities(): Promise<Capabilities> {
    this.record('capabilities');
    const methods = this.options.methods ?? ['runtime.handshake', 'runtime.capabilities', 'desktop.list', 'window.list', 'window.bind', 'window.unbind', 'session.open', 'session.close', 'run.start', 'run.finish', 'run.show', 'run.wait', 'run.cancel', 'observe', 'act', 'wait', 'request.show', 'artifact.show', 'artifact.read', 'events.subscribe'];
    return {
      apiVersion: RUNTIME_API_VERSION,
      interface: { methods: methods.map((m) => ({ method: m, mutation: m === 'act' || m.startsWith('run.') || m.startsWith('window.') || m.startsWith('session.'), stage: 'P0' as const })) },
      backend: { platform: { os: 'macos' }, permissions: { screenRecording: 'granted', accessibility: 'granted' }, features: [] },
    };
  }

  async status(): Promise<Record<string, unknown>> {
    this.record('status');
    return { state: 'ready' };
  }

  async listDesktops(): Promise<Desktop[]> {
    this.record('listDesktops');
    return [{ desktopId: 'desk_fake', name: 'wechat', state: 'ready', createdAt: now(), binding: null, openSessions: 0 }];
  }

  async listWindows(params?: { desktopId?: Id; pid?: number }): Promise<Window[]> {
    this.record('listWindows', params);
    return [{ windowId: 11, process: { pid: 777, startedAt: now() }, appName: 'WeChat', bundleId: 'com.tencent.xinWeChat', title: '微信', frame: { x: 0, y: 25, width: 1280, height: 875 }, onScreen: true }];
  }

  async bindWindow(params: { desktopId: Id; pid: number; windowId?: number }): Promise<Desktop> {
    this.record('bindWindow', params);
    return { desktopId: params.desktopId, name: 'wechat', state: 'ready', createdAt: now(), binding: { pid: params.pid, windowId: params.windowId ?? 11 }, openSessions: 0 };
  }

  async unbindWindow(params: { desktopId: Id }): Promise<Desktop> {
    this.record('unbindWindow', params);
    return { desktopId: params.desktopId, name: 'wechat', state: 'ready', createdAt: now(), binding: null, openSessions: 0 };
  }

  async openSession(desktopId: Id): Promise<Session> {
    this.record('openSession', desktopId);
    return { sessionId: this.id('ses'), desktopId, state: 'open', createdAt: now() };
  }

  async closeSession(sessionId: Id): Promise<Session> {
    this.record('closeSession', sessionId);
    return { sessionId, desktopId: 'desk_fake', state: 'closed', createdAt: now(), closedAt: now() };
  }

  async startRun(sessionId: Id): Promise<Run> {
    this.record('startRun', sessionId);
    const run: Run = {
      runId: this.id('run'), kind: 'act', origin: 'agent_hub', ownership: 'external_client', lifetime: 'connection_scoped',
      clientId: 'app:wechat-agent', connectionId: 'conn_fake', sessionId, desktopId: 'desk_fake', phase: 'running', outcome: null,
      quiescence: 'not_confirmed', closingReason: null, revision: 1, createdAt: now(), receipts: [], unknownActions: 0,
    };
    this.runs.set(run.runId, run);
    return run;
  }

  private endRun(runId: Id, outcome: Run['outcome']): Run {
    const run = this.runs.get(runId);
    if (!run) throw new DriverError({ code: 'not_found', message: runId, phase: 'handler', retryable: false });
    Object.assign(run, { phase: 'ended', outcome, quiescence: 'confirmed', revision: run.revision + 1, endedAt: now() });
    return run;
  }

  async finishRun(runId: Id, outcome: 'success' | 'failed' | 'cancelled'): Promise<Run> {
    this.record('finishRun', runId, outcome);
    return this.endRun(runId, outcome);
  }

  async showRun(runId: Id): Promise<Run> {
    this.record('showRun', runId);
    const run = this.runs.get(runId);
    if (!run) throw new DriverError({ code: 'not_found', message: runId, phase: 'handler', retryable: false });
    return run;
  }

  async waitRun(runId: Id, timeoutMs: number): Promise<Run> {
    this.record('waitRun', runId, timeoutMs);
    return this.showRun(runId);
  }

  async cancelRun(runId: Id): Promise<CancelReceipt> {
    this.record('cancelRun', runId);
    const run = this.endRun(runId, 'cancelled');
    return { cancelRequest: { accepted: true, scope: { kind: 'run', id: runId } }, execution: { phase: run.phase, quiescence: run.quiescence, outcome: run.outcome, revision: run.revision } };
  }

  async listRuns(): Promise<Run[]> {
    this.record('listRuns');
    return [...this.runs.values()];
  }

  async observe(context: { sessionId: Id; runId?: Id }, params?: { screenshot?: boolean; elements?: boolean; query?: string }): Promise<Observation> {
    this.record('observe', context, params);
    const list = this.options.observations ?? [];
    const base = list[Math.min(this.observeIndex, list.length - 1)];
    this.observeIndex += 1;
    const snapshotId = this.id('snap');
    if (!base) {
      return { snapshotId, desktopId: 'desk_fake', sessionId: context.sessionId, capturedAt: now(), screen: {}, target: null, image: null, elements: [] };
    }
    return { ...base, snapshotId, sessionId: context.sessionId, capturedAt: now() };
  }

  async act(context: { sessionId: Id; runId: Id }, params: { snapshotId: Id; action: Action }, requestId: Id): Promise<ActionReceipt> {
    this.record('act', context, params, requestId);
    const previous = this.acts.get(requestId);
    if (previous) {
      if (JSON.stringify(previous.params) !== JSON.stringify(params)) {
        throw new DriverError({ code: 'idempotency_conflict', message: 'same requestId, different parameters', phase: 'request', retryable: false, notSent: true });
      }
      return previous.receipt;
    }
    const receipt: ActionReceipt = {
      receiptId: this.id('rcpt'), requestId, runId: context.runId, desktopId: 'desk_fake', sessionId: context.sessionId, snapshotId: params.snapshotId,
      delivery: 'dispatched', execution: 'completed', verification: 'not_requested', businessResult: 'not_evaluated', route: 'fake',
      target: { generation: 1, process: { pid: 777, startedAt: null }, windowId: 11, elementRef: null, point: 'target' in params.action && params.action.target && 'imagePoint' in params.action.target ? params.action.target.imagePoint : null },
      timing: { acceptedAt: now(), dispatchedAt: now(), completedAt: now() },
      ...this.options.receipt,
    };
    this.acts.set(requestId, { params, receipt });
    this.requests.set(requestId, { requestId, method: 'act', state: 'completed', acceptedAt: now(), finishedAt: now(), outcome: { receiptId: receipt.receiptId } });
    this.runs.get(context.runId)?.receipts.push(receipt.receiptId);
    return receipt;
  }

  async wait(context: { sessionId: Id; runId?: Id }, params: { condition: WaitCondition; timeoutMs: number }): Promise<WaitResult> {
    this.record('wait', context, params);
    return { satisfied: true, snapshotId: this.id('snap'), matches: [] };
  }

  async showRequest(requestId: Id): Promise<RequestRecord> {
    this.record('showRequest', requestId);
    const record = this.requests.get(requestId);
    if (!record) throw new DriverError({ code: 'not_found', message: requestId, phase: 'handler', retryable: false });
    return record;
  }

  async showArtifact(artifactId: Id): Promise<Artifact> {
    this.record('showArtifact', artifactId);
    const bytes = this.options.artifacts?.[artifactId];
    if (!bytes) throw new DriverError({ code: 'not_found', message: artifactId, phase: 'handler', retryable: false });
    return { artifactId, mediaType: 'image/png', byteSize: bytes.byteLength, sha256: '0'.repeat(64), createdAt: now() };
  }

  async readArtifact(artifactId: Id): Promise<Uint8Array> {
    this.record('readArtifact', artifactId);
    const bytes = this.options.artifacts?.[artifactId];
    if (!bytes) throw new DriverError({ code: 'not_found', message: artifactId, phase: 'handler', retryable: false });
    return bytes;
  }

  async subscribe(params?: { runId?: Id; after?: number }): Promise<EventStream> {
    this.record('subscribe', params);
    const frames: EventFrame[] = [];
    let cursor = params?.after ?? 0;
    const stream: EventStream = {
      get cursor() { return cursor; },
      async close() { /* independent of the control connection */ },
      async *[Symbol.asyncIterator]() {
        for (const frame of frames) { cursor = frame.cursor ?? cursor; yield frame; }
      },
    };
    return stream;
  }

  /** Test helper: a disconnected control connection; subsequent calls throw connection_lost. */
  dropConnection(): void {
    this.state = 'disconnected';
  }

  countCalls(method: string): number {
    return this.counters.get(method) ?? 0;
  }
}
