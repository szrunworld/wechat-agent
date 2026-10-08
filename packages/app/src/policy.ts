// PolicyGate (方案 E03): allowlist, action allowlist, active hours and quota
// (through the ledger), account revision, model upload. Any miss blocks the
// task with a reason code; nothing here touches the platform.
import type { AccountBinding, DomainReasonCode, Handler, Id, Ledger, Policy, Timestamp, WeChatTask } from '@wechat-agent/ports';
import { featureKeyFor, OUTBOUND_ACTIONS, reasonCodeForFeature, type FeatureMap } from './features.ts';

export type Verdict =
  | { ok: true; reservationId?: Id }
  | { ok: false; reasonCode: DomainReasonCode; detail: string };

export function conversationTargetOf(task: WeChatTask): Id | undefined {
  const payload = task.payload;
  return payload.kind === 'reply_draft' || payload.kind === 'send_message' ? payload.conversationTargetId : undefined;
}

export class PolicyGate {
  constructor(private readonly ledger: Ledger) {}

  /** Checks that need no platform call. Used at creation and again before approval. */
  checkStatic(task: WeChatTask, handler: Handler | undefined, account: AccountBinding | undefined, policy: Policy, features: FeatureMap): Verdict {
    const feature = features[featureKeyFor(task.type)];
    if (!feature.enabled) return { ok: false, reasonCode: reasonCodeForFeature(feature), detail: feature.detail ?? feature.reason };
    if (!handler) return { ok: false, reasonCode: 'capability_missing', detail: `处理器 ${task.type} 未注册` };
    if (!account || account.status !== 'confirmed') return { ok: false, reasonCode: 'identity_unproven', detail: '账号未确认' };
    if (task.accountRevision !== account.revision) return { ok: false, reasonCode: 'account_changed', detail: `任务绑定账号版本 ${task.accountRevision}，当前 ${account.revision}` };
    if (task.payload.kind === 'reply_draft' && task.payload.source === 'model' && !policy.modelUpload) {
      return { ok: false, reasonCode: 'policy_disabled', detail: '模型上传已关闭，只能手写草稿' };
    }
    const conversation = conversationTargetOf(task);
    if (conversation !== undefined && !policy.allowlist.includes(conversation)) {
      return { ok: false, reasonCode: 'policy_disabled', detail: '会话不在白名单' };
    }
    const notAllowed = handler.requires.actions.filter((a) => !policy.allowedActions.includes(a));
    if (notAllowed.length) return { ok: false, reasonCode: 'policy_disabled', detail: `策略未允许动作：${notAllowed.join(', ')}` };
    return { ok: true };
  }

  /** Static checks plus the quota reservation for the handler's outbound action. */
  async preflight(task: WeChatTask, handler: Handler | undefined, account: AccountBinding | undefined, policy: Policy, features: FeatureMap, now: Timestamp): Promise<Verdict> {
    const verdict = this.checkStatic(task, handler, account, policy, features);
    if (!verdict.ok || !handler || !account) return verdict;
    const primary = handler.requires.actions.find((a) => OUTBOUND_ACTIONS.includes(a));
    if (!primary) return { ok: true };
    const quota = await this.ledger.reserveQuota({ accountId: account.accountId, actionKind: primary, intentId: task.fingerprint }, policy, now);
    if (!quota.ok) {
      const reasonCode: DomainReasonCode = quota.reason === 'daily_limit' || quota.reason === 'min_interval' ? 'rate_limited' : 'policy_disabled';
      return { ok: false, reasonCode, detail: `额度/时段：${quota.reason}` };
    }
    return { ok: true, reservationId: quota.reservation.reservationId };
  }
}
