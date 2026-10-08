// A Unix-socket connection speaking runtime/1 frames: requests are matched to
// responses by requestId (the server answers in order; matching by id also
// tolerates a late reply after a local timeout), frames that are not a reply
// to a pending request are handed to `onPush` (event subscriptions).
import net from 'node:net';
import { DriverError, RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type { RuntimeError, RuntimeRequest, RuntimeResponse } from '@wechat-agent/ports';
import { encodeFrame, LineDecoder } from './framing.ts';

interface Pending {
  requestId: string;
  resolve: (response: RuntimeResponse) => void;
  reject: (error: DriverError) => void;
  timer: NodeJS.Timeout;
}

export function connectError(code: RuntimeError['code'], message: string, details?: Record<string, unknown>): DriverError {
  return new DriverError({ code, message, phase: 'connect', retryable: code === 'runtime_offline', notSent: true, details });
}

function mapSocketError(err: NodeJS.ErrnoException, endpoint: string): DriverError {
  const code = err.code ?? 'UNKNOWN';
  if (code === 'EACCES' || code === 'EPERM') {
    return connectError('permission_denied', `endpoint ${endpoint} refused the connection: ${code}`, { errno: code, endpoint });
  }
  return connectError('runtime_offline', `no Runtime accepted the connection at ${endpoint}: ${code}`, { errno: code, endpoint });
}

export class RpcConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly order: Pending[] = [];
  private readonly decoder = new LineDecoder();
  private closed = false;

  /** Frames that are not a reply to a pending request. */
  onPush: (frame: Record<string, unknown>) => void = () => {};
  /** Fired once, when the socket is gone (closed locally or dropped by the peer). */
  onClose: () => void = () => {};

  static connect(endpoint: string, timeoutMs: number): Promise<RpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: endpoint });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(connectError('runtime_offline', `connect to ${endpoint} timed out after ${timeoutMs} ms`, { endpoint, timeoutMs }));
      }, timeoutMs);
      const onError = (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(mapSocketError(err, endpoint));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve(new RpcConnection(socket));
      });
    });
  }

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => { /* 'close' follows; pending requests are failed there */ });
    socket.on('close', () => this.handleClose());
  }

  get open(): boolean {
    return !this.closed;
  }

  /** Sends one request and waits for its reply. Throws DriverError only. */
  request(request: RuntimeRequest, timeoutMs: number): Promise<RuntimeResponse> {
    const line = encodeFrame(request); // frame_too_large is thrown before anything is written
    if (this.closed) {
      return Promise.reject(new DriverError({ code: 'connection_lost', message: 'connection is not open', phase: 'transport', retryable: false, notSent: true }));
    }
    return new Promise<RuntimeResponse>((resolve, reject) => {
      const pending: Pending = {
        requestId: request.requestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.forget(pending);
          reject(new DriverError({
            code: 'deadline_exceeded',
            message: `${request.method} (${request.requestId}) got no reply within ${timeoutMs} ms`,
            phase: 'transport',
            retryable: false,
            notSent: false,
            details: { method: request.method, requestId: request.requestId, timeoutMs },
          }));
        }, timeoutMs),
      };
      this.pending.set(request.requestId, pending);
      this.order.push(pending);
      this.socket.write(line, (err) => {
        if (err && this.pending.has(request.requestId)) {
          this.forget(pending);
          reject(new DriverError({ code: 'connection_lost', message: `write failed: ${err.message}`, phase: 'transport', retryable: false, notSent: false }));
        }
      });
    });
  }

  /** Sends a frame without waiting for a reply (used for events.unsubscribe on a subscription). */
  async send(frame: unknown): Promise<void> {
    const line = encodeFrame(frame);
    if (this.closed) throw new DriverError({ code: 'connection_lost', message: 'connection is not open', phase: 'transport', retryable: false, notSent: true });
    await new Promise<void>((resolve, reject) => {
      this.socket.write(line, (err) => (err ? reject(new DriverError({ code: 'connection_lost', message: `write failed: ${err.message}`, phase: 'transport', retryable: false, notSent: false })) : resolve()));
    });
  }

  /** Graceful close; resolves once the socket is closed. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.end();
      // A peer that never acks the FIN must not hang the caller.
      setTimeout(() => this.socket.destroy(), 200).unref();
    });
  }

  destroy(): void {
    if (!this.closed) this.socket.destroy();
  }

  private forget(pending: Pending): void {
    clearTimeout(pending.timer);
    this.pending.delete(pending.requestId);
    const i = this.order.indexOf(pending);
    if (i >= 0) this.order.splice(i, 1);
  }

  private onData(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch {
      // A peer that overruns the frame limit is not speaking the contract; drop it.
      this.socket.destroy();
      return;
    }
    for (const text of lines) {
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        this.socket.destroy();
        return;
      }
      if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) continue;
      this.dispatch(frame as Record<string, unknown>);
    }
  }

  private dispatch(frame: Record<string, unknown>): void {
    if (frame.apiVersion === RUNTIME_API_VERSION && typeof frame.ok === 'boolean') {
      const requestId = frame.requestId;
      let pending: Pending | undefined;
      if (typeof requestId === 'string') pending = this.pending.get(requestId);
      else if (requestId === null && frame.ok === false) pending = this.order[0];
      if (pending) {
        this.forget(pending);
        pending.resolve(frame as unknown as RuntimeResponse);
        return;
      }
      if (typeof requestId === 'string') return; // a late reply to a request that already timed out
    }
    this.onPush(frame);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const stranded = [...this.order];
    this.pending.clear();
    this.order.length = 0;
    for (const pending of stranded) {
      clearTimeout(pending.timer);
      pending.reject(new DriverError({
        code: 'connection_lost',
        message: `connection closed before a reply to ${pending.requestId} arrived`,
        phase: 'transport',
        retryable: false,
        notSent: false,
        details: { requestId: pending.requestId },
      }));
    }
    this.onClose();
  }
}
