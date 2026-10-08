// The app's own durable facts (方案 §08): tasks, approvals, attempts, quota,
// facts, evidence, outbox. Lane B implements it on SQLite; the in-memory
// fake in ./fakes is the reference for behaviour.

import type {
  AccountBinding, ActionAttempt, ActionKind, BusinessApproval, DomainFact, Evidence, Id, OutboxEvent, Policy,
  QuotaReservation, Revision, TaskPayload, TaskState, TaskType, Timestamp, WeChatTask,
} from './domain.ts';

export class LedgerConflictError extends Error {
  constructor(readonly kind: 'operation_fingerprint' | 'revision' | 'approval' | 'attempt' | 'transition', message: string) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}

/** The ledger refuses writes (corrupt file, disk full, bad migration). Never swallowed into an empty database. */
export class LedgerUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`ledger unavailable: ${reason}`);
    this.name = 'LedgerUnavailableError';
  }
}

export interface TaskIntake {
  operationId: string;
  fingerprint: string;
  type: TaskType;
  accountRevision: Revision;
  targetId?: Id;
  targetRevision?: Revision;
  payload: TaskPayload;
  payloadHash: string;
  deadline?: Timestamp;
}

export interface TaskQuery { cursor?: string; limit?: number; states?: TaskState[]; types?: TaskType[] }

export interface AttemptPrepare { taskId: Id; stepId: string; sessionId?: Id; runId?: Id }

export type QuotaDecision =
  | { ok: true; reservation: QuotaReservation }
  | { ok: false; reason: 'daily_limit' | 'min_interval' | 'outside_hours' | 'action_not_allowed' };

export interface LegacySuppression { key: string; sourceHash: string }

/** What a support bundle may say about the ledger. Never row contents. */
export interface LedgerDiagnostics {
  schemaVersion: number;
  writable: boolean;
  reason?: string;
  lastError?: { code?: string; message: string; operation: string; at: Timestamp };
  quickCheck?: string;
  rows?: Record<string, number>;
}

export interface Ledger {
  /** Same operationId + same fingerprint returns the existing task (created=false); a different fingerprint throws. */
  intake(input: TaskIntake, now: Timestamp): Promise<{ task: WeChatTask; created: boolean }>;
  getTask(taskId: Id): Promise<WeChatTask | undefined>;
  listTasks(query?: TaskQuery): Promise<{ tasks: WeChatTask[]; next?: string }>;
  /** Enforces TASK_TRANSITIONS and expectedRevision; writes an audit row in the same transaction. */
  transitionTask(taskId: Id, to: TaskState, expectedRevision: Revision, now: Timestamp, reason?: string): Promise<WeChatTask>;

  recordApproval(approval: Omit<BusinessApproval, 'approvalId' | 'consumedAt'>): Promise<BusinessApproval>;
  /** Read without consuming: a handler re-checks an approval before the dangerous click; the UI shows its state. */
  getApproval(approvalId: Id): Promise<BusinessApproval | undefined>;
  /** Single use; throws LedgerConflictError('approval') when consumed, expired, or any revision/hash differs. */
  consumeApproval(approvalId: Id, expected: { taskId: Id; contentHash: string; targetRevision: Revision; accountRevision: Revision }, now: Timestamp): Promise<BusinessApproval>;

  /** Next ordinal for (taskId, stepId); state prepared. */
  prepareAttempt(input: AttemptPrepare, now: Timestamp): Promise<ActionAttempt>;
  /** prepared → dispatching with the requestId that will be sent; persisted before the platform call. */
  markDispatching(attemptId: Id, dispatch: { requestId: Id; canonicalDigest: string; snapshotId: Id; sessionId: Id; runId: Id }, now: Timestamp): Promise<ActionAttempt>;
  recordReceipt(attemptId: Id, receiptId: Id, receipt: Record<string, unknown>, now: Timestamp): Promise<ActionAttempt>;
  markVerified(attemptId: Id, now: Timestamp): Promise<ActionAttempt>;
  markUnknown(attemptId: Id, reason: string, now: Timestamp): Promise<ActionAttempt>;
  /** dispatching → not_sent, only on a proven notSent error; the step may be planned again with a new attempt. */
  markNotSent(attemptId: Id, reason: string, now: Timestamp): Promise<ActionAttempt>;
  getAttempt(attemptId: Id): Promise<ActionAttempt | undefined>;
  /** All attempts of a task, oldest first: reconciliation and TaskView.platform read requestIds from here. */
  listAttempts(taskId: Id): Promise<ActionAttempt[]>;
  /** The platform receipt recordReceipt stored verbatim, for reconciliation. */
  getReceipt(attemptId: Id): Promise<Record<string, unknown> | undefined>;
  /** Attempts a crash left in dispatching/receipt_received: recovery queries them, never re-dispatches. */
  findOpenAttempts(): Promise<ActionAttempt[]>;

  reserveQuota(input: { accountId: Id; actionKind: ActionKind; intentId: Id }, policy: Policy, now: Timestamp): Promise<QuotaDecision>;
  consumeQuota(reservationId: Id): Promise<QuotaReservation>;
  releaseQuota(reservationId: Id): Promise<QuotaReservation>;
  /** For unknown outcomes: the reservation stays counted so the intent is not sent twice. */
  holdQuota(reservationId: Id): Promise<QuotaReservation>;

  appendFact(fact: Omit<DomainFact, 'factId'>): Promise<DomainFact>;
  listFacts(taskId: Id): Promise<DomainFact[]>;
  putEvidence(evidence: Omit<Evidence, 'evidenceId'>): Promise<Evidence>;
  getEvidence(evidenceId: Id): Promise<Evidence | undefined>;

  /** Idempotent on (taskId, revision, payloadHash): the same intent enqueued twice is one event. */
  enqueueOutbox(event: Omit<OutboxEvent, 'eventId' | 'state'>): Promise<OutboxEvent>;
  /** A terminal transition and its outbox event in one transaction; a refused transition leaves no event. */
  transitionTaskWithOutbox(taskId: Id, to: TaskState, expectedRevision: Revision, now: Timestamp, reason: string | undefined,
    outbox: (task: WeChatTask) => Omit<OutboxEvent, 'eventId' | 'state'>): Promise<{ task: WeChatTask; event: OutboxEvent }>;
  /** Every pending event, oldest first, retryAt included: the deliverer decides what is due with its own clock. */
  pendingOutbox(limit?: number): Promise<OutboxEvent[]>;
  /** A retryable failure: stays pending, attempts + 1, next try at retryAt. */
  deferOutbox(eventId: Id, retryAt: Timestamp, error: string): Promise<OutboxEvent>;
  /** Delivered (with the sink's receipt) or failed for good. */
  settleOutbox(eventId: Id, state: 'delivered' | 'failed', detail: { receipt?: string; error?: string }, now: Timestamp): Promise<OutboxEvent>;
  listOutbox(taskId: Id): Promise<OutboxEvent[]>;
  /** @deprecated use deferOutbox / settleOutbox; kept for older callers. */
  markOutbox(eventId: Id, state: 'delivered' | 'failed', retryAt?: Timestamp): Promise<OutboxEvent>;

  getAccount(): Promise<AccountBinding | undefined>;
  /** A new binding bumps the revision; approvals under the old revision stop matching. */
  confirmAccount(binding: Omit<AccountBinding, 'revision'>, expectedRevision: Revision | undefined): Promise<AccountBinding>;
  getPolicy(): Promise<Policy>;
  setPolicy(policy: Omit<Policy, 'revision'>, expectedRevision: Revision): Promise<Policy>;

  /** Old `handled` keys become suppressions only; they never create tasks or imply success. */
  importLegacySuppressions(entries: LegacySuppression[], migratedAt: Timestamp): Promise<number>;
  isSuppressed(key: string): Promise<boolean>;

  health(): Promise<{ writable: boolean; reason?: string; schemaVersion: number }>;
  /** For diagnostics.export; may be synchronous in an implementation, so always `await` it. */
  diagnostics(): LedgerDiagnostics | Promise<LedgerDiagnostics>;
  close(): Promise<void>;
}
