import { useState } from 'react';
import type { IpcMethods } from '@wechat-agent/ports';
import { ActionButton } from '../components/ActionButton.tsx';
import { IdentityText } from '../components/IdentityText.tsx';
import { KeyValue } from '../components/KeyValue.tsx';
import { Notice } from '../components/Notice.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { TaskCard } from '../components/TaskCard.tsx';
import { ACCOUNT_STATUS, CONNECTION_DETAIL, CONNECTION_STATE, COVERAGE, COVERAGE_DETAIL, INPUT_GATE, INPUT_GATE_DETAIL, TASK_STATE_DETAIL, featureText, formatTime } from '../copy.ts';
import { canPause, canRequestHandback, canResume } from '../rules.ts';
import { newOperationId } from '../service.ts';
import type { ScreenProps } from './index.ts';

/** W02 · 工作台：账号 / 巡检 / 三计数 / 当前任务 / 暂停 / 接管。 */
export function W02Workbench({ snapshot, call, run, busy, onSelectTask, go }: ScreenProps) {
  const { account, patrol, counts, activeTask, tasks, inputGate, connection } = snapshot;
  const [handback, setHandback] = useState<IpcMethods['window.requestHandback']['result'] | null>(null);
  const gateTone = inputGate === 'open' ? 'ok' : inputGate === 'closed' ? 'neutral' : 'warn';

  return (
    <section aria-labelledby="w02-title">
      <h1 id="w02-title">W02 · 工作台</h1>

      {connection.state !== 'ready' ? <Notice tone="danger" title={`平台：${CONNECTION_STATE[connection.state]}`}>{CONNECTION_DETAIL[connection.state]}</Notice> : null}
      <Notice tone={gateTone} title={INPUT_GATE[inputGate]}>{INPUT_GATE_DETAIL[inputGate]}</Notice>
      {patrol.coverage === 'partial' || patrol.coverage === 'unreadable' ? <Notice tone="warn" title={`本轮巡检：${COVERAGE[patrol.coverage]}`}>{COVERAGE_DETAIL[patrol.coverage]}</Notice> : null}

      <div className="grid-2">
        <div className="card">
          <h2>账号</h2>
          {account ? (
            <KeyValue rows={[
              { k: '账号', v: <IdentityText>{account.visibleLabel}</IdentityText> },
              { k: '状态', v: <StatusBadge tone={account.status === 'confirmed' ? 'ok' : 'warn'}>{ACCOUNT_STATUS[account.status]}</StatusBadge> },
            ]} />
          ) : <p className="muted">未绑定账号。<button type="button" className="link" onClick={() => go('W01')}>去连接与账号确认</button></p>}
        </div>
        <div className="card">
          <h2>巡检</h2>
          <KeyValue rows={[
            { k: '状态', v: <StatusBadge tone={patrol.enabled ? 'ok' : 'neutral'}>{patrol.enabled ? '已开启' : '已关闭'}</StatusBadge> },
            { k: '间隔', v: `${patrol.intervalSeconds} 秒` },
            { k: '上次扫描', v: formatTime(patrol.lastScanAt) },
            { k: '覆盖', v: patrol.coverage ? COVERAGE[patrol.coverage] ?? patrol.coverage : '—' },
            { k: '可见单聊', v: patrol.visibleSingleChats ?? '—' },
          ]} />
        </div>
      </div>

      <h2>计数</h2>
      <ul className="counters" aria-label="计数">
        <li><button type="button" className="counter" onClick={() => go('W03')}><span className="counter-n">{counts.waitingApproval}</span><span>待审批</span></button></li>
        <li><button type="button" className="counter" onClick={() => go('W05')}><span className="counter-n">{counts.needsReconciliation}</span><span>待核实</span></button></li>
        <li><div className="counter"><span className="counter-n">{counts.confirmed}</span><span>已确认</span></div></li>
      </ul>

      <h2>当前任务</h2>
      {activeTask ? (
        <>
          <TaskCard task={activeTask} onSelect={(id) => { onSelectTask(id); go('W05'); }} />
          {TASK_STATE_DETAIL[activeTask.state] ? <p className="muted">{TASK_STATE_DETAIL[activeTask.state]}</p> : null}
        </>
      ) : <p className="muted">没有正在进行的任务。</p>}

      <h2>控制</h2>
      <div className="actions">
        {inputGate === 'open' ? (
          <ActionButton kind="danger" busy={busy} decision={canPause(snapshot)} onClick={() => run('暂停', () => call('app.pause', { operationId: newOperationId('pause'), expectedRevision: snapshot.revision }))}>暂停（关闭写入门）</ActionButton>
        ) : (
          <ActionButton busy={busy} decision={canResume(snapshot)} onClick={() => run('恢复', () => call('app.resume', { operationId: newOperationId('resume'), expectedRevision: snapshot.revision }))}>恢复（打开写入门）</ActionButton>
        )}
        <ActionButton kind="secondary" busy={busy} decision={canRequestHandback(snapshot)} onClick={() => run('接管微信窗口', async () => setHandback(await call('window.requestHandback', { operationId: newOperationId('handback') })))}>我要接管微信窗口</ActionButton>
      </div>
      {!snapshot.features.handback.enabled ? (
        <p className="muted">归还：{featureText(snapshot.features.handback)}。<button type="button" className="link" onClick={() => go('W06')}>查看手动接管指引</button></p>
      ) : null}
      {handback ? (
        <Notice tone={handback.mode === 'platform' ? 'ok' : 'warn'} title={handback.mode === 'platform' ? '平台已归还窗口' : '需要手动归还'}>{handback.instructions ?? '按 AgentDesktop 的提示完成。'}</Notice>
      ) : null}

      <h2>任务列表</h2>
      {tasks.length === 0 ? <p className="muted">暂无任务。</p> : (
        <ul className="task-list">
          {tasks.map((t) => <li key={t.taskId}><TaskCard task={t} onSelect={(id) => { onSelectTask(id); go('W05'); }} /></li>)}
        </ul>
      )}
    </section>
  );
}
