// What the preload exposes to the renderer: exactly { call, subscribe }, the
// ApplicationService shape. The transport is abstract so the bridge can be
// unit-tested in plain Node; preload.ts binds it to ipcRenderer.
import { IpcFailure, type ApplicationService, type AppSnapshot, type IpcMethod, type IpcMethods } from '@wechat-agent/ports';
import { CALL_CHANNEL, SNAPSHOT_CHANNEL, isIpcMethod, rejectedMethod, type CallEnvelope } from './channels.ts';

export interface RendererTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

export function buildBridge(transport: RendererTransport): ApplicationService {
  const bridge: ApplicationService = {
    async call<M extends IpcMethod>(method: M, params: IpcMethods[M]['params']): Promise<IpcMethods[M]['result']> {
      if (!isIpcMethod(method)) throw new IpcFailure(rejectedMethod(method));
      const envelope = (await transport.invoke(CALL_CHANNEL, method, params ?? {})) as CallEnvelope | undefined;
      if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
        throw new IpcFailure({ code: 'internal', message: 'malformed reply from main process' });
      }
      if (!envelope.ok) throw new IpcFailure(envelope.error);
      return envelope.result as IpcMethods[M]['result'];
    },
    subscribe(listener: (snapshot: AppSnapshot) => void): () => void {
      return transport.on(SNAPSHOT_CHANNEL, (payload) => listener(payload as AppSnapshot));
    },
  };
  // Frozen so a renderer cannot hang extra members on it before contextBridge copies it.
  return Object.freeze(bridge);
}
