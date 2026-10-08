// Per-task runtime state the ledger does not hold (draft, approval request,
// platform ids, timeline), the task view projection, and the walk through
// TASK_TRANSITIONS from a state to a target.
import { TASK_TRANSITIONS, TERMINAL_TASK_STATES } from '@wechat-agent/ports';
import type {
  ApprovalDecision, ApprovalRequest, BusinessApproval, DomainFact, DomainOutcome, DomainReasonCode, Id, Revision, TargetRef, TaskState, TaskType, TaskView, Timestamp, WeChatTask,
} from '@wechat-agent/ports';
import { hashContent, Mutex, type Deferred } from './support.ts';

export type TaskOrigin = 'ui' | 'patrol' | 'baseline';

export interface PendingApproval {
  decision: Deferred<ApprovalDecision>;
  /** The content/target/account the request was made for no longer match. */
  stale: boolean;
}

export interface TaskRuntime {
  taskId: Id;
  origin: TaskOrigin;
  draft?: { text: string; revision: Revision; source: 'manual' | 'model' };
  target?: TaskView['target'];
  approvalRequest?: ApprovalRequest & { taskRevision: Revision; requestedAt: Timestamp };
  approval?: BusinessApproval;
  platform?: TaskView['platform'];
  timeline: { at: Timestamp; label: string }[];
  reservationId?: Id;
  abort: AbortController;
  pending?: PendingApproval;
  /** Set when a stale approval was refused: the handler is run again from scratch. */
  reReview?: boolean;
  /** Attempts this task prepared in this process (the ledger has no per-task listing). */
  attempts: Map<Id, { requestId?: Id; state: string }>;
  /** The run was asked to stop but the platform never confirmed quiescence. */
  stopUnconfirmed?: boolean;
  /** The control connection dropped while this task's handler was running. */
  disconnected?: boolean;
  sessionId?: Id;
  runId?: Id;
  /** The run is still open on the platform (needs finish or cancel). */
  runOpen?: boolean;
  /** Reason of the latest blocked/terminal transition (the ledger only audits it). */
  stateReason?: DomainReasonCode;
  /** The handler's conclusion being settled right now; the outbox event of the terminal transition carries it. */
  finalOutcome?: DomainOutcome;
  stateDetail?: string;
  /** Serialises state changes of this task (approve vs cancel vs handler return). */
  lock: Mutex;
}

export function newRuntime(taskId: Id, origin: TaskOrigin, now: Timestamp, label: string): TaskRuntime {
  return { taskId, origin, timeline: [{ at: now, label }], abort: new AbortController(), attempts: new Map(), lock: new Mutex() };
}

export const RUNNING_STATES: readonly TaskState[] = ['preparing', 'ready', 'executing', 'verifying'];

export const OPEN_TASK_STATES: readonly TaskState[] = (Object.keys(TASK_TRANSITIONS) as TaskState[]).filter((s) => !TERMINAL_TASK_STATES.includes(s));

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

const INTERMEDIATE: readonly TaskState[] = ['preparing', 'ready', 'executing', 'verifying'];

/**
 * Shortest legal path from `from` to `to` through the working states only
 * (never through blocked/cancelled/stopping/waiting_*), excluding `from`.
 */
export function pathTo(from: TaskState, to: TaskState, via: readonly TaskState[] = INTERMEDIATE): TaskState[] | undefined {
  if (from === to) return [];
  const prev = new Map<TaskState, TaskState>();
  const seen = new Set<TaskState>([from]);
  const queue: TaskState[] = [from];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of TASK_TRANSITIONS[current]) {
      if (seen.has(next)) continue;
      if (next === to) {
        const path: TaskState[] = [to];
        let cursor = current;
        while (cursor !== from) { path.unshift(cursor); cursor = prev.get(cursor)!; }
        return path;
      }
      if (!via.includes(next)) continue;
      seen.add(next);
      prev.set(next, current);
      queue.push(next);
    }
  }
  return undefined;
}

export function targetKindFor(type: TaskType): string {
  switch (type) {
    case 'accept_request': return 'friend_request';
    case 'add_friend': return 'search_profile';
    case 'reply_draft': case 'send_message': return 'single';
    default: return 'list';
  }
}

/** The TargetRef a handler receives: only what the task itself states; identity stays unproven until the handler reads it. */
export function targetRefFor(task: WeChatTask, accountId: Id): TargetRef | undefined {
  const base = defaultTarget(task);
  if (!base) return undefined;
  const kind = targetKindFor(task.type);
  return {
    targetId: task.targetId ?? `${task.type}:${base.displayName}`, accountId, kind: kind as TargetRef['kind'], displayName: base.displayName,
    visibleIdentifier: base.visibleIdentifier, identityEvidenceIds: [], confidence: 0, revision: task.targetRevision ?? 1,
  };
}

export function defaultTarget(task: WeChatTask): TaskView['target'] | undefined {
  const p = task.payload;
  switch (p.kind) {
    case 'accept_request': return { displayName: p.requestKey, kind: 'friend_request', confidence: 0, evidenceIds: [] };
    case 'add_friend': return { displayName: p.typedId, visibleIdentifier: p.typedId, kind: 'search_profile', confidence: 0, evidenceIds: [] };
    case 'reply_draft': case 'send_message': return { displayName: p.conversationTargetId, kind: 'single', confidence: 0, evidenceIds: [] };
    default: return undefined;
  }
}

export function projectTask(task: WeChatTask, runtime: TaskRuntime | undefined, facts: DomainFact[], platform?: TaskView['platform']): TaskView {
  const view: TaskView = {
    taskId: task.taskId, type: task.type, state: task.state, stateReason: task.stateReason ?? runtime?.stateReason, revision: task.revision,
    facts, timeline: runtime?.timeline ?? [], createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
  const target = runtime?.target ?? defaultTarget(task);
  if (target) view.target = target;
  if (runtime?.draft) view.draft = { ...runtime.draft };
  else if (task.payload.kind === 'send_message') view.draft = { text: task.payload.content, revision: task.payload.contextRevision, source: 'manual' };
  // Convention: no `approval` while waiting; `pendingContentHash` is what the renderer sends back to task.approve.
  if (runtime?.approval) {
    view.approval = { approvalId: runtime.approval.approvalId, contentHash: runtime.approval.contentHash, expiresAt: runtime.approval.expiresAt, consumed: runtime.approval.consumedAt !== undefined };
  }
  const platformView = runtime?.platform ?? platform;
  if (platformView) view.platform = { ...platformView };
  if (runtime?.pending && runtime.approvalRequest) view.pendingContentHash = runtime.approvalRequest.contentHash;
  else if (runtime?.draft) view.pendingContentHash = hashContent(runtime.draft.text);
  else if (task.payload.kind === 'send_message') view.pendingContentHash = task.payload.contentHash;
  return view;
}
