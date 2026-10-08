// The two IPC channels between the preload bridge and the main process, and
// the envelope that carries a typed-IPC result or a structured IpcError across
// them. Electron's ipcMain.handle flattens rejected errors to a plain message,
// so the error travels inside the envelope and the bridge rethrows it as
// IpcFailure in the renderer.
import { IPC_METHODS, type IpcError, type IpcMethod } from '@wechat-agent/ports';

export const CALL_CHANNEL = 'wechat-agent:call';
export const SNAPSHOT_CHANNEL = 'wechat-agent:snapshot';

export type CallEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: IpcError };

const allowed: ReadonlySet<string> = new Set(IPC_METHODS);

/** True only for a method in the frozen whitelist of packages/ports. */
export function isIpcMethod(method: unknown): method is IpcMethod {
  return typeof method === 'string' && allowed.has(method);
}

export function rejectedMethod(method: unknown): IpcError {
  const shown = typeof method === 'string' ? method : typeof method;
  return { code: 'blocked', message: `method not in IPC whitelist: ${shown}` };
}
