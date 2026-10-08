// The typed IPC between the renderer (lane F) and the application service
// (lane E), through the Electron main process (lane G). 方案 §08 local methods.
// The renderer never sees platform `act` parameters.

import type {
  AccountBinding, BusinessApproval, DomainFact, DomainReasonCode, Id, Revision, TaskPayload, TaskState, TaskType, Timestamp, WeChatTask,
} from './domain.ts';

export type FeatureKey = 'read_list' | 'accept_request' | 'add_friend' | 'reply_draft' | 'send_message' | 'handback';

export type FeatureState =
  | { enabled: true }
  | { enabled: false; reason: 'pairing_missing' | 'capability_missing' | 'policy_disabled' | 'platform_offline' | 'account_unconfirmed' | 'input_gate_closed'; detail?: string };

export type ConnectionState = 'disconnected' | 'connecting' | 'incompatible' | 'unpaired' | 'ready';

export type InputGateState = 'open' | 'closed' | 'stopping' | 'quiescence_unconfirmed';

export interface SetupStep { key: 'discover' | 'contract' | 'pairing' | 'window' | 'account' | 'baseline'; state: 'pending' | 'done' | 'failed' | 'blocked'; detail?: string }

export interface TaskView {
  taskId: Id;
  type: TaskType;
  state: TaskState;
  stateReason?: DomainReasonCode;
  revision: Revision;
  target?: { displayName: string; visibleIdentifier?: string; kind: string; confidence: number; evidenceIds: Id[]; /** The verification message of a friend request. */ message?: string };
  draft?: { text: string; revision: Revision; source: 'manual' | 'model' };
  approval?: { approvalId: Id; contentHash: string; expiresAt: Timestamp; consumed: boolean };
  /** sha256 of the draft the app would ask approval for; the renderer must send this hash back, never its own. */
  pendingContentHash?: string;
  platform?: { runId?: Id; requestId?: Id; delivery?: string; execution?: string; quiescence?: string };
  facts: DomainFact[];
  timeline: { at: Timestamp; label: string }[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AppSnapshot {
  revision: Revision;
  connection: {
    state: ConnectionState;
    endpoint: string;
    product?: string;
    apiVersion?: string;
    principal?: { clientId: string; role: string };
    missingCapabilities: string[];
    steps: SetupStep[];
  };
  account: AccountBinding | null;
  inputGate: InputGateState;
  patrol: { enabled: boolean; intervalSeconds: number; lastScanAt?: Timestamp; coverage?: string; visibleSingleChats?: number };
  counts: { waitingApproval: number; needsReconciliation: number; confirmed: number };
  activeTask?: TaskView;
  tasks: TaskView[];
  features: Record<FeatureKey, FeatureState>;
  policy: { allowlistCount: number; approvalPerAction: true; modelUpload: boolean; patrolIntervalSeconds: number; approvalTtlSeconds: number; evidenceRetentionDays: number };
}

export interface IpcMethods {
  'app.getSnapshot': { params: Record<string, never>; result: AppSnapshot };
  'connection.check': { params: Record<string, never>; result: { state: ConnectionState; apiVersion?: string; methods: string[]; missingCapabilities: string[] } };
  'account.confirm': { params: { bindingEvidenceId: Id; expectedRevision?: Revision }; result: AccountBinding };
  'task.create': { params: { operationId: string; type: TaskType; targetId?: Id; payload: TaskPayload; expectedAccountRevision: Revision }; result: TaskView };
  'task.list': { params: { cursor?: string; limit?: number }; result: { tasks: TaskView[]; next?: string } };
  'task.show': { params: { taskId: Id }; result: TaskView };
  'task.draft': { params: { taskId: Id; text: string; expectedDraftRevision: Revision }; result: TaskView };
  'task.approve': { params: { taskId: Id; approvalRevision: Revision; approvedContentHash: string; expiresAt: Timestamp }; result: BusinessApproval };
  'task.skip': { params: { taskId: Id; expectedRevision: Revision }; result: TaskView };
  'task.cancel': { params: { taskId: Id; expectedRevision: Revision }; result: TaskView };
  'app.pause': { params: { operationId: string; expectedRevision: Revision }; result: { inputGate: InputGateState } };
  'app.resume': { params: { operationId: string; expectedRevision: Revision }; result: { inputGate: InputGateState } };
  'task.reconcile': { params: { taskId: Id; expectedRevision: Revision }; result: TaskView };
  'task.concludeManually': { params: { taskId: Id; expectedRevision: Revision; conclusion: string; evidenceIds: Id[] }; result: TaskView };
  'window.requestHandback': { params: { operationId: string }; result: { mode: 'platform' | 'manual'; instructions?: string } };
  /** Read-only: an evidence image for display, redacted by default; the app never hands out platform paths. */
  'evidence.read': { params: { evidenceId: Id; redacted?: boolean }; result: { dataUrl: string; width: number; height: number; crop?: { x: number; y: number; width: number; height: number }; redacted: boolean; captureTime: Timestamp } };
  'diagnostics.export': { params: { includeEvidence: boolean; selectedEvidenceIds: Id[] }; result: { path: string; byteSize: number } };
}

export type IpcMethod = keyof IpcMethods;

/** The preload whitelist. Nothing else crosses the renderer boundary. */
export const IPC_METHODS: readonly IpcMethod[] = [
  'app.getSnapshot', 'connection.check', 'account.confirm', 'task.create', 'task.list', 'task.show', 'task.draft',
  'task.approve', 'task.skip', 'task.cancel', 'app.pause', 'app.resume', 'task.reconcile', 'task.concludeManually',
  'window.requestHandback', 'diagnostics.export', 'evidence.read',
];

export interface IpcError {
  code: 'revision_conflict' | 'operation_conflict' | 'not_found' | 'invalid_state' | 'blocked' | 'unavailable' | 'internal';
  message: string;
  details?: Record<string, unknown>;
}

export class IpcFailure extends Error {
  constructor(readonly error: IpcError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'IpcFailure';
  }
}

/** What the main process exposes; the renderer gets exactly this shape over contextBridge. */
export interface ApplicationService {
  call<M extends IpcMethod>(method: M, params: IpcMethods[M]['params']): Promise<IpcMethods[M]['result']>;
  /** Snapshot pushes; returns an unsubscribe. */
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
}
