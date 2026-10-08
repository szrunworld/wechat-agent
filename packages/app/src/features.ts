// FeatureGate (方案 E02): which features the UI may offer, with a reason the
// person can act on when one is off. Computed from capabilities, principal,
// account, policy and the input gate; never from a guess.
import type { ActionKind, ConnectionState, DomainReasonCode, FeatureKey, FeatureState, HandlerRegistry, Policy, TaskType } from '@wechat-agent/ports';

export const OUTBOUND_ACTIONS: readonly ActionKind[] = ['accept_request', 'send_friend_request', 'send_message'];

const FEATURE_TASK: Record<Exclude<FeatureKey, 'handback'>, TaskType> = {
  read_list: 'read_requests',
  accept_request: 'accept_request',
  add_friend: 'add_friend',
  reply_draft: 'reply_draft',
  send_message: 'send_message',
};

export function featureKeyFor(type: TaskType): Exclude<FeatureKey, 'handback'> {
  const entry = (Object.entries(FEATURE_TASK) as [Exclude<FeatureKey, 'handback'>, TaskType][]).find(([, t]) => t === type);
  return entry ? entry[0] : 'read_list';
}

export interface FeatureInput {
  connection: ConnectionState;
  paired: boolean;
  methods: string[];
  accountConfirmed: boolean;
  gateOpen: boolean;
  gateDetail?: string;
  policy: Policy;
  handlers: HandlerRegistry;
  /** Verified platform handback (CR03). Off until the platform offers it. */
  handbackVerified: boolean;
}

export type FeatureMap = Record<FeatureKey, FeatureState>;

const off = (reason: Exclude<FeatureState, { enabled: true }>['reason'], detail?: string): FeatureState => (detail ? { enabled: false, reason, detail } : { enabled: false, reason });

export function computeFeatures(input: FeatureInput): FeatureMap {
  const all = (state: FeatureState): FeatureMap => ({ read_list: state, accept_request: state, add_friend: state, reply_draft: state, send_message: state, handback: state });
  if (input.connection === 'disconnected' || input.connection === 'connecting') return all(off('platform_offline', 'AgentDesktop 不可达'));
  if (input.connection === 'incompatible') return all(off('capability_missing', '协议不兼容：需要 agentdesktop.runtime/1'));

  const result = {} as FeatureMap;
  for (const [key, type] of Object.entries(FEATURE_TASK) as [Exclude<FeatureKey, 'handback'>, TaskType][]) {
    const handler = input.handlers.get(type);
    if (!handler) { result[key] = off('capability_missing', `处理器 ${type} 未注册`); continue; }
    const missing = handler.requires.methods.filter((m) => !input.methods.includes(m));
    if (missing.length) { result[key] = off('capability_missing', `平台缺少方法：${missing.join(', ')}`); continue; }
    const outbound = handler.requires.actions.some((a) => OUTBOUND_ACTIONS.includes(a));
    if (outbound) {
      if (!input.paired) { result[key] = off('pairing_missing', '未配对：CR01 落地前外发保持 blocked'); continue; }
      if (!input.accountConfirmed) { result[key] = off('account_unconfirmed', '请先确认当前微信账号'); continue; }
      const notAllowed = handler.requires.actions.filter((a) => !input.policy.allowedActions.includes(a));
      if (notAllowed.length) { result[key] = off('policy_disabled', `策略未允许动作：${notAllowed.join(', ')}`); continue; }
      if (!input.gateOpen) { result[key] = off('input_gate_closed', input.gateDetail ?? '写门已关闭'); continue; }
    } else if (key !== 'read_list' && !input.accountConfirmed) {
      result[key] = off('account_unconfirmed', '请先确认当前微信账号');
      continue;
    }
    result[key] = { enabled: true };
  }
  result.handback = input.handbackVerified ? { enabled: true } : off('capability_missing', '归还能力未验证（CR03）：请按手动指引归还窗口');
  return result;
}

/** A disabled feature becomes the task's blocked reason. */
export function reasonCodeForFeature(state: FeatureState): DomainReasonCode {
  if (state.enabled) return 'policy_disabled';
  switch (state.reason) {
    case 'pairing_missing': return 'pairing_missing';
    case 'capability_missing': return 'capability_missing';
    case 'policy_disabled': return 'policy_disabled';
    case 'platform_offline': return 'disconnected';
    case 'account_unconfirmed': return 'identity_unproven';
    case 'input_gate_closed': return 'write_gate_closed';
    default: return 'policy_disabled';
  }
}
