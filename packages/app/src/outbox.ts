// Outbox (方案 §08 Outbox, plan §8 "写入方定为 App core"): the app's business
// events for an external consumer, written into the ledger together with the
// state change that produced them and delivered later by a serial loop.
//
//   finalize ──► ledger (task + outbox row, one transaction on SQLite)
//                      │
//   deliverer ◄── pendingOutbox ──► sink.deliver(event) ──► settle / defer / fail
//
// Delivery is at-least-once: a crash between the sink's acknowledgement and
// the ledger write replays the same eventId after restart, so a sink must
// recognise an eventId it has already taken. The deliverer never touches the
// driver: it has no handle to it, by construction.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { LedgerConflictError } from '@wechat-agent/ports';
import type { DomainFact, DomainOutcome, DomainReasonCode, FactKind, Id, Ledger, OutboxEvent, Revision, TaskState, Timestamp, WeChatTask } from '@wechat-agent/ports';
import { canonicalJson, errorMessage, Mutex, sha256, type Scheduler } from './support.ts';

// ---- sinks ---------------------------------------------------------------------

export type SinkResult = { ok: true; receipt: string } | { ok: false; retryable: boolean; reason: string };

/** Where delivered events go. `deliver` may be called again with an eventId it already took; it answers ok with the same receipt. */
export interface OutboxSink {
  readonly name: string;
  deliver(event: OutboxEvent): Promise<SinkResult>;
}

export type OutboxDraft = Omit<OutboxEvent, 'eventId' | 'state'>;

/**
 * What the SQLite ledger adds beyond the frozen port (INTERFACE REQUEST in the PR): the transition and the event in one
 * transaction, a retry that keeps the row pending, a settle that stores the receipt. Detected by shape; the in-memory
 * fake has none of it and gets the two-write fallback.
 */
export interface OutboxLedgerExtension {
  transitionTaskWithOutbox(taskId: Id, to: TaskState, expectedRevision: Revision, now: Timestamp, reason: string | undefined, outbox: (task: WeChatTask) => OutboxDraft): Promise<{ task: WeChatTask; event: OutboxEvent }>;
  deferOutbox(eventId: Id, retryAt: Timestamp, error: string): Promise<OutboxEvent & { attempts?: number }>;
  settleOutbox(eventId: Id, state: 'delivered' | 'failed', detail: { receipt?: string; error?: string }, now: Timestamp): Promise<OutboxEvent>;
  listOutbox(taskId: Id): Promise<OutboxEvent[]>;
}

export function outboxExtension(ledger: Ledger): OutboxLedgerExtension | undefined {
  const candidate = ledger as unknown as Partial<OutboxLedgerExtension>;
  const complete = ['transitionTaskWithOutbox', 'deferOutbox', 'settleOutbox', 'listOutbox'].every((m) => typeof (candidate as Record<string, unknown>)[m] === 'function');
  return complete ? (ledger as unknown as OutboxLedgerExtension) : undefined;
}

// ---- payloads ------------------------------------------------------------------

/** Business facts worth an event of their own, beside the task's final state. */
export const KEY_FACT_KINDS: readonly FactKind[] = ['friend_added', 'friend_request_sent', 'message_sent', 'draft_written'];

export interface TaskFinalPayload {
  kind: 'task_final';
  taskId: Id;
  taskType: WeChatTask['type'];
  operationId: string;
  fingerprint: string;
  accountRevision: Revision;
  taskPayloadHash: string;
  state: TaskState;
  stateReason: DomainReasonCode | null;
  reason: string | null;
  /** The handler's conclusion when one produced this state (sent_unconfirmed and needs_reconciliation both end in needs_reconciliation). */
  outcome: DomainOutcome | null;
  revision: Revision;
  at: Timestamp;
  /** Key business facts the task recorded, so a consumer can join them. */
  keyFactIds: Id[];
}

export interface FactPayload {
  kind: 'fact';
  taskId: Id;
  taskType: WeChatTask['type'];
  factId: Id;
  factKind: FactKind;
  outcome: DomainFact['outcome'];
  observedAt: Timestamp;
  confidence: number;
  reason: string | null;
  data: Record<string, unknown> | null;
  revision: Revision;
}

export const payloadHashOf = (payload: Record<string, unknown>): string => sha256(canonicalJson(payload));

export function taskFinalDraft(task: WeChatTask, extra: { stateReason?: DomainReasonCode; reason?: string; outcome?: DomainOutcome; keyFactIds?: Id[] } = {}): OutboxDraft {
  const payload: TaskFinalPayload = {
    kind: 'task_final', taskId: task.taskId, taskType: task.type, operationId: task.operationId, fingerprint: task.fingerprint, accountRevision: task.accountRevision,
    taskPayloadHash: task.payloadHash, state: task.state, stateReason: extra.stateReason ?? task.stateReason ?? null, reason: extra.reason ?? null,
    outcome: extra.outcome ?? null, revision: task.revision, at: task.updatedAt, keyFactIds: [...(extra.keyFactIds ?? [])].sort(),
  };
  const record = payload as unknown as Record<string, unknown>;
  return { taskId: task.taskId, revision: task.revision, payloadHash: payloadHashOf(record), payload: record };
}

export function factDraft(task: WeChatTask, fact: DomainFact): OutboxDraft {
  const payload: FactPayload = {
    kind: 'fact', taskId: task.taskId, taskType: task.type, factId: fact.factId, factKind: fact.factKind, outcome: fact.outcome, observedAt: fact.observedAt,
    confidence: fact.confidence, reason: fact.reason ?? null, data: fact.data ?? null, revision: task.revision,
  };
  const record = payload as unknown as Record<string, unknown>;
  return { taskId: task.taskId, revision: task.revision, payloadHash: payloadHashOf(record), payload: record };
}

const dedupKey = (e: { taskId: Id; revision: Revision; payloadHash: string }) => `${e.taskId}:${e.revision}:${e.payloadHash}`;

// ---- writer ----------------------------------------------------------------------

export interface OutboxWriterDeps {
  ledger: Ledger;
  log(line: string): void;
  /** Something new is pending: the deliverer should look. */
  onEnqueued?(event: OutboxEvent): void;
}

/** Writes events. One per (taskId, revision, payloadHash): the SQLite ledger enforces it on disk, this class within the process. */
export class OutboxWriter {
  private readonly ext: OutboxLedgerExtension | undefined;
  private readonly seen = new Map<string, Id>();

  constructor(private readonly deps: OutboxWriterDeps) {
    this.ext = outboxExtension(deps.ledger);
  }

  /** True when the ledger writes the transition and the event in one transaction. */
  get atomic(): boolean {
    return this.ext !== undefined;
  }

  /**
   * The terminal transition of a task and its event. With the extension both land in one ledger write; without it the
   * event follows the transition in a second write (a crash in between loses the event — fakes only).
   */
  async finalize(taskId: Id, to: TaskState, expectedRevision: Revision, now: Timestamp, reason: string | undefined, draftFor: (task: WeChatTask) => OutboxDraft): Promise<{ task: WeChatTask; event: OutboxEvent | undefined }> {
    if (this.ext) {
      const { task, event } = await this.ext.transitionTaskWithOutbox(taskId, to, expectedRevision, now, reason, draftFor);
      const fresh = !this.seen.has(dedupKey(event));
      this.seen.set(dedupKey(event), event.eventId);
      if (fresh && event.state === 'pending') this.deps.onEnqueued?.(event);
      return { task, event };
    }
    const task = await this.deps.ledger.transitionTask(taskId, to, expectedRevision, now, reason);
    return { task, event: await this.enqueue(draftFor(task)) };
  }

  /** Enqueues unless the same (taskId, revision, payloadHash) is already there; returns the event either way. */
  async enqueue(draft: OutboxDraft): Promise<OutboxEvent> {
    const key = dedupKey(draft);
    const known = this.seen.get(key);
    if (known) {
      const pending = await this.deps.ledger.pendingOutbox(10_000);
      const row = pending.find((e) => e.eventId === known);
      if (row) return row;
      // Delivered or failed already: still the same event, never a second one.
      return { ...draft, eventId: known, state: 'delivered' };
    }
    const pending = await this.deps.ledger.pendingOutbox(10_000);
    const existing = pending.find((e) => dedupKey(e) === key);
    if (existing) { this.seen.set(key, existing.eventId); return existing; }
    const event = await this.deps.ledger.enqueueOutbox(draft);
    const fresh = !this.seen.has(key);
    this.seen.set(key, event.eventId);
    if (fresh && event.state === 'pending') this.deps.onEnqueued?.(event);
    return event;
  }

  /** A key business fact as an event of its own, under the task's current revision. */
  async recordFact(fact: DomainFact): Promise<OutboxEvent | undefined> {
    if (!KEY_FACT_KINDS.includes(fact.factKind)) return undefined;
    const task = await this.deps.ledger.getTask(fact.taskId);
    if (!task) return undefined;
    return this.enqueue(factDraft(task, fact));
  }

  /** Events of a task, every state (extension) or the pending ones (port). */
  async list(taskId: Id): Promise<OutboxEvent[]> {
    if (this.ext) return this.ext.listOutbox(taskId);
    return (await this.deps.ledger.pendingOutbox(10_000)).filter((e) => e.taskId === taskId);
  }
}

// ---- deliverer -------------------------------------------------------------------

export interface OutboxBackoff {
  baseMs: number;
  maxMs: number;
  /** Retryable failures beyond this become failed. */
  maxAttempts: number;
  /** A sink that neither answers nor throws within this is a retryable failure. */
  deliverTimeoutMs: number;
}

export const DEFAULT_OUTBOX_BACKOFF: OutboxBackoff = { baseMs: 1_000, maxMs: 300_000, maxAttempts: 12, deliverTimeoutMs: 10_000 };

export interface DeliveryReport {
  delivered: Id[];
  deferred: { eventId: Id; attempts: number; retryAt: Timestamp; reason: string }[];
  failed: { eventId: Id; reason: string }[];
  /** Pending events whose retryAt is still ahead. */
  waiting: number;
}

export interface OutboxDelivererDeps {
  ledger: Ledger;
  sink: OutboxSink;
  now(): Timestamp;
  scheduler: Scheduler;
  log(line: string): void;
  backoff?: Partial<OutboxBackoff>;
  /** A line for the task's timeline (TaskView). */
  onEvent?(taskId: Id, label: string, at: Timestamp): void;
}

interface Attempts { attempts: number; retryAt?: Timestamp; lastError?: string }

/** One cycle at a time per ledger, whichever deliverer instance runs it (a start() racing a kick(), or two instances in tests). */
const cycleLocks = new WeakMap<object, Mutex>();
function cycleLockFor(ledger: Ledger): Mutex {
  let lock = cycleLocks.get(ledger);
  if (!lock) { lock = new Mutex(); cycleLocks.set(ledger, lock); }
  return lock;
}

/**
 * Takes pending events in ledger order, one at a time, to the sink. A cycle never overlaps another (mutex), so two
 * concurrent `runOnce` calls deliver each event once. Retry state lives in the ledger when it can (extension) and in
 * memory otherwise; after a restart a pending event is simply tried again.
 */
export class OutboxDeliverer {
  private readonly ext: OutboxLedgerExtension | undefined;
  private readonly backoff: OutboxBackoff;
  private readonly cycle: Mutex;
  private readonly memory = new Map<Id, Attempts>();
  private timer: unknown;
  private stopped = true;
  private wakeQueued = false;
  /**
   * Two concurrent `runOnce` calls (same or different instance over one ledger) never deliver an event twice within a
   * process; the second waits and finds nothing pending. Two processes are kept apart by the app's single-instance lock,
   * and even then the sink's eventId dedup makes a double delivery harmless.
   */
  readonly reports: DeliveryReport[] = [];

  constructor(private readonly deps: OutboxDelivererDeps) {
    this.ext = outboxExtension(deps.ledger);
    this.backoff = { ...DEFAULT_OUTBOX_BACKOFF, ...deps.backoff };
    this.cycle = cycleLockFor(deps.ledger);
  }

  get sinkName(): string {
    return this.deps.sink.name;
  }

  /** Begins the background loop: one cycle now (recovery of whatever is pending), then as events arrive or retries fall due. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.runInBackground();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) { this.deps.scheduler.clearTimeout(this.timer); this.timer = undefined; }
    this.wakeQueued = false;
  }

  /** Something new is pending: run a cycle soon (coalesced). */
  kick(): void {
    if (this.stopped || this.wakeQueued) return;
    this.wakeQueued = true;
    if (this.timer !== undefined) { this.deps.scheduler.clearTimeout(this.timer); this.timer = undefined; }
    this.timer = this.deps.scheduler.setTimeout(() => { this.timer = undefined; this.wakeQueued = false; void this.runInBackground(); }, 0);
  }

  private async runInBackground(): Promise<void> {
    if (this.stopped) return;
    let report: DeliveryReport | undefined;
    try { report = await this.runOnce(); } catch (error) { this.deps.log(`outbox: cycle stopped: ${errorMessage(error)}`); }
    if (this.stopped || this.wakeQueued) return;
    const nextAt = this.nextRetryAt(report);
    if (nextAt === undefined) return;
    const delay = Math.max(0, Date.parse(nextAt) - Date.parse(this.deps.now()));
    this.timer = this.deps.scheduler.setTimeout(() => { this.timer = undefined; void this.runInBackground(); }, delay);
  }

  private nextRetryAt(report: DeliveryReport | undefined): Timestamp | undefined {
    const times = [...this.memory.values()].map((a) => a.retryAt).filter((t): t is Timestamp => t !== undefined);
    if (report) for (const d of report.deferred) times.push(d.retryAt);
    if (report?.waiting && times.length === 0) return this.deps.now();
    return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  }

  private stateOf(event: OutboxEvent): Attempts {
    const stored = event as OutboxEvent & { attempts?: number; lastError?: string };
    const mem = this.memory.get(event.eventId);
    const attempts = Math.max(stored.attempts ?? 0, mem?.attempts ?? 0);
    return { attempts, retryAt: event.retryAt ?? mem?.retryAt, lastError: stored.lastError ?? mem?.lastError };
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** Math.max(0, attempts - 1));
  }

  private async deliverWithTimeout(event: OutboxEvent): Promise<SinkResult> {
    let handle: unknown;
    const timeout = new Promise<SinkResult>((resolve) => {
      handle = this.deps.scheduler.setTimeout(() => resolve({ ok: false, retryable: true, reason: `timeout after ${this.backoff.deliverTimeoutMs}ms` }), this.backoff.deliverTimeoutMs);
    });
    try {
      return await Promise.race([this.deps.sink.deliver(event).catch((error: unknown): SinkResult => ({ ok: false, retryable: true, reason: errorMessage(error) })), timeout]);
    } finally {
      this.deps.scheduler.clearTimeout(handle);
    }
  }

  /** One cycle over everything pending and due. Throws only when the ledger refuses a write (the cycle stops; nothing is marked that was not). */
  async runOnce(): Promise<DeliveryReport> {
    const release = await this.cycle.acquire();
    const report: DeliveryReport = { delivered: [], deferred: [], failed: [], waiting: 0 };
    try {
      const pending = await this.deps.ledger.pendingOutbox(500);
      for (const event of pending) {
        const state = this.stateOf(event);
        const now = this.deps.now();
        if (state.retryAt && Date.parse(state.retryAt) > Date.parse(now)) { report.waiting += 1; continue; }
        const result = await this.deliverWithTimeout(event);
        const at = this.deps.now();
        if (result.ok) {
          await this.settle(event, 'delivered', { receipt: result.receipt }, state.attempts + 1, at);
          report.delivered.push(event.eventId);
          continue;
        }
        const attempts = state.attempts + 1;
        if (!result.retryable || attempts >= this.backoff.maxAttempts) {
          const reason = result.retryable ? `${result.reason} (gave up after ${attempts} attempts)` : result.reason;
          await this.settle(event, 'failed', { error: reason }, attempts, at);
          report.failed.push({ eventId: event.eventId, reason });
          continue;
        }
        const retryAt = new Date(Date.parse(at) + this.retryDelayMs(attempts)).toISOString();
        await this.defer(event, attempts, retryAt, result.reason, at);
        report.deferred.push({ eventId: event.eventId, attempts, retryAt, reason: result.reason });
      }
    } finally {
      this.reports.push(report);
      release();
    }
    return report;
  }

  private async settle(event: OutboxEvent, state: 'delivered' | 'failed', detail: { receipt?: string; error?: string }, attempts: number, at: Timestamp): Promise<void> {
    if (this.ext) await this.ext.settleOutbox(event.eventId, state, detail, at);
    else await this.deps.ledger.markOutbox(event.eventId, state);
    this.memory.delete(event.eventId);
    const label = state === 'delivered' ? `外发已送达（${this.deps.sink.name}）` : `外发失败（${this.deps.sink.name}）：${detail.error}`;
    await this.fact(event, state, { ...detail, attempts }, label, at);
  }

  private async defer(event: OutboxEvent, attempts: number, retryAt: Timestamp, reason: string, at: Timestamp): Promise<void> {
    if (this.ext) {
      try { await this.ext.deferOutbox(event.eventId, retryAt, reason); } catch (error) {
        if (!(error instanceof LedgerConflictError)) throw error;
        this.deps.log(`outbox: defer ${event.eventId}: ${errorMessage(error)}`);
      }
    }
    this.memory.set(event.eventId, { attempts, retryAt, lastError: reason });
    await this.fact(event, 'deferred', { error: reason, attempts, retryAt }, `外发暂缓（${this.deps.sink.name}，第 ${attempts} 次：${reason}）`, at);
  }

  private async fact(event: OutboxEvent, status: 'delivered' | 'failed' | 'deferred', detail: { receipt?: string; error?: string; attempts: number; retryAt?: Timestamp }, label: string, at: Timestamp): Promise<void> {
    try {
      await this.deps.ledger.appendFact({
        taskId: event.taskId, factKind: 'reconciliation', outcome: 'observed', evidenceIds: [], observedAt: at, confidence: 1,
        reason: label,
        data: {
          kind: 'outbox_delivery', eventId: event.eventId, sink: this.deps.sink.name, status, revision: event.revision, payloadHash: event.payloadHash,
          attempts: detail.attempts, receipt: detail.receipt ?? null, error: detail.error ?? null, retryAt: detail.retryAt ?? null,
        },
      });
    } catch (error) {
      this.deps.log(`outbox: fact for ${event.eventId}: ${errorMessage(error)}`);
    }
    this.deps.onEvent?.(event.taskId, label, at);
  }
}

// ---- sinks shipped with the app ---------------------------------------------------

export interface MemorySinkScript {
  /** The first N deliveries of any new eventId fail retryably. */
  failRetryable?: number;
  /** Every new eventId fails for good. */
  failNonRetryable?: boolean;
  /** The first delivery of any new eventId never answers (the deliverer's timeout is what ends it). */
  hangOnce?: boolean;
  /** The first delivery of any new eventId throws. */
  throwOnce?: boolean;
}

/** Test sink: remembers what it took, counts repeats of an eventId it already holds, follows a fault script. */
export class MemorySink implements OutboxSink {
  readonly name = 'memory';
  readonly delivered: OutboxEvent[] = [];
  readonly receipts = new Map<Id, string>();
  /** Calls with an eventId already delivered (the at-least-once replays the deliverer may produce). */
  duplicates = 0;
  calls = 0;
  private hung = false;
  private thrown = false;

  constructor(public script: MemorySinkScript = {}) {}

  async deliver(event: OutboxEvent): Promise<SinkResult> {
    this.calls += 1;
    const known = this.receipts.get(event.eventId);
    if (known) { this.duplicates += 1; return { ok: true, receipt: known }; }
    if (this.script.hangOnce && !this.hung) { this.hung = true; return new Promise<SinkResult>(() => undefined); }
    if (this.script.throwOnce && !this.thrown) { this.thrown = true; throw new Error('sink exploded'); }
    if (this.script.failNonRetryable) return { ok: false, retryable: false, reason: 'rejected by sink' };
    if ((this.script.failRetryable ?? 0) > 0) { this.script.failRetryable! -= 1; return { ok: false, retryable: true, reason: 'sink unavailable' }; }
    const receipt = `memory:${this.delivered.length + 1}:${event.eventId}`;
    this.delivered.push(event);
    this.receipts.set(event.eventId, receipt);
    return { ok: true, receipt };
  }
}

/**
 * Appends one JSON line per event to a file the app owns (0600). On the first delivery it reads the file once, so an
 * eventId that is already on disk is answered with its existing receipt instead of a second line.
 */
export class FileSink implements OutboxSink {
  readonly name = 'file';
  private index: Map<Id, string> | undefined;

  constructor(readonly path: string, private readonly now: () => Timestamp = () => new Date().toISOString()) {}

  private load(): Map<Id, string> {
    if (this.index) return this.index;
    const index = new Map<Id, string>();
    if (existsSync(this.path)) {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter((l) => l.length > 0);
      lines.forEach((line, i) => {
        try {
          const row = JSON.parse(line) as { eventId?: string };
          if (typeof row.eventId === 'string') index.set(row.eventId, FileSink.receiptFor(i + 1, line));
        } catch { /* a torn last line from a crash mid-write is not an event */ }
      });
    }
    this.index = index;
    return index;
  }

  private static receiptFor(lineNo: number, line: string): string {
    return `file:${lineNo}:${createHash('sha256').update(line).digest('hex').slice(0, 16)}`;
  }

  async deliver(event: OutboxEvent): Promise<SinkResult> {
    let index: Map<Id, string>;
    try { index = this.load(); } catch (error) { return { ok: false, retryable: true, reason: `read ${this.path}: ${errorMessage(error)}` }; }
    const known = index.get(event.eventId);
    if (known) return { ok: true, receipt: known };
    const line = JSON.stringify({ eventId: event.eventId, taskId: event.taskId, revision: event.revision, payloadHash: event.payloadHash, payload: event.payload, deliveredAt: this.now() });
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = openSync(this.path, 'a', 0o600);
      try { writeSync(fd, `${line}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      return { ok: false, retryable: true, reason: `append ${this.path}: ${errorMessage(error)}` };
    }
    const receipt = FileSink.receiptFor(index.size + 1, line);
    index.set(event.eventId, receipt);
    return { ok: true, receipt };
  }
}
