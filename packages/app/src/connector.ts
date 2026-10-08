// RuntimeConnector (方案 E02/E03): one long-lived control connection, an
// independent event subscription, and the first four setup steps
// (discover → contract → pairing → window). A drop closes the write gate at
// once (through the hook) and reconnects with exponential backoff; a
// reconnect only re-establishes observation. Old Runs are never resumed here.
import { DriverError, EXPECTED_PRODUCT, RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type { AgentDesktopDriver, Capabilities, ConnectionState, EventFrame, EventStream, HandshakeResult, Id, SetupStep } from '@wechat-agent/ports';
import { errorMessage, type Scheduler } from './support.ts';

/** Methods the app itself needs; handlers declare their own on top. */
export const CORE_METHODS: readonly string[] = [
  'runtime.handshake', 'runtime.capabilities', 'desktop.list', 'window.list', 'window.bind', 'session.open', 'session.close',
  'run.start', 'run.finish', 'run.show', 'run.wait', 'run.cancel', 'observe', 'act', 'request.show', 'artifact.show', 'artifact.read', 'events.subscribe',
];
export const WECHAT_BUNDLE_ID = 'com.tencent.xinWeChat';
/** A finished event stream is re-opened after this long; never a hot loop, whatever the reconnect backoff is. */
export const EVENTS_RESUBSCRIBE_MS = 1_000;
const STEP_KEYS: SetupStep['key'][] = ['discover', 'contract', 'pairing', 'window', 'account', 'baseline'];

export class SetupSteps {
  readonly steps: SetupStep[] = STEP_KEYS.map((key) => ({ key, state: 'pending' }));

  get(key: SetupStep['key']): SetupStep {
    return this.steps.find((s) => s.key === key)!;
  }

  set(key: SetupStep['key'], state: SetupStep['state'], detail?: string): void {
    const step = this.get(key);
    step.state = state;
    if (detail === undefined) delete step.detail;
    else step.detail = detail;
  }

  /** Puts `from` and every later step back to pending. */
  reset(from: SetupStep['key']): void {
    let resetting = false;
    for (const step of this.steps) {
      if (step.key === from) resetting = true;
      if (resetting) { step.state = 'pending'; delete step.detail; }
    }
  }

  snapshot(): SetupStep[] {
    return this.steps.map((s) => ({ ...s }));
  }
}

export interface ConnectorHooks {
  onConnected(): Promise<void> | void;
  onDisconnected(reason: string): void;
  onEvent(frame: EventFrame): void;
  onChange(): void;
  log(line: string): void;
}

export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof DriverError)) return false;
  const { code, phase } = error.error;
  return code === 'connection_lost' || code === 'runtime_offline' || code === 'handshake_required' || phase === 'connect' || phase === 'transport';
}

function isContractError(error: unknown): boolean {
  if (!(error instanceof DriverError)) return false;
  const { code, phase } = error.error;
  return phase === 'handshake' || code === 'version_mismatch' || code === 'capability_mismatch' || code === 'instance_mismatch' || code === 'unsupported_backend';
}

export class RuntimeConnector {
  state: ConnectionState = 'disconnected';
  handshake: HandshakeResult | undefined;
  capabilities: Capabilities | undefined;
  methods: string[] = [];
  missingCapabilities: string[] = [];
  desktopId: Id | undefined;
  binding: { pid: number; windowId: number; title: string | null } | undefined;
  lastError: string | undefined;
  readonly steps = new SetupSteps();
  /** Successful connects, for tests that assert a reconnect happened. */
  connects = 0;
  private attempts = 0;
  private timer: unknown;
  private eventTimer: unknown;
  private stream: EventStream | undefined;
  private cursor: number | undefined;
  private stopped = false;
  private connecting: Promise<ConnectionState> | undefined;

  constructor(
    private readonly driver: AgentDesktopDriver,
    private readonly reconnect: { baseMs: number; maxMs: number },
    private readonly scheduler: Scheduler,
    private readonly hooks: ConnectorHooks,
  ) {}

  get paired(): boolean {
    return this.handshake?.principal?.role === 'paired';
  }

  get principal(): { clientId: string; role: string } | undefined {
    const p = this.handshake?.principal;
    return p ? { clientId: p.clientId, role: p.role } : undefined;
  }

  /** Control connection usable for observation (pairing may still be missing). */
  get ready(): boolean {
    return this.state === 'ready' || this.state === 'unpaired';
  }

  /** One attempt at discover → contract → pairing → window. Never throws. */
  connect(): Promise<ConnectionState> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => { this.connecting = undefined; this.hooks.onChange(); });
    return this.connecting;
  }

  private async connectOnce(): Promise<ConnectionState> {
    if (this.stopped) return this.state;
    this.state = 'connecting';
    this.steps.reset('discover');
    this.hooks.onChange();

    let handshake: HandshakeResult;
    try {
      handshake = await this.driver.connect();
    } catch (error) {
      if (isContractError(error)) {
        this.steps.set('discover', 'done');
        return this.fail('contract', `协议握手失败：${errorMessage(error)}`, 'incompatible');
      }
      return this.fail('discover', `未找到 AgentDesktop：${errorMessage(error)}`, 'disconnected');
    }
    this.handshake = handshake;
    this.steps.set('discover', 'done', handshake.identity.endpoint);

    const { identity } = handshake;
    const versionOk = identity.apiVersion === RUNTIME_API_VERSION || (identity.apiVersions ?? []).includes(RUNTIME_API_VERSION);
    if (identity.product !== EXPECTED_PRODUCT || !versionOk) {
      this.missingCapabilities = ['observe', 'act'];
      return this.fail('contract', `产品/协议不匹配：${identity.product} ${identity.apiVersion}，需要 ${EXPECTED_PRODUCT} ${RUNTIME_API_VERSION}`, 'incompatible');
    }
    try {
      this.capabilities = await this.driver.capabilities();
    } catch (error) {
      return this.fail('discover', `读取能力失败：${errorMessage(error)}`, 'disconnected');
    }
    this.methods = this.capabilities.interface.methods.map((m) => m.method);
    this.missingCapabilities = CORE_METHODS.filter((m) => !this.methods.includes(m));
    if (this.missingCapabilities.length) {
      return this.fail('contract', `平台缺少方法：${this.missingCapabilities.join(', ')}`, 'incompatible');
    }
    this.steps.set('contract', 'done', `${identity.product} ${identity.apiVersion}`);

    if (this.paired) this.steps.set('pairing', 'done', handshake.principal?.clientId);
    else this.steps.set('pairing', 'blocked', `未配对（principal.role=${handshake.principal?.role ?? 'none'}）：CR01 落地前外发保持 blocked`);

    try {
      await this.bindWeChatWindow();
    } catch (error) {
      if (isConnectionError(error)) return this.fail('discover', `连接中断：${errorMessage(error)}`, 'disconnected');
      this.steps.set('window', 'failed', errorMessage(error));
      this.desktopId = undefined;
      this.binding = undefined;
    }

    this.state = this.paired ? 'ready' : 'unpaired';
    this.attempts = 0;
    this.connects += 1;
    this.lastError = undefined;
    this.startEvents();
    await this.hooks.onConnected();
    return this.state;
  }

  private async bindWeChatWindow(): Promise<void> {
    const desktops = await this.driver.listDesktops();
    const desktop = desktops.find((d) => d.state === 'ready') ?? desktops[0];
    if (!desktop) throw new Error('没有可用的桌面');
    const windows = await this.driver.listWindows();
    const wechat = windows.find((w) => w.bundleId === WECHAT_BUNDLE_ID);
    if (!wechat) throw new Error(`未找到微信窗口（bundleId ${WECHAT_BUNDLE_ID}）`);
    const boundPid = (desktop.binding as { pid?: number } | null | undefined)?.pid;
    const bound = boundPid === wechat.process.pid ? desktop : await this.driver.bindWindow({ desktopId: desktop.desktopId, pid: wechat.process.pid, windowId: wechat.windowId });
    this.desktopId = bound.desktopId;
    this.binding = { pid: wechat.process.pid, windowId: wechat.windowId, title: wechat.title };
    this.steps.set('window', 'done', `${wechat.appName} #${wechat.windowId}`);
  }

  private fail(step: 'discover' | 'contract', detail: string, state: ConnectionState): ConnectionState {
    this.steps.set(step, 'failed', detail);
    this.state = state;
    this.lastError = detail;
    this.hooks.log(`connector: ${step} failed: ${detail}`);
    if (state === 'disconnected') this.scheduleReconnect();
    return state;
  }

  /** Anyone who saw the control connection drop reports it here. Idempotent. */
  noteDisconnected(reason: string): void {
    if (this.state === 'disconnected' && this.timer) return;
    const wasReady = this.ready;
    this.state = 'disconnected';
    this.lastError = reason;
    this.steps.reset('discover');
    this.steps.set('discover', 'failed', `连接中断：${reason}`);
    this.closeStream();
    if (wasReady) this.hooks.onDisconnected(reason);
    this.scheduleReconnect();
    this.hooks.onChange();
  }

  /** Inspects an error from any driver call; a connection error flips the connector. */
  observeError(error: unknown): boolean {
    if (!isConnectionError(error)) return false;
    this.noteDisconnected(error instanceof DriverError ? error.error.code : errorMessage(error));
    return true;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(this.reconnect.baseMs * 2 ** this.attempts, this.reconnect.maxMs);
    this.attempts += 1;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
  }

  /** Skips the backoff wait (tests, or a person pressing "retry"). */
  async reconnectNow(): Promise<ConnectionState> {
    if (this.timer) { this.scheduler.clearTimeout(this.timer); this.timer = undefined; }
    return this.connect();
  }

  private startEvents(): void {
    this.closeStream();
    void this.pumpEvents();
  }

  private async pumpEvents(): Promise<void> {
    if (this.stopped || !this.ready) return;
    let stream: EventStream;
    try {
      stream = await this.driver.subscribe(this.cursor === undefined ? undefined : { after: this.cursor });
    } catch (error) {
      if (error instanceof DriverError && error.error.code === 'events_cursor_expired') {
        this.cursor = undefined;
        this.eventTimer = this.scheduler.setTimeout(() => void this.pumpEvents(), EVENTS_RESUBSCRIBE_MS);
        return;
      }
      if (!this.observeError(error)) this.hooks.log(`events: subscribe failed: ${errorMessage(error)}`);
      return;
    }
    this.stream = stream;
    try {
      for await (const frame of stream) {
        if (frame.cursor !== undefined) this.cursor = frame.cursor;
        this.hooks.onEvent(frame);
      }
      if (!this.stopped && this.stream === stream && this.ready) {
        this.stream = undefined;
        this.eventTimer = this.scheduler.setTimeout(() => void this.pumpEvents(), EVENTS_RESUBSCRIBE_MS);
      }
    } catch (error) {
      if (this.stream === stream) this.stream = undefined;
      if (error instanceof DriverError && error.error.code === 'events_cursor_expired') {
        this.cursor = undefined;
        this.eventTimer = this.scheduler.setTimeout(() => void this.pumpEvents(), EVENTS_RESUBSCRIBE_MS);
        return;
      }
      if (!this.observeError(error)) this.hooks.log(`events: stream failed: ${errorMessage(error)}`);
    }
  }

  private closeStream(): void {
    if (this.eventTimer) { this.scheduler.clearTimeout(this.eventTimer); this.eventTimer = undefined; }
    const stream = this.stream;
    this.stream = undefined;
    if (stream) void stream.close().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { this.scheduler.clearTimeout(this.timer); this.timer = undefined; }
    this.closeStream();
    if (this.driver.state === 'connected') await this.driver.close().catch(() => undefined);
    this.state = 'disconnected';
  }
}
