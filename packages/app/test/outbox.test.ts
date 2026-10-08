// Outbox on the in-memory fakes: the writer's idempotency, the deliverer's
// retry/failure/timeout/concurrency behaviour, and the end-to-end path from a
// handler's conclusion to a delivered event. The same scenarios run on the
// SQLite ledger in tests/integration/test/outbox.test.ts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LedgerUnavailableError } from '@wechat-agent/ports';
import type { Ledger, OutboxEvent, WeChatTask } from '@wechat-agent/ports';
import { InMemoryLedger } from '@wechat-agent/ports/fakes';
import { canonicalJson, FileSink, ManualScheduler, MemorySink, OutboxDeliverer, OutboxWriter, payloadHashOf, sha256, taskFinalDraft } from '../src/index.ts';
import { acceptStub, makeClock, makeHarness, sendStub, waitFor, waitState } from './harness.ts';

const FAR = '2099-01-01T00:00:00+08:00';
const log = () => undefined;

async function seedTask(ledger: Ledger, operationId = 'op_outbox'): Promise<WeChatTask> {
  const { task } = await ledger.intake({
    operationId, fingerprint: `fp_${operationId}`, type: 'accept_request', accountRevision: 1,
    payload: { kind: 'accept_request', requestKey: '测试联系人甲|测试联系人甲' }, payloadHash: 'ph',
  }, '2026-10-08T10:00:00+08:00');
  return task;
}

function deliverer(ledger: Ledger, sink: MemorySink, over: { backoff?: Partial<ConstructorParameters<typeof OutboxDeliverer>[0]['backoff']>; timeline?: string[] } = {}) {
  const clock = makeClock();
  const scheduler = new ManualScheduler();
  const d = new OutboxDeliverer({
    ledger, sink, now: clock.now, scheduler, log, backoff: { baseMs: 1000, maxMs: 8000, maxAttempts: 5, deliverTimeoutMs: 50, ...over.backoff },
    onEvent: (_taskId, label) => over.timeline?.push(label),
  });
  return { d, clock, scheduler };
}

test('writer: a terminal finalize enqueues one event whose payloadHash is sha256 of the canonical payload and whose revision is the task revision', async () => {
  const ledger = new InMemoryLedger();
  const task = await seedTask(ledger);
  const writer = new OutboxWriter({ ledger, log });
  assert.equal(writer.atomic, false, 'the fake has no atomic extension');
  let queued = await ledger.transitionTask(task.taskId, 'queued', 1, '2026-10-08T10:00:01+08:00');
  queued = await ledger.transitionTask(task.taskId, 'cancelled', queued.revision, '2026-10-08T10:00:02+08:00');
  // The writer's own finalize path, used by the dispatcher for every terminal transition.
  const other = await seedTask(ledger, 'op_outbox_2');
  const { task: final, event } = await writer.finalize(other.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', 'cancelled: 用户取消', (t) => taskFinalDraft(t, { stateReason: 'cancelled', reason: '用户取消' }));
  assert.equal(final.state, 'cancelled');
  assert.equal(final.revision, 2);
  assert.ok(event);
  assert.equal(event.revision, final.revision);
  assert.equal(event.taskId, other.taskId);
  assert.equal(event.state, 'pending');
  assert.equal(event.payloadHash, sha256(canonicalJson(event.payload)));
  assert.equal(event.payloadHash, payloadHashOf(event.payload));
  assert.equal(event.payload.kind, 'task_final');
  assert.equal(event.payload.state, 'cancelled');
  assert.equal(event.payload.stateReason, 'cancelled');
  assert.equal(event.payload.revision, 2);
  assert.equal((await ledger.pendingOutbox()).length, 1);
  void queued;
});

test('writer: the same task at the same revision finalized twice yields one event, not two', async () => {
  const ledger = new InMemoryLedger();
  const task = await seedTask(ledger);
  const writer = new OutboxWriter({ ledger, log });
  const first = await writer.finalize(task.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', undefined, (t) => taskFinalDraft(t, { stateReason: 'cancelled' }));
  const draft = taskFinalDraft(first.task, { stateReason: 'cancelled' });
  const again = await writer.enqueue(draft);
  assert.equal(again.eventId, first.event!.eventId);
  assert.equal((await ledger.pendingOutbox()).length, 1);
  // A second writer over the same ledger (another code path in the same process) sees the pending row and joins it.
  const second = new OutboxWriter({ ledger, log });
  const joined = await second.enqueue(draft);
  assert.equal(joined.eventId, first.event!.eventId);
  assert.equal((await ledger.pendingOutbox()).length, 1);
  // Once delivered, the first writer still answers with the same event and never enqueues anew.
  await ledger.markOutbox(first.event!.eventId, 'delivered');
  const after = await writer.enqueue(draft);
  assert.equal(after.eventId, first.event!.eventId);
  assert.equal(after.state, 'delivered');
  assert.equal((await ledger.pendingOutbox()).length, 0);
});

test('deliverer: crash after enqueue, before delivery → the next process delivers exactly once', async () => {
  const ledger = new InMemoryLedger();
  const task = await seedTask(ledger);
  const writer = new OutboxWriter({ ledger, log });
  await writer.finalize(task.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', undefined, (t) => taskFinalDraft(t));
  // "Crash": no deliverer ever ran. Restart: a fresh deliverer over the same ledger.
  const sink = new MemorySink();
  const { d } = deliverer(ledger, sink);
  const report = await d.runOnce();
  assert.equal(report.delivered.length, 1);
  assert.equal(sink.delivered.length, 1);
  assert.equal(sink.duplicates, 0);
  assert.deepEqual(await ledger.pendingOutbox(), []);
  // Another cycle, and another restart, deliver nothing more.
  assert.equal((await d.runOnce()).delivered.length, 0);
  const { d: again } = deliverer(ledger, sink);
  assert.equal((await again.runOnce()).delivered.length, 0);
  assert.equal(sink.calls, 1);
  const facts = await ledger.listFacts(task.taskId);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.factKind, 'reconciliation');
  assert.equal(facts[0]!.data?.kind, 'outbox_delivery');
  assert.equal(facts[0]!.data?.status, 'delivered');
  assert.equal(facts[0]!.data?.sink, 'memory');
  assert.equal(facts[0]!.data?.receipt, sink.receipts.get(facts[0]!.data?.eventId as string));
});

test('deliverer: delivered, then the ledger write fails (crash before markOutbox) → after restart the sink sees the same eventId, dedupes, and the ledger ends delivered', async () => {
  const ledger = new InMemoryLedger();
  const task = await seedTask(ledger);
  const writer = new OutboxWriter({ ledger, log });
  await writer.finalize(task.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', undefined, (t) => taskFinalDraft(t));
  const sink = new MemorySink();
  let cut = true;
  const cuttable = new Proxy(ledger, {
    get: (target, prop) => {
      if (cut && (prop === 'markOutbox' || prop === 'settleOutbox')) return async () => { throw new LedgerUnavailableError('crash before markOutbox'); };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Ledger;
  const { d: first } = deliverer(cuttable, sink);
  await assert.rejects(first.runOnce(), (e: unknown) => e instanceof LedgerUnavailableError);
  assert.equal(sink.delivered.length, 1, 'the sink took the event before the crash');
  assert.equal((await ledger.pendingOutbox()).length, 1, 'the ledger never learned of it');
  // Restart.
  cut = false;
  const { d: second } = deliverer(ledger, sink);
  const report = await second.runOnce();
  assert.equal(report.delivered.length, 1);
  assert.equal(sink.duplicates, 1, 'the replay was recognised');
  assert.equal(sink.delivered.length, 1, 'and not stored twice');
  assert.deepEqual(await ledger.pendingOutbox(), []);
  const fact = (await ledger.listFacts(task.taskId)).at(-1)!;
  assert.equal(fact.data?.status, 'delivered');
  assert.equal(fact.data?.receipt, sink.receipts.get(sink.delivered[0]!.eventId), 'the receipt is the one the sink issued the first time');
});

test('deliverer: retryable failures back off exponentially with a monotone retryAt, then the event is delivered', async () => {
  const ledger = new InMemoryLedger();
  const task = await seedTask(ledger);
  const writer = new OutboxWriter({ ledger, log });
  await writer.finalize(task.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', undefined, (t) => taskFinalDraft(t));
  const sink = new MemorySink({ failRetryable: 3 });
  const timeline: string[] = [];
  // The test clock moves one second per read; the backoff steps are well above that.
  const { d, clock } = deliverer(ledger, sink, { timeline, backoff: { baseMs: 5000, maxMs: 40_000 } });
  const retryAts: string[] = [];
  const delays: number[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const report = await d.runOnce();
    assert.equal(report.deferred.length, 1, `attempt ${i} deferred`);
    assert.equal(report.deferred[0]!.attempts, i);
    retryAts.push(report.deferred[0]!.retryAt);
    delays.push(Date.parse(report.deferred[0]!.retryAt) - Date.parse(clock.peek()));
    // Too early: nothing is tried.
    const early = await d.runOnce();
    assert.equal(early.waiting, 1);
    assert.equal(early.deferred.length, 0);
    assert.equal(sink.calls, i);
    clock.advance(delays[i - 1]! + 1);
  }
  for (let i = 1; i < retryAts.length; i += 1) assert.ok(Date.parse(retryAts[i]!) > Date.parse(retryAts[i - 1]!), `retryAt monotone at ${i}`);
  assert.deepEqual(delays, [5000, 10_000, 20_000], 'baseMs · 2^(attempts-1)');
  const done = await d.runOnce();
  assert.equal(done.delivered.length, 1);
  assert.equal(sink.calls, 4);
  assert.equal(sink.delivered.length, 1);
  assert.deepEqual(await ledger.pendingOutbox(), []);
  const statuses = (await ledger.listFacts(task.taskId)).map((f) => `${f.data?.status}:${f.data?.attempts}`);
  assert.deepEqual(statuses, ['deferred:1', 'deferred:2', 'deferred:3', 'delivered:4']);
  assert.equal(timeline.length, 4);
  assert.match(timeline[0]!, /外发暂缓/);
  assert.match(timeline[3]!, /外发已送达/);
});

test('deliverer: the backoff caps at maxMs and gives up at maxAttempts as failed', async () => {
  const ledger = new InMemoryLedger();
  const task = await seedTask(ledger);
  await new OutboxWriter({ ledger, log }).finalize(task.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', undefined, (t) => taskFinalDraft(t));
  const sink = new MemorySink({ failRetryable: 99 });
  const { d, clock } = deliverer(ledger, sink, { backoff: { baseMs: 5000, maxMs: 12_500, maxAttempts: 4 } });
  const delays: number[] = [];
  for (let i = 1; i <= 3; i += 1) {
    const r = await d.runOnce();
    delays.push(Date.parse(r.deferred[0]!.retryAt) - Date.parse(clock.peek()));
    clock.advance(60_000);
  }
  assert.deepEqual(delays, [5000, 10_000, 12_500]);
  const last = await d.runOnce();
  assert.equal(last.failed.length, 1);
  assert.match(last.failed[0]!.reason, /gave up after 4 attempts/);
  assert.deepEqual(await ledger.pendingOutbox(), []);
  assert.equal((await ledger.listFacts(task.taskId)).at(-1)!.data?.status, 'failed');
  assert.equal((await d.runOnce()).delivered.length + sink.delivered.length, 0);
});

test('deliverer: a non-retryable answer marks the event failed with a fact, and it is never offered again', async () => {
  const ledger = new InMemoryLedger();
  const task = await seedTask(ledger);
  await new OutboxWriter({ ledger, log }).finalize(task.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', undefined, (t) => taskFinalDraft(t));
  const sink = new MemorySink({ failNonRetryable: true });
  const timeline: string[] = [];
  const { d } = deliverer(ledger, sink, { timeline });
  const report = await d.runOnce();
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0]!.reason, 'rejected by sink');
  assert.deepEqual(await ledger.pendingOutbox(), []);
  const fact = (await ledger.listFacts(task.taskId)).at(-1)!;
  assert.equal(fact.factKind, 'reconciliation');
  assert.equal(fact.data?.kind, 'outbox_delivery');
  assert.equal(fact.data?.status, 'failed');
  assert.equal(fact.data?.error, 'rejected by sink');
  assert.match(timeline[0]!, /外发失败/);
  await d.runOnce();
  assert.equal(sink.calls, 1);
});

test('deliverer: a sink that hangs is a retryable failure after deliverTimeoutMs; a sink that throws likewise', async () => {
  const ledger = new InMemoryLedger();
  const task = await seedTask(ledger);
  await new OutboxWriter({ ledger, log }).finalize(task.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', undefined, (t) => taskFinalDraft(t));
  const sink = new MemorySink({ hangOnce: true, throwOnce: true });
  const { d, clock, scheduler } = deliverer(ledger, sink);
  const hanging = d.runOnce();
  await waitFor(() => scheduler.size === 1, 'the delivery timeout is armed');
  scheduler.flush();
  const first = await hanging;
  assert.equal(first.deferred.length, 1);
  assert.match(first.deferred[0]!.reason, /timeout after 50ms/);
  clock.advance(5000);
  const second = await d.runOnce();
  assert.equal(second.deferred.length, 1);
  assert.equal(second.deferred[0]!.reason, 'sink exploded');
  assert.equal(second.deferred[0]!.attempts, 2);
  clock.advance(5000);
  const third = await d.runOnce();
  assert.equal(third.delivered.length, 1);
  assert.equal(sink.delivered.length, 1);
});

test('deliverer: two concurrent cycles (and two deliverers over one ledger) never deliver an event twice', async () => {
  const ledger = new InMemoryLedger();
  const writer = new OutboxWriter({ ledger, log });
  for (let i = 0; i < 5; i += 1) {
    const task = await seedTask(ledger, `op_c${i}`);
    await writer.finalize(task.taskId, 'cancelled', 1, '2026-10-08T10:00:03+08:00', undefined, (t) => taskFinalDraft(t));
  }
  const sink = new MemorySink();
  const { d } = deliverer(ledger, sink);
  const [a, b] = await Promise.all([d.runOnce(), d.runOnce()]);
  assert.equal(a.delivered.length + b.delivered.length, 5);
  assert.equal(sink.delivered.length, 5);
  assert.equal(sink.duplicates, 0);
  assert.equal(sink.calls, 5);
  // A second deliverer instance (e.g. a start() racing a kick()) finds nothing.
  const { d: other } = deliverer(ledger, sink);
  const [c, e] = await Promise.all([other.runOnce(), d.runOnce()]);
  assert.equal(c.delivered.length + e.delivered.length, 0);
  assert.equal(sink.calls, 5);
});

test('FileSink: appends one JSONL line per event under the data dir and recognises an eventId it already holds, across instances', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-agent-outbox-file-'));
  const file = path.join(dir, 'outbox.jsonl');
  const sink = new FileSink(file, () => '2026-10-08T10:00:09+08:00');
  const event: OutboxEvent = { eventId: 'out_1', taskId: 'task_1', revision: 3, payloadHash: 'h', payload: { kind: 'task_final', state: 'confirmed' }, state: 'pending' };
  const first = await sink.deliver(event);
  assert.ok(first.ok);
  const again = await sink.deliver(event);
  assert.ok(again.ok && again.receipt === first.receipt);
  const reopened = new FileSink(file);
  const replay = await reopened.deliver(event);
  assert.ok(replay.ok && replay.receipt === first.receipt, 'a restart reads the file and answers with the same receipt');
  await reopened.deliver({ ...event, eventId: 'out_2' });
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => (JSON.parse(l) as { eventId: string }).eventId), ['out_1', 'out_2']);
  assert.equal((JSON.parse(lines[0]!) as { deliveredAt: string }).deliveredAt, '2026-10-08T10:00:09+08:00');
});

test('end to end: a handler conclusion becomes a task_final event (revision = task revision) plus a fact event; delivery adds a timeline line and touches no driver call', async () => {
  const sink = new MemorySink();
  const h2 = await makeHarness({ handlers: [acceptStub(), sendStub()], config: { outbox: { baseMs: 10, maxMs: 100, maxAttempts: 3, deliverTimeoutMs: 1000 } }, outboxSink: sink });
  await h2.confirmAccount();
  const account = (await h2.ledger.getAccount())!;
  const policy = await h2.ledger.getPolicy();
  await h2.ledger.setPolicy({ ...policy, allowlist: ['chat_a'] }, policy.revision);
  const view = await h2.call('task.create', { operationId: 'op_e2e', type: 'send_message', expectedAccountRevision: account.revision, payload: { kind: 'send_message', conversationTargetId: 'chat_a', content: '你好', contentHash: 'h:你好', contextRevision: 1 } });
  await waitState(h2, view.taskId, 'waiting_approval');
  const waiting = await h2.call('task.show', { taskId: view.taskId });
  await h2.call('task.approve', { taskId: view.taskId, approvalRevision: waiting.revision, approvedContentHash: 'h:你好', expiresAt: FAR });
  await waitState(h2, view.taskId, 'confirmed');
  const task = (await h2.ledger.getTask(view.taskId))!;
  const pending = await h2.ledger.pendingOutbox();
  assert.equal(pending.length, 2, 'one fact event (message_sent) and one task_final event');
  const factEvent = pending.find((e) => e.payload.kind === 'fact')!;
  const finalEvent = pending.find((e) => e.payload.kind === 'task_final')!;
  assert.equal(factEvent.payload.factKind, 'message_sent');
  assert.ok(factEvent.revision < task.revision, 'the fact was recorded while the task was still executing');
  assert.equal(finalEvent.revision, task.revision);
  assert.equal(finalEvent.payload.state, 'confirmed');
  assert.equal(finalEvent.payload.outcome, 'confirmed');
  assert.deepEqual(finalEvent.payload.keyFactIds, [factEvent.payload.factId]);
  assert.equal(finalEvent.payloadHash, payloadHashOf(finalEvent.payload));
  const actsBefore = h2.acts();
  const callsBefore = h2.driver.calls.length;
  // The kick after enqueue is parked on the manual scheduler (a 0 ms timer); the cycle itself is run here by hand.
  assert.ok(h2.scheduler.delays().includes(0), 'the enqueue kicked the deliverer');
  const report = await h2.app.internals.outbox.runOnce();
  assert.equal(report.delivered.length, 2);
  assert.equal(sink.delivered.length, 2);
  assert.equal((await h2.ledger.pendingOutbox()).length, 0, 'ledger marked delivered');
  assert.equal(sink.duplicates, 0);
  assert.equal(h2.acts(), actsBefore, 'delivery is not a GUI action');
  assert.equal(h2.driver.calls.length, callsBefore, 'delivery makes no platform call at all');
  const shown = await h2.call('task.show', { taskId: view.taskId });
  assert.ok(shown.timeline.some((t) => t.label.includes('外发事件已入账')), shown.timeline.map((t) => t.label).join(' > '));
  assert.ok(shown.timeline.filter((t) => t.label.includes('外发已送达')).length === 2);
  assert.equal(shown.facts.filter((f) => f.data?.kind === 'outbox_delivery' && f.data?.status === 'delivered').length, 2);
  assert.equal(h2.app.internals.outbox.sinkName, 'memory');
  await h2.app.stop();
});

test('end to end: cancel and no_op end states are events too; a blocked task is not (not terminal)', async () => {
  const sink = new MemorySink();
  const h = await makeHarness({ handlers: [acceptStub()], outboxSink: sink });
  await h.confirmAccount();
  const account = (await h.ledger.getAccount())!;
  const view = await h.call('task.create', { operationId: 'op_cancel', type: 'accept_request', expectedAccountRevision: account.revision, payload: { kind: 'accept_request', requestKey: 'r1' } });
  await waitState(h, view.taskId, 'waiting_approval');
  const waiting = await h.call('task.show', { taskId: view.taskId });
  await h.call('task.cancel', { taskId: view.taskId, expectedRevision: waiting.revision });
  await waitState(h, view.taskId, 'cancelled');
  const pending = await h.ledger.pendingOutbox();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.payload.state, 'cancelled');
  assert.equal(pending[0]!.payload.stateReason, 'cancelled');
  assert.equal(pending[0]!.revision, (await h.ledger.getTask(view.taskId))!.revision);
  await h.app.stop();
});
