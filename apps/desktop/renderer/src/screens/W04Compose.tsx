import { useEffect, useState } from 'react';
import type { IdKind } from '@wechat-agent/ports';
import { ActionButton } from '../components/ActionButton.tsx';
import { IdentityText } from '../components/IdentityText.tsx';
import { KeyValue } from '../components/KeyValue.tsx';
import { Notice } from '../components/Notice.tsx';
import { TaskCard, TaskStateBadge } from '../components/TaskCard.tsx';
import { COVERAGE, COVERAGE_DETAIL, REASON, TARGET_KIND, confidenceText, featureText } from '../copy.ts';
import { APPROVAL_TTL_MS, canApproveContent, canCreateAddFriend, canSaveDraft, canSkip, isIdentityAmbiguous } from '../rules.ts';
import { newOperationId, sha256Hex } from '../service.ts';
import { allTasks, pickTask } from '../tasks.ts';
import type { ScreenProps } from './index.ts';

const ID_KINDS: { value: IdKind; label: string }[] = [
  { value: 'wechat_id', label: '微信号' }, { value: 'phone', label: '手机号' }, { value: 'unknown', label: '不确定' },
];

/** W04 · 加好友与回复编辑：会话类型、上下文覆盖说明、草稿编辑、最终正文批准；对象不明则禁用。 */
export function W04Compose({ snapshot, call, run, busy, selectedTaskId, onSelectTask }: ScreenProps) {
  const messages = allTasks(snapshot).filter((t) => t.type === 'send_message' || t.type === 'reply_draft');
  const task = pickTask(messages, selectedTaskId);
  const [text, setText] = useState(task?.draft?.text ?? '');
  useEffect(() => { setText(task?.draft?.text ?? ''); }, [task?.taskId, task?.draft?.revision]);
  const dirty = (task?.draft?.text ?? '') !== text;

  const [typedId, setTypedId] = useState('');
  const [idKind, setIdKind] = useState<IdKind>('wechat_id');
  const [note, setNote] = useState('');

  const approveContent = canApproveContent(snapshot, task, dirty);
  const saveDraft = canSaveDraft(snapshot, task);
  const createAdd = canCreateAddFriend(snapshot, typedId);

  return (
    <section aria-labelledby="w04-title">
      <h1 id="w04-title">W04 · 加好友与回复编辑</h1>

      <h2>回复编辑</h2>
      <div className="grid-side">
        <aside aria-label="待编辑的消息任务">
          {messages.length === 0 ? <p className="muted">没有待编辑的消息任务。</p> : (
            <ul className="task-list">
              {messages.map((t) => <li key={t.taskId}><TaskCard task={t} selected={t.taskId === task?.taskId} onSelect={onSelectTask} /></li>)}
            </ul>
          )}
        </aside>
        <div>
          {task ? (
            <article className="card">
              <TaskStateBadge task={task} />
              {isIdentityAmbiguous(task) ? <Notice tone="danger" title="对象不明，已禁用批准">{REASON.target_ambiguous}。请先在微信里确认是哪一个会话。</Notice> : null}
              <KeyValue rows={[
                { k: '会话类型', v: task.target ? `${TARGET_KIND[task.target.kind] ?? task.target.kind}${task.target.kind === 'group' ? '（群聊不在允许范围）' : ''}` : '—' },
                { k: '对象', v: task.target ? <><IdentityText className="identity-large">{task.target.displayName}</IdentityText>{task.target.visibleIdentifier ? <IdentityText className="muted"> · {task.target.visibleIdentifier}</IdentityText> : null}<span className="muted"> · 置信度 {confidenceText(task.target.confidence)}</span></> : '—' },
                { k: '上下文覆盖', v: snapshot.patrol.coverage ? `${COVERAGE[snapshot.patrol.coverage] ?? snapshot.patrol.coverage}：${COVERAGE_DETAIL[snapshot.patrol.coverage] ?? ''}` : '未知：本轮没有读取记录' },
                { k: '草稿来源', v: task.draft ? (task.draft.source === 'model' ? '模型生成（需你审阅）' : '手动') : '—' },
              ]} />
              <Notice tone="info" title="模型只看到了上面说明的上下文范围">回复内容只依据读到的消息；没读到的部分模型不知道。{snapshot.policy.modelUpload ? '已允许把截图上传给模型。' : '策略不允许把截图上传给模型，草稿只基于本机识别出的文字。'}</Notice>
              <label className="field">
                <span>草稿正文（发送的就是这段文字，一字不差）</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} disabled={!saveDraft.ok} />
              </label>
              <div className="actions">
                <ActionButton kind="secondary" busy={busy} decision={dirty ? saveDraft : { ok: false, reasons: ['没有改动'] }} onClick={() => run('保存草稿', () => call('task.draft', { taskId: task.taskId, text, expectedDraftRevision: task.draft?.revision ?? 0 }))}>保存草稿</ActionButton>
                <ActionButton busy={busy} decision={approveContent} onClick={() => run('批准最终正文', async () => {
                  const contentHash = await sha256Hex(text);
                  await call('task.approve', { taskId: task.taskId, approvalRevision: task.revision, approvedContentHash: contentHash, expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() });
                })}>批准最终正文并发送</ActionButton>
                <ActionButton kind="secondary" busy={busy} decision={canSkip(task)} onClick={() => run('先跳过', () => call('task.skip', { taskId: task.taskId, expectedRevision: task.revision }))}>先跳过</ActionButton>
              </div>
              <p className="muted small">执行时若输入框里的文字与批准的正文不一致，会停止并标记"内容不一致"，不会发送默认文案。</p>
            </article>
          ) : null}
        </div>
      </div>

      <h2>加好友</h2>
      {!snapshot.features.add_friend.enabled ? <Notice tone="warn" title="加好友当前不可用">{featureText(snapshot.features.add_friend)}。本应用不会用前台旁路绕过它。</Notice> : null}
      <form className="card" onSubmit={(e) => { e.preventDefault(); if (!createAdd.ok || !snapshot.account) return; run('创建加好友任务', () => call('task.create', { operationId: newOperationId('add_friend'), type: 'add_friend', payload: { kind: 'add_friend', typedId: typedId.trim(), idKind, note }, expectedAccountRevision: snapshot.account!.revision })); }}>
        <label className="field"><span>微信号 / 手机号</span><input value={typedId} onChange={(e) => setTypedId(e.target.value)} autoComplete="off" /></label>
        <label className="field"><span>标识类型</span>
          <select value={idKind} onChange={(e) => setIdKind(e.target.value as IdKind)}>{ID_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
        </label>
        <label className="field"><span>验证语（留空则不填，不会用默认语）</span><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></label>
        <div className="actions">
          <ActionButton busy={busy} decision={createAdd} onClick={() => { if (!snapshot.account) return; run('创建加好友任务', () => call('task.create', { operationId: newOperationId('add_friend'), type: 'add_friend', payload: { kind: 'add_friend', typedId: typedId.trim(), idKind, note }, expectedAccountRevision: snapshot.account!.revision })); }}>创建加好友任务（之后仍需审批）</ActionButton>
        </div>
      </form>
    </section>
  );
}
