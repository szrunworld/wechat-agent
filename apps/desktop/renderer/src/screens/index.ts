import type { AppSnapshot } from '@wechat-agent/ports';
import type { Call } from '../service.ts';
import type { Tone } from '../components/StatusBadge.tsx';

export type ScreenKey = 'W01' | 'W02' | 'W03' | 'W04' | 'W05' | 'W06';

export const SCREENS: { key: ScreenKey; title: string }[] = [
  { key: 'W01', title: '连接与账号' },
  { key: 'W02', title: '工作台' },
  { key: 'W03', title: '好友审批' },
  { key: 'W04', title: '加好友与回复' },
  { key: 'W05', title: '任务详情' },
  { key: 'W06', title: '设置与诊断' },
];

export type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>;

export interface ScreenProps {
  snapshot: AppSnapshot;
  call: Call;
  /** Runs an IPC action with busy/feedback handling. */
  run: Run;
  busy: boolean;
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
  go: (screen: ScreenKey) => void;
  report: (message: string, tone: Tone) => void;
}
