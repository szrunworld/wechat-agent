// Main-process side of the typed IPC: validates the method against the
// whitelist again (the preload is the first gate, this is the second), calls
// the ApplicationService, and wraps the outcome in an envelope. Pure, so the
// rejection path is unit-tested without Electron.
import { IpcFailure, type ApplicationService, type IpcError } from '@wechat-agent/ports';
import { isIpcMethod, rejectedMethod, type CallEnvelope } from './channels.ts';

export function toIpcError(error: unknown): IpcError {
  if (error instanceof IpcFailure) return error.error;
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message };
}

export function createCallGateway(service: ApplicationService) {
  return async (method: unknown, params: unknown): Promise<CallEnvelope> => {
    if (!isIpcMethod(method)) return { ok: false, error: rejectedMethod(method) };
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      return { ok: false, error: { code: 'blocked', message: 'params must be an object' } };
    }
    try {
      const result = await service.call(method, (params ?? {}) as never);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: toIpcError(error) };
    }
  };
}
