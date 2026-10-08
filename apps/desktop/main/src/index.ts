// Lane G. See docs/lanes/lane-g.md. Pure modules only: main.ts and preload.ts
// are the Electron entry points and are bundled by build.mjs, not re-exported.
import { IPC_METHODS } from '@wechat-agent/ports';
export const preloadWhitelist: readonly string[] = IPC_METHODS;
export { CALL_CHANNEL, SNAPSHOT_CHANNEL, isIpcMethod, rejectedMethod, type CallEnvelope } from './channels.ts';
export { buildBridge, type RendererTransport } from './bridge.ts';
export { createCallGateway, toIpcError } from './gateway.ts';
export { shellStatus, trayToggle, STATUS_LABEL, type ShellStatus } from './status.ts';
export { decideClose, CLOSE_HINT, type CloseContext, type CloseDecision } from './lifecycle.ts';
export { runQuitFlow, quitPrompt, gateSettles, type QuitOutcome, type QuitFlowOptions, type QuitPhase } from './quit.ts';
