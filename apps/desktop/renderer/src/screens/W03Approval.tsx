import { ActionButton } from '../components/ActionButton.tsx';
import { EvidenceViewer } from '../components/EvidenceViewer.tsx';
import { IdentityText } from '../components/IdentityText.tsx';
import { KeyValue } from '../components/KeyValue.tsx';
import { Notice } from '../components/Notice.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { TaskCard, TaskStateBadge } from '../components/TaskCard.tsx';
import { REASON, TARGET_KIND, confidenceText, featureText, formatTime } from '../copy.ts';
import { APPROVAL_TTL_MS, IDENTITY_CONFIDENCE_MIN, canApproveAccept, canSkip, isIdentityAmbiguous } from '../rules.ts';
import { sha256Hex } from '../service.ts';
import { allTasks, pickTask } from '../tasks.ts';
import type { ScreenProps } from './index.ts';

/** W03 · 好友审批：证据卡 + 批准 / 先跳过。批准只对这个对象、这一次有效。 */
export function W03Approval({ snapshot, call, run, busy, selectedTaskId, onSelectTask }: ScreenProps) {
  const requests = allTasks(snapshot).filter((t) => t.type === 'accept_request');
  const task = pickTask(requests, selectedTaskId);
  const approve = canApproveAccept(snapshot, task);
  const skip = canSkip(task);

  const onApprove = () => {
    if (!task?.target) return;
    run('批准接受申请', async () => {
      const t = task.target!;
      const contentHash = await sha256Hex(JSON.stringify({ type: task.type, taskId: task.taskId, displayName: t.displayName, visibleIdentifier: t.visibleIdentifier ?? null, evidenceIds: t.evidenceIds }));
      await call('task.approve', { taskId: task.taskId, approvalRevision: task.revision, approvedContentHash: contentHash, expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() });
    });
  };

  return (
    <section aria-labelledby="w03-title">
      <h1 id="w03-title">W03 · 好友审批</h1>
      {!snapshot.features.accept_request.enabled ? <Notice tone="warn" title="接受好友申请当前不可用">{featureText(snapshot.features.accept_request)}。可以继续查看证据，但不能批准。</Notice> : null}

      <div className="grid-side">
        <aside aria-label="待审批的申请">
          <h2>申请（{requests.length}）</h2>
          {requests.length === 0 ? <p className="muted">没有好友申请任务。巡检读到新申请后会出现在这里。</p> : (
            <ul className="task-list">
              {requests.map((t) => <li key={t.taskId}><TaskCard task={t} selected={t.taskId === task?.taskId} onSelect={onSelectTask} /></li>)}
            </ul>
          )}
        </aside>

        <div>
          {task ? (
            <article className="card" aria-labelledby="w03-card">
              <h2 id="w03-card">证据卡</h2>
              <TaskStateBadge task={task} />
              {task.stateReason === 'approval_expired' ? (
                <Notice tone="warn" title="上次的批准已过期，没有执行">{REASON.approval_expired}。有效期截止 {formatTime(task.approval?.expiresAt)}。请重新核对下面的证据；再次批准会生成新的审批。</Notice>
              ) : null}
              {task.stateReason === 'target_ambiguous' || (task.target && task.target.confidence < IDENTITY_CONFIDENCE_MIN) ? (
                <Notice tone="danger" title="身份歧义，不能批准">{REASON.target_ambiguous}。这一条需要你在微信里亲自核对；本应用不会猜。</Notice>
              ) : null}
              {task.target ? (
                <KeyValue rows={[
                  { k: '昵称', v: <IdentityText className="identity-large">{task.target.displayName}</IdentityText> },
                  { k: '可见标识', v: task.target.visibleIdentifier ? <IdentityText>{task.target.visibleIdentifier}</IdentityText> : <span className="muted">界面上没有显示微信号 / 手机号</span> },
                  { k: '来源', v: TARGET_KIND[task.target.kind] ?? task.target.kind },
                  { k: '留言', v: <span className="muted">（当前任务视图未提供留言字段，见证据截图）</span> },
                  { k: '识别置信度', v: <StatusBadge tone={task.target.confidence >= IDENTITY_CONFIDENCE_MIN ? 'ok' : 'danger'}>{confidenceText(task.target.confidence)}</StatusBadge> },
                  { k: '发现时间', v: formatTime(task.createdAt) },
                ]} />
              ) : <Notice tone="danger" title="没有对象信息">这个任务没有可核对的身份证据，不能批准。</Notice>}

              {task.target?.evidenceIds.map((id) => <EvidenceViewer key={id} evidenceId={id} alt={`${task.target!.displayName} 的申请截图`} />)}

              <Notice tone="info" title="批准仅适用于本对象、本次">
                批准的是"接受 <IdentityText>{task.target?.displayName ?? '—'}</IdentityText> 的这一条申请"，不会用于其他申请，也不会自动重复；超过有效期未执行则作废。
                {isIdentityAmbiguous(task) ? '' : ' 执行前会再截图一次核对同一身份。'}
              </Notice>
              <div className="actions">
                <ActionButton busy={busy} decision={approve} onClick={onApprove}>批准接受</ActionButton>
                <ActionButton kind="secondary" busy={busy} decision={skip} onClick={() => run('先跳过', () => call('task.skip', { taskId: task.taskId, expectedRevision: task.revision }))}>先跳过</ActionButton>
              </div>
            </article>
          ) : null}
        </div>
      </div>
    </section>
  );
}
