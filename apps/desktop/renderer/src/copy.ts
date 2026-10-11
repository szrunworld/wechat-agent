// Every user-facing string of the renderer, keyed by the frozen enums of
// @wechat-agent/ports. Each abnormal state has its own wording (lane F rule 3);
// nothing is conveyed by colour alone.
import type { ConnectionState, DomainReasonCode, FeatureKey, FeatureState, InputGateState, PairingView, SetupStep, TaskState, TaskType, TargetKind, Coverage, IpcError } from '@wechat-agent/ports';

export const CONNECTION_STATE: Record<ConnectionState, string> = {
  disconnected: '未连接', connecting: '连接中', incompatible: '协议不兼容', unpaired: '未配对', pairing: '等待确认', ready: '已配对', no_access: '授权不可用', revoked: '已撤销',
};

export const CONNECTION_DETAIL: Record<ConnectionState, string> = {
  disconnected: '平台离线：没有连上 AgentDesktop。本应用不会自行启动、移动或点击微信；在平台恢复前所有外发功能保持关闭，等待恢复后只重连观察，不重放任何动作。',
  connecting: '正在连接 AgentDesktop……',
  incompatible: '协议不兼容：平台提供的 runtime 版本或方法集合与本应用需要的 agentdesktop.runtime/1 不一致。请升级 AgentDesktop 或本应用，功能全部关闭。',
  unpaired: '未配对：本应用还没有 AgentDesktop 的配对身份。AgentDesktop 对未配对的程序只回答配对请求，读取和外发都不可用。点"申请配对"后，到 AgentDesktop 的确认窗口里核对配对码，再用 Touch ID 批准。',
  pairing: '等待确认：配对申请已发给 AgentDesktop。请到它的确认窗口核对配对码与申请的权限，确认无误后用 Touch ID 批准；拒绝或超时后一分钟内不能再申请。',
  ready: '已配对：已连上 AgentDesktop，契约校验通过。能访问的范围以 AgentDesktop 批准的授权为准，配对不等于能看所有窗口。',
  no_access: '授权不可用：本应用已配对，但授权已过期或被收回。请在 AgentDesktop 中续期或重新授权，然后点"重新检查连接"；本应用不会自行反复重连。',
  revoked: '已撤销：本应用在 AgentDesktop 中的授权已被撤销（或保存的凭据不再被认可）。旧凭据已删除，所有受保护的操作都被拒绝；需要重新申请配对。',
};

export const PAIRING_STATE: Record<PairingView['state'], string> = {
  unpaired: '未配对', waiting: '等待确认', paired: '已配对', denied: '未获批准', expired: '申请已失效', revoked: '已撤销', no_access: '授权不可用',
};

export const CAPABILITY_LABEL: Record<string, string> = {
  observe: '查看（桌面/窗口列表、截图与元素）', act: '操作（打开会话、发送输入）', 'desktop.manage': '管理桌面（绑定窗口）', run: '运行（Run 与事件）', 'unit.run': 'GUI 单元任务',
};

export const INPUT_GATE: Record<InputGateState, string> = {
  open: '写入门开放', closed: '写入门已关闭', stopping: '正在停止', quiescence_unconfirmed: '静止未确认',
};

export const INPUT_GATE_DETAIL: Record<InputGateState, string> = {
  open: '已批准的动作可以派发；每个动作仍需单独审批。',
  closed: '不会派发任何外发动作。点击"恢复"重新打开；恢复不会重放之前取消的动作。',
  stopping: '正在停止：写入门已关闭，正在取消所属 Run 并等待平台确认在途动作静止。此时不能批准、不能发送、不能恢复，直到平台回报静止。',
  quiescence_unconfirmed: '静止未确认：连接在有动作在途时中断，平台尚未确认这些动作是否已经停止。恢复连接后请先在任务详情里"仅核实"，不要在微信里人工重复同一操作。',
};

export const FEATURE_LABEL: Record<FeatureKey, string> = {
  read_list: '读取列表', accept_request: '接受好友申请', add_friend: '加好友', reply_draft: '回复草稿', send_message: '发送消息', handback: '归还微信窗口',
};

type DisabledReason = Exclude<FeatureState, { enabled: true }>['reason'];
export const FEATURE_REASON: Record<DisabledReason, string> = {
  pairing_missing: '未与 AgentDesktop 配对',
  grant_missing: 'AgentDesktop 授权不足或已过期',
  capability_missing: '平台未提供所需能力',
  policy_disabled: '已被策略禁用',
  platform_offline: '平台离线',
  account_unconfirmed: '账号尚未确认',
  input_gate_closed: '写入门已关闭',
};

export function featureText(f: FeatureState): string {
  if (f.enabled) return '可用';
  return `不可用：${FEATURE_REASON[f.reason]}${f.detail ? `（${f.detail}）` : ''}`;
}

export const TASK_STATE: Record<TaskState, string> = {
  created: '已创建', queued: '排队中', preparing: '准备中', waiting_approval: '等待审批', ready: '已就绪', executing: '执行中', verifying: '核实中',
  confirmed: '已确认', failed: '失败', no_op: '无需操作', needs_reconciliation: '待核实', cancelled: '已取消', stopping: '正在停止', blocked: '受阻', waiting_user: '等待用户',
};

export const TASK_STATE_DETAIL: Partial<Record<TaskState, string>> = {
  stopping: '任务正在停止：已请求平台取消所属 Run，等待静止确认。结果以平台回执和之后的核实为准。',
  needs_reconciliation: '任务结果未知：平台没有给出可信的投递结果，业务层也未核实。只能核实，不能重发；同一意图不会被执行第二次。',
  blocked: '任务受阻：在当前条件下不能继续，解除原因后会回到之前的状态重新检查。',
  waiting_user: '需要你在本应用里补充信息或做决定。',
  executing: '正在通过平台执行，请不要在微信里同时操作同一对象。',
  verifying: '动作已派发，正在对照截图核实业务结果。',
};

export const REASON: Record<DomainReasonCode, string> = {
  capability_missing: '平台能力缺失', pairing_missing: '未配对', grant_missing: '授权不足：AgentDesktop 的授权不覆盖这个操作', policy_disabled: '策略禁用', write_gate_closed: '写入门已关闭',
  content_mismatch: '内容不一致：输入框里的文字与批准的正文不符，已停止，不会发送默认文案',
  target_ambiguous: '身份歧义：无法唯一确定对象（重名、截断或缺少可见标识）',
  identity_unproven: '身份未证实：缺少足够的身份证据',
  account_changed: '账号已变更：原有审批全部失效',
  approval_invalid: '审批无效', approval_expired: '审批已过期：批准后未在有效期内执行，需要重新核对后再次批准',
  user_draft_present: '输入框里已有你自己的草稿，未覆盖', unexpected_dialog: '出现了意外弹窗', layout_unreadable: '界面不可读（尺寸、缩放或主题不匹配）',
  coverage_partial: '覆盖不完整：只读到了部分列表', not_found: '未找到对象', already_friend: '已是好友', request_expired: '申请已过期',
  disconnected: '连接中断', platform_unknown: '平台结果未知', verification_missing: '缺少核实证据', rate_limited: '已达频率限制', cancelled: '已取消',
};

export const TASK_TYPE: Record<TaskType, string> = {
  read_requests: '读取好友申请', accept_request: '接受好友申请', add_friend: '加好友', reply_draft: '回复草稿', send_message: '发送消息',
};

export const TARGET_KIND: Record<TargetKind | string, string> = {
  single: '单聊', group: '群聊', friend_request: '好友申请', search_profile: '搜索资料',
};

export const COVERAGE: Record<Coverage | string, string> = {
  current_viewport: '仅当前视口', partial: '部分（覆盖不完整）', end_confirmed: '已读到列表末尾', unreadable: '不可读',
};

export const COVERAGE_DETAIL: Record<Coverage | string, string> = {
  current_viewport: '只读到了当前可见的一屏，屏幕外的会话不在其中。',
  partial: '覆盖部分：巡检只读到列表的一部分，没读到的会话不会出现在这里，不能据此判断"没有新消息"或"没有新申请"。',
  end_confirmed: '已确认读到列表末尾。',
  unreadable: '界面不可读：尺寸、缩放或主题与识别配置不匹配，本轮没有读取结果。',
};

export const SETUP_STEP: Record<SetupStep['key'], string> = {
  discover: '发现 AgentDesktop', contract: '契约校验', pairing: '配对', window: '绑定微信窗口', account: '确认账号', baseline: '只读基线',
};

export const STEP_STATE: Record<SetupStep['state'], { glyph: string; text: string }> = {
  pending: { glyph: '○', text: '待执行' }, done: { glyph: '✓', text: '完成' }, failed: { glyph: '✕', text: '失败' }, blocked: { glyph: '■', text: '受阻' },
};

export const ACCOUNT_STATUS: Record<'unconfirmed' | 'confirmed' | 'changed', string> = {
  unconfirmed: '待确认', confirmed: '已确认', changed: '已变更',
};

export const PLATFORM_DELIVERY: Record<string, string> = {
  dispatched: '已派发', accepted: '已接收', completed: '已完成', unknown: '未知', not_sent: '未发出', failed: '失败',
};
export const PLATFORM_EXECUTION: Record<string, string> = { completed: '已完成', running: '执行中', failed: '失败', unknown: '未知', cancelled: '已取消' };
export const PLATFORM_QUIESCENCE: Record<string, string> = { confirmed: '已确认静止', pending: '等待静止', not_confirmed: '静止未确认' };

export const IPC_ERROR: Record<IpcError['code'], string> = {
  revision_conflict: '状态已变化，请按最新内容重新确认',
  operation_conflict: '同一操作已在处理中',
  not_found: '对象不存在或已被清理',
  invalid_state: '当前状态下不允许这个操作',
  blocked: '操作被阻止',
  unavailable: '服务暂不可用',
  internal: '内部错误',
};

export function confidenceText(confidence: number): string {
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.9) return `${pct}%（高）`;
  if (confidence >= 0.7) return `${pct}%（中）`;
  return `${pct}%（低，身份不明）`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
