// Preload: runs in the renderer's isolated world with sandbox: true, so it is
// bundled (build.mjs) and may only require 'electron'. It exposes exactly
// { call, subscribe } as window.wechatAgent; `call` refuses any method that
// is not in IPC_METHODS before it reaches ipcRenderer.
import { contextBridge, ipcRenderer } from 'electron';
import { buildBridge } from './bridge.ts';

const bridge = buildBridge({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

contextBridge.exposeInMainWorld('wechatAgent', bridge);
