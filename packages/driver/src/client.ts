// AgentDesktop runtime/1 client over runtime.sock (docs/lanes/lane-a.md).
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RUNTIME_ENDPOINT, DriverError, EXPECTED_PRODUCT, MAX_ARTIFACT_CHUNK_BYTES, RUNTIME_API_VERSION,
} from '@wechat-agent/ports';
import type {
  Action, ActionReceipt, AgentDesktopDriver, Artifact, Capabilities, CancelReceipt, Desktop, DriverConfig, DriverState,
  EventFrame, EventStream, HandshakeResult, Id, Observation, Principal, RequestContext, RequestRecord, Run, RuntimeIdentity,
  RuntimeRequest, Session, WaitCondition, WaitResult, Window,
} from '@wechat-agent/ports';
import { RpcConnection } from './connection.ts';
import { requestProblems, stripUndefined } from './schema.ts';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** Extra time granted to server-side waits (run.wait / wait) on top of their own timeoutMs. */
const WAIT_GRACE_MS = 2_000;

/** `~` and `~/...` expand to the home directory; nothing else is rewritten and no other socket is probed. */
export function resolveEndpoint(endpoint: string | undefined): string {
  const raw = endpoint ?? DEFAULT_RUNTIME_ENDPOINT;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function local(code: string, message: string, details?: Record<string, unknown>): DriverError {
  return new DriverError({ code, message, phase: 'local', retryable: false, notSent: true, details });
}

function notConnected(state: DriverState): DriverError {
  return new DriverError({
    code: 'connection_lost',
    message: `control connection is not open (driver state: ${state}); call connect() first`,
    phase: 'transport',
    retryable: false,
    notSent: true,
    details: { state },
  });
}

let requestCounter = 0;
function nextRequestId(): Id {
  requestCounter += 1;
  return `rq_${Date.now().toString(36)}_${process.pid.toString(36)}_${requestCounter.toString(36)}`;
}

interface CallOptions { context?: RequestContext; requestId?: Id; timeoutMs?: number }

/** One request/response on a connection, validated against the snapshot before it is written. */
async function rawCall<T = Record<string, unknown>>(conn: RpcConnection, method: string, params: Record<string, unknown>, options: CallOptions, defaultTimeoutMs: number): Promise<T> {
  const request: RuntimeRequest = {
    apiVersion: RUNTIME_API_VERSION,
    requestId: options.requestId ?? nextRequestId(),
    method,
    ...(options.context ? { context: stripUndefined(options.context as Record<string, unknown>) as RequestContext } : {}),
    params: stripUndefined(params),
  };
  const problems = requestProblems(request);
  if (problems.length) throw local('schema_invalid', `${method}: request fails runtime.schema.json: ${problems.join('; ')}`, { method, problems });
  const response = await conn.request(request, options.timeoutMs ?? defaultTimeoutMs);
  if (!response.ok) throw new DriverError(response.error);
  return response.data as T;
}

async function performHandshake(conn: RpcConnection, client: DriverConfig['client'], timeoutMs: number): Promise<HandshakeResult> {
  const raw = await rawCall<Record<string, unknown>>(conn, 'runtime.handshake', { apiVersions: [RUNTIME_API_VERSION], client }, {}, timeoutMs);
  const { principal, ...identity } = raw as Record<string, unknown> & { principal?: Principal };
  const apiVersions = Array.isArray(identity.apiVersions) ? (identity.apiVersions as unknown[]) : [];
  if (identity.product !== EXPECTED_PRODUCT) {
    throw new DriverError({
      code: 'version_mismatch',
      message: `endpoint answered as product ${JSON.stringify(identity.product)}, expected ${EXPECTED_PRODUCT}`,
      phase: 'handshake',
      retryable: false,
      notSent: false,
      details: { reason: 'product', product: identity.product, expected: EXPECTED_PRODUCT },
    });
  }
  if (!apiVersions.includes(RUNTIME_API_VERSION)) {
    throw new DriverError({
      code: 'version_mismatch',
      message: `Runtime speaks ${JSON.stringify(apiVersions)}, this driver needs ${RUNTIME_API_VERSION}`,
      phase: 'handshake',
      retryable: false,
      notSent: false,
      details: { reason: 'apiVersion', apiVersions, expected: RUNTIME_API_VERSION },
    });
  }
  return { identity: identity as unknown as RuntimeIdentity, principal, raw };
}

function isIncompatible(error: unknown): boolean {
  return error instanceof DriverError && (error.error.code === 'version_mismatch' || error.error.code === 'instance_mismatch');
}

/** Unbounded FIFO bridging push frames to an async iterator. */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((item: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: item });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ done: false, value: this.items.shift() as T });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const FINISH_EXIT_CODES: Record<'success' | 'failed' | 'cancelled', number> = { success: 0, failed: 1, cancelled: 130 };

class Driver implements AgentDesktopDriver {
  state: DriverState = 'disconnected';
  private conn: RpcConnection | null = null;
  private readonly subscriptions = new Set<RpcConnection>();
  private readonly endpoint: string;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly config: DriverConfig) {
    this.endpoint = resolveEndpoint(config.endpoint);
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async connect(): Promise<HandshakeResult> {
    if (this.state === 'connected' || this.state === 'connecting') throw local('invalid_argument', `connect() called while ${this.state}`);
    this.state = 'connecting';
    let conn: RpcConnection;
    try {
      conn = await RpcConnection.connect(this.endpoint, this.connectTimeoutMs);
    } catch (error) {
      this.state = 'disconnected';
      throw error;
    }
    try {
      const result = await performHandshake(conn, this.config.client, this.requestTimeoutMs);
      this.conn = conn;
      this.state = 'connected';
      conn.onClose = () => {
        if (this.conn !== conn) return;
        this.conn = null;
        // No automatic reconnect (T34): the app decides when to connect again.
        if (this.state === 'connected') this.state = 'disconnected';
      };
      return result;
    } catch (error) {
      conn.destroy();
      this.state = isIncompatible(error) ? 'incompatible' : 'disconnected';
      throw error;
    }
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    this.state = 'closed';
    for (const sub of [...this.subscriptions]) sub.destroy();
    this.subscriptions.clear();
    if (conn) await conn.close();
  }

  private call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    if (this.state !== 'connected' || !this.conn || !this.conn.open) return Promise.reject(notConnected(this.state));
    return rawCall<T>(this.conn, method, params, options, this.requestTimeoutMs);
  }

  capabilities(): Promise<Capabilities> {
    return this.call<Capabilities>('runtime.capabilities');
  }

  status(): Promise<Record<string, unknown>> {
    return this.call('runtime.status');
  }

  async listDesktops(): Promise<Desktop[]> {
    return (await this.call<{ desktops: Desktop[] }>('desktop.list')).desktops;
  }

  async listWindows(params?: { desktopId?: Id; pid?: number }): Promise<Window[]> {
    // window_list_params has no desktopId; the Desktop goes into the envelope context.
    const context = params?.desktopId ? { desktopId: params.desktopId } : undefined;
    return (await this.call<{ windows: Window[] }>('window.list', { pid: params?.pid }, { context })).windows;
  }

  bindWindow(params: { desktopId: Id; pid: number; windowId?: number }): Promise<Desktop> {
    return this.call<Desktop>('window.bind', { desktopId: params.desktopId, pid: params.pid, windowId: params.windowId });
  }

  unbindWindow(params: { desktopId: Id }): Promise<Desktop> {
    return this.call<Desktop>('window.unbind', { desktopId: params.desktopId });
  }

  openSession(desktopId: Id): Promise<Session> {
    return this.call<Session>('session.open', { desktopId });
  }

  closeSession(sessionId: Id): Promise<Session> {
    return this.call<Session>('session.close', { sessionId });
  }

  /** Delegated Run: params stay empty; lifetime/ownership/origin are never sent (ADR-05, T36). The attach token is dropped, never stored. */
  async startRun(sessionId: Id): Promise<Run> {
    const { run } = await this.call<{ run: Run; attachToken: string }>('run.start', {}, { context: { sessionId } });
    return run;
  }

  finishRun(runId: Id, outcome: 'success' | 'failed' | 'cancelled'): Promise<Run> {
    return this.call<Run>('run.finish', { runId, exitCode: FINISH_EXIT_CODES[outcome] });
  }

  showRun(runId: Id): Promise<Run> {
    return this.call<Run>('run.show', { runId });
  }

  waitRun(runId: Id, timeoutMs: number): Promise<Run> {
    return this.call<Run>('run.wait', { runId, timeoutMs }, { timeoutMs: timeoutMs + Math.max(this.requestTimeoutMs, WAIT_GRACE_MS) });
  }

  cancelRun(runId: Id): Promise<CancelReceipt> {
    return this.call<CancelReceipt>('run.cancel', { runId });
  }

  async listRuns(): Promise<Run[]> {
    const runs: Run[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: { runs: Run[]; next: string | null } = await this.call<{ runs: Run[]; next: string | null }>('run.list', cursor ? { cursor } : {});
      runs.push(...page.runs);
      if (!page.next || page.next === cursor) break;
      cursor = page.next;
    }
    return runs;
  }

  observe(context: { sessionId: Id; runId?: Id }, params?: { screenshot?: boolean; elements?: boolean; query?: string }): Promise<Observation> {
    return this.call<Observation>('observe', { screenshot: params?.screenshot, elements: params?.elements, query: params?.query }, { context });
  }

  act(context: { sessionId: Id; runId: Id }, params: { snapshotId: Id; action: Action }, requestId: Id): Promise<ActionReceipt> {
    // The caller's requestId is the envelope requestId: the platform's idempotency key.
    return this.call<ActionReceipt>('act', { snapshotId: params.snapshotId, action: params.action }, { context, requestId });
  }

  wait(context: { sessionId: Id; runId?: Id }, params: { condition: WaitCondition; timeoutMs: number }): Promise<WaitResult> {
    return this.call<WaitResult>('wait', { condition: params.condition, timeoutMs: params.timeoutMs }, { context, timeoutMs: params.timeoutMs + Math.max(this.requestTimeoutMs, WAIT_GRACE_MS) });
  }

  showRequest(requestId: Id): Promise<RequestRecord> {
    return this.call<RequestRecord>('request.show', { requestId });
  }

  showArtifact(artifactId: Id): Promise<Artifact> {
    return this.call<Artifact>('artifact.show', { artifactId });
  }

  async readArtifact(artifactId: Id): Promise<Uint8Array> {
    const meta = await this.showArtifact(artifactId);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await this.call<{ artifactId: Id; offset: number; length: number; eof: boolean; dataBase64: string }>(
        'artifact.read', { artifactId, offset, length: MAX_ARTIFACT_CHUNK_BYTES },
      );
      const bytes = Buffer.from(chunk.dataBase64, 'base64');
      if (chunk.offset !== offset || bytes.byteLength !== chunk.length || bytes.byteLength > MAX_ARTIFACT_CHUNK_BYTES) {
        throw local('internal_error', `artifact.read returned an inconsistent chunk for ${artifactId}`, { artifactId, expectedOffset: offset, chunk: { offset: chunk.offset, length: chunk.length, decoded: bytes.byteLength } });
      }
      chunks.push(bytes);
      offset += bytes.byteLength;
      if (chunk.eof) break;
      if (bytes.byteLength === 0 || offset > meta.byteSize) {
        throw local('internal_error', `artifact.read for ${artifactId} does not converge (offset ${offset}, byteSize ${meta.byteSize})`, { artifactId, offset, byteSize: meta.byteSize });
      }
    }
    const data = Buffer.concat(chunks);
    if (data.byteLength !== meta.byteSize) {
      throw local('internal_error', `artifact ${artifactId}: read ${data.byteLength} bytes, artifact.show said ${meta.byteSize}`, { artifactId, expected: meta.byteSize, actual: data.byteLength });
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== meta.sha256) {
      throw local('internal_error', `artifact ${artifactId}: sha256 mismatch`, { artifactId, expected: meta.sha256, actual: sha256 });
    }
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Own connection + own handshake; the control connection is untouched by its life or death. */
  async subscribe(params?: { runId?: Id; after?: number }): Promise<EventStream> {
    const conn = await RpcConnection.connect(this.endpoint, this.connectTimeoutMs);
    const queue = new AsyncQueue<EventFrame | DriverError>();
    let cursor = params?.after ?? 0;
    conn.onPush = (frame) => {
      if (isEventFrame(frame)) {
        if (typeof frame.cursor === 'number') cursor = frame.cursor;
        queue.push(frame);
      } else if (frame.ok === false && typeof frame.error === 'object' && frame.error !== null) {
        queue.push(new DriverError(frame.error as DriverError['error']));
      }
    };
    conn.onClose = () => {
      this.subscriptions.delete(conn);
      queue.end(); // a dropped subscription ends the iterator; the caller re-subscribes from `cursor`
    };
    try {
      await performHandshake(conn, this.config.client, this.requestTimeoutMs);
      const ack = await rawCall<{ subscribed: boolean; runId?: Id; next?: number }>(conn, 'events.subscribe', { runId: params?.runId, after: params?.after }, {}, this.requestTimeoutMs);
      if (typeof ack.next === 'number') cursor = ack.next;
    } catch (error) {
      conn.destroy();
      throw error; // events_cursor_expired and friends pass through unchanged
    }
    this.subscriptions.add(conn);
    const stream: EventStream = {
      get cursor() { return cursor; },
      async close() {
        queue.end();
        await conn.close();
      },
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<EventFrame>> {
            const item = await queue.next();
            if (item.done) return { done: true, value: undefined };
            if (item.value instanceof DriverError) throw item.value;
            return { done: false, value: item.value };
          },
          async return(): Promise<IteratorResult<EventFrame>> {
            await stream.close();
            return { done: true, value: undefined };
          },
        };
      },
    };
    return stream;
  }
}

function isEventFrame(frame: Record<string, unknown>): frame is EventFrame & Record<string, unknown> {
  const event = frame.event;
  return frame.apiVersion === RUNTIME_API_VERSION && typeof event === 'object' && event !== null && typeof (event as { runId?: unknown }).runId === 'string';
}

export function createDriver(config: DriverConfig): AgentDesktopDriver {
  if (!config?.client?.name || !config.client.version) throw local('invalid_argument', 'createDriver needs client.name and client.version');
  return new Driver(config);
}
