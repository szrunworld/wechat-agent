// The only path from the renderer to the application service. Every call goes
// through the IPC_METHODS whitelist; there is no other channel and no Node.
import { IPC_METHODS, IpcFailure, type ApplicationService, type IpcMethod, type IpcMethods } from '@wechat-agent/ports';
import { IPC_ERROR } from './copy.ts';

export type Call = <M extends IpcMethod>(method: M, params: IpcMethods[M]['params']) => Promise<IpcMethods[M]['result']>;

export function makeCall(service: ApplicationService): Call {
  return (method, params) => {
    if (!IPC_METHODS.includes(method)) return Promise.reject(new Error(`方法不在 IPC 白名单内：${String(method)}`));
    return service.call(method, params);
  };
}

export function describeError(err: unknown): string {
  if (err instanceof IpcFailure) return `${IPC_ERROR[err.error.code] ?? err.error.code}：${err.error.message}`;
  if (err && typeof err === 'object' && 'error' in err) {
    const e = (err as { error?: { code?: string; message?: string } }).error;
    if (e?.code) return `${IPC_ERROR[e.code as keyof typeof IPC_ERROR] ?? e.code}：${e.message ?? ''}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function newOperationId(prefix: string): string {
  const c = globalThis.crypto;
  const rand = c && 'randomUUID' in c ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}:${rand}`;
}

/** SHA-256 hex of a string, via WebCrypto. Throws where WebCrypto is unavailable rather than inventing a weaker digest. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境没有 WebCrypto，无法计算内容哈希');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
