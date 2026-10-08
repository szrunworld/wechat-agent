import type { AppSnapshot, FeatureKey, FeatureState, SetupStep, TaskView } from '../ipc.ts';

export type SnapshotKey =
  | 'platform_offline' | 'incompatible' | 'unpaired' | 'account_unconfirmed' | 'ready_idle' | 'waiting_approval'
  | 'executing' | 'stopping' | 'quiescence_unconfirmed' | 'unknown_result' | 'ambiguous_identity' | 'approval_expired' | 'coverage_partial';

const ENDPOINT = '~/Library/Application Support/AgentDesktop/control.sock';
const T = '2026-10-08T10:20:00+08:00';

export function emptyFeatures(reason: Exclude<FeatureState, { enabled: true }>['reason']): Record<FeatureKey, FeatureState> {
  const off: FeatureState = { enabled: false, reason };
  return { read_list: off, accept_request: off, add_friend: off, reply_draft: off, send_message: off, handback: off };
}

const steps = (done: number, failed?: SetupStep['key'], detail?: string): SetupStep[] => {
  const keys: SetupStep['key'][] = ['discover', 'contract', 'pairing', 'window', 'account', 'baseline'];
  return keys.map((key, i) => ({ key, state: key === failed ? 'failed' : i < done ? 'done' : i === done ? 'blocked' : 'pending', detail: key === failed ? detail : undefined }));
};

const base = (over: Partial<AppSnapshot>): AppSnapshot => ({
  revision: 1,
  connection: { state: 'ready', endpoint: ENDPOINT, product: 'AgentDesktop', apiVersion: 'agentdesktop.runtime/1', principal: { clientId: 'app:wechat-agent', role: 'paired' }, missingCapabilities: [], steps: steps(6) },
  account: { accountId: 'acct_a', visibleLabel: '示例账号 A', evidenceIds: ['ev_1'], confirmedAt: T, revision: 1, status: 'confirmed' },
  inputGate: 'open',
  patrol: { enabled: true, intervalSeconds: 60, lastScanAt: T, coverage: 'current_viewport', visibleSingleChats: 5 },
  counts: { waitingApproval: 0, needsReconciliation: 0, confirmed: 3 },
  tasks: [],
  features: { read_list: { enabled: true }, accept_request: { enabled: true }, add_friend: { enabled: false, reason: 'capability_missing', detail: '前台弹层路由未提供（CR02）' }, reply_draft: { enabled: true }, send_message: { enabled: true }, handback: { enabled: false, reason: 'capability_missing', detail: '归还能力未验证（CR03）' } },
  policy: { allowlistCount: 2, approvalPerAction: true, modelUpload: false, patrolIntervalSeconds: 60, approvalTtlSeconds: 600, evidenceRetentionDays: 1 },
  ...over,
});

const acceptTask = (over: Partial<TaskView>): TaskView => ({
  taskId: 'task_1', type: 'accept_request', state: 'waiting_approval', revision: 3,
  target: { displayName: '陈一', visibleIdentifier: 'example_id', kind: 'friend_request', confidence: 0.92, evidenceIds: ['ev_2'], message: '我是陈一，我们刚讨论过项目。' },
  facts: [], timeline: [{ at: T, label: '发现申请' }, { at: T, label: '读取详情' }], createdAt: T, updatedAt: T, ...over,
});

export const sampleSnapshots: Record<SnapshotKey, AppSnapshot> = {
  platform_offline: base({ connection: { state: 'disconnected', endpoint: ENDPOINT, missingCapabilities: [], steps: steps(0, 'discover', '未找到 AgentDesktop（control.sock 不存在）') }, account: null, inputGate: 'closed', features: emptyFeatures('platform_offline'), patrol: { enabled: false, intervalSeconds: 60 } }),
  incompatible: base({ connection: { state: 'incompatible', endpoint: ENDPOINT, product: 'AgentDesktop', apiVersion: 'agentdesktop.runtime/2', missingCapabilities: ['act', 'observe'], steps: steps(1, 'contract', '协议版本不匹配：需要 agentdesktop.runtime/1') }, account: null, inputGate: 'closed', features: emptyFeatures('capability_missing') }),
  unpaired: base({ connection: { state: 'unpaired', endpoint: ENDPOINT, product: 'AgentDesktop', apiVersion: 'agentdesktop.runtime/1', principal: { clientId: 'local:501', role: 'owner' }, missingCapabilities: [], steps: steps(2) }, account: null, inputGate: 'closed', features: { ...emptyFeatures('pairing_missing'), read_list: { enabled: true } } }),
  account_unconfirmed: base({ connection: { ...base({}).connection, steps: steps(4) }, account: { accountId: 'acct_a', visibleLabel: '（待确认）', evidenceIds: ['ev_1'], confirmedAt: T, revision: 0, status: 'unconfirmed' }, inputGate: 'closed', features: { ...emptyFeatures('account_unconfirmed'), read_list: { enabled: true } } }),
  ready_idle: base({}),
  waiting_approval: base({ counts: { waitingApproval: 2, needsReconciliation: 1, confirmed: 3 }, activeTask: acceptTask({}), tasks: [acceptTask({}), acceptTask({ taskId: 'task_2', type: 'send_message', target: { displayName: '林二', kind: 'single', confidence: 0.98, evidenceIds: ['ev_3'] }, draft: { text: '明天下午可以，请告诉我方便的时间。', revision: 2, source: 'model' } })] }),
  executing: base({ activeTask: acceptTask({ state: 'executing', platform: { runId: 'run_9', requestId: 'rq_1', delivery: 'dispatched', execution: 'completed', quiescence: 'not_confirmed' } }) }),
  stopping: base({ inputGate: 'stopping', activeTask: acceptTask({ state: 'stopping', platform: { runId: 'run_9', quiescence: 'pending' } }), features: emptyFeatures('input_gate_closed') }),
  quiescence_unconfirmed: base({ connection: { state: 'disconnected', endpoint: ENDPOINT, missingCapabilities: [], steps: steps(0, 'discover', '连接中断') }, inputGate: 'quiescence_unconfirmed', activeTask: acceptTask({ state: 'stopping', platform: { runId: 'run_9', quiescence: 'not_confirmed' } }), features: emptyFeatures('platform_offline') }),
  unknown_result: base({ counts: { waitingApproval: 0, needsReconciliation: 1, confirmed: 3 }, activeTask: acceptTask({ taskId: 'task_7', type: 'add_friend', state: 'needs_reconciliation', stateReason: 'platform_unknown', target: { displayName: '示例联系人', visibleIdentifier: 'example_wx', kind: 'search_profile', confidence: 0.9, evidenceIds: ['ev_5'] }, platform: { runId: 'run_示例', requestId: 'rq_7', delivery: 'unknown', quiescence: 'confirmed' }, timeline: [{ at: '2026-10-08T10:21:00+08:00', label: '业务批准' }, { at: '2026-10-08T10:21:01+08:00', label: '平台派发' }, { at: '2026-10-08T10:21:02+08:00', label: '连接中断' }, { at: '2026-10-08T10:21:03+08:00', label: '停止确认' }] }) }),
  ambiguous_identity: base({ activeTask: acceptTask({ state: 'blocked', stateReason: 'target_ambiguous', target: { displayName: '陈一', kind: 'friend_request', confidence: 0.41, evidenceIds: ['ev_2'] } }) }),
  approval_expired: base({ activeTask: acceptTask({ state: 'waiting_approval', stateReason: 'approval_expired', approval: { approvalId: 'appr_1', contentHash: 'abc', expiresAt: '2026-10-08T09:00:00+08:00', consumed: false } }) }),
  coverage_partial: base({ patrol: { enabled: true, intervalSeconds: 60, lastScanAt: T, coverage: 'partial', visibleSingleChats: 5 } }),
};
