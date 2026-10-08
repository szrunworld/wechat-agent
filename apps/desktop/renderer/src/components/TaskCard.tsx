import type { TaskView } from '@wechat-agent/ports';
import { REASON, TASK_STATE, TASK_TYPE, TARGET_KIND, confidenceText, formatTime } from '../copy.ts';
import { IdentityText } from './IdentityText.tsx';
import { StatusBadge, type Tone } from './StatusBadge.tsx';

export function taskTone(task: TaskView): Tone {
  switch (task.state) {
    case 'confirmed': case 'no_op': return 'ok';
    case 'failed': case 'cancelled': return 'danger';
    case 'needs_reconciliation': case 'stopping': case 'blocked': return 'warn';
    case 'waiting_approval': case 'waiting_user': return 'info';
    default: return 'neutral';
  }
}

export function TaskStateBadge({ task }: { task: TaskView }) {
  return (
    <StatusBadge tone={taskTone(task)}>
      {TASK_STATE[task.state]}{task.stateReason ? `（${REASON[task.stateReason]}）` : ''}
    </StatusBadge>
  );
}

export function TaskCard({ task, selected, onSelect }: { task: TaskView; selected?: boolean; onSelect?: (taskId: string) => void }) {
  const body = (
    <>
      <div className="task-head">
        <strong>{TASK_TYPE[task.type]}</strong>
        <TaskStateBadge task={task} />
      </div>
      {task.target ? (
        <div className="task-target">
          <IdentityText>{task.target.displayName}</IdentityText>
          {task.target.visibleIdentifier ? <IdentityText className="muted"> · {task.target.visibleIdentifier}</IdentityText> : null}
          <span className="muted"> · {TARGET_KIND[task.target.kind] ?? task.target.kind} · 置信度 {confidenceText(task.target.confidence)}</span>
        </div>
      ) : <div className="muted">（没有对象信息）</div>}
      <div className="muted small">任务 {task.taskId} · 版本 {task.revision} · 更新于 {formatTime(task.updatedAt)}</div>
    </>
  );
  if (!onSelect) return <div className={`task-card${selected ? ' selected' : ''}`}>{body}</div>;
  return (
    <button type="button" className={`task-card task-card-button${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={() => onSelect(task.taskId)}>
      {body}
    </button>
  );
}
