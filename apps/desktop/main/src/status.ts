// Menu-bar status derived from the AppSnapshot. Four words the tray shows;
// `quiescence_unconfirmed` is its own word because it is not "paused".
import type { AppSnapshot } from '@wechat-agent/ports';

export type ShellStatus = 'running' | 'stopping' | 'paused' | 'offline' | 'quiescence_unconfirmed';

export const STATUS_LABEL: Record<ShellStatus, string> = {
  running: '运行中',
  stopping: '停止中',
  paused: '已暂停',
  offline: '离线',
  quiescence_unconfirmed: '静止未确认',
};

export function shellStatus(snapshot: Pick<AppSnapshot, 'connection' | 'inputGate'>): ShellStatus {
  if (snapshot.inputGate === 'quiescence_unconfirmed') return 'quiescence_unconfirmed';
  if (snapshot.inputGate === 'stopping') return 'stopping';
  if (snapshot.connection.state !== 'ready') return 'offline';
  return snapshot.inputGate === 'open' ? 'running' : 'paused';
}

/** Which of pause / resume the tray offers; neither while stopping or unconfirmed. */
export function trayToggle(status: ShellStatus): 'pause' | 'resume' | null {
  if (status === 'running') return 'pause';
  if (status === 'paused') return 'resume';
  return null;
}
