// Patrol (方案 E03): every policy.patrolIntervalSeconds a read-only
// ReadRequests task is queued. A pending row the ledger does not suppress
// becomes an accept_request task waiting for approval; skipping one only
// suppresses it for this process, never as a stored suppression.
import type { DomainFact, Id, Ledger, Timestamp } from '@wechat-agent/ports';
import type { Dispatcher, FinishedEvent } from './dispatcher.ts';
import type { InputGate } from './gate.ts';
import type { RuntimeConnector } from './connector.ts';
import { errorMessage, type Scheduler } from './support.ts';

export interface PatrolDeps {
  ledger: Ledger;
  dispatcher: Dispatcher;
  gate: InputGate;
  connector: RuntimeConnector;
  scheduler: Scheduler;
  hasReadHandler(): boolean;
  now(): Timestamp;
  log(line: string): void;
  onChange(): void;
}

/** A row a ReadRequests handler reported inside a list_read/request_read fact's `data.requests`. */
export interface ReportedRequest { rowKey: string; status: string; name?: string }

export function requestsFromFacts(facts: DomainFact[]): { rows: ReportedRequest[]; coverage?: string; visibleSingleChats?: number } {
  const rows: ReportedRequest[] = [];
  let coverage: string | undefined;
  let visibleSingleChats: number | undefined;
  for (const fact of facts) {
    if (fact.factKind !== 'list_read' && fact.factKind !== 'request_read') continue;
    const data = fact.data ?? {};
    if (typeof data.coverage === 'string') coverage = data.coverage;
    if (typeof data.visibleSingleChats === 'number') visibleSingleChats = data.visibleSingleChats;
    const list = Array.isArray(data.requests) ? data.requests : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (typeof row.rowKey !== 'string' || typeof row.status !== 'string') continue;
      rows.push({ rowKey: row.rowKey, status: row.status, name: typeof row.name === 'string' ? row.name : undefined });
    }
  }
  return { rows, coverage, visibleSingleChats };
}

export class Patrol {
  enabled = false;
  intervalSeconds = 60;
  lastScanAt: Timestamp | undefined;
  coverage: string | undefined;
  visibleSingleChats: number | undefined;
  /** Rows skipped in this process. Not persisted: a skip suppresses this time only. */
  readonly skipped = new Set<string>();
  private timer: unknown;
  private readonly scanTasks = new Set<Id>();
  private unsubscribe: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly deps: PatrolDeps) {}

  start(intervalSeconds: number, enabled: boolean): void {
    this.intervalSeconds = intervalSeconds;
    this.enabled = enabled;
    this.stopped = false;
    this.unsubscribe.push(this.deps.dispatcher.onFinished((event) => void this.onFinished(event)));
    this.unsubscribe.push(this.deps.dispatcher.onSkipped((task) => { if (task.payload.kind === 'accept_request') this.skipped.add(task.payload.requestKey); }));
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { this.deps.scheduler.clearTimeout(this.timer); this.timer = undefined; }
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  private schedule(): void {
    if (this.stopped || this.timer || !this.enabled) return;
    this.timer = this.deps.scheduler.setTimeout(() => { this.timer = undefined; void this.tick(); }, this.intervalSeconds * 1000);
  }

  /** One scan. Skipped (not queued) when the platform or the gate is not ready. */
  async tick(): Promise<boolean> {
    try {
      if (!this.enabled || !this.deps.connector.ready || !this.deps.connector.desktopId || !this.deps.gate.isOpen() || !this.deps.hasReadHandler()) return false;
      const account = await this.deps.ledger.getAccount();
      if (!account || account.status !== 'confirmed') return false;
      const task = await this.deps.dispatcher.create({
        operationId: `patrol:${account.accountId}:${this.deps.now()}`, type: 'read_requests', payload: { kind: 'read_requests' }, expectedAccountRevision: account.revision,
      }, 'patrol');
      this.scanTasks.add(task.taskId);
      return true;
    } catch (error) {
      this.deps.log(`patrol: ${errorMessage(error)}`);
      return false;
    } finally {
      this.schedule();
    }
  }

  private async onFinished(event: FinishedEvent): Promise<void> {
    if (!this.scanTasks.has(event.task.taskId) && event.runtime.origin !== 'baseline') return;
    this.scanTasks.delete(event.task.taskId);
    this.lastScanAt = this.deps.now();
    const facts = [...event.result.facts, ...(await this.deps.ledger.listFacts(event.task.taskId))];
    const { rows, coverage, visibleSingleChats } = requestsFromFacts(facts);
    if (coverage) this.coverage = coverage;
    if (visibleSingleChats !== undefined) this.visibleSingleChats = visibleSingleChats;
    this.deps.onChange();
    const account = await this.deps.ledger.getAccount();
    if (!account || account.status !== 'confirmed') return;
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.status !== 'pending' || seen.has(row.rowKey) || this.skipped.has(row.rowKey)) continue;
      seen.add(row.rowKey);
      if (await this.deps.ledger.isSuppressed(row.rowKey)) continue;
      try {
        await this.deps.dispatcher.create({
          operationId: `patrol:accept:${account.accountId}:${row.rowKey}`, type: 'accept_request', payload: { kind: 'accept_request', requestKey: row.rowKey }, expectedAccountRevision: account.revision,
        }, 'patrol');
      } catch (error) {
        this.deps.log(`patrol: accept_request for ${row.rowKey}: ${errorMessage(error)}`);
      }
    }
  }
}
