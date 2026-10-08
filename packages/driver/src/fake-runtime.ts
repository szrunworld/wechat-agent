// Fake AgentDesktop Runtime: a Unix-socket server that speaks runtime/1 well
// enough for the other lanes and the integration tests. It validates every
// request against the contract snapshot, keeps a request ledger (same
// requestId + same content -> same reply; different content ->
// idempotency_conflict), owns Desktops/Sessions/Runs/artifacts/events, and
// takes injected faults. It never touches a real application, screen or
// pointer: "dispatching" an action only produces a receipt and an event.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MAX_ARTIFACT_CHUNK_BYTES, RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type {
  ActionReceipt, Artifact, Element, ErrorPhase, Id, Principal, Rect, RequestContext, RequestRecord, Run, RunEvent, RuntimeError,
  RuntimeIdentity, RuntimeResponse, Session, Timestamp,
} from '@wechat-agent/ports';
import { encodeFrame, LineDecoder } from './framing.ts';
import { canonicalJson, ERROR_CODES, METHODS, validator } from './schema.ts';

/** `onCall` absent: the fault fires on the next call of `method`; set: on that absolute call number (1-based). One-shot unless `sticky`. */
export type FakeFault =
  /** Process the request, then drop the connection instead of replying (the Runtime kept the result; request.show finds it). */
  | { kind: 'disconnect_before_reply'; method: string; onCall?: number; sticky?: boolean }
  /** Process the request, keep the connection, never reply (caller hits its requestTimeoutMs; a retry with the same requestId replays). */
  | { kind: 'hang'; method: string; onCall?: number; sticky?: boolean }
  /** Reply with this error instead of processing. */
  | { kind: 'error'; method: string; onCall?: number; sticky?: boolean; error: Partial<RuntimeError> & { code: string } }
  /** Process `act` normally but overwrite receipt fields (e.g. delivery: 'unknown'). */
  | { kind: 'receipt'; method?: 'act'; onCall?: number; sticky?: boolean; receipt: Partial<ActionReceipt> };

export interface FakeRuntimeOptions {
  /** Defaults to a fresh temp directory; keep it short (Unix socket paths are limited to ~104 bytes on macOS). */
  socketPath?: string;
  /** Overrides for the handshake identity, e.g. { product: 'OtherDesktop' } or { apiVersions: ['agentdesktop.runtime/2'] }. */
  identity?: Partial<RuntimeIdentity>;
  /** Answer the handshake even when the client's apiVersions share nothing with ours (lets tests see the client refuse). */
  acceptAnyApiVersion?: boolean;
  /** Principal reported with the handshake; `null` omits it (the frozen RuntimeIdentity has no principal yet). */
  principal?: Omit<Principal, 'connectionId'> | null;
  features?: string[];
  /** Cursors below this value are gone: events.subscribe with a smaller `after` returns events_cursor_expired. */
  retainedEventsFrom?: number;
  /** Screenshot artifacts produced by observe. byteSize > 524288 exercises chunked artifact.read. */
  screenshot?: { width?: number; height?: number; byteSize?: number };
  /** Accessibility elements of every observation. */
  elements?: Element[];
  /** Start with the default Desktop bound to the fake WeChat window (default true). */
  bound?: boolean;
  /** Refuse run.start when lifetime/ownership/origin are present (default true; ADR-05). */
  refuseEscalation?: boolean;
  faults?: FakeFault[];
}

export interface LoggedRequest { connectionId: Id; requestId: Id; method: string; context: RequestContext; params: Record<string, unknown> }

class FakeError extends Error {
  constructor(readonly code: string, message: string, readonly extra: Partial<RuntimeError> = {}) {
    super(message);
  }
}

interface Conn {
  id: Id;
  socket: net.Socket;
  decoder: LineDecoder;
  handshaken: boolean;
  subscription: { runId?: Id } | null;
  runIds: Set<Id>;
  chain: Promise<void>;
  alive: boolean;
}

interface DesktopState {
  desktopId: Id; name: string; state: 'ready' | 'busy' | 'destroying'; createdAt: Timestamp;
  screen: { displayId: number; frame: Rect; hiDPI: boolean };
  binding: { generation: number; process: { pid: number; startedAt: Timestamp | null }; windowId: number; appName: string; boundAt: Timestamp } | null;
  generation: number;
}

interface WindowState { windowId: number; process: { pid: number; startedAt: Timestamp | null }; appName: string; bundleId: string | null; title: string | null; frame: Rect; onScreen: boolean }

interface RunState extends Run { attachToken: string; connectionId: Id; seq: number; events: RunEvent[] }

interface ArtifactState extends Artifact { bytes: Buffer }

interface SnapshotState { snapshotId: Id; desktopId: Id; elements: Element[]; image: { artifactId: Id; transform: { originX: number; originY: number; scale: number } } | null }

interface LedgerEntry { digest: string; response?: RuntimeResponse }

const now = (): Timestamp => new Date().toISOString();

const DEFAULT_ELEMENTS: Element[] = [
  { id: 'el_list', role: 'AXList', label: 'Contacts', value: null, actions: [], frame: { x: 0, y: 0, width: 300, height: 875 } },
  { id: 'el_row_1', role: 'AXRow', label: 'Sample Person', value: null, actions: ['AXPress'], frame: { x: 0, y: 60, width: 300, height: 64 } },
  { id: 'el_accept', role: 'AXButton', label: 'Accept', value: null, actions: ['AXPress'], frame: { x: 980, y: 420, width: 120, height: 36 } },
  { id: 'el_input', role: 'AXTextArea', label: 'Message', value: '', actions: [], frame: { x: 320, y: 760, width: 900, height: 100 } },
];

export class FakeRuntime {
  readonly endpoint: string;
  readonly identity: RuntimeIdentity;
  /** Every request that passed envelope validation, in arrival order. */
  readonly requests: LoggedRequest[] = [];
  readonly desktops = new Map<Id, DesktopState>();
  readonly sessions = new Map<Id, Session>();
  readonly runs = new Map<Id, RunState>();
  readonly receipts = new Map<Id, ActionReceipt>();
  readonly artifacts = new Map<Id, ArtifactState>();
  readonly records = new Map<Id, RequestRecord>();
  readonly snapshots = new Map<Id, SnapshotState>();
  readonly windows: WindowState[] = [];
  admission: 'enabled' | 'stopping' | 'stopped' = 'enabled';
  /** Total connections ever accepted (T34: no silent reconnects). */
  connectionsAccepted = 0;

  private readonly server: net.Server;
  private readonly conns = new Map<Id, Conn>();
  private readonly ledger = new Map<Id, LedgerEntry>();
  private readonly faults: FakeFault[];
  private readonly calls = new Map<string, number>();
  private readonly globalEvents: { cursor: number; event: RunEvent }[] = [];
  private globalCursor = 0;
  private counter = 0;
  private readonly tempDir: string | null;
  private readonly startedAt = now();

  private constructor(private readonly options: FakeRuntimeOptions) {
    if (options.socketPath) {
      this.tempDir = null;
      this.endpoint = options.socketPath;
    } else {
      this.tempDir = mkdtempSync(path.join(os.tmpdir(), 'wa-fake-'));
      this.endpoint = path.join(this.tempDir, 'runtime.sock');
    }
    this.faults = [...(options.faults ?? [])];
    this.identity = {
      product: 'AgentDesktop',
      productVersion: '0.0.0-fake',
      apiVersion: RUNTIME_API_VERSION,
      apiVersions: [RUNTIME_API_VERSION],
      instanceId: `inst_${randomBytes(4).toString('hex')}`,
      pid: process.pid,
      startedAt: this.startedAt,
      endpoint: this.endpoint,
      platform: { os: 'macos', osVersion: '0.0', arch: 'fake' },
      build: { source: 'fake' },
      ...options.identity,
    };
    const windowStarted = now();
    this.windows.push({ windowId: 11, process: { pid: 777, startedAt: windowStarted }, appName: 'WeChat', bundleId: 'com.tencent.xinWeChat', title: 'WeChat', frame: { x: 0, y: 25, width: 1280, height: 875 }, onScreen: true });
    const desktop: DesktopState = {
      desktopId: 'desk_1', name: 'wechat-fake', state: 'ready', createdAt: now(),
      screen: { displayId: 1, frame: { x: 0, y: 0, width: 1280, height: 900 }, hiDPI: true },
      binding: null, generation: 0,
    };
    this.desktops.set(desktop.desktopId, desktop);
    if (options.bound !== false) this.bind(desktop, this.windows[0]);
    this.server = net.createServer((socket) => this.accept(socket));
  }

  static start(options: FakeRuntimeOptions = {}): Promise<FakeRuntime> {
    const runtime = new FakeRuntime(options);
    return new Promise((resolve, reject) => {
      runtime.server.once('error', reject);
      runtime.server.listen(runtime.endpoint, () => {
        runtime.server.off('error', reject);
        resolve(runtime);
      });
    });
  }

  async close(): Promise<void> {
    for (const conn of this.conns.values()) conn.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
  }

  // ---- fault injection -------------------------------------------------

  inject(fault: FakeFault): void {
    this.faults.push(fault);
  }

  /** The reply to the nth call of `method` never arrives: the socket is dropped after processing. */
  injectDisconnectBeforeReply(method: string, onCall?: number): void {
    this.inject({ kind: 'disconnect_before_reply', method, onCall });
  }

  /** The nth call of `method` is processed but never answered (client-side deadline_exceeded). */
  injectTimeout(method: string, onCall?: number): void {
    this.inject({ kind: 'hang', method, onCall });
  }

  /** The nth call of `method` fails with `code`; phase/retryable default from errors.json. */
  injectError(method: string, code: string, extra: Partial<RuntimeError> & { onCall?: number } = {}): void {
    const { onCall, ...error } = extra;
    this.inject({ kind: 'error', method, onCall, error: { code, ...error } });
  }

  injectIdempotencyConflict(onCall?: number): void { this.injectError('act', 'idempotency_conflict', { onCall }); }
  injectCursorExpired(): void { this.injectError('events.subscribe', 'events_cursor_expired'); }
  /** request.show for a record the Runtime no longer retains. */
  injectRequestNotFound(onCall?: number): void { this.injectError('request.show', 'not_found', { onCall }); }
  /** act refused before anything reached the window (notSent: true). */
  injectActNotSent(code: string = 'invalid_target', onCall?: number): void { this.injectError('act', code, { notSent: true, onCall }); }
  injectInputDisabled(onCall?: number): void { this.injectError('act', 'input_disabled', { onCall }); }
  injectStaleObservation(onCall?: number): void { this.injectError('act', 'stale_observation', { onCall }); }
  /** act is processed, but the receipt says e.g. delivery 'unknown'. */
  injectReceipt(receipt: Partial<ActionReceipt>, onCall?: number): void { this.inject({ kind: 'receipt', receipt, onCall }); }

  /** Flips one byte of a stored artifact without touching its sha256 (readArtifact must notice). */
  corruptArtifact(artifactId: Id): void {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new Error(`unknown artifact ${artifactId}`);
    if (artifact.bytes.byteLength === 0) throw new Error('cannot corrupt an empty artifact');
    artifact.bytes[0] = artifact.bytes[0] ^ 0xff;
  }

  /** Drops every connection (control and subscriptions), as if the Runtime went away. */
  dropConnections(): void {
    for (const conn of this.conns.values()) conn.socket.destroy();
  }

  /** Drops only subscription connections; control connections stay. */
  dropSubscriptions(): void {
    for (const conn of this.conns.values()) if (conn.subscription) conn.socket.destroy();
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  callCount(method: string): number {
    return this.calls.get(method) ?? 0;
  }

  /** Appends an event to a Run (for tests that need traffic on a subscription). */
  emitEvent(runId: Id, type: string, data: Record<string, unknown> = {}): RunEvent {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return this.emit(run, type, data);
  }

  // ---- connections -----------------------------------------------------

  private accept(socket: net.Socket): void {
    this.connectionsAccepted += 1;
    const conn: Conn = { id: this.id('conn'), socket, decoder: new LineDecoder(), handshaken: false, subscription: null, runIds: new Set(), chain: Promise.resolve(), alive: true };
    this.conns.set(conn.id, conn);
    socket.on('data', (chunk: Buffer) => {
      if (!conn.alive) return;
      let lines: string[];
      try {
        lines = conn.decoder.push(chunk);
      } catch {
        // Reply, then close gracefully so the reply is flushed; further bytes are ignored.
        this.write(conn, this.errorResponse(null, 'frame_too_large', 'a message exceeded maxFrameBytes'));
        conn.alive = false;
        socket.end();
        return;
      }
      for (const line of lines) {
        // Requests on one connection are answered in order.
        conn.chain = conn.chain.then(() => this.handleLine(conn, line)).catch(() => undefined);
      }
    });
    socket.on('error', () => { /* close follows */ });
    socket.on('close', () => {
      conn.alive = false;
      this.conns.delete(conn.id);
      // Delegated Runs are connection-scoped: losing the control connection ends them.
      for (const runId of conn.runIds) {
        const run = this.runs.get(runId);
        if (run && run.phase !== 'ended') this.endRun(run, 'cancelled', 'connection_closed');
      }
    });
  }

  private write(conn: Conn, frame: unknown): void {
    if (!conn.alive || conn.socket.destroyed) return;
    conn.socket.write(encodeFrame(frame));
  }

  private errorResponse(requestId: Id | null, code: string, message: string, extra: Partial<RuntimeError> = {}): RuntimeResponse {
    const spec = ERROR_CODES.get(code);
    const error: RuntimeError = {
      code,
      message,
      phase: (extra.phase ?? spec?.phase ?? 'handler') as ErrorPhase,
      retryable: extra.retryable ?? false,
      ...(extra.notSent !== undefined ? { notSent: extra.notSent } : {}),
      ...(extra.details ? { details: extra.details } : {}),
    };
    return { apiVersion: RUNTIME_API_VERSION, requestId, ok: false, error };
  }

  private async handleLine(conn: Conn, line: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.write(conn, this.errorResponse(null, 'schema_invalid', 'request is not JSON', { phase: 'request' }));
      return;
    }
    const envelope = validator.errors('Request', frame);
    const requestId = typeof (frame as { requestId?: unknown })?.requestId === 'string' ? (frame as { requestId: string }).requestId : null;
    if (envelope.length) {
      this.write(conn, this.errorResponse(requestId, 'schema_invalid', `request envelope: ${envelope.join('; ')}`, { phase: 'request', details: { problems: envelope } }));
      return;
    }
    const request = frame as { requestId: Id; method: string; context?: RequestContext; params: Record<string, unknown> };
    const context = request.context ?? {};
    this.requests.push({ connectionId: conn.id, requestId: request.requestId, method: request.method, context, params: request.params });

    if (!conn.handshaken && request.method !== 'runtime.handshake') {
      this.write(conn, this.errorResponse(request.requestId, 'handshake_required', 'send runtime.handshake first'));
      return;
    }
    if (conn.subscription && request.method !== 'events.unsubscribe') {
      this.write(conn, this.errorResponse(request.requestId, 'conflict', 'this connection is subscribed to events; events.unsubscribe first'));
      return;
    }
    const spec = METHODS.get(request.method);
    if (!spec) {
      this.write(conn, this.errorResponse(request.requestId, 'capability_missing', `${request.method} is not implemented by this Runtime`, { phase: 'request' }));
      return;
    }
    const paramProblems = validator.errors(spec.params, request.params);
    if (paramProblems.length) {
      this.write(conn, this.errorResponse(request.requestId, 'schema_invalid', `${request.method} params: ${paramProblems.join('; ')}`, { phase: 'request', details: { problems: paramProblems } }));
      return;
    }

    // Request ledger: mutations keyed by requestId, digest of {method, context, params}.
    const digest = createHash('sha256').update(canonicalJson({ method: request.method, context, params: request.params })).digest('hex');
    if (spec.mutation) {
      const prior = this.ledger.get(request.requestId);
      if (prior) {
        if (prior.digest !== digest) {
          this.write(conn, this.errorResponse(request.requestId, 'idempotency_conflict', `requestId ${request.requestId} was used with different content`));
          return;
        }
        if (prior.response) {
          this.write(conn, prior.response);
          return;
        }
      }
    }

    const fault = this.takeFault(request.method);
    let response: RuntimeResponse;
    if (fault?.kind === 'error') {
      const { code, message, ...rest } = fault.error;
      response = this.errorResponse(request.requestId, code, message ?? `${code} (injected)`, rest);
      this.record(request, 'failed', { error: response.ok ? undefined : response.error });
      this.write(conn, response);
      return;
    }
    try {
      const data = await this.dispatch(conn, request.method, context, request.params, request.requestId, fault?.kind === 'receipt' ? fault.receipt : undefined);
      response = { apiVersion: RUNTIME_API_VERSION, requestId: request.requestId, ok: true, data };
      this.record(request, 'completed', summarize(request.method, data));
    } catch (error) {
      if (error instanceof FakeError) response = this.errorResponse(request.requestId, error.code, error.message, error.extra);
      else response = this.errorResponse(request.requestId, 'internal_error', error instanceof Error ? error.message : String(error));
      this.record(request, 'failed', { error: response.ok ? undefined : response.error });
    }
    if (spec.mutation) this.ledger.set(request.requestId, { digest, response });
    if (fault?.kind === 'disconnect_before_reply') {
      conn.socket.destroy();
      return;
    }
    if (fault?.kind === 'hang') return;
    this.write(conn, response);
    if (response.ok && request.method === 'events.subscribe') this.flushSubscription(conn, request.params);
  }

  private takeFault(method: string): FakeFault | undefined {
    const n = (this.calls.get(method) ?? 0) + 1;
    this.calls.set(method, n);
    // onCall absent: the next call of that method; onCall set: that absolute call number.
    const index = this.faults.findIndex((f) => (f.method ?? 'act') === method && (f.onCall === undefined || f.onCall === n));
    if (index === -1) return undefined;
    const fault = this.faults[index];
    if (!fault.sticky) this.faults.splice(index, 1);
    return fault;
  }

  private record(request: { requestId: Id; method: string }, state: RequestRecord['state'], outcome: Record<string, unknown> | undefined): void {
    const previous = this.records.get(request.requestId);
    const at = now();
    this.records.set(request.requestId, {
      requestId: request.requestId,
      method: request.method,
      state,
      acceptedAt: previous?.acceptedAt ?? at,
      finishedAt: at,
      ...(outcome ? { outcome } : {}),
    });
  }

  // ---- method handlers ---------------------------------------------------

  private async dispatch(conn: Conn, method: string, context: RequestContext, params: Record<string, unknown>, requestId: Id, receiptOverride?: Partial<ActionReceipt>): Promise<Record<string, unknown>> {
    switch (method) {
      case 'runtime.handshake': {
        const offered = params.apiVersions as string[];
        if (!this.options.acceptAnyApiVersion && !offered.some((v) => this.identity.apiVersions.includes(v))) {
          throw new FakeError('version_mismatch', `no API version in common: client ${JSON.stringify(offered)}, runtime ${JSON.stringify(this.identity.apiVersions)}`);
        }
        conn.handshaken = true;
        const principal = this.options.principal === undefined ? undefined : this.options.principal;
        return { ...this.identity, ...(principal ? { principal: { ...principal, connectionId: conn.id } } : {}) };
      }
      case 'runtime.status':
        return {
          instanceId: this.identity.instanceId, state: 'running', startedAt: this.startedAt,
          uptimeSeconds: (Date.now() - Date.parse(this.startedAt)) / 1000,
          connections: this.conns.size, desktops: this.desktops.size, sessions: [...this.sessions.values()].filter((s) => s.state === 'open').length,
          runs: [...this.runs.values()].filter((r) => r.phase !== 'ended').length, inputAdmission: this.admission,
        };
      case 'runtime.capabilities':
        return {
          apiVersion: RUNTIME_API_VERSION,
          interface: { methods: [...METHODS.values()].map((m) => ({ method: m.method, mutation: m.mutation, stage: m.stage })) },
          backend: { platform: this.identity.platform, permissions: { screenRecording: 'granted', accessibility: 'granted' }, features: this.options.features ?? [] },
        };
      case 'desktop.list':
        return { desktops: [...this.desktops.values()].map((d) => this.desktopView(d)) };
      case 'desktop.show':
        return this.desktopView(this.desktop(params.desktopId as Id));
      case 'desktop.create': {
        const desktop: DesktopState = {
          desktopId: this.id('desk'), name: (params.name as string) ?? 'desktop', state: 'ready', createdAt: now(),
          screen: { displayId: this.desktops.size + 1, frame: { x: 0, y: 0, width: (params.width as number) ?? 1280, height: (params.height as number) ?? 900 }, hiDPI: true },
          binding: null, generation: 0,
        };
        this.desktops.set(desktop.desktopId, desktop);
        return this.desktopView(desktop);
      }
      case 'desktop.destroy': {
        const desktop = this.desktop(params.desktopId as Id);
        const active = [...this.runs.values()].some((r) => r.desktopId === desktop.desktopId && r.phase !== 'ended');
        if (active) throw new FakeError('conflict', 'desktop has active Runs');
        for (const session of this.sessions.values()) if (session.desktopId === desktop.desktopId && session.state === 'open') this.closeSession(session);
        this.desktops.delete(desktop.desktopId);
        return { desktopId: desktop.desktopId, destroyed: true, quitApps: [] };
      }
      case 'app.list':
        return { apps: [{ process: this.windows[0].process, bundleId: this.windows[0].bundleId, name: this.windows[0].appName, active: false, hidden: false }] };
      case 'app.launch': {
        const desktop = this.desktop(params.desktopId as Id);
        const window: WindowState = {
          windowId: 100 + this.windows.length, process: { pid: 1000 + this.windows.length, startedAt: now() }, appName: 'FakeApp',
          bundleId: (params.bundleId as string) ?? null, title: 'FakeApp', frame: { x: 0, y: 25, width: 800, height: 600 }, onScreen: true,
        };
        this.windows.push(window);
        return { desktopId: desktop.desktopId, process: window.process, windows: [{ windowId: window.windowId, appName: window.appName, title: window.title ?? '', frame: window.frame }] };
      }
      case 'window.list': {
        if (context.desktopId) this.desktop(context.desktopId);
        return {
          windows: this.windows
            .filter((w) => (params.pid === undefined || w.process.pid === params.pid) && (params.bundleId === undefined || w.bundleId === params.bundleId))
            .filter((w) => params.includeOffscreen === true || w.onScreen),
        };
      }
      case 'window.bind': {
        const desktop = this.desktop(params.desktopId as Id);
        const window = this.windows.find((w) => w.process.pid === params.pid && (params.windowId === undefined || w.windowId === params.windowId));
        if (!window) throw new FakeError('not_found', `no window for pid ${params.pid}`);
        this.bind(desktop, window);
        return this.desktopView(desktop);
      }
      case 'window.unbind': {
        const desktop = this.desktop(params.desktopId as Id);
        desktop.binding = null;
        return this.desktopView(desktop);
      }
      case 'session.open': {
        const desktop = this.desktop(params.desktopId as Id);
        const session: Session = { sessionId: this.id('ses'), desktopId: desktop.desktopId, state: 'open', createdAt: now() };
        this.sessions.set(session.sessionId, session);
        return { ...session };
      }
      case 'session.show':
        return { ...this.session(params.sessionId as Id, false) };
      case 'session.close': {
        const session = this.session(params.sessionId as Id, false);
        if (session.state === 'open') this.closeSession(session);
        return { ...session };
      }
      case 'observe': {
        const session = this.sessionFromContext(context);
        const desktop = this.desktop(session.desktopId);
        const snapshot = this.capture(desktop, params.screenshot !== false, params.elements !== false, params.query as string | undefined, context.runId);
        return {
          snapshotId: snapshot.snapshotId, desktopId: desktop.desktopId, sessionId: session.sessionId, capturedAt: now(), screen: desktop.screen,
          target: desktop.binding ? this.targetView(desktop) : null,
          image: snapshot.image ? this.imageView(snapshot.image.artifactId, snapshot.image.transform) : null,
          elements: snapshot.elements,
        };
      }
      case 'request.show': {
        const record = this.records.get(params.requestId as Id);
        if (!record) throw new FakeError('not_found', `no request ${params.requestId}`);
        return { ...record };
      }
      case 'act':
        return { ...this.act(conn, context, params as { snapshotId: Id; action: Record<string, unknown> }, requestId, receiptOverride) };
      case 'wait': {
        const session = this.sessionFromContext(context);
        const desktop = this.desktop(session.desktopId);
        const condition = params.condition as { kind: string; role?: string; label?: string; labelContains?: string };
        const snapshot = this.capture(desktop, false, true, undefined, context.runId);
        const matches = snapshot.elements.filter((el) =>
          (condition.role === undefined || el.role === condition.role)
          && (condition.label === undefined || el.label === condition.label)
          && (condition.labelContains === undefined || (el.label ?? '').includes(condition.labelContains)));
        return { satisfied: true, snapshotId: snapshot.snapshotId, matches: condition.kind === 'elementAbsent' ? [] : matches };
      }
      case 'run.start': {
        const session = this.sessionFromContext(context);
        const escalation = ['lifetime', 'ownership', 'origin'].filter((k) => k in params);
        if (escalation.length && this.options.refuseEscalation !== false) {
          throw new FakeError('ownership_escalation_denied', `run.start must not carry ${escalation.join(', ')}`, { phase: 'request', details: { keys: escalation } });
        }
        const run: RunState = {
          runId: this.id('run'), kind: 'act', origin: 'agent_hub', ownership: 'external_client', lifetime: 'connection_scoped',
          clientId: this.options.principal?.clientId ?? 'local:501', connectionId: conn.id, sessionId: session.sessionId, desktopId: session.desktopId,
          phase: 'running', outcome: null, quiescence: 'not_confirmed', closingReason: null, revision: 1, createdAt: now(), receipts: [], unknownActions: 0,
          attachToken: randomBytes(32).toString('hex'), seq: 0, events: [],
        };
        this.runs.set(run.runId, run);
        conn.runIds.add(run.runId);
        this.emit(run, 'run.started', { sessionId: run.sessionId });
        return { run: this.runView(run), attachToken: run.attachToken };
      }
      case 'run.attach': {
        const run = this.run(params.runId as Id);
        if (run.attachToken !== params.token) throw new FakeError('permission_denied', 'attach token does not match', { phase: 'handler' });
        conn.runIds.add(run.runId);
        return this.runView(run);
      }
      case 'run.finish': {
        const run = this.run(params.runId as Id);
        if (run.phase !== 'ended') this.endRun(run, (params.exitCode ?? 0) === 0 ? 'success' : 'failed', 'finished');
        return this.runView(run);
      }
      case 'run.show':
        return this.runView(this.run(params.runId as Id));
      case 'run.wait': {
        const run = this.run(params.runId as Id);
        const deadline = Date.now() + (params.timeoutMs as number);
        while (run.phase !== 'ended' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
        }
        return this.runView(run);
      }
      case 'run.cancel': {
        const run = this.run(params.runId as Id);
        const alreadyTerminal = run.phase === 'ended';
        if (!alreadyTerminal) this.endRun(run, 'cancelled', 'cancelled');
        return {
          cancelRequest: { accepted: true, scope: { kind: 'run', id: run.runId } },
          execution: { phase: run.phase, quiescence: run.quiescence, outcome: run.outcome, revision: run.revision },
          ...(alreadyTerminal ? { alreadyTerminal: true } : {}),
        };
      }
      case 'run.list': {
        const runs = [...this.runs.values()].filter((r) =>
          (params.desktopId === undefined || r.desktopId === params.desktopId)
          && (params.phase === undefined || r.phase === params.phase)
          && (params.origin === undefined || r.origin === params.origin)
          && (params.clientId === undefined || r.clientId === params.clientId)
          && (params.active === undefined || (r.phase !== 'ended') === params.active));
        return { runs: runs.map((r) => this.runView(r)), next: null };
      }
      case 'run.events': {
        const run = this.run(params.runId as Id);
        const after = (params.after as number) ?? 0;
        const limit = (params.limit as number) ?? 500;
        const events = run.events.filter((e) => e.sequence > after).slice(0, limit);
        return { events, next: events.length ? events[events.length - 1].sequence : after, ended: run.phase === 'ended' };
      }
      case 'runtime.stopAll': {
        this.admission = 'stopped';
        const stopped: Record<string, unknown>[] = [];
        for (const run of this.runs.values()) {
          if (run.phase === 'ended') continue;
          this.endRun(run, 'cancelled', 'stop_all');
          stopped.push({ runId: run.runId, accepted: true, phase: run.phase, quiescence: run.quiescence, outcome: run.outcome });
        }
        return { admission: this.admission, runs: stopped, pending: [] };
      }
      case 'runtime.enableInput':
        this.admission = 'enabled';
        return { admission: 'enabled' };
      case 'artifact.show':
        return this.artifactView(this.artifact(params.artifactId as Id));
      case 'artifact.read': {
        const artifact = this.artifact(params.artifactId as Id);
        const offset = (params.offset as number) ?? 0;
        const length = Math.min((params.length as number) ?? MAX_ARTIFACT_CHUNK_BYTES, MAX_ARTIFACT_CHUNK_BYTES);
        const slice = artifact.bytes.subarray(offset, Math.min(artifact.bytes.byteLength, offset + length));
        return { artifactId: artifact.artifactId, offset, length: slice.byteLength, eof: offset + slice.byteLength >= artifact.bytes.byteLength, dataBase64: slice.toString('base64') };
      }
      case 'events.subscribe': {
        const after = params.after as number | undefined;
        const retainedFrom = this.options.retainedEventsFrom ?? 0;
        if (params.runId !== undefined) {
          const run = this.run(params.runId as Id);
          if (after !== undefined && after < retainedFrom) throw new FakeError('events_cursor_expired', `cursor ${after} is before the retained range (${retainedFrom})`);
          conn.subscription = { runId: run.runId };
          return { subscribed: true, runId: run.runId, next: after ?? 0 };
        }
        const start = after ?? this.globalCursor;
        if (start < retainedFrom) throw new FakeError('events_cursor_expired', `cursor ${start} is before the retained range (${retainedFrom})`);
        conn.subscription = {};
        return { subscribed: true, next: start };
      }
      case 'events.unsubscribe':
        conn.subscription = null;
        return { subscribed: false };
      default:
        throw new FakeError('capability_missing', `${method} is not implemented by the fake`, { phase: 'request' });
    }
  }

  private act(conn: Conn, context: RequestContext, params: { snapshotId: Id; action: Record<string, unknown> }, requestId: Id, override?: Partial<ActionReceipt>): ActionReceipt {
    const session = this.sessionFromContext(context);
    if (!context.runId) throw new FakeError('invalid_argument', 'act needs context.runId', { phase: 'request' });
    const run = this.run(context.runId);
    if (run.phase === 'ended') throw new FakeError('run_not_active', `run ${run.runId} has ended`);
    if (this.admission !== 'enabled') throw new FakeError('input_disabled', 'input is stopped for all Runs');
    const snapshot = this.snapshots.get(params.snapshotId);
    if (!snapshot) throw new FakeError('not_found', `no snapshot ${params.snapshotId}`);
    const desktop = this.desktop(session.desktopId);
    if (snapshot.desktopId !== desktop.desktopId) throw new FakeError('invalid_target', 'snapshot belongs to another Desktop', { notSent: true });
    if (!desktop.binding) throw new FakeError('invalid_target', 'desktop has no bound window', { notSent: true });
    const target = params.action.target as { elementRef?: Id; imagePoint?: { x: number; y: number } } | undefined;
    let elementRef: Id | null = null;
    let point: { x: number; y: number } | null = null;
    if (target?.elementRef !== undefined) {
      const element = snapshot.elements.find((el) => el.id === target.elementRef);
      if (!element) throw new FakeError('invalid_target', `element ${target.elementRef} is not in snapshot ${snapshot.snapshotId}`, { notSent: true });
      elementRef = element.id;
      if (element.frame) point = { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 };
    } else if (target?.imagePoint) {
      const t = snapshot.image?.transform ?? { originX: 0, originY: 0, scale: 1 };
      point = { x: t.originX + target.imagePoint.x / t.scale, y: t.originY + target.imagePoint.y / t.scale };
    }
    const at = now();
    const receipt: ActionReceipt = {
      receiptId: this.id('rcpt'), requestId, runId: run.runId, desktopId: desktop.desktopId, sessionId: session.sessionId, snapshotId: snapshot.snapshotId,
      delivery: 'dispatched', execution: 'completed', verification: 'not_requested', businessResult: 'not_evaluated', route: 'fake.background',
      target: { generation: desktop.binding.generation, process: desktop.binding.process, windowId: desktop.binding.windowId, elementRef, point },
      timing: { acceptedAt: at, dispatchedAt: at, completedAt: at },
      ...override,
    };
    this.receipts.set(receipt.receiptId, receipt);
    run.receipts.push(receipt.receiptId);
    run.revision += 1;
    if (receipt.delivery === 'unknown' || receipt.execution === 'unknown') run.unknownActions += 1;
    this.emit(run, 'action.receipt', { receiptId: receipt.receiptId, requestId, delivery: receipt.delivery, execution: receipt.execution, kind: params.action.kind });
    void conn;
    return receipt;
  }

  // ---- state helpers -----------------------------------------------------

  private id(prefix: string): Id {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  private desktop(desktopId: Id): DesktopState {
    const desktop = this.desktops.get(desktopId);
    if (!desktop) throw new FakeError('not_found', `no desktop ${desktopId}`);
    return desktop;
  }

  private session(sessionId: Id, mustBeOpen: boolean): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new FakeError('not_found', `no session ${sessionId}`);
    if (mustBeOpen && session.state !== 'open') throw new FakeError('conflict', `session ${sessionId} is closed`);
    return session;
  }

  private sessionFromContext(context: RequestContext): Session {
    if (!context.sessionId) throw new FakeError('invalid_argument', 'context.sessionId is required', { phase: 'request' });
    return this.session(context.sessionId, true);
  }

  private closeSession(session: Session): void {
    session.state = 'closed';
    session.closedAt = now();
    for (const run of this.runs.values()) if (run.sessionId === session.sessionId && run.phase !== 'ended') this.endRun(run, 'cancelled', 'session_closed');
  }

  private run(runId: Id): RunState {
    const run = this.runs.get(runId);
    if (!run) throw new FakeError('not_found', `no run ${runId}`);
    return run;
  }

  private artifact(artifactId: Id): ArtifactState {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new FakeError('not_found', `no artifact ${artifactId}`);
    return artifact;
  }

  private bind(desktop: DesktopState, window: WindowState): void {
    desktop.generation += 1;
    desktop.binding = { generation: desktop.generation, process: window.process, windowId: window.windowId, appName: window.appName, boundAt: now() };
  }

  private capture(desktop: DesktopState, screenshot: boolean, elements: boolean, query: string | undefined, runId: Id | undefined): SnapshotState {
    let image: SnapshotState['image'] = null;
    if (screenshot) {
      const spec = this.options.screenshot ?? {};
      const byteSize = spec.byteSize ?? 16_384;
      const bytes = Buffer.alloc(byteSize);
      for (let i = 0; i < byteSize; i += 1) bytes[i] = (i * 31 + this.counter) & 0xff;
      const artifact: ArtifactState = { artifactId: this.id('art'), mediaType: 'image/png', byteSize, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: now(), ...(runId ? { runId } : {}), bytes };
      this.artifacts.set(artifact.artifactId, artifact);
      const frame = desktop.binding ? this.windowFrame(desktop) : desktop.screen.frame;
      image = { artifactId: artifact.artifactId, transform: { originX: frame.x, originY: frame.y, scale: 2 } };
    }
    const all = elements && desktop.binding ? (this.options.elements ?? DEFAULT_ELEMENTS) : [];
    const filtered = query ? all.filter((el) => (el.label ?? '').includes(query) || el.role.includes(query)) : all;
    const snapshot: SnapshotState = { snapshotId: this.id('snap'), desktopId: desktop.desktopId, elements: filtered, image };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }

  private windowFrame(desktop: DesktopState): Rect {
    const window = this.windows.find((w) => w.windowId === desktop.binding?.windowId);
    return window?.frame ?? desktop.screen.frame;
  }

  private emit(run: RunState, type: string, data: Record<string, unknown>): RunEvent {
    run.seq += 1;
    this.globalCursor += 1;
    const event: RunEvent = { runId: run.runId, sequence: run.seq, at: now(), type, data };
    run.events.push(event);
    this.globalEvents.push({ cursor: this.globalCursor, event });
    for (const conn of this.conns.values()) {
      if (!conn.subscription) continue;
      if (conn.subscription.runId !== undefined) {
        if (conn.subscription.runId !== run.runId) continue;
        this.write(conn, { apiVersion: RUNTIME_API_VERSION, event, cursor: event.sequence });
        if (run.phase === 'ended') conn.socket.end();
      } else {
        this.write(conn, { apiVersion: RUNTIME_API_VERSION, event, cursor: this.globalCursor });
      }
    }
    return event;
  }

  private flushSubscription(conn: Conn, params: Record<string, unknown>): void {
    if (!conn.subscription) return;
    const after = params.after as number | undefined;
    if (conn.subscription.runId !== undefined) {
      const run = this.run(conn.subscription.runId);
      for (const event of run.events) if (event.sequence > (after ?? 0)) this.write(conn, { apiVersion: RUNTIME_API_VERSION, event, cursor: event.sequence });
      if (run.phase === 'ended') conn.socket.end();
      return;
    }
    const start = after ?? this.globalCursor;
    for (const entry of this.globalEvents) if (entry.cursor > start) this.write(conn, { apiVersion: RUNTIME_API_VERSION, event: entry.event, cursor: entry.cursor });
  }

  private endRun(run: RunState, outcome: 'success' | 'failed' | 'cancelled' | 'unknown', closingReason: string): void {
    run.phase = 'ended';
    run.outcome = outcome;
    run.quiescence = 'confirmed';
    run.closingReason = closingReason;
    run.revision += 1;
    run.endedAt = now();
    this.emit(run, 'run.ended', { outcome, closingReason });
  }

  private desktopView(desktop: DesktopState): Record<string, unknown> {
    return {
      desktopId: desktop.desktopId, name: desktop.name, state: desktop.state, createdAt: desktop.createdAt, screen: desktop.screen,
      binding: desktop.binding, openSessions: [...this.sessions.values()].filter((s) => s.desktopId === desktop.desktopId && s.state === 'open').length,
    };
  }

  private targetView(desktop: DesktopState): Record<string, unknown> {
    const binding = desktop.binding!;
    const window = this.windows.find((w) => w.windowId === binding.windowId);
    return { generation: binding.generation, process: binding.process, windowId: binding.windowId, windowFrame: this.windowFrame(desktop), title: window?.title ?? binding.appName };
  }

  private imageView(artifactId: Id, transform: { originX: number; originY: number; scale: number }): Record<string, unknown> {
    const artifact = this.artifact(artifactId);
    const spec = this.options.screenshot ?? {};
    return { artifactId, mediaType: 'image/png', width: spec.width ?? 2560, height: spec.height ?? 1750, byteSize: artifact.byteSize, sha256: artifact.sha256, transform };
  }

  private artifactView(artifact: ArtifactState): Record<string, unknown> {
    const { bytes: _bytes, ...view } = artifact;
    return view;
  }

  private runView(run: RunState): Record<string, unknown> {
    const { attachToken: _token, connectionId, seq: _seq, events: _events, ...view } = run;
    return { ...view, connectionId };
  }
}

function summarize(method: string, data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (method === 'act') return { receiptId: data.receiptId, delivery: data.delivery, execution: data.execution };
  if (method === 'run.start') return { runId: (data.run as { runId: Id }).runId };
  return undefined;
}
