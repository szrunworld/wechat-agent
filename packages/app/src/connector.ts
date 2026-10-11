// RuntimeConnector (方案 E02/E03): one long-lived control connection, an
// independent event subscription, and the first four setup steps
// (discover → contract → pairing → window). A drop closes the write gate at
// once (through the hook) and reconnects with exponential backoff; a
// reconnect only re-establishes observation. Old Runs are never resumed here.
//
// Pairing (A4, agentdesktop #137): the app is an ordinary client of
// runtime.sock. Who it is comes only from the credential it shows in the
// handshake; without one the Runtime answers nothing but pairing. The person
// pairs it in AgentDesktop's trusted window (Touch ID); the credential arrives
// once, on the connection that asked, and is kept in the CredentialStore.
// What a paired app may reach is its grant, as the Runtime enforces it: the
// app never assumes more, never asks for owner calls, and stops — instead of
// reconnecting in a loop — when its access is revoked or runs out.
import { DriverError, EXPECTED_PRODUCT, IpcFailure, RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type {
  AgentDesktopDriver, Capabilities, ConnectionState, CredentialStore, EventFrame, EventStream, GrantRequest, HandshakeResult, HubGrant, Id, PairingView,
  SetupStep, StoredCredential, Timestamp,
} from '@wechat-agent/ports';
import { errorMessage, type Scheduler } from './support.ts';

/** Methods the app itself needs; handlers declare their own on top. */
export const CORE_METHODS: readonly string[] = [
  'runtime.handshake', 'runtime.capabilities', 'hub.pairing.start', 'hub.pairing.status', 'desktop.list', 'window.list', 'window.bind', 'session.open', 'session.close',
  'run.start', 'run.finish', 'run.show', 'run.wait', 'run.cancel', 'observe', 'act', 'request.show', 'artifact.show', 'artifact.read', 'events.subscribe',
];

export interface PairingConfig {
  /** Shown to the person as self-reported: one line of printable text. */
  agentName: string;
  publisher?: string;
  /**
   * What the person is asked to allow. observe: lists, observe, artifacts; act: session.open (observe needs a
   * session) and act; desktop.manage: window.bind; run: run.* and events. Desktops and apps name the scope;
   * the Runtime grants exactly this or nothing.
   */
  requested: GrantRequest;
  /** hub.pairing.status polling interval while the person decides. */
  pollMs: number;
}

/** After the person refuses, AgentDesktop takes no new request from this program for a minute. */
export const PAIRING_COOLDOWN_MS = 60_000;

/** The Runtime no longer accepts this app's access: the credential is gone or the grant does not let it work. */
export function isAccessLost(error: unknown): boolean {
  return accessLoss(error) !== undefined;
}

type AccessLoss = 'revoked' | 'unpaired' | 'no_access';

function reasonOf(error: DriverError): string | undefined {
  const reason = error.error.details?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function accessLoss(error: unknown): AccessLoss | undefined {
  if (!(error instanceof DriverError)) return undefined;
  const { code } = error.error;
  const reason = reasonOf(error);
  if (code === 'client_revoked') return 'revoked';
  // The credential does not prove this app (unknown to the Runtime, or another program now holds it).
  if (code === 'permission_denied' && (reason === 'bad_credential' || reason === 'code_identity_mismatch' || reason === 'owner_not_on_socket')) return 'revoked';
  if (code === 'pairing_required') return 'unpaired';
  if (code === 'grant_expired') return 'no_access';
  if (code === 'grant_missing' && reason === 'no_grant') return 'no_access';
  return undefined;
}

/** The owner narrowed or revoked the grant: the Runtime cut this connection; a reconnect shows what is left. */
function isCut(error: unknown): boolean {
  return error instanceof DriverError && error.error.code === 'grant_missing' && ['grant_revoked', 'grant_narrowed', 'connection_cut'].includes(reasonOf(error) ?? '');
}

/** Words a person can act on, for a refusal of the Runtime. */
export function describeRefusal(error: unknown): string {
  if (!(error instanceof DriverError)) return errorMessage(error);
  const { code } = error.error;
  const reason = reasonOf(error);
  switch (code) {
    case 'client_revoked': return '本应用在 AgentDesktop 中的授权已被撤销，需要重新配对';
    case 'pairing_required': return '尚未与 AgentDesktop 配对';
    case 'grant_expired': return '授权已过期：请在 AgentDesktop 中续期后点“重新检查”';
    case 'grant_missing':
      if (reason === 'no_grant') return '授权已被收回：请在 AgentDesktop 中重新授权';
      if (reason === 'bind_requires_grant') return '授权不足：授权里没有这个应用，不能绑定它的窗口';
      if (reason === 'launch_requires_grant') return '授权不足：授权里没有这个应用，不能启动它';
      if (reason === 'window_discovery_requires_grant') return '授权不足：没有查看窗口列表的权限';
      if (typeof error.error.details?.capability === 'string') return `授权不足：缺少 ${error.error.details.capability} 权限`;
      return `授权不足：${error.error.message}`;
    case 'permission_denied':
      switch (reason) {
        case 'bad_credential': return '保存的凭据不被 AgentDesktop 认可，需要重新配对';
        case 'code_identity_mismatch': return '凭据属于另一个程序签名，需要重新配对';
        case 'owner_not_on_socket': return 'AgentDesktop 不接受以所有者身份连接，需要配对';
        case 'pairing_cooldown': return '刚刚被拒绝：一分钟后才能再次申请配对';
        case 'pairing_busy': return '已有一个配对申请在等待确认';
        case 'no_trusted_ui': return 'AgentDesktop 无法显示确认窗口，配对未完成';
        case 'owner_only': return '该操作只允许 AgentDesktop 本人在主窗口中进行';
        case 'physical_desktop_requires_grant': return '物理窗口 Desktop 尚未开放（等待窗口级授权）';
        default: return `被 AgentDesktop 拒绝：${error.error.message}`;
      }
    default: return errorMessage(error);
  }
}
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
  return code === 'connection_lost' || code === 'runtime_offline' || code === 'handshake_required' || phase === 'connect' || phase === 'transport' || isCut(error);
}

/** The platform is out of reach for this task: the connection dropped, or the app's access is gone. */
export function isPlatformLost(error: unknown): boolean {
  return isConnectionError(error) || isAccessLost(error);
}

function isContractError(error: unknown): boolean {
  if (!(error instanceof DriverError)) return false;
  const { code, phase } = error.error;
  return phase === 'handshake' || code === 'version_mismatch' || code === 'capability_mismatch' || code === 'instance_mismatch' || code === 'unsupported_backend';
}

function grantView(grant: HubGrant | undefined): PairingView['grant'] {
  return grant ? { capabilities: [...grant.capabilities], desktops: [...grant.desktops], apps: [...grant.apps], expiresAt: grant.expiresAt } : undefined;
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
  /** What the person sees about pairing; never holds the token. */
  pairing: PairingView = { state: 'unpaired' };
  private pairingId: Id | undefined;
  private pairingTimer: unknown;
  private cooldownUntil = 0;
  /** A credential that arrived but could not be stored: used for this process only. */
  private unsaved: StoredCredential | null = null;

  constructor(
    private readonly driver: AgentDesktopDriver,
    private readonly reconnect: { baseMs: number; maxMs: number },
    private readonly scheduler: Scheduler,
    private readonly hooks: ConnectorHooks,
    private readonly access: { credentials: CredentialStore; pairing: PairingConfig; now: () => Timestamp },
  ) {}

  /** Paired with a usable grant: the Runtime said so in this connection's handshake. Never owner. */
  get paired(): boolean {
    return this.handshake?.principal?.role === 'paired' && this.state === 'ready';
  }

  get principal(): { clientId: string; role: string } | undefined {
    const p = this.handshake?.principal;
    return p ? { clientId: p.clientId, role: p.role } : undefined;
  }

  /** Control connection usable for observation: paired, with a grant (A4: an unpaired app may only pair). */
  get ready(): boolean {
    return this.state === 'ready';
  }

  private nowMs(): number {
    return Date.parse(this.access.now());
  }

  private async loadCredential(): Promise<StoredCredential | null> {
    if (this.unsaved) return this.unsaved;
    try {
      return await this.access.credentials.load();
    } catch (error) {
      this.hooks.log(`connector: credential store unreadable: ${errorMessage(error)}`);
      return null;
    }
  }

  private async forgetCredential(): Promise<void> {
    this.unsaved = null;
    await this.access.credentials.clear().catch((error: unknown) => this.hooks.log(`connector: could not clear the credential: ${errorMessage(error)}`));
  }

  private refusal(error: unknown): PairingView['refusal'] {
    const e = error instanceof DriverError ? error.error : undefined;
    const reason = e?.details?.reason;
    return { code: e?.code ?? 'error', ...(typeof reason === 'string' ? { reason } : {}), message: describeRefusal(error), at: this.access.now() };
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

    // A reconnect always starts from a fresh socket. The driver keeps its socket after a
    // deadline_exceeded (a late reply is ignored) while this connector already counted that as a
    // lost connection; createDriver().connect() refuses to run while 'connected', so the stale
    // connection is closed here. Closing it also ends its connection_scoped Run on the platform,
    // which is what the app assumed when it parked the task (ADR v2.2).
    if (this.driver.state === 'connected') await this.driver.close().catch(() => undefined);
    const credential = await this.loadCredential();
    let handshake: HandshakeResult;
    try {
      handshake = await this.driver.connect({ credential });
    } catch (error) {
      if (accessLoss(error)) {
        this.steps.set('discover', 'done');
        this.steps.set('contract', 'done');
        await this.loseAccess(error);
        return this.state;
      }
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

    const principal = handshake.principal;
    if (principal?.role !== 'paired') {
      // Unpaired (or, never on a socket, owner): nothing but pairing. The app does not run as owner.
      this.attempts = 0;
      this.connects += 1;
      this.lastError = undefined;
      this.desktopId = undefined;
      this.binding = undefined;
      const owner = principal?.role === 'owner';
      if (owner) this.steps.set('pairing', 'failed', '握手返回所有者身份：本应用不以所有者身份运行，只使用配对身份');
      else this.steps.set('pairing', 'blocked', '未配对：请在本应用中申请配对，并在 AgentDesktop 的确认窗口中核对配对码后用 Touch ID 批准');
      this.steps.set('window', 'blocked', '需要先完成配对');
      if (this.pairingId && this.pairing.state === 'waiting') this.state = 'pairing';
      else {
        this.state = 'unpaired';
        if (this.pairing.state === 'paired' || this.pairing.state === 'no_access') this.pairing = { state: 'unpaired' };
      }
      return this.state;
    }
    this.steps.set('pairing', 'done', principal.clientId);
    this.pairing = {
      ...this.pairing, state: 'paired', clientId: principal.clientId, codeIdentityLevel: principal.codeIdentityLevel,
      grant: grantView(credential?.grant) ?? (this.pairing.clientId === principal.clientId ? this.pairing.grant : undefined),
      refusal: undefined, shortCode: undefined, expiresAt: undefined, retryAfter: undefined, detail: undefined,
    };

    try {
      await this.bindWeChatWindow();
    } catch (error) {
      if (isConnectionError(error)) return this.fail('discover', `连接中断：${errorMessage(error)}`, 'disconnected');
      if (accessLoss(error)) {
        await this.loseAccess(error);
        return this.state;
      }
      // What the grant does not cover is a clear refusal, not a broken connection: say so and stay paired.
      this.steps.set('window', 'failed', error instanceof DriverError ? describeRefusal(error) : errorMessage(error));
      if (error instanceof DriverError) this.pairing = { ...this.pairing, refusal: this.refusal(error) };
      this.desktopId = undefined;
      this.binding = undefined;
    }

    this.state = 'ready';
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
    // The grant decides which Desktops exist for this app. The app creates none and attaches no display.
    if (!desktop) throw new Error('授权范围内没有可用的桌面：物理窗口 Desktop 尚未开放（等待窗口级授权），本应用不创建虚拟桌面');
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
    // Revoked: nothing reconnects until the person pairs again.
    if (this.state === 'revoked') return;
    const wasReady = this.ready;
    this.lapsePairing('连接中断，配对申请已失效（AgentDesktop 只把凭据交给发起申请的那条连接）');
    this.state = 'disconnected';
    this.lastError = reason;
    this.steps.reset('discover');
    this.steps.set('discover', 'failed', `连接中断：${reason}`);
    this.closeStream();
    // The platform must see what the app decided: a connection the app gave up on is closed now,
    // so its Delegated Run ends on the platform too instead of lingering with input admitted.
    if (this.driver.state === 'connected') void this.driver.close().catch(() => undefined);
    if (wasReady) this.hooks.onDisconnected(reason);
    this.scheduleReconnect();
    this.hooks.onChange();
  }

  /** Inspects an error from any driver call; a connection error or lost access flips the connector. */
  observeError(error: unknown): boolean {
    if (accessLoss(error)) {
      void this.loseAccess(error);
      return true;
    }
    if (!isConnectionError(error)) return false;
    this.noteDisconnected(error instanceof DriverError ? error.error.code : errorMessage(error));
    return true;
  }

  /**
   * The Runtime no longer accepts this app's access. Revoked (or a credential that proves nothing): the
   * credential is dropped and nothing reconnects until the person pairs again. Grant gone or expired: the
   * credential is kept (the owner can renew), the connection is left as it is, and nothing retries by itself.
   * Either way the write gate closes now.
   */
  private async loseAccess(error: unknown): Promise<void> {
    const loss = accessLoss(error);
    if (!loss) return;
    const wasReady = this.ready;
    const detail = describeRefusal(error);
    this.lastError = detail;
    this.hooks.log(`connector: access lost (${loss}): ${detail}`);
    if (this.timer) { this.scheduler.clearTimeout(this.timer); this.timer = undefined; }
    this.closeStream();
    this.desktopId = undefined;
    this.binding = undefined;
    this.steps.reset('pairing');
    if (loss === 'no_access') {
      this.state = 'no_access';
      this.pairing = { ...this.pairing, state: 'no_access', refusal: this.refusal(error) };
      this.steps.set('pairing', 'failed', detail);
    } else {
      this.state = loss === 'revoked' ? 'revoked' : 'unpaired';
      this.lapsePairing();
      this.pairing = { state: loss === 'revoked' ? 'revoked' : 'unpaired', refusal: this.refusal(error) };
      this.steps.set('pairing', 'failed', detail);
      if (loss === 'revoked') {
        await this.forgetCredential();
        if (this.driver.state === 'connected') await this.driver.close().catch(() => undefined);
      }
    }
    if (wasReady) this.hooks.onDisconnected(`access_lost:${loss}`);
    this.hooks.onChange();
  }

  // ---- pairing ---------------------------------------------------------------

  /**
   * Asks AgentDesktop to pair this app: hub.pairing.start on an unpaired connection, then hub.pairing.status
   * on that same connection until the person answers in the trusted window. Approved: the credential is
   * stored and the app reconnects with it. The app never approves anything itself.
   */
  async startPairing(): Promise<PairingView> {
    if (this.stopped) throw new IpcFailure({ code: 'invalid_state', message: '应用已停止' });
    if (this.state === 'ready') throw new IpcFailure({ code: 'invalid_state', message: '已配对' });
    if (this.state === 'no_access') {
      throw new IpcFailure({ code: 'invalid_state', message: '已配对，但授权已过期或被收回：请在 AgentDesktop 中续期或重新授权，不必再次配对', details: { reasonCode: 'grant_missing' } });
    }
    if (this.pairingId && this.pairing.state === 'waiting') return { ...this.pairing };
    if (this.nowMs() < this.cooldownUntil) {
      throw new IpcFailure({ code: 'blocked', message: '刚刚被拒绝：一分钟后才能再次申请配对', details: { retryAfter: new Date(this.cooldownUntil).toISOString() } });
    }
    if (this.connecting) await this.connecting.catch(() => undefined);
    // An unpaired connection of its own: the credential, once approved, goes only to the connection that asked.
    if (this.state !== 'unpaired' || this.driver.state !== 'connected' || this.handshake?.principal?.role !== 'unpaired') {
      if (this.timer) { this.scheduler.clearTimeout(this.timer); this.timer = undefined; }
      if (this.driver.state === 'connected') await this.driver.close().catch(() => undefined);
      this.state = 'connecting';
      this.hooks.onChange();
      try {
        this.handshake = await this.driver.connect({ credential: null });
      } catch (error) {
        this.state = 'disconnected';
        this.steps.set('discover', 'failed', `未找到 AgentDesktop：${errorMessage(error)}`);
        this.hooks.onChange();
        throw new IpcFailure({ code: 'unavailable', message: `无法连接 AgentDesktop：${errorMessage(error)}` });
      }
      if (this.handshake.principal?.role !== 'unpaired') {
        await this.driver.close().catch(() => undefined);
        this.state = 'disconnected';
        this.hooks.onChange();
        throw new IpcFailure({ code: 'invalid_state', message: `握手身份不是未配对（${this.handshake.principal?.role ?? '无'}），不发起配对` });
      }
      this.state = 'unpaired';
      this.steps.set('discover', 'done', this.handshake.identity.endpoint);
    }
    const { agentName, publisher, requested } = this.access.pairing;
    let started;
    try {
      started = await this.driver.startPairing({ agentName, ...(publisher ? { publisher } : {}), requested });
    } catch (error) {
      if (error instanceof DriverError && reasonOf(error) === 'pairing_cooldown') this.cooldownUntil = this.nowMs() + PAIRING_COOLDOWN_MS;
      this.pairing = {
        state: this.pairing.state === 'revoked' ? 'revoked' : 'unpaired', refusal: this.refusal(error),
        ...(this.cooldownUntil > this.nowMs() ? { retryAfter: new Date(this.cooldownUntil).toISOString() } : {}),
      };
      if (isConnectionError(error)) this.noteDisconnected(error instanceof DriverError ? error.error.code : errorMessage(error));
      this.hooks.onChange();
      throw new IpcFailure({ code: 'blocked', message: describeRefusal(error), details: { reasonCode: 'pairing_missing', ...(error instanceof DriverError ? { platform: { code: error.error.code, reason: reasonOf(error) } } : {}) } });
    }
    this.pairingId = started.pairingId;
    this.pairing = { state: 'waiting', shortCode: started.shortCode, expiresAt: started.expiresAt };
    this.state = 'pairing';
    this.steps.set('pairing', 'blocked', `等待确认：请在 AgentDesktop 的确认窗口核对配对码 ${started.shortCode}，再用 Touch ID 批准`);
    this.hooks.log(`connector: pairing ${started.pairingId} requested`);
    this.schedulePairingPoll();
    this.hooks.onChange();
    return { ...this.pairing };
  }

  private schedulePairingPoll(): void {
    if (this.pairingTimer) this.scheduler.clearTimeout(this.pairingTimer);
    this.pairingTimer = this.scheduler.setTimeout(() => {
      this.pairingTimer = undefined;
      void this.pollPairing();
    }, this.access.pairing.pollMs);
  }

  /** One hub.pairing.status. Exposed for tests that drive time by hand. */
  async pollPairing(): Promise<PairingView> {
    const pairingId = this.pairingId;
    if (!pairingId || this.state !== 'pairing') return { ...this.pairing };
    let status;
    try {
      status = await this.driver.pairingStatus(pairingId);
    } catch (error) {
      if (this.pairingId !== pairingId) return { ...this.pairing };
      if (isConnectionError(error)) {
        this.noteDisconnected(error instanceof DriverError ? error.error.code : errorMessage(error));
      } else {
        this.lapsePairing(`查询配对状态失败：${describeRefusal(error)}`);
        this.state = 'unpaired';
        this.hooks.onChange();
      }
      return { ...this.pairing };
    }
    if (this.pairingId !== pairingId) return { ...this.pairing };
    switch (status.state) {
      case 'requested':
        if (Date.parse(status.expiresAt) <= this.nowMs()) { this.lapsePairing('配对申请已过期'); this.state = 'unpaired'; break; }
        this.schedulePairingPoll();
        return { ...this.pairing };
      case 'denied':
        this.pairingId = undefined;
        this.cooldownUntil = this.nowMs() + PAIRING_COOLDOWN_MS;
        this.pairing = { state: 'denied', retryAfter: new Date(this.cooldownUntil).toISOString(), detail: '配对未获批准（拒绝、取消、超时或无法验证身份）；一分钟后才能再次申请' };
        this.steps.set('pairing', 'blocked', this.pairing.detail);
        this.state = 'unpaired';
        break;
      case 'expired':
        this.lapsePairing('配对申请已过期');
        this.state = 'unpaired';
        break;
      case 'approved': {
        this.pairingId = undefined;
        if (!status.credential) {
          this.pairing = { state: 'unpaired', detail: '配对已批准，但凭据没有交给本连接；请重新申请' };
          this.state = 'unpaired';
          break;
        }
        const stored: StoredCredential = { clientId: status.credential.clientId, token: status.credential.token, ...(status.grant ? { grant: status.grant } : {}), pairedAt: this.access.now() };
        try {
          await this.access.credentials.save(stored);
          this.unsaved = null;
        } catch (error) {
          // Paired for this run of the app only; the person is told it will have to pair again.
          this.unsaved = stored;
          this.hooks.log(`connector: credential could not be stored: ${errorMessage(error)}`);
        }
        this.pairing = {
          state: 'paired', clientId: stored.clientId, grant: grantView(status.grant),
          ...(this.unsaved ? { detail: '凭据未能保存：本次运行有效，重启后需要重新配对' } : {}),
        };
        this.hooks.log(`connector: paired as ${stored.clientId}`);
        // The identity of a connection never changes after its handshake: reconnect with the credential.
        this.state = 'connecting';
        this.hooks.onChange();
        await this.connect();
        return { ...this.pairing };
      }
    }
    this.hooks.onChange();
    return { ...this.pairing };
  }

  /** An open pairing request is gone (the connection that asked closed, or it lapsed). */
  private lapsePairing(detail?: string): void {
    if (this.pairingTimer) { this.scheduler.clearTimeout(this.pairingTimer); this.pairingTimer = undefined; }
    if (!this.pairingId) return;
    this.pairingId = undefined;
    if (this.pairing.state === 'waiting') this.pairing = { state: 'expired', ...(detail ? { detail } : {}) };
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

  /** Skips the backoff wait (tests, or a person pressing "retry"). A revoked app pairs again instead. */
  async reconnectNow(): Promise<ConnectionState> {
    if (this.state === 'revoked' || this.state === 'pairing') return this.state;
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
    this.lapsePairing();
    this.closeStream();
    if (this.driver.state === 'connected') await this.driver.close().catch(() => undefined);
    this.state = 'disconnected';
  }
}
