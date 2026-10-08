import { ATTEMPT_TRANSITIONS, canTransition } from '../domain.ts';
import type {
  AccountBinding, ActionAttempt, ActionKind, AttemptState, BusinessApproval, DomainFact, Evidence, Id, OutboxEvent, Policy,
  QuotaReservation, Revision, TaskState, Timestamp, WeChatTask,
} from '../domain.ts';
import { LedgerConflictError, LedgerUnavailableError } from '../ledger.ts';
import type { AttemptPrepare, Ledger, LedgerDiagnostics, LegacySuppression, QuotaDecision, TaskIntake, TaskQuery } from '../ledger.ts';

export const DEFAULT_POLICY: Policy = {
  revision: 1, allowlist: [], allowedActions: ['read', 'navigate', 'accept_request', 'send_friend_request', 'send_message'],
  activeHours: [{ start: '00:00', end: '24:00' }], timezone: 'Asia/Shanghai', maxDaily: {}, minIntervalSeconds: 0,
  modelUpload: false, patrolIntervalSeconds: 60, approvalPerAction: true,
};

/** Reference behaviour for the SQLite ledger. Single process, no durability. */
export class InMemoryLedger implements Ledger {
  readonly tasks = new Map<Id, WeChatTask>();
  readonly audit: { taskId: Id; from: TaskState; to: TaskState; at: Timestamp; reason?: string }[] = [];
  readonly approvals = new Map<Id, BusinessApproval>();
  readonly attempts = new Map<Id, ActionAttempt>();
  readonly receipts = new Map<Id, Record<string, unknown>>();
  readonly quotas = new Map<Id, QuotaReservation>();
  readonly facts: DomainFact[] = [];
  readonly evidence = new Map<Id, Evidence>();
  readonly outbox = new Map<Id, OutboxEvent>();
  readonly suppressions = new Map<string, LegacySuppression & { migratedAt: Timestamp }>();
  private account: AccountBinding | undefined;
  private policy: Policy = { ...DEFAULT_POLICY };
  private writable = true;
  private seq = 0;

  private id(prefix: string): Id {
    this.seq += 1;
    return `${prefix}_${this.seq.toString(36).padStart(4, '0')}`;
  }

  private write(): void {
    if (!this.writable) throw new LedgerUnavailableError('write failure injected');
  }

  /** Test helper: every later write throws, like a corrupt file or a full disk. */
  breakWrites(): void {
    this.writable = false;
  }

  async intake(input: TaskIntake, now: Timestamp): Promise<{ task: WeChatTask; created: boolean }> {
    this.write();
    const existing = [...this.tasks.values()].find((t) => t.operationId === input.operationId);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new LedgerConflictError('operation_fingerprint', `operationId ${input.operationId} already holds a different intent`);
      return { task: existing, created: false };
    }
    const task: WeChatTask = {
      taskId: this.id('task'), operationId: input.operationId, fingerprint: input.fingerprint, type: input.type,
      accountRevision: input.accountRevision, targetId: input.targetId, targetRevision: input.targetRevision,
      payload: input.payload, payloadHash: input.payloadHash, state: 'created', revision: 1, deadline: input.deadline,
      createdAt: now, updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    return { task, created: true };
  }

  async getTask(taskId: Id): Promise<WeChatTask | undefined> {
    return this.tasks.get(taskId);
  }

  async listTasks(query: TaskQuery = {}): Promise<{ tasks: WeChatTask[]; next?: string }> {
    let tasks = [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (query.states) tasks = tasks.filter((t) => query.states!.includes(t.state));
    if (query.types) tasks = tasks.filter((t) => query.types!.includes(t.type));
    const start = query.cursor ? Number(query.cursor) : 0;
    const limit = query.limit ?? 50;
    const page = tasks.slice(start, start + limit);
    return { tasks: page, next: start + limit < tasks.length ? String(start + limit) : undefined };
  }

  async transitionTask(taskId: Id, to: TaskState, expectedRevision: Revision, now: Timestamp, reason?: string): Promise<WeChatTask> {
    this.write();
    const task = this.tasks.get(taskId);
    if (!task) throw new LedgerConflictError('transition', `no task ${taskId}`);
    if (task.revision !== expectedRevision) throw new LedgerConflictError('revision', `task ${taskId} is at revision ${task.revision}, not ${expectedRevision}`);
    if (!canTransition(task.state, to)) throw new LedgerConflictError('transition', `${task.state} → ${to} is not allowed`);
    this.audit.push({ taskId, from: task.state, to, at: now, reason });
    task.state = to;
    task.revision += 1;
    task.updatedAt = now;
    return task;
  }

  async recordApproval(approval: Omit<BusinessApproval, 'approvalId' | 'consumedAt'>): Promise<BusinessApproval> {
    this.write();
    const saved: BusinessApproval = { ...approval, approvalId: this.id('appr') };
    this.approvals.set(saved.approvalId, saved);
    return saved;
  }

  async getApproval(approvalId: Id): Promise<BusinessApproval | undefined> {
    return this.approvals.get(approvalId);
  }

  async consumeApproval(approvalId: Id, expected: { taskId: Id; contentHash: string; targetRevision: Revision; accountRevision: Revision }, now: Timestamp): Promise<BusinessApproval> {
    this.write();
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new LedgerConflictError('approval', `no approval ${approvalId}`);
    if (approval.consumedAt) throw new LedgerConflictError('approval', 'approval already consumed');
    if (approval.expiresAt <= now) throw new LedgerConflictError('approval', 'approval expired');
    if (approval.taskId !== expected.taskId || approval.contentHash !== expected.contentHash
      || approval.targetRevision !== expected.targetRevision || approval.accountRevision !== expected.accountRevision) {
      throw new LedgerConflictError('approval', 'approval does not match the task, target, account or content');
    }
    approval.consumedAt = now;
    return approval;
  }

  private moveAttempt(attemptId: Id, to: AttemptState, now: Timestamp, patch: Partial<ActionAttempt> = {}): ActionAttempt {
    this.write();
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new LedgerConflictError('attempt', `no attempt ${attemptId}`);
    if (!ATTEMPT_TRANSITIONS[attempt.state].includes(to)) throw new LedgerConflictError('attempt', `${attempt.state} → ${to} is not allowed`);
    Object.assign(attempt, patch, { state: to, updatedAt: now });
    return attempt;
  }

  async prepareAttempt(input: AttemptPrepare, now: Timestamp): Promise<ActionAttempt> {
    this.write();
    const ordinal = [...this.attempts.values()].filter((a) => a.taskId === input.taskId && a.stepId === input.stepId).length + 1;
    const attempt: ActionAttempt = { attemptId: this.id('att'), taskId: input.taskId, stepId: input.stepId, attemptOrdinal: ordinal, sessionId: input.sessionId, runId: input.runId, state: 'prepared', createdAt: now, updatedAt: now };
    this.attempts.set(attempt.attemptId, attempt);
    return attempt;
  }

  async markDispatching(attemptId: Id, dispatch: { requestId: Id; canonicalDigest: string; snapshotId: Id; sessionId: Id; runId: Id }, now: Timestamp): Promise<ActionAttempt> {
    if ([...this.attempts.values()].some((a) => a.requestId === dispatch.requestId)) throw new LedgerConflictError('attempt', `requestId ${dispatch.requestId} already used`);
    return this.moveAttempt(attemptId, 'dispatching', now, dispatch);
  }

  async recordReceipt(attemptId: Id, receiptId: Id, receipt: Record<string, unknown>, now: Timestamp): Promise<ActionAttempt> {
    const moved = this.moveAttempt(attemptId, 'receipt_received', now, { receiptId });
    this.receipts.set(attemptId, receipt);
    return moved;
  }

  async getReceipt(attemptId: Id): Promise<Record<string, unknown> | undefined> {
    return this.receipts.get(attemptId);
  }

  async markVerified(attemptId: Id, now: Timestamp): Promise<ActionAttempt> {
    return this.moveAttempt(attemptId, 'verified', now);
  }

  async markUnknown(attemptId: Id, _reason: string, now: Timestamp): Promise<ActionAttempt> {
    return this.moveAttempt(attemptId, 'unknown', now);
  }

  async markNotSent(attemptId: Id, _reason: string, now: Timestamp): Promise<ActionAttempt> {
    return this.moveAttempt(attemptId, 'not_sent', now);
  }

  async getAttempt(attemptId: Id): Promise<ActionAttempt | undefined> {
    return this.attempts.get(attemptId);
  }

  async listAttempts(taskId: Id): Promise<ActionAttempt[]> {
    return [...this.attempts.values()].filter((a) => a.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attemptOrdinal - b.attemptOrdinal);
  }

  async findOpenAttempts(): Promise<ActionAttempt[]> {
    return [...this.attempts.values()].filter((a) => a.state === 'dispatching' || a.state === 'receipt_received');
  }

  private policyDay(now: Timestamp, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  }

  async reserveQuota(input: { accountId: Id; actionKind: ActionKind; intentId: Id }, policy: Policy, now: Timestamp): Promise<QuotaDecision> {
    this.write();
    if (!policy.allowedActions.includes(input.actionKind)) return { ok: false, reason: 'action_not_allowed' };
    const day = this.policyDay(now, policy.timezone);
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: policy.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
    if (!policy.activeHours.some((h) => h.start <= hhmm && hhmm < h.end)) return { ok: false, reason: 'outside_hours' };
    const same = [...this.quotas.values()].filter((q) => q.accountId === input.accountId && q.actionKind === input.actionKind && q.state !== 'released');
    const existing = same.find((q) => q.intentId === input.intentId);
    if (existing) return { ok: true, reservation: existing };
    const today = same.filter((q) => q.policyDay === day);
    const max = policy.maxDaily[input.actionKind];
    if (max !== undefined && today.length >= max) return { ok: false, reason: 'daily_limit' };
    const last = same.map((q) => q.createdAt).sort().at(-1);
    if (last && policy.minIntervalSeconds > 0 && (Date.parse(now) - Date.parse(last)) / 1000 < policy.minIntervalSeconds) return { ok: false, reason: 'min_interval' };
    const reservation: QuotaReservation = { reservationId: this.id('quota'), accountId: input.accountId, actionKind: input.actionKind, policyDay: day, intentId: input.intentId, state: 'reserved', createdAt: now };
    this.quotas.set(reservation.reservationId, reservation);
    return { ok: true, reservation };
  }

  private setQuota(reservationId: Id, state: QuotaReservation['state']): QuotaReservation {
    this.write();
    const q = this.quotas.get(reservationId);
    if (!q) throw new LedgerConflictError('attempt', `no reservation ${reservationId}`);
    // A held or consumed reservation keeps counting; it is never released by a later resume.
    if (q.state === 'held' || q.state === 'consumed') return q;
    q.state = state;
    return q;
  }

  async consumeQuota(reservationId: Id): Promise<QuotaReservation> { return this.setQuota(reservationId, 'consumed'); }
  async releaseQuota(reservationId: Id): Promise<QuotaReservation> { return this.setQuota(reservationId, 'released'); }
  async holdQuota(reservationId: Id): Promise<QuotaReservation> { return this.setQuota(reservationId, 'held'); }

  async appendFact(fact: Omit<DomainFact, 'factId'>): Promise<DomainFact> {
    this.write();
    const saved: DomainFact = { ...fact, factId: this.id('fact') };
    this.facts.push(saved);
    return saved;
  }

  async listFacts(taskId: Id): Promise<DomainFact[]> {
    return this.facts.filter((f) => f.taskId === taskId);
  }

  async putEvidence(evidence: Omit<Evidence, 'evidenceId'>): Promise<Evidence> {
    this.write();
    const saved: Evidence = { ...evidence, evidenceId: this.id('ev') };
    this.evidence.set(saved.evidenceId, saved);
    return saved;
  }

  async getEvidence(evidenceId: Id): Promise<Evidence | undefined> {
    return this.evidence.get(evidenceId);
  }

  async enqueueOutbox(event: Omit<OutboxEvent, 'eventId' | 'state'>): Promise<OutboxEvent> {
    this.write();
    const same = [...this.outbox.values()].find((e) => e.taskId === event.taskId && e.revision === event.revision && e.payloadHash === event.payloadHash);
    if (same) return same;
    const saved: OutboxEvent = { ...event, eventId: this.id('out'), state: 'pending', attempts: 0, enqueuedAt: new Date().toISOString() };
    this.outbox.set(saved.eventId, saved);
    return saved;
  }

  async transitionTaskWithOutbox(taskId: Id, to: TaskState, expectedRevision: Revision, now: Timestamp, reason: string | undefined,
    outbox: (task: WeChatTask) => Omit<OutboxEvent, 'eventId' | 'state'>): Promise<{ task: WeChatTask; event: OutboxEvent }> {
    // transitionTask throws before anything changes, so no event is written for a refused transition.
    const task = await this.transitionTask(taskId, to, expectedRevision, now, reason);
    const draft = outbox(task);
    if (draft.taskId !== taskId || draft.revision !== task.revision) throw new LedgerConflictError('transition', `outbox event must belong to ${taskId}@${task.revision}`);
    return { task, event: await this.enqueueOutbox(draft) };
  }

  async pendingOutbox(limit = 50): Promise<OutboxEvent[]> {
    return [...this.outbox.values()].filter((e) => e.state === 'pending').slice(0, limit);
  }

  async deferOutbox(eventId: Id, retryAt: Timestamp, error: string): Promise<OutboxEvent> {
    this.write();
    const event = this.outbox.get(eventId);
    if (!event) throw new LedgerConflictError('attempt', `no outbox event ${eventId}`);
    Object.assign(event, { retryAt, attempts: (event.attempts ?? 0) + 1, lastError: error });
    return event;
  }

  async settleOutbox(eventId: Id, state: 'delivered' | 'failed', detail: { receipt?: string; error?: string }, now: Timestamp): Promise<OutboxEvent> {
    this.write();
    const event = this.outbox.get(eventId);
    if (!event) throw new LedgerConflictError('attempt', `no outbox event ${eventId}`);
    Object.assign(event, { state, settledAt: now, receipt: detail.receipt, lastError: detail.error ?? event.lastError, retryAt: undefined });
    return event;
  }

  async listOutbox(taskId: Id): Promise<OutboxEvent[]> {
    return [...this.outbox.values()].filter((e) => e.taskId === taskId);
  }

  async markOutbox(eventId: Id, state: 'delivered' | 'failed', retryAt?: Timestamp): Promise<OutboxEvent> {
    this.write();
    const event = this.outbox.get(eventId);
    if (!event) throw new LedgerConflictError('attempt', `no outbox event ${eventId}`);
    event.state = state;
    event.retryAt = retryAt;
    return event;
  }

  async getAccount(): Promise<AccountBinding | undefined> {
    return this.account;
  }

  async confirmAccount(binding: Omit<AccountBinding, 'revision'>, expectedRevision: Revision | undefined): Promise<AccountBinding> {
    this.write();
    if ((this.account?.revision ?? undefined) !== expectedRevision) throw new LedgerConflictError('revision', 'account revision mismatch');
    this.account = { ...binding, revision: (this.account?.revision ?? 0) + 1 };
    return this.account;
  }

  async getPolicy(): Promise<Policy> {
    return this.policy;
  }

  async setPolicy(policy: Omit<Policy, 'revision'>, expectedRevision: Revision): Promise<Policy> {
    this.write();
    if (this.policy.revision !== expectedRevision) throw new LedgerConflictError('revision', 'policy revision mismatch');
    this.policy = { ...policy, revision: expectedRevision + 1 };
    return this.policy;
  }

  async importLegacySuppressions(entries: LegacySuppression[], migratedAt: Timestamp): Promise<number> {
    this.write();
    let added = 0;
    for (const entry of entries) {
      if (this.suppressions.has(entry.key)) continue;
      this.suppressions.set(entry.key, { ...entry, migratedAt });
      added += 1;
    }
    return added;
  }

  async isSuppressed(key: string): Promise<boolean> {
    return this.suppressions.has(key);
  }

  async health(): Promise<{ writable: boolean; reason?: string; schemaVersion: number }> {
    return { writable: this.writable, reason: this.writable ? undefined : 'write failure injected', schemaVersion: 0 };
  }

  async diagnostics(): Promise<LedgerDiagnostics> {
    return { schemaVersion: 0, writable: this.writable, reason: this.writable ? undefined : 'write failure injected', rows: { tasks: this.tasks.size, attempts: this.attempts.size, approvals: this.approvals.size } };
  }

  async close(): Promise<void> {}
}
