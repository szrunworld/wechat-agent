// SQLite implementation of the Ledger port (方案 E04). Behaviour follows
// packages/ports/src/fakes/ledger.ts; this file adds durability: WAL, a
// single writer (immediate transactions + busy_timeout), forward-only
// migrations, and a hard stop on the first failed write.
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ATTEMPT_TRANSITIONS, canTransition, LedgerConflictError, LedgerUnavailableError } from '@wechat-agent/ports';
import type {
  AccountBinding, ActionAttempt, ActionKind, AttemptPrepare, AttemptState, BusinessApproval, DomainFact, Evidence, Id,
  Ledger, LegacySuppression, OutboxEvent, Policy, QuotaDecision, QuotaReservation, Revision, TaskIntake, TaskQuery,
  TaskState, Timestamp, WeChatTask,
} from '@wechat-agent/ports';
import { migrate, MIGRATIONS, SUPPORTED_SCHEMA_VERSION, schemaVersionOf } from './migrations.ts';
import type { Migration } from './migrations.ts';

/** Same values as the in-memory fake's DEFAULT_POLICY; stored on first open. */
export const DEFAULT_POLICY: Policy = {
  revision: 1, allowlist: [], allowedActions: ['read', 'navigate', 'accept_request', 'send_friend_request', 'send_message'],
  activeHours: [{ start: '00:00', end: '24:00' }], timezone: 'Asia/Shanghai', maxDaily: {}, minIntervalSeconds: 0,
  modelUpload: false, patrolIntervalSeconds: 60, approvalPerAction: true,
};

/** Test-only knobs. Production callers pass nothing. */
export interface FaultInjection {
  /** `PRAGMA max_page_count` for this connection: a real SQLITE_FULL once the file reaches it. */
  maxPageCount?: number;
  /** Called inside every write transaction just before commit; throwing rolls the transaction back (a crash before commit). */
  beforeCommit?: (operation: string) => void;
}

export interface OpenOptions {
  busyTimeoutMs?: number;
  /** Replaces the shipped migrations (tests only). */
  migrations?: readonly Migration[];
  faultInjection?: FaultInjection;
}

export interface LedgerDiagnostics {
  path: string;
  exportedAt: Timestamp;
  schemaVersion: number;
  supportedSchemaVersion: number;
  writable: boolean;
  reason?: string;
  lastError?: { code?: string; message: string; operation: string; at: Timestamp };
  quickCheck?: string;
  fileBytes?: number;
  walBytes?: number;
  pageCount?: number;
  pageSize?: number;
  rows?: Record<string, number>;
}

type Row = Record<string, unknown>;

/** OutboxEvent plus the delivery bookkeeping of migration 0003 (the port type stays frozen; extra fields are additive). */
export interface StoredOutboxEvent extends OutboxEvent {
  attempts: number;
  lastError?: string;
  receipt?: string;
  enqueuedAt?: Timestamp;
  settledAt?: Timestamp;
}

const TABLES = ['tasks', 'task_audit', 'approvals', 'attempts', 'quota_reservations', 'facts', 'evidence', 'outbox', 'account', 'policy', 'legacy_suppression'] as const;

function sqliteCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : undefined;
}

function reasonFor(code: string | undefined, message: string): string {
  if (code === 'SQLITE_FULL') return 'disk_full';
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return 'corrupt';
  if (code === 'SQLITE_READONLY' || code === 'SQLITE_READONLY_DBMOVED') return 'read_only';
  if (code === 'SQLITE_IOERR' || code?.startsWith('SQLITE_IOERR_')) return 'io_error';
  return `write_failed: ${code ?? message}`;
}

function nul<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}
function opt<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
function parse<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}
/** Drops undefined keys so a row read back equals the object that was written. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value)) if ((value as Record<string, unknown>)[key] === undefined) delete (value as Record<string, unknown>)[key];
  return value;
}
function uid(prefix: string): Id {
  return `${prefix}_${randomUUID()}`;
}
function policyDay(now: Timestamp, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
function policyTime(now: Timestamp, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
}

export class SqliteLedger implements Ledger {
  private db: Database.Database;
  private readonly fault: FaultInjection;
  private writable = true;
  private reason: string | undefined;
  private lastError: LedgerDiagnostics['lastError'];
  private closed = false;
  private readonly schemaVersion: number;

  private constructor(readonly path: string, db: Database.Database, schemaVersion: number, fault: FaultInjection) {
    this.db = db;
    this.schemaVersion = schemaVersion;
    this.fault = fault;
  }

  /** Opens or creates the file. A file that cannot be read, migrated or checked throws; nothing is ever replaced by an empty database. */
  static open(path: string, options: OpenOptions = {}): SqliteLedger {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    let db: Database.Database;
    try {
      db = new Database(path, { timeout: options.busyTimeoutMs ?? 5000 });
    } catch (error) {
      throw new LedgerUnavailableError(`open_failed: ${(error as Error).message}`);
    }
    let version: number;
    try {
      chmodSync(path, 0o600);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      if (options.faultInjection?.maxPageCount) db.pragma(`max_page_count = ${options.faultInjection.maxPageCount}`);
      const check = db.pragma('quick_check', { simple: true }) as string;
      if (check !== 'ok') throw new LedgerUnavailableError(`corrupt: ${check}`);
      version = migrate(db, options.migrations ?? MIGRATIONS);
      db.transaction(() => {
        const has = db.prepare(`SELECT 1 FROM policy WHERE singleton = 1`).get();
        if (!has) {
          const { revision, ...body } = DEFAULT_POLICY;
          db.prepare(`INSERT INTO policy (singleton, revision, body) VALUES (1, ?, ?)`).run(revision, JSON.stringify(body));
        }
      }).immediate();
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    } catch (error) {
      db.close();
      if (error instanceof LedgerUnavailableError) throw error;
      const code = sqliteCode(error);
      throw new LedgerUnavailableError(`${reasonFor(code, (error as Error).message)}: ${(error as Error).message}`);
    }
    return new SqliteLedger(path, db, version, options.faultInjection ?? {});
  }

  // ---- write discipline -------------------------------------------------

  private guard(): void {
    if (this.closed) throw new LedgerUnavailableError('closed');
    if (!this.writable) throw new LedgerUnavailableError(this.reason ?? 'write_failed');
  }

  /** Every write: one immediate transaction. A SQLite failure stops all later writes and exports diagnostics. */
  private write<T>(operation: string, fn: () => T): T {
    this.guard();
    try {
      return this.db.transaction(() => {
        const result = fn();
        this.fault.beforeCommit?.(operation);
        return result;
      }).immediate();
    } catch (error) {
      if (error instanceof LedgerConflictError) throw error;
      const code = sqliteCode(error);
      if (!code) throw error;
      this.stopWrites(operation, code, (error as Error).message);
      throw new LedgerUnavailableError(this.reason!);
    }
  }

  private stopWrites(operation: string, code: string | undefined, message: string): void {
    this.writable = false;
    this.reason = reasonFor(code, message);
    this.lastError = { code, message, operation, at: new Date().toISOString() };
    try {
      const diagnostics = this.diagnostics();
      writeFileSync(`${this.path}.diagnostics.json`, JSON.stringify(diagnostics, null, 2), { mode: 0o600 });
    } catch {
      // Best effort: a full disk may refuse the export too; diagnostics() still answers in memory.
    }
  }

  private read<T>(fn: () => T): T {
    if (this.closed) throw new LedgerUnavailableError('closed');
    try {
      return fn();
    } catch (error) {
      const code = sqliteCode(error);
      if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code?.startsWith('SQLITE_IOERR')) {
        this.stopWrites('read', code, (error as Error).message);
        throw new LedgerUnavailableError(this.reason!);
      }
      throw error;
    }
  }

  /** What a support bundle needs: version, writability, last failure, integrity, sizes, row counts. Never includes row contents. */
  diagnostics(): LedgerDiagnostics {
    const out: LedgerDiagnostics = {
      path: this.path, exportedAt: new Date().toISOString(), schemaVersion: this.schemaVersion,
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, writable: this.writable && !this.closed, reason: this.reason, lastError: this.lastError,
    };
    try { out.fileBytes = statSync(this.path).size; } catch { /* unreadable size is itself a finding */ }
    try { out.walBytes = statSync(`${this.path}-wal`).size; } catch { /* no wal file */ }
    if (this.closed) return out;
    try { out.quickCheck = this.db.pragma('quick_check', { simple: true }) as string; } catch (error) { out.quickCheck = `failed: ${(error as Error).message}`; }
    try {
      out.pageCount = this.db.pragma('page_count', { simple: true }) as number;
      out.pageSize = this.db.pragma('page_size', { simple: true }) as number;
      out.rows = {};
      for (const table of TABLES) out.rows[table] = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } catch { /* partial diagnostics are better than none */ }
    return out;
  }

  // ---- tasks --------------------------------------------------------------

  private taskFromRow(r: Row): WeChatTask {
    return compact({
      taskId: r.task_id as Id, operationId: r.operation_id as string, fingerprint: r.fingerprint as string, type: r.type as WeChatTask['type'],
      accountRevision: r.account_revision as Revision, targetId: opt(r.target_id as Id | null), targetRevision: opt(r.target_revision as Revision | null),
      payload: JSON.parse(r.payload as string), payloadHash: r.payload_hash as string, state: r.state as TaskState,
      stateReason: opt(r.state_reason as WeChatTask['stateReason'] | null), revision: r.revision as Revision, deadline: opt(r.deadline as Timestamp | null),
      createdAt: r.created_at as Timestamp, updatedAt: r.updated_at as Timestamp,
    });
  }

  private taskRow(taskId: Id): Row | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(taskId) as Row | undefined;
  }

  async intake(input: TaskIntake, now: Timestamp): Promise<{ task: WeChatTask; created: boolean }> {
    return this.write('intake', () => {
      const existing = this.db.prepare(`SELECT * FROM tasks WHERE operation_id = ?`).get(input.operationId) as Row | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) throw new LedgerConflictError('operation_fingerprint', `operationId ${input.operationId} already holds a different intent`);
        return { task: this.taskFromRow(existing), created: false };
      }
      const task: WeChatTask = compact({
        taskId: uid('task'), operationId: input.operationId, fingerprint: input.fingerprint, type: input.type,
        accountRevision: input.accountRevision, targetId: input.targetId, targetRevision: input.targetRevision,
        payload: input.payload, payloadHash: input.payloadHash, state: 'created', revision: 1, deadline: input.deadline,
        createdAt: now, updatedAt: now,
      });
      this.db.prepare(`INSERT INTO tasks (task_id, operation_id, fingerprint, type, account_revision, target_id, target_revision, payload, payload_hash, state, state_reason, revision, deadline, created_at, updated_at)
        VALUES (@taskId, @operationId, @fingerprint, @type, @accountRevision, @targetId, @targetRevision, @payload, @payloadHash, @state, NULL, @revision, @deadline, @createdAt, @updatedAt)`)
        .run({ ...task, targetId: nul(task.targetId), targetRevision: nul(task.targetRevision), payload: JSON.stringify(task.payload), deadline: nul(task.deadline) });
      return { task, created: true };
    });
  }

  async getTask(taskId: Id): Promise<WeChatTask | undefined> {
    return this.read(() => {
      const row = this.taskRow(taskId);
      return row ? this.taskFromRow(row) : undefined;
    });
  }

  async listTasks(query: TaskQuery = {}): Promise<{ tasks: WeChatTask[]; next?: string }> {
    return this.read(() => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.states?.length) { where.push(`state IN (${query.states.map(() => '?').join(',')})`); params.push(...query.states); }
      if (query.types?.length) { where.push(`type IN (${query.types.map(() => '?').join(',')})`); params.push(...query.types); }
      const start = query.cursor ? Number(query.cursor) : 0;
      if (!Number.isInteger(start) || start < 0) throw new LedgerConflictError('transition', `bad cursor ${query.cursor}`);
      const limit = query.limit ?? 50;
      const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid LIMIT ? OFFSET ?`;
      const rows = this.db.prepare(sql).all(...params, limit + 1, start) as Row[];
      const tasks = rows.slice(0, limit).map((r) => this.taskFromRow(r));
      return { tasks, next: rows.length > limit ? String(start + limit) : undefined };
    });
  }

  async transitionTask(taskId: Id, to: TaskState, expectedRevision: Revision, now: Timestamp, reason?: string): Promise<WeChatTask> {
    return this.write('transitionTask', () => {
      const row = this.taskRow(taskId);
      if (!row) throw new LedgerConflictError('transition', `no task ${taskId}`);
      const task = this.taskFromRow(row);
      if (task.revision !== expectedRevision) throw new LedgerConflictError('revision', `task ${taskId} is at revision ${task.revision}, not ${expectedRevision}`);
      if (!canTransition(task.state, to)) throw new LedgerConflictError('transition', `${task.state} → ${to} is not allowed`);
      const next = task.revision + 1;
      this.db.prepare(`INSERT INTO task_audit (task_id, from_state, to_state, from_revision, to_revision, at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(taskId, task.state, to, task.revision, next, now, nul(reason));
      const changed = this.db.prepare(`UPDATE tasks SET state = ?, revision = ?, updated_at = ? WHERE task_id = ? AND revision = ?`).run(to, next, now, taskId, task.revision).changes;
      if (changed !== 1) throw new LedgerConflictError('revision', `task ${taskId} changed under us`);
      return { ...task, state: to, revision: next, updatedAt: now };
    });
  }

  /** Audit rows of one task, oldest first. */
  listAudit(taskId: Id): { taskId: Id; from: TaskState; to: TaskState; fromRevision: Revision; toRevision: Revision; at: Timestamp; reason?: string }[] {
    return this.read(() => (this.db.prepare(`SELECT * FROM task_audit WHERE task_id = ? ORDER BY audit_id`).all(taskId) as Row[]).map((r) => compact({
      taskId: r.task_id as Id, from: r.from_state as TaskState, to: r.to_state as TaskState, fromRevision: r.from_revision as Revision,
      toRevision: r.to_revision as Revision, at: r.at as Timestamp, reason: opt(r.reason as string | null),
    })));
  }

  // ---- approvals ----------------------------------------------------------

  private approvalFromRow(r: Row): BusinessApproval {
    return compact({
      approvalId: r.approval_id as Id, taskId: r.task_id as Id, accountRevision: r.account_revision as Revision, targetRevision: r.target_revision as Revision,
      draftRevision: r.draft_revision as Revision, contentHash: r.content_hash as string, allowedAction: r.allowed_action as ActionKind,
      expiresAt: r.expires_at as Timestamp, createdAt: r.created_at as Timestamp, consumedAt: opt(r.consumed_at as Timestamp | null),
    });
  }

  async recordApproval(approval: Omit<BusinessApproval, 'approvalId' | 'consumedAt'>): Promise<BusinessApproval> {
    return this.write('recordApproval', () => {
      const saved: BusinessApproval = compact({ ...approval, approvalId: uid('appr') });
      this.db.prepare(`INSERT INTO approvals (approval_id, task_id, account_revision, target_revision, draft_revision, content_hash, allowed_action, expires_at, created_at, consumed_at)
        VALUES (@approvalId, @taskId, @accountRevision, @targetRevision, @draftRevision, @contentHash, @allowedAction, @expiresAt, @createdAt, NULL)`).run(saved);
      return saved;
    });
  }

  async consumeApproval(approvalId: Id, expected: { taskId: Id; contentHash: string; targetRevision: Revision; accountRevision: Revision }, now: Timestamp): Promise<BusinessApproval> {
    return this.write('consumeApproval', () => {
      const row = this.db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId) as Row | undefined;
      if (!row) throw new LedgerConflictError('approval', `no approval ${approvalId}`);
      const approval = this.approvalFromRow(row);
      if (approval.consumedAt) throw new LedgerConflictError('approval', 'approval already consumed');
      if (Date.parse(approval.expiresAt) <= Date.parse(now)) throw new LedgerConflictError('approval', 'approval expired');
      if (approval.taskId !== expected.taskId || approval.contentHash !== expected.contentHash
        || approval.targetRevision !== expected.targetRevision || approval.accountRevision !== expected.accountRevision) {
        throw new LedgerConflictError('approval', 'approval does not match the task, target, account or content');
      }
      const changed = this.db.prepare(`UPDATE approvals SET consumed_at = ? WHERE approval_id = ? AND consumed_at IS NULL`).run(now, approvalId).changes;
      if (changed !== 1) throw new LedgerConflictError('approval', 'approval already consumed');
      return { ...approval, consumedAt: now };
    });
  }

  async getApproval(approvalId: Id): Promise<BusinessApproval | undefined> {
    return this.read(() => {
      const row = this.db.prepare(`SELECT * FROM approvals WHERE approval_id = ?`).get(approvalId) as Row | undefined;
      return row ? this.approvalFromRow(row) : undefined;
    });
  }

  // ---- attempts -----------------------------------------------------------

  private attemptFromRow(r: Row): ActionAttempt {
    return compact({
      attemptId: r.attempt_id as Id, taskId: r.task_id as Id, stepId: r.step_id as string, attemptOrdinal: r.attempt_ordinal as number,
      requestId: opt(r.request_id as Id | null), canonicalDigest: opt(r.canonical_digest as string | null), sessionId: opt(r.session_id as Id | null),
      runId: opt(r.run_id as Id | null), snapshotId: opt(r.snapshot_id as Id | null), state: r.state as AttemptState, receiptId: opt(r.receipt_id as Id | null),
      createdAt: r.created_at as Timestamp, updatedAt: r.updated_at as Timestamp,
    });
  }

  private attemptRow(attemptId: Id): Row | undefined {
    return this.db.prepare(`SELECT * FROM attempts WHERE attempt_id = ?`).get(attemptId) as Row | undefined;
  }

  private moveAttempt(operation: string, attemptId: Id, to: AttemptState, now: Timestamp, patch: Record<string, unknown> = {}): ActionAttempt {
    const row = this.attemptRow(attemptId);
    if (!row) throw new LedgerConflictError('attempt', `no attempt ${attemptId}`);
    const attempt = this.attemptFromRow(row);
    if (!ATTEMPT_TRANSITIONS[attempt.state].includes(to)) throw new LedgerConflictError('attempt', `${attempt.state} → ${to} is not allowed`);
    const columns = Object.keys(patch);
    const sets = ['state = @state', 'updated_at = @updatedAt', ...columns.map((c) => `${c} = @${c}`)].join(', ');
    const changed = this.db.prepare(`UPDATE attempts SET ${sets} WHERE attempt_id = @attemptId AND state = @fromState`)
      .run({ ...patch, state: to, updatedAt: now, attemptId, fromState: attempt.state }).changes;
    if (changed !== 1) throw new LedgerConflictError('attempt', `attempt ${attemptId} changed under ${operation}`);
    return this.attemptFromRow(this.attemptRow(attemptId)!);
  }

  async prepareAttempt(input: AttemptPrepare, now: Timestamp): Promise<ActionAttempt> {
    return this.write('prepareAttempt', () => {
      const { n } = this.db.prepare(`SELECT COALESCE(MAX(attempt_ordinal), 0) AS n FROM attempts WHERE task_id = ? AND step_id = ?`).get(input.taskId, input.stepId) as { n: number };
      const attempt: ActionAttempt = compact({
        attemptId: uid('att'), taskId: input.taskId, stepId: input.stepId, attemptOrdinal: n + 1, sessionId: input.sessionId, runId: input.runId,
        state: 'prepared', createdAt: now, updatedAt: now,
      });
      this.db.prepare(`INSERT INTO attempts (attempt_id, task_id, step_id, attempt_ordinal, request_id, canonical_digest, session_id, run_id, snapshot_id, state, receipt_id, receipt, unknown_reason, created_at, updated_at)
        VALUES (@attemptId, @taskId, @stepId, @attemptOrdinal, NULL, NULL, @sessionId, @runId, NULL, @state, NULL, NULL, NULL, @createdAt, @updatedAt)`)
        .run({ ...attempt, sessionId: nul(attempt.sessionId), runId: nul(attempt.runId) });
      return attempt;
    });
  }

  async markDispatching(attemptId: Id, dispatch: { requestId: Id; canonicalDigest: string; snapshotId: Id; sessionId: Id; runId: Id }, now: Timestamp): Promise<ActionAttempt> {
    return this.write('markDispatching', () => {
      const used = this.db.prepare(`SELECT attempt_id FROM attempts WHERE request_id = ?`).get(dispatch.requestId);
      if (used) throw new LedgerConflictError('attempt', `requestId ${dispatch.requestId} already used`);
      return this.moveAttempt('markDispatching', attemptId, 'dispatching', now, {
        request_id: dispatch.requestId, canonical_digest: dispatch.canonicalDigest, snapshot_id: dispatch.snapshotId, session_id: dispatch.sessionId, run_id: dispatch.runId,
      });
    });
  }

  async recordReceipt(attemptId: Id, receiptId: Id, receipt: Record<string, unknown>, now: Timestamp): Promise<ActionAttempt> {
    return this.write('recordReceipt', () => this.moveAttempt('recordReceipt', attemptId, 'receipt_received', now, { receipt_id: receiptId, receipt: JSON.stringify(receipt) }));
  }

  async markVerified(attemptId: Id, now: Timestamp): Promise<ActionAttempt> {
    return this.write('markVerified', () => this.moveAttempt('markVerified', attemptId, 'verified', now));
  }

  async markNotSent(attemptId: Id, reason: string, now: Timestamp): Promise<ActionAttempt> {
    return this.write('markNotSent', () => this.moveAttempt('markNotSent', attemptId, 'not_sent', now, { not_sent_reason: reason }));
  }

  async markUnknown(attemptId: Id, reason: string, now: Timestamp): Promise<ActionAttempt> {
    return this.write('markUnknown', () => this.moveAttempt('markUnknown', attemptId, 'unknown', now, { unknown_reason: reason }));
  }

  async listAttempts(taskId: Id): Promise<ActionAttempt[]> {
    return this.read(() => {
      const rows = this.db.prepare(`SELECT * FROM attempts WHERE task_id = ? ORDER BY created_at, attempt_ordinal`).all(taskId) as Row[];
      return rows.map((row) => this.attemptFromRow(row));
    });
  }

  async getAttempt(attemptId: Id): Promise<ActionAttempt | undefined> {
    return this.read(() => {
      const row = this.attemptRow(attemptId);
      return row ? this.attemptFromRow(row) : undefined;
    });
  }

  /** The platform receipt stored verbatim by recordReceipt, for reconciliation. */
  async getReceipt(attemptId: Id): Promise<Record<string, unknown> | undefined> {
    return this.read(() => {
      const row = this.db.prepare(`SELECT receipt FROM attempts WHERE attempt_id = ?`).get(attemptId) as { receipt: string | null } | undefined;
      return row ? parse<Record<string, unknown>>(row.receipt) : undefined;
    });
  }

  async findOpenAttempts(): Promise<ActionAttempt[]> {
    return this.read(() => (this.db.prepare(`SELECT * FROM attempts WHERE state IN ('dispatching', 'receipt_received') ORDER BY created_at, rowid`).all() as Row[]).map((r) => this.attemptFromRow(r)));
  }

  // ---- quota --------------------------------------------------------------

  private quotaFromRow(r: Row): QuotaReservation {
    return {
      reservationId: r.reservation_id as Id, accountId: r.account_id as Id, actionKind: r.action_kind as ActionKind, policyDay: r.policy_day as string,
      intentId: r.intent_id as Id, state: r.state as QuotaReservation['state'], createdAt: r.created_at as Timestamp,
    };
  }

  async reserveQuota(input: { accountId: Id; actionKind: ActionKind; intentId: Id }, policy: Policy, now: Timestamp): Promise<QuotaDecision> {
    return this.write('reserveQuota', (): QuotaDecision => {
      if (!policy.allowedActions.includes(input.actionKind)) return { ok: false, reason: 'action_not_allowed' };
      const day = policyDay(now, policy.timezone);
      const hhmm = policyTime(now, policy.timezone);
      if (!policy.activeHours.some((h) => h.start <= hhmm && hhmm < h.end)) return { ok: false, reason: 'outside_hours' };
      const live = this.db.prepare(`SELECT * FROM quota_reservations WHERE account_id = ? AND action_kind = ? AND state <> 'released'`).all(input.accountId, input.actionKind) as Row[];
      const existing = live.find((q) => q.intent_id === input.intentId);
      if (existing) return { ok: true, reservation: this.quotaFromRow(existing) };
      const today = live.filter((q) => q.policy_day === day);
      const max = policy.maxDaily[input.actionKind];
      if (max !== undefined && today.length >= max) return { ok: false, reason: 'daily_limit' };
      const last = live.map((q) => q.created_at as string).sort().at(-1);
      if (last && policy.minIntervalSeconds > 0 && (Date.parse(now) - Date.parse(last)) / 1000 < policy.minIntervalSeconds) return { ok: false, reason: 'min_interval' };
      const reservation: QuotaReservation = { reservationId: uid('quota'), accountId: input.accountId, actionKind: input.actionKind, policyDay: day, intentId: input.intentId, state: 'reserved', createdAt: now };
      this.db.prepare(`INSERT INTO quota_reservations (reservation_id, account_id, action_kind, policy_day, intent_id, state, created_at) VALUES (@reservationId, @accountId, @actionKind, @policyDay, @intentId, @state, @createdAt)`).run(reservation);
      return { ok: true, reservation };
    });
  }

  private setQuota(operation: string, reservationId: Id, state: QuotaReservation['state']): QuotaReservation {
    return this.write(operation, () => {
      const row = this.db.prepare(`SELECT * FROM quota_reservations WHERE reservation_id = ?`).get(reservationId) as Row | undefined;
      if (!row) throw new LedgerConflictError('attempt', `no reservation ${reservationId}`);
      const q = this.quotaFromRow(row);
      // A held or consumed reservation keeps counting; it is never released by a later resume.
      if (q.state === 'held' || q.state === 'consumed') return q;
      this.db.prepare(`UPDATE quota_reservations SET state = ? WHERE reservation_id = ?`).run(state, reservationId);
      return { ...q, state };
    });
  }

  async consumeQuota(reservationId: Id): Promise<QuotaReservation> { return this.setQuota('consumeQuota', reservationId, 'consumed'); }
  async releaseQuota(reservationId: Id): Promise<QuotaReservation> { return this.setQuota('releaseQuota', reservationId, 'released'); }
  async holdQuota(reservationId: Id): Promise<QuotaReservation> { return this.setQuota('holdQuota', reservationId, 'held'); }

  async getQuota(reservationId: Id): Promise<QuotaReservation | undefined> {
    return this.read(() => {
      const row = this.db.prepare(`SELECT * FROM quota_reservations WHERE reservation_id = ?`).get(reservationId) as Row | undefined;
      return row ? this.quotaFromRow(row) : undefined;
    });
  }

  // ---- facts & evidence ---------------------------------------------------

  async appendFact(fact: Omit<DomainFact, 'factId'>): Promise<DomainFact> {
    return this.write('appendFact', () => {
      const saved: DomainFact = compact({ ...fact, factId: uid('fact') });
      this.db.prepare(`INSERT INTO facts (fact_id, task_id, fact_kind, outcome, evidence_ids, observed_at, confidence, reason, data)
        VALUES (@factId, @taskId, @factKind, @outcome, @evidenceIds, @observedAt, @confidence, @reason, @data)`)
        .run({ ...saved, evidenceIds: JSON.stringify(saved.evidenceIds), reason: nul(saved.reason), data: json(saved.data) });
      return saved;
    });
  }

  async listFacts(taskId: Id): Promise<DomainFact[]> {
    return this.read(() => (this.db.prepare(`SELECT * FROM facts WHERE task_id = ? ORDER BY rowid`).all(taskId) as Row[]).map((r) => compact({
      factId: r.fact_id as Id, taskId: r.task_id as Id, factKind: r.fact_kind as DomainFact['factKind'], outcome: r.outcome as DomainFact['outcome'],
      evidenceIds: JSON.parse(r.evidence_ids as string), observedAt: r.observed_at as Timestamp, confidence: r.confidence as number,
      reason: opt(r.reason as string | null), data: parse<Record<string, unknown>>(r.data as string | null),
    })));
  }

  async putEvidence(evidence: Omit<Evidence, 'evidenceId'>): Promise<Evidence> {
    return this.write('putEvidence', () => {
      const saved: Evidence = compact({ ...evidence, evidenceId: uid('ev') });
      this.db.prepare(`INSERT INTO evidence (evidence_id, artifact_id, local_path, sha256, capture_time, coverage, crop, retention_until)
        VALUES (@evidenceId, @artifactId, @localPath, @sha256, @captureTime, @coverage, @crop, @retentionUntil)`)
        .run({ ...saved, artifactId: nul(saved.artifactId), localPath: nul(saved.localPath), crop: json(saved.crop) });
      return saved;
    });
  }

  async getEvidence(evidenceId: Id): Promise<Evidence | undefined> {
    return this.read(() => {
      const r = this.db.prepare(`SELECT * FROM evidence WHERE evidence_id = ?`).get(evidenceId) as Row | undefined;
      if (!r) return undefined;
      return compact({
        evidenceId: r.evidence_id as Id, artifactId: opt(r.artifact_id as Id | null), localPath: opt(r.local_path as string | null), sha256: r.sha256 as string,
        captureTime: r.capture_time as Timestamp, coverage: r.coverage as Evidence['coverage'], crop: parse<Evidence['crop']>(r.crop as string | null),
        retentionUntil: r.retention_until as Timestamp,
      });
    });
  }

  // ---- outbox -------------------------------------------------------------

  private outboxFromRow(r: Row): StoredOutboxEvent {
    return compact({
      eventId: r.event_id as Id, taskId: r.task_id as Id, revision: r.revision as Revision, payloadHash: r.payload_hash as string,
      payload: JSON.parse(r.payload as string), state: r.state as OutboxEvent['state'], retryAt: opt(r.retry_at as Timestamp | null),
      attempts: (r.attempts as number | null) ?? 0, lastError: opt(r.last_error as string | null), receipt: opt(r.receipt as string | null),
      enqueuedAt: opt(r.enqueued_at as Timestamp | null), settledAt: opt(r.settled_at as Timestamp | null),
    });
  }

  private outboxRow(eventId: Id): Row | undefined {
    return this.db.prepare(`SELECT * FROM outbox WHERE event_id = ?`).get(eventId) as Row | undefined;
  }

  /**
   * Inside a write transaction. One row per (taskId, revision, payloadHash): a second enqueue of the same triple
   * returns the existing row untouched (its state included), so a repeated finalize never creates a second event.
   */
  private insertOutbox(event: Omit<OutboxEvent, 'eventId' | 'state'>, now: Timestamp | undefined): StoredOutboxEvent {
    const existing = this.db.prepare(`SELECT * FROM outbox WHERE task_id = ? AND revision = ? AND payload_hash = ?`).get(event.taskId, event.revision, event.payloadHash) as Row | undefined;
    if (existing) return this.outboxFromRow(existing);
    const saved: StoredOutboxEvent = compact({ ...event, eventId: uid('out'), state: 'pending', attempts: 0, enqueuedAt: now });
    this.db.prepare(`INSERT INTO outbox (event_id, task_id, revision, payload_hash, payload, state, retry_at, attempts, enqueued_at)
      VALUES (@eventId, @taskId, @revision, @payloadHash, @payload, @state, @retryAt, 0, @enqueuedAt)`)
      .run({ ...saved, payload: JSON.stringify(saved.payload), retryAt: nul(saved.retryAt), enqueuedAt: nul(saved.enqueuedAt) });
    return saved;
  }

  async enqueueOutbox(event: Omit<OutboxEvent, 'eventId' | 'state'>): Promise<OutboxEvent> {
    return this.write('enqueueOutbox', () => this.insertOutbox(event, undefined));
  }

  /**
   * The task transition and its outbox event in ONE transaction (app core finalizing a task): either both are on
   * disk or neither. Same checks and audit row as transitionTask; the event's revision is the task's new revision.
   */
  async transitionTaskWithOutbox(
    taskId: Id, to: TaskState, expectedRevision: Revision, now: Timestamp, reason: string | undefined,
    outbox: (task: WeChatTask) => Omit<OutboxEvent, 'eventId' | 'state'>,
  ): Promise<{ task: WeChatTask; event: OutboxEvent }> {
    return this.write('transitionTaskWithOutbox', () => {
      const row = this.taskRow(taskId);
      if (!row) throw new LedgerConflictError('transition', `no task ${taskId}`);
      const task = this.taskFromRow(row);
      if (task.revision !== expectedRevision) throw new LedgerConflictError('revision', `task ${taskId} is at revision ${task.revision}, not ${expectedRevision}`);
      if (!canTransition(task.state, to)) throw new LedgerConflictError('transition', `${task.state} → ${to} is not allowed`);
      const next = task.revision + 1;
      this.db.prepare(`INSERT INTO task_audit (task_id, from_state, to_state, from_revision, to_revision, at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(taskId, task.state, to, task.revision, next, now, nul(reason));
      const changed = this.db.prepare(`UPDATE tasks SET state = ?, revision = ?, updated_at = ? WHERE task_id = ? AND revision = ?`).run(to, next, now, taskId, task.revision).changes;
      if (changed !== 1) throw new LedgerConflictError('revision', `task ${taskId} changed under us`);
      const updated: WeChatTask = { ...task, state: to, revision: next, updatedAt: now };
      const draft = outbox(updated);
      if (draft.taskId !== taskId || draft.revision !== next) throw new LedgerConflictError('transition', `outbox event must belong to ${taskId}@${next}`);
      return { task: updated, event: this.insertOutbox(draft, now) };
    });
  }

  async pendingOutbox(limit = 50): Promise<OutboxEvent[]> {
    return this.read(() => (this.db.prepare(`SELECT * FROM outbox WHERE state = 'pending' ORDER BY rowid LIMIT ?`).all(limit) as Row[]).map((r) => this.outboxFromRow(r)));
  }

  async markOutbox(eventId: Id, state: 'delivered' | 'failed', retryAt?: Timestamp): Promise<OutboxEvent> {
    return this.write('markOutbox', () => {
      const row = this.outboxRow(eventId);
      if (!row) throw new LedgerConflictError('attempt', `no outbox event ${eventId}`);
      this.db.prepare(`UPDATE outbox SET state = ?, retry_at = ? WHERE event_id = ?`).run(state, nul(retryAt), eventId);
      return compact({ ...this.outboxFromRow(row), state, retryAt });
    });
  }

  /** A retryable delivery failure: the event stays pending, retry_at / attempts / last_error are persisted for the next process. */
  async deferOutbox(eventId: Id, retryAt: Timestamp, error: string): Promise<StoredOutboxEvent> {
    return this.write('deferOutbox', () => {
      const row = this.outboxRow(eventId);
      if (!row) throw new LedgerConflictError('attempt', `no outbox event ${eventId}`);
      if (row.state !== 'pending') throw new LedgerConflictError('attempt', `outbox event ${eventId} is ${String(row.state)}, not pending`);
      this.db.prepare(`UPDATE outbox SET retry_at = ?, attempts = attempts + 1, last_error = ? WHERE event_id = ?`).run(retryAt, error, eventId);
      return this.outboxFromRow(this.outboxRow(eventId)!);
    });
  }

  /** The sink's final answer: delivered (with its receipt) or failed (with the reason). Idempotent on a row already in that state. */
  async settleOutbox(eventId: Id, state: 'delivered' | 'failed', detail: { receipt?: string; error?: string }, now: Timestamp): Promise<StoredOutboxEvent> {
    return this.write('settleOutbox', () => {
      const row = this.outboxRow(eventId);
      if (!row) throw new LedgerConflictError('attempt', `no outbox event ${eventId}`);
      if (row.state === state) return this.outboxFromRow(row);
      if (row.state !== 'pending') throw new LedgerConflictError('attempt', `outbox event ${eventId} is ${String(row.state)}, not pending`);
      this.db.prepare(`UPDATE outbox SET state = ?, retry_at = NULL, attempts = attempts + 1, receipt = ?, last_error = ?, settled_at = ? WHERE event_id = ?`)
        .run(state, nul(detail.receipt), nul(detail.error), now, eventId);
      return this.outboxFromRow(this.outboxRow(eventId)!);
    });
  }

  /** Every outbox event of a task, oldest first, whatever its state (TaskView / diagnostics). */
  async listOutbox(taskId: Id): Promise<StoredOutboxEvent[]> {
    return this.read(() => (this.db.prepare(`SELECT * FROM outbox WHERE task_id = ? ORDER BY rowid`).all(taskId) as Row[]).map((r) => this.outboxFromRow(r)));
  }

  // ---- account & policy ---------------------------------------------------

  private accountRow(): AccountBinding | undefined {
    const r = this.db.prepare(`SELECT * FROM account WHERE singleton = 1`).get() as Row | undefined;
    if (!r) return undefined;
    return {
      accountId: r.account_id as Id, visibleLabel: r.visible_label as string, evidenceIds: JSON.parse(r.evidence_ids as string),
      confirmedAt: r.confirmed_at as Timestamp, revision: r.revision as Revision, status: r.status as AccountBinding['status'],
    };
  }

  async getAccount(): Promise<AccountBinding | undefined> {
    return this.read(() => this.accountRow());
  }

  async confirmAccount(binding: Omit<AccountBinding, 'revision'>, expectedRevision: Revision | undefined): Promise<AccountBinding> {
    return this.write('confirmAccount', () => {
      const current = this.accountRow();
      if (current?.revision !== expectedRevision) throw new LedgerConflictError('revision', 'account revision mismatch');
      const next: AccountBinding = { ...binding, revision: (current?.revision ?? 0) + 1 };
      this.db.prepare(`INSERT INTO account (singleton, account_id, visible_label, evidence_ids, confirmed_at, revision, status) VALUES (1, @accountId, @visibleLabel, @evidenceIds, @confirmedAt, @revision, @status)
        ON CONFLICT (singleton) DO UPDATE SET account_id = excluded.account_id, visible_label = excluded.visible_label, evidence_ids = excluded.evidence_ids,
          confirmed_at = excluded.confirmed_at, revision = excluded.revision, status = excluded.status`)
        .run({ ...next, evidenceIds: JSON.stringify(next.evidenceIds) });
      return next;
    });
  }

  private policyRow(): Policy {
    const r = this.db.prepare(`SELECT revision, body FROM policy WHERE singleton = 1`).get() as { revision: number; body: string } | undefined;
    if (!r) throw new LedgerUnavailableError('policy row missing');
    return { ...(JSON.parse(r.body) as Omit<Policy, 'revision'>), revision: r.revision };
  }

  async getPolicy(): Promise<Policy> {
    return this.read(() => this.policyRow());
  }

  async setPolicy(policy: Omit<Policy, 'revision'>, expectedRevision: Revision): Promise<Policy> {
    return this.write('setPolicy', () => {
      const current = this.policyRow();
      if (current.revision !== expectedRevision) throw new LedgerConflictError('revision', 'policy revision mismatch');
      const { revision: _drop, ...body } = policy as Policy;
      const next: Policy = { ...body, revision: expectedRevision + 1 };
      this.db.prepare(`UPDATE policy SET revision = ?, body = ? WHERE singleton = 1 AND revision = ?`).run(next.revision, JSON.stringify(body), expectedRevision);
      return next;
    });
  }

  // ---- legacy -------------------------------------------------------------

  async importLegacySuppressions(entries: LegacySuppression[], migratedAt: Timestamp): Promise<number> {
    return this.write('importLegacySuppressions', () => {
      const insert = this.db.prepare(`INSERT OR IGNORE INTO legacy_suppression (key, source_hash, migrated_at) VALUES (?, ?, ?)`);
      let added = 0;
      for (const entry of entries) added += insert.run(entry.key, entry.sourceHash, migratedAt).changes;
      return added;
    });
  }

  async isSuppressed(key: string): Promise<boolean> {
    return this.read(() => this.db.prepare(`SELECT 1 FROM legacy_suppression WHERE key = ?`).get(key) !== undefined);
  }

  // ---- lifecycle ----------------------------------------------------------

  async health(): Promise<{ writable: boolean; reason?: string; schemaVersion: number }> {
    if (this.closed) return { writable: false, reason: 'closed', schemaVersion: this.schemaVersion };
    return { writable: this.writable, reason: this.reason, schemaVersion: this.schemaVersion };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** Reads the schema version of a file without migrating it (0 when the file has none). */
export function peekSchemaVersion(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return schemaVersionOf(db); } finally { db.close(); }
}
