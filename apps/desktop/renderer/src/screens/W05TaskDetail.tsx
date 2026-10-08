import { useState } from 'react';
import type { TaskView } from '@wechat-agent/ports';
import { ActionButton } from '../components/ActionButton.tsx';
import { EvidenceViewer } from '../components/EvidenceViewer.tsx';
import { IdentityText } from '../components/IdentityText.tsx';
import { KeyValue } from '../components/KeyValue.tsx';
import { Notice } from '../components/Notice.tsx';
import { StatusBadge, type Tone } from '../components/StatusBadge.tsx';
import { TaskCard, TaskStateBadge } from '../components/TaskCard.tsx';
import { PLATFORM_DELIVERY, PLATFORM_EXECUTION, PLATFORM_QUIESCENCE, REASON, TARGET_KIND, TASK_STATE, TASK_STATE_DETAIL, TASK_TYPE, confidenceText, formatTime } from '../copy.ts';
import { canCancel, canConcludeManually, canReconcile } from '../rules.ts';
import { allTasks, pickTask } from '../tasks.ts';
import type { ScreenProps } from './index.ts';

function layerTone(value: string | undefined, good: string[], bad: string[]): Tone {
  if (!value) return 'neutral';
  if (good.includes(value)) return 'ok';
  if (bad.includes(value)) return 'warn';
  return 'neutral';
}

function businessLayer(task: TaskView): { tone: Tone; text: string } {
  switch (task.state) {
    case 'confirmed': return { tone: 'ok', text: '已核实：截图里出现了预期结果' };
    case 'no_op': return { tone: 'ok', text: '无需操作：目标状态已经满足' };
    case 'failed': return { tone: 'danger', text: `失败${task.stateReason ? `：${REASON[task.stateReason]}` : ''}` };
    case 'needs_reconciliation': return { tone: 'warn', text: '未核实：业务结果不明，等待核实或人工检查' };
    case 'cancelled': return { tone: 'neutral', text: '已取消' };
    default: return { tone: 'neutral', text: `尚未核实（${TASK_STATE[task.state]}）` };
  }
}

/** W05 · 任务详情与未知核实：三层结果、时间线；只有"仅核实"和"我已人工检查"。 */
export function W05TaskDetail({ snapshot, call, run, busy, selectedTaskId, onSelectTask }: ScreenProps) {
  const list = allTasks(snapshot);
  const task = pickTask(list, selectedTaskId);
  const [conclusion, setConclusion] = useState('');
  const [checkedEvidence, setCheckedEvidence] = useState<string[]>([]);
  const reconcile = canReconcile(snapshot, task);
  const conclude = canConcludeManually(task, conclusion);
  const cancel = canCancel(task);
  const unknown = task?.state === 'needs_reconciliation' || task?.stateReason === 'platform_unknown';

  return (
    <section aria-labelledby="w05-title">
      <h1 id="w05-title">W05 · 任务详情与未知核实</h1>
      <div className="grid-side">
        <aside aria-label="任务">
          {list.length === 0 ? <p className="muted">没有任务。</p> : (
            <ul className="task-list">
              {list.map((t) => <li key={t.taskId}><TaskCard task={t} selected={t.taskId === task?.taskId} onSelect={onSelectTask} /></li>)}
            </ul>
          )}
        </aside>
        <div>
          {task ? (
            <article className="card">
              <div className="task-head"><h2>{TASK_TYPE[task.type]} · {task.taskId}</h2><TaskStateBadge task={task} /></div>
              {TASK_STATE_DETAIL[task.state] ? <Notice tone={task.state === 'needs_reconciliation' ? 'warn' : 'info'} title={TASK_STATE[task.state]}>{TASK_STATE_DETAIL[task.state]}</Notice> : null}
              {task.stateReason && task.state !== 'needs_reconciliation' ? <Notice tone="warn" title={REASON[task.stateReason]} /> : null}
              {snapshot.inputGate === 'quiescence_unconfirmed' ? <Notice tone="warn" title="静止未确认">平台还没确认这个任务的动作是否已经停止。核实要等连接恢复；在此之前不要在微信里重复操作。</Notice> : null}

              {task.target ? (
                <KeyValue rows={[
                  { k: '对象', v: <><IdentityText className="identity-large">{task.target.displayName}</IdentityText>{task.target.visibleIdentifier ? <IdentityText className="muted"> · {task.target.visibleIdentifier}</IdentityText> : null}</> },
                  { k: '类型', v: `${TARGET_KIND[task.target.kind] ?? task.target.kind} · 置信度 ${confidenceText(task.target.confidence)}` },
                ]} />
              ) : null}
              {task.draft ? <KeyValue rows={[{ k: '批准的正文', v: <IdentityText>{task.draft.text}</IdentityText> }]} /> : null}
              {task.approval ? <KeyValue rows={[{ k: '审批', v: `${task.approval.approvalId} · 截止 ${formatTime(task.approval.expiresAt)} · ${task.approval.consumed ? '已消费' : '未消费'}` }]} /> : null}

              <h3>三层结果</h3>
              <ol className="layers">
                <li>
                  <span className="layer-name">平台投递</span>
                  <StatusBadge tone={layerTone(task.platform?.delivery, ['dispatched', 'accepted', 'completed'], ['unknown', 'failed'])}>{task.platform?.delivery ? PLATFORM_DELIVERY[task.platform.delivery] ?? task.platform.delivery : '尚未派发'}</StatusBadge>
                  {task.platform?.execution ? <span className="muted"> · 执行 {PLATFORM_EXECUTION[task.platform.execution] ?? task.platform.execution}</span> : null}
                  {task.platform?.requestId ? <span className="muted"> · 请求 {task.platform.requestId}{task.platform.runId ? ` · Run ${task.platform.runId}` : ''}</span> : null}
                </li>
                <li>
                  <span className="layer-name">平台静止</span>
                  <StatusBadge tone={layerTone(task.platform?.quiescence, ['confirmed'], ['not_confirmed', 'pending'])}>{task.platform?.quiescence ? PLATFORM_QUIESCENCE[task.platform.quiescence] ?? task.platform.quiescence : '—'}</StatusBadge>
                </li>
                <li>
                  <span className="layer-name">业务核实</span>
                  <StatusBadge tone={businessLayer(task).tone}>{businessLayer(task).text}</StatusBadge>
                </li>
              </ol>
              <p className="muted small">三层各自独立：平台说"已派发"不等于微信里发出去了；平台说"静止"只表示没有在途动作；只有业务核实才回答"做成了没有"。</p>

              <h3>时间线</h3>
              <ol className="timeline">
                {task.timeline.map((e, i) => <li key={i}><time dateTime={e.at}>{formatTime(e.at)}</time> <span>{e.label}</span></li>)}
                {task.timeline.length === 0 ? <li className="muted">暂无记录</li> : null}
              </ol>

              {task.facts.length > 0 ? (
                <>
                  <h3>事实</h3>
                  <ul>
                    {task.facts.map((f) => <li key={f.factId}>{f.factKind} · {f.outcome} · 置信度 {Math.round(f.confidence * 100)}%{f.reason ? ` · ${f.reason}` : ''}</li>)}
                  </ul>
                </>
              ) : null}

              {task.target?.evidenceIds.map((id) => <EvidenceViewer key={id} evidenceId={id} alt={`${task.target!.displayName} 的证据截图`} />)}

              {unknown ? (
                <div className="reconcile">
                  <h3>结果未知，如何处理</h3>
                  <Notice tone="warn" title="只核实，不重做">
                    这个动作可能已经在微信里生效，也可能没有。本应用只会再次读取微信画面来核实，绝不会把同一动作执行第二次；这里没有重做入口。
                  </Notice>
                  <div className="actions">
                    <ActionButton busy={busy} decision={reconcile} onClick={() => run('仅核实', () => call('task.reconcile', { taskId: task.taskId, expectedRevision: task.revision }))}>仅核实（再读一次画面）</ActionButton>
                  </div>
                  <form className="card" onSubmit={(e) => { e.preventDefault(); if (conclude.ok) run('记录人工检查', () => call('task.concludeManually', { taskId: task.taskId, expectedRevision: task.revision, conclusion: conclusion.trim(), evidenceIds: checkedEvidence })); }}>
                    <label className="field"><span>我在微信里亲自检查后看到的结果</span><textarea value={conclusion} onChange={(e) => setConclusion(e.target.value)} rows={3} placeholder="例如：对方已在通讯录里；或：没有发出，我也不会再发" /></label>
                    {task.target && task.target.evidenceIds.length > 0 ? (
                      <fieldset className="field"><legend>关联证据</legend>
                        {task.target.evidenceIds.map((id) => (
                          <label key={id} className="check"><input type="checkbox" checked={checkedEvidence.includes(id)} onChange={(e) => setCheckedEvidence((prev) => e.target.checked ? [...prev, id] : prev.filter((x) => x !== id))} /> {id}</label>
                        ))}
                      </fieldset>
                    ) : null}
                    <div className="actions">
                      <ActionButton kind="secondary" busy={busy} decision={conclude} onClick={() => run('记录人工检查', () => call('task.concludeManually', { taskId: task.taskId, expectedRevision: task.revision, conclusion: conclusion.trim(), evidenceIds: checkedEvidence }))}>我已人工检查，记录结论</ActionButton>
                    </div>
                  </form>
                </div>
              ) : null}

              {cancel.ok ? (
                <div className="actions">
                  <ActionButton kind="danger" busy={busy} decision={cancel} onClick={() => run('取消任务', () => call('task.cancel', { taskId: task.taskId, expectedRevision: task.revision }))}>取消任务</ActionButton>
                </div>
              ) : null}
            </article>
          ) : null}
        </div>
      </div>
    </section>
  );
}
