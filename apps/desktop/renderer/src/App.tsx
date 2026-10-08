import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApplicationService, AppSnapshot } from '@wechat-agent/ports';
import type { FakeApplicationService, SnapshotKey } from '@wechat-agent/ports/fakes';
import { DevStatePanel } from './components/DevStatePanel.tsx';
import { Notice } from './components/Notice.tsx';
import { StatusBadge, type Tone } from './components/StatusBadge.tsx';
import { CONNECTION_STATE, INPUT_GATE } from './copy.ts';
import { SCREENS, type ScreenKey, type ScreenProps } from './screens/index.ts';
import { W01Setup } from './screens/W01Setup.tsx';
import { W02Workbench } from './screens/W02Workbench.tsx';
import { W03Approval } from './screens/W03Approval.tsx';
import { W04Compose } from './screens/W04Compose.tsx';
import { W05TaskDetail } from './screens/W05TaskDetail.tsx';
import { W06Settings } from './screens/W06Settings.tsx';
import { describeError, makeCall } from './service.ts';

export function connectionTone(s: AppSnapshot): Tone {
  if (s.connection.state === 'ready') return s.inputGate === 'open' ? 'ok' : 'warn';
  if (s.connection.state === 'connecting') return 'info';
  return 'danger';
}

export function App({ service, fake, initialScreen = 'W01' }: { service: ApplicationService; fake?: FakeApplicationService; initialScreen?: ScreenKey }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined);
  const [feedback, setFeedback] = useState<{ message: string; tone: Tone } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fakeKey, setFakeKey] = useState<SnapshotKey>(() => (new URLSearchParams(window.location.search).get('state') as SnapshotKey) || 'ready_idle');

  useEffect(() => service.subscribe((s) => setSnapshot(s)), [service]);

  const call = useMemo(() => makeCall(service), [service]);
  const report = useCallback((message: string, tone: Tone) => setFeedback({ message, tone }), []);
  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setFeedback({ message: `${label}：已提交`, tone: 'ok' });
    } catch (err) {
      setFeedback({ message: `${label}失败 — ${describeError(err)}`, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }, []);

  if (!snapshot) return <main className="app-loading" aria-busy="true">正在读取应用状态…</main>;

  const props: ScreenProps = { snapshot, call, run, busy, selectedTaskId, onSelectTask: setSelectedTaskId, go: setScreen, report };
  const Screen = { W01: W01Setup, W02: W02Workbench, W03: W03Approval, W04: W04Compose, W05: W05TaskDetail, W06: W06Settings }[screen];

  return (
    <div className="app" data-ready="true" data-screen={screen}>
      <a className="skip-link" href="#main">跳到主要内容</a>
      <header className="app-header">
        <div className="app-brand">WeChat Agent</div>
        <div className="app-status">
          <StatusBadge tone={connectionTone(snapshot)}>{CONNECTION_STATE[snapshot.connection.state]}</StatusBadge>
          <StatusBadge tone={snapshot.inputGate === 'open' ? 'ok' : 'warn'}>{INPUT_GATE[snapshot.inputGate]}</StatusBadge>
          {snapshot.account ? <span className="identity">{snapshot.account.visibleLabel}</span> : <span className="muted">未绑定账号</span>}
        </div>
        {fake ? <DevStatePanel fake={fake} current={fakeKey} onChange={setFakeKey} /> : null}
      </header>
      <div className="app-body">
        <nav className="app-nav" aria-label="屏幕">
          <ul>
            {SCREENS.map((s) => (
              <li key={s.key}>
                <button type="button" className={`nav-item${s.key === screen ? ' active' : ''}`} aria-current={s.key === screen ? 'page' : undefined} onClick={() => setScreen(s.key)}>
                  <span className="nav-key">{s.key}</span> {s.title}
                  {s.key === 'W03' && snapshot.counts.waitingApproval > 0 ? <span className="nav-count" aria-label={`${snapshot.counts.waitingApproval} 条待审批`}>{snapshot.counts.waitingApproval}</span> : null}
                  {s.key === 'W05' && snapshot.counts.needsReconciliation > 0 ? <span className="nav-count" aria-label={`${snapshot.counts.needsReconciliation} 条待核实`}>{snapshot.counts.needsReconciliation}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="app-main" tabIndex={-1}>
          {feedback ? (
            <div className="feedback">
              <Notice tone={feedback.tone} title={feedback.message} />
              <button type="button" className="btn btn-secondary" onClick={() => setFeedback(null)}>关闭提示</button>
            </div>
          ) : null}
          <Screen {...props} />
        </main>
      </div>
    </div>
  );
}
