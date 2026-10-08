// Domain entities and state machines of the WeChat Agent (方案 §08). These are
// the app's own facts; nothing here mirrors a platform Run.

export type Id = string;
export type Revision = number;
/** ISO 8601 with offset, e.g. 2026-10-08T14:03:00+08:00. */
export type Timestamp = string;

export type TaskType = 'read_requests' | 'accept_request' | 'add_friend' | 'reply_draft' | 'send_message';

/** Business task states (方案 §08). */
export type TaskState =
  | 'created' | 'queued' | 'preparing' | 'waiting_approval' | 'ready' | 'executing' | 'verifying'
  | 'confirmed' | 'failed' | 'no_op' | 'needs_reconciliation' | 'cancelled'
  | 'stopping' | 'blocked' | 'waiting_user';

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['confirmed', 'failed', 'no_op', 'needs_reconciliation', 'cancelled'];

/** Allowed transitions. `blocked` / `waiting_user` return to the state they came from after a re-check. */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  created: ['queued', 'cancelled', 'blocked'],
  queued: ['preparing', 'cancelled', 'blocked'],
  preparing: ['waiting_approval', 'ready', 'no_op', 'failed', 'blocked', 'waiting_user', 'cancelled'],
  waiting_approval: ['ready', 'cancelled', 'blocked', 'waiting_user', 'preparing'],
  ready: ['executing', 'cancelled', 'blocked', 'preparing'],
  executing: ['verifying', 'stopping', 'needs_reconciliation', 'failed', 'waiting_user'],
  verifying: ['confirmed', 'failed', 'no_op', 'needs_reconciliation', 'stopping'],
  stopping: ['cancelled', 'confirmed', 'needs_reconciliation'],
  blocked: ['queued', 'preparing', 'waiting_approval', 'ready', 'cancelled'],
  waiting_user: ['preparing', 'ready', 'needs_reconciliation', 'cancelled'],
  confirmed: [], failed: [], no_op: [], needs_reconciliation: [], cancelled: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** One platform action on behalf of a task step (方案 §08 ActionAttempt). */
export type AttemptState = 'prepared' | 'dispatching' | 'receipt_received' | 'verified' | 'unknown';

export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  prepared: ['dispatching'],
  dispatching: ['receipt_received', 'unknown'],
  receipt_received: ['verified', 'unknown'],
  verified: [],
  // unknown is settled only by reconciliation, which appends facts; it never re-dispatches.
  unknown: ['verified'],
};

/** What a handler concludes about a task (方案 §09). Never a bare "success" boolean. */
export type DomainOutcome =
  | 'confirmed' | 'failed' | 'no_op' | 'needs_reconciliation' | 'sent_unconfirmed'
  | 'ambiguous' | 'waiting_user' | 'blocked';

export type DomainReasonCode =
  | 'capability_missing' | 'pairing_missing' | 'policy_disabled' | 'write_gate_closed'
  | 'content_mismatch' | 'target_ambiguous' | 'identity_unproven' | 'account_changed'
  | 'approval_invalid' | 'approval_expired' | 'user_draft_present' | 'unexpected_dialog'
  | 'layout_unreadable' | 'coverage_partial' | 'not_found' | 'already_friend' | 'request_expired'
  | 'disconnected' | 'platform_unknown' | 'verification_missing' | 'rate_limited' | 'cancelled';

export interface DomainResult {
  outcome: DomainOutcome;
  reasonCode?: DomainReasonCode;
  reason?: string;
  facts: DomainFact[];
  evidenceIds: Id[];
}

export interface AccountBinding {
  /** Local UUID; never pretends to be WeChat's internal id. */
  accountId: Id;
  visibleLabel: string;
  evidenceIds: Id[];
  confirmedAt: Timestamp;
  revision: Revision;
  status: 'unconfirmed' | 'confirmed' | 'changed';
}

export type TargetKind = 'single' | 'group' | 'friend_request' | 'search_profile';

export interface TargetRef {
  targetId: Id;
  accountId: Id;
  kind: TargetKind;
  displayName: string;
  /** A WeChat id or phone number as the UI showed it, when it did. */
  visibleIdentifier?: string;
  identityEvidenceIds: Id[];
  /** 0..1; outbound actions need identity evidence, not a high number. */
  confidence: number;
  revision: Revision;
}

export type IdKind = 'phone' | 'wechat_id' | 'internal_wxid' | 'unknown';

export interface ReadRequestsPayload { kind: 'read_requests' }
export interface AcceptRequestPayload { kind: 'accept_request'; requestKey: string }
export interface AddFriendPayload { kind: 'add_friend'; typedId: string; idKind: IdKind; note: string }
export interface ReplyDraftPayload { kind: 'reply_draft'; conversationTargetId: Id; source: 'manual' | 'model' }
export interface SendMessagePayload { kind: 'send_message'; conversationTargetId: Id; content: string; contentHash: string; contextRevision: Revision }
export type TaskPayload = ReadRequestsPayload | AcceptRequestPayload | AddFriendPayload | ReplyDraftPayload | SendMessagePayload;

export interface WeChatTask {
  taskId: Id;
  /** Client-chosen; the same operationId with the same fingerprint returns the same task. */
  operationId: string;
  /** sha256 over (type, target, payloadHash). */
  fingerprint: string;
  type: TaskType;
  accountRevision: Revision;
  targetId?: Id;
  targetRevision?: Revision;
  payload: TaskPayload;
  payloadHash: string;
  state: TaskState;
  stateReason?: DomainReasonCode;
  revision: Revision;
  deadline?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type ActionKind = 'accept_request' | 'send_friend_request' | 'send_message' | 'navigate' | 'read';

export interface BusinessApproval {
  approvalId: Id;
  taskId: Id;
  accountRevision: Revision;
  targetRevision: Revision;
  draftRevision: Revision;
  contentHash: string;
  allowedAction: ActionKind;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  consumedAt?: Timestamp;
}

export interface ActionAttempt {
  attemptId: Id;
  taskId: Id;
  stepId: string;
  attemptOrdinal: number;
  /** The platform requestId, chosen before dispatch and never swapped on retry. */
  requestId?: Id;
  canonicalDigest?: string;
  sessionId?: Id;
  runId?: Id;
  snapshotId?: Id;
  state: AttemptState;
  receiptId?: Id;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type FactKind =
  | 'list_read' | 'request_read' | 'profile_read' | 'request_status' | 'friend_added'
  | 'friend_request_sent' | 'message_sent' | 'input_mismatch' | 'platform_receipt'
  | 'quiescence' | 'reconciliation' | 'manual_conclusion';

export interface DomainFact {
  factId: Id;
  taskId: Id;
  factKind: FactKind;
  outcome: DomainOutcome | 'observed';
  evidenceIds: Id[];
  observedAt: Timestamp;
  confidence: number;
  reason?: string;
  data?: Record<string, unknown>;
}

export type Coverage = 'current_viewport' | 'partial' | 'end_confirmed' | 'unreadable';

export interface Evidence {
  evidenceId: Id;
  artifactId?: Id;
  /** A path owned by the app, never a platform path. */
  localPath?: string;
  sha256: string;
  captureTime: Timestamp;
  coverage: Coverage;
  crop?: { x: number; y: number; width: number; height: number };
  retentionUntil: Timestamp;
}

export interface Policy {
  revision: Revision;
  /** Target ids of single chats the app may reply in. */
  allowlist: Id[];
  allowedActions: ActionKind[];
  activeHours: { start: string; end: string }[];
  timezone: string;
  maxDaily: Partial<Record<ActionKind, number>>;
  minIntervalSeconds: number;
  modelUpload: boolean;
  patrolIntervalSeconds: number;
  approvalPerAction: true;
}

export interface QuotaReservation {
  reservationId: Id;
  accountId: Id;
  actionKind: ActionKind;
  /** Local calendar day in the policy timezone. */
  policyDay: string;
  intentId: Id;
  state: 'reserved' | 'consumed' | 'released' | 'held';
  createdAt: Timestamp;
}

export interface OutboxEvent {
  eventId: Id;
  taskId: Id;
  revision: Revision;
  payloadHash: string;
  payload: Record<string, unknown>;
  state: 'pending' | 'delivered' | 'failed';
  retryAt?: Timestamp;
}
