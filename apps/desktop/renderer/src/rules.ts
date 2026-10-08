// Pure enable/disable rules for the main controls. Screens call these; tests
// assert them directly. A control is disabled only for a stated reason.
import { canTransition, type AppSnapshot, type FeatureKey, type TaskView } from '@wechat-agent/ports';
import { FEATURE_REASON, REASON } from './copy.ts';

/** Below this, identity is treated as unproven and no outbound approval is offered. */
export const IDENTITY_CONFIDENCE_MIN = 0.7;
/** Default approval validity offered to the application service. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface Decision { ok: boolean; reasons: string[] }

const allow = (): Decision => ({ ok: true, reasons: [] });
const deny = (reasons: string[]): Decision => ({ ok: reasons.length === 0, reasons });

function featureReasons(snapshot: AppSnapshot, key: FeatureKey): string[] {
  const f = snapshot.features[key];
  if (f.enabled) return [];
  return [`${FEATURE_REASON[f.reason]}${f.detail ? `（${f.detail}）` : ''}`];
}

function gateReasons(snapshot: AppSnapshot): string[] {
  switch (snapshot.inputGate) {
    case 'open': return [];
    case 'closed': return ['写入门已关闭'];
    case 'stopping': return ['正在停止，等待平台确认静止'];
    case 'quiescence_unconfirmed': return ['静止未确认，先核实在途任务'];
  }
}

function identityReasons(task: TaskView): string[] {
  const out: string[] = [];
  if (!task.target) out.push('没有对象信息');
  else if (task.target.confidence < IDENTITY_CONFIDENCE_MIN) out.push(`身份置信度 ${Math.round(task.target.confidence * 100)}% 低于 ${IDENTITY_CONFIDENCE_MIN * 100}%`);
  if (task.stateReason === 'target_ambiguous' || task.stateReason === 'identity_unproven') out.push(REASON[task.stateReason]);
  return out;
}

export function isIdentityAmbiguous(task: TaskView): boolean {
  return identityReasons(task).length > 0;
}

/** W03: approve an accept_request task. */
export function canApproveAccept(snapshot: AppSnapshot, task: TaskView | undefined): Decision {
  if (!task) return deny(['没有待审批的申请']);
  const reasons: string[] = [];
  if (task.type !== 'accept_request') reasons.push('不是好友申请任务');
  if (task.state !== 'waiting_approval') reasons.push('任务不在等待审批状态');
  reasons.push(...featureReasons(snapshot, 'accept_request'), ...gateReasons(snapshot), ...identityReasons(task));
  if (snapshot.account?.status !== 'confirmed') reasons.push('账号未确认');
  return deny(reasons);
}

/** W03/W04: skip is allowed whenever the task is still waiting on a person. */
export function canSkip(task: TaskView | undefined): Decision {
  if (!task) return deny(['没有任务']);
  return task.state === 'waiting_approval' || task.state === 'waiting_user' ? allow() : deny(['任务不在等待审批状态']);
}

/** W04: approve the final text of a send_message / reply task. `dirty` = editor differs from the saved draft. */
export function canApproveContent(snapshot: AppSnapshot, task: TaskView | undefined, dirty: boolean): Decision {
  if (!task) return deny(['没有待审批的正文']);
  const reasons: string[] = [];
  if (task.type !== 'send_message' && task.type !== 'reply_draft') reasons.push('不是消息任务');
  if (task.state !== 'waiting_approval') reasons.push('任务不在等待审批状态');
  if (!task.draft || task.draft.text.trim() === '') reasons.push('草稿为空');
  if (dirty) reasons.push('草稿有未保存的修改，先保存再批准');
  reasons.push(...featureReasons(snapshot, 'send_message'), ...gateReasons(snapshot), ...identityReasons(task));
  if (task.target && task.target.kind === 'group') reasons.push('群聊不在允许的会话类型内');
  if (snapshot.account?.status !== 'confirmed') reasons.push('账号未确认');
  return deny(reasons);
}

export function canSaveDraft(snapshot: AppSnapshot, task: TaskView | undefined): Decision {
  if (!task) return deny(['没有任务']);
  const reasons: string[] = [];
  if (task.state !== 'waiting_approval' && task.state !== 'waiting_user' && task.state !== 'preparing') reasons.push('任务当前不可编辑');
  reasons.push(...featureReasons(snapshot, 'reply_draft'));
  return deny(reasons);
}

/** W04: create an add_friend task. */
export function canCreateAddFriend(snapshot: AppSnapshot, typedId: string): Decision {
  const reasons = [...featureReasons(snapshot, 'add_friend'), ...gateReasons(snapshot)];
  if (snapshot.account?.status !== 'confirmed') reasons.push('账号未确认');
  if (typedId.trim() === '') reasons.push('请输入微信号或手机号');
  return deny(reasons);
}

/** W02 */
export function canPause(snapshot: AppSnapshot): Decision {
  if (snapshot.connection.state !== 'ready') return deny(['平台未就绪']);
  if (snapshot.inputGate !== 'open') return deny([`当前是"${snapshot.inputGate === 'stopping' ? '正在停止' : snapshot.inputGate === 'closed' ? '已暂停' : '静止未确认'}"`]);
  return allow();
}

export function canResume(snapshot: AppSnapshot): Decision {
  if (snapshot.connection.state !== 'ready') return deny(['平台未就绪，恢复连接后只重连观察']);
  if (snapshot.inputGate === 'stopping') return deny(['正在停止，等平台确认静止后才能恢复']);
  if (snapshot.inputGate === 'quiescence_unconfirmed') return deny(['静止未确认，先核实在途任务']);
  if (snapshot.inputGate === 'open') return deny(['未暂停']);
  if (snapshot.account?.status !== 'confirmed') return deny(['账号未确认']);
  return allow();
}

export function canRequestHandback(snapshot: AppSnapshot): Decision {
  return deny(featureReasons(snapshot, 'handback'));
}

/** W01 */
export function canConfirmAccount(snapshot: AppSnapshot): Decision {
  const reasons: string[] = [];
  if (snapshot.connection.state !== 'ready') reasons.push('平台未就绪');
  if (!snapshot.account) reasons.push('还没有读到账号');
  else if (snapshot.account.status === 'confirmed') reasons.push('账号已确认');
  else if (snapshot.account.evidenceIds.length === 0) reasons.push('缺少账号证据');
  return deny(reasons);
}

/** W05: reconcile-only; never a resend. */
export function canReconcile(snapshot: AppSnapshot, task: TaskView | undefined): Decision {
  if (!task) return deny(['没有任务']);
  const reasons: string[] = [];
  if (task.state !== 'needs_reconciliation' && task.stateReason !== 'platform_unknown') reasons.push('任务不在待核实状态');
  if (snapshot.connection.state !== 'ready') reasons.push('平台未就绪，核实要等连接恢复');
  return deny(reasons);
}

export function canConcludeManually(task: TaskView | undefined, conclusion: string): Decision {
  if (!task) return deny(['没有任务']);
  const reasons: string[] = [];
  if (task.state !== 'needs_reconciliation') reasons.push('任务不在待核实状态');
  if (conclusion.trim() === '') reasons.push('请写明你在微信里看到了什么');
  return deny(reasons);
}

export function canCancel(task: TaskView | undefined): Decision {
  if (!task) return deny(['没有任务']);
  return canTransition(task.state, 'cancelled') ? allow() : deny([`"${task.state}"状态下不能取消`]);
}
