// Outbox persistence, idempotency, delivery confirmation and crash recovery
// (plan §8: the app core writes the outbox) on BOTH ledgers: the in-memory
// fake and lane B's SQLite file. "Restart" closes the ledger handle and the
// deliverer and opens fresh ones over the same file; two scenarios go further
// and SIGKILL a child process. The last tests drive the real stack (lane E app
// + lane D handlers + SQLite) end to end. Fake-level evidence: the T records
// in docs/acceptance/cases stay as they are.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FileSink, ManualScheduler, MemorySink, OutboxDeliverer, OutboxWriter, outboxExtension, payloadHashOf, taskFinalDraft, type Application as RealApplication } from '@wechat-agent/app';
import { createHandlers } from '@wechat-agent/handlers';
import { openLedger, type SqliteLedger, type StoredOutboxEvent } from '@wechat-agent/ledger';
import { LedgerUnavailableError } from '@wechat-agent/ports';
import type { Ledger, Timestamp, WeChatTask } from '@wechat-agent/ports';
import { InMemoryLedger } from '@wechat-agent/ports/fakes';
import { clock, newFriendsPage, pageFacts, requestRow } from '../src/fixtures.ts';
import { approve, createAccept, NAME, TERMINAL, waitForTask } from '../src/scenario.ts';
import { createSlice } from '../src/wiring.ts';

const T0 = '2026-10-08T10:00:00+08:00';
const log = () => undefined;
const tmpDir = () => mkdtempSync(path.join(tmpdir(), 'wechat-agent-outbox-'));

/** One ledger family: how to open it and how to "restart" it. The fake has one instance for its whole life. */
interface Family {
  kind: 'fake' | 'sqlite';
  open(): Promise<Ledger>;
  /** Simulates a process restart: the old handle is abandoned (closed for SQLite), a new one opened over the same state. */
  reopen(ledger: Ledger): Promise<Ledger>;
}

function families(): Family[] {
  const fake = new InMemoryLedger();
  const file = path.join(tmpDir(), 'ledger.sqlite');
  return [
    { kind: 'fake', open: async () => fake, reopen: async (l) => l },
    { kind: 'sqlite', open: () => openLedger(file), reopen: async (l) => { await l.close(); return openLedger(file); } },
  ];
}

async function seedTask(ledger: Ledger, operationId: string): Promise<WeChatTask> {
  const { task } = await ledger.intake({
    operationId, fingerprint: `fp_${operationId}`, type: 'accept_request', accountRevision: 1,
    payload: { kind: 'accept_request', requestKey: `${NAME}|${NAME}` }, payloadHash: 'ph',
  }, T0);
  return task;
}

async function finalize(ledger: Ledger, operationId: string) {
  const task = await seedTask(ledger, operationId);
  const writer = new OutboxWriter({ ledger, log });
  return writer.finalize(task.taskId, 'cancelled', task.revision, T0, 'cancelled: 测试', (t) => taskFinalDraft(t, { stateReason: 'cancelled', reason: '测试' }));
}

function deliverer(ledger: Ledger, sink: MemorySink, c = clock(T0), backoff = { baseMs: 5000, maxMs: 40_000, maxAttempts: 5, deliverTimeoutMs: 1000 }) {
  return { d: new OutboxDeliverer({ ledger, sink, now: c.now, scheduler: new ManualScheduler(), log, backoff }), clock: c };
}

for (const family of families()) {
  const on = family.kind;

  test(`[${on}] crash after enqueue, before delivery: after restart the event is delivered exactly once and stays delivered`, async () => {
    let ledger = await family.open();
    const { task, event } = await finalize(ledger, 'op_before');
    assert.ok(event);
    assert.equal(event.revision, task.revision);
    assert.equal(event.payloadHash, payloadHashOf(event.payload));
    ledger = await family.reopen(ledger);
    assert.equal((await ledger.pendingOutbox()).length, 1, 'the event survived the restart');
    const sink = new MemorySink();
    const { d } = deliverer(ledger, sink);
    assert.equal((await d.runOnce()).delivered.length, 1);
    assert.equal(sink.delivered.length, 1);
    ledger = await family.reopen(ledger);
    assert.deepEqual(await ledger.pendingOutbox(), []);
    const { d: next } = deliverer(ledger, sink);
    assert.equal((await next.runOnce()).delivered.length, 0);
    assert.equal(sink.calls, 1, 'nothing was offered to the sink again');
    const facts = await ledger.listFacts(task.taskId);
    assert.equal(facts.filter((f) => f.data?.kind === 'outbox_delivery').length, 1);
    assert.equal(facts[0]!.factKind, 'reconciliation');
    await ledger.close();
  });

  test(`[${on}] delivered but the ledger write fails before markOutbox: the restart replays the same eventId, the sink dedupes, the ledger ends delivered`, async () => {
    let ledger = await family.open();
    const { event } = await finalize(ledger, 'op_after');
    const sink = new MemorySink();
    const cut = new Proxy(ledger, {
      get: (target, prop) => {
        if (prop === 'markOutbox' || prop === 'settleOutbox') return async () => { throw new LedgerUnavailableError('cut before markOutbox'); };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Ledger;
    const { d } = deliverer(cut, sink);
    await assert.rejects(d.runOnce(), (e: unknown) => e instanceof LedgerUnavailableError);
    assert.equal(sink.delivered.length, 1);
    ledger = await family.reopen(ledger);
    assert.equal((await ledger.pendingOutbox()).length, 1, 'still pending after the restart');
    const { d: again } = deliverer(ledger, sink);
    assert.equal((await again.runOnce()).delivered.length, 1);
    assert.equal(sink.duplicates, 1, 'the replay carried the same eventId and was recognised');
    assert.equal(sink.delivered.length, 1);
    assert.deepEqual(await ledger.pendingOutbox(), []);
    const fact = (await ledger.listFacts(event!.taskId)).at(-1)!;
    assert.equal(fact.data?.status, 'delivered');
    assert.equal(fact.data?.receipt, sink.receipts.get(event!.eventId));
    await ledger.close();
  });

  test(`[${on}] retryable failures N times then success: retryAt monotone, attempts counted, survives a restart in between`, async () => {
    let ledger = await family.open();
    const { event } = await finalize(ledger, 'op_retry');
    const sink = new MemorySink({ failRetryable: 3 });
    const c = clock(T0);
    let { d } = deliverer(ledger, sink, c);
    const retryAts: Timestamp[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const report = await d.runOnce();
      assert.equal(report.deferred.length, 1, `deferred #${i}`);
      assert.equal(report.deferred[0]!.attempts, i);
      retryAts.push(report.deferred[0]!.retryAt);
      assert.equal((await d.runOnce()).waiting, 1, 'not due yet');
      if (on === 'sqlite') {
        // The retry state is on disk: a fresh handle and a fresh deliverer carry on from it.
        ledger = await family.reopen(ledger);
        const stored = (await ledger.pendingOutbox())[0] as StoredOutboxEvent;
        assert.equal(stored.retryAt, retryAts[i - 1]);
        assert.equal(stored.attempts, i);
        assert.equal(stored.lastError, 'sink unavailable');
        d = deliverer(ledger, sink, c).d;
        assert.equal((await d.runOnce()).waiting, 1, 'the new deliverer honours the persisted retryAt');
      }
      c.advance(5 * 2 ** (i - 1) + 2);
    }
    for (let i = 1; i < retryAts.length; i += 1) assert.ok(Date.parse(retryAts[i]!) > Date.parse(retryAts[i - 1]!), 'retryAt monotone');
    const done = await d.runOnce();
    assert.equal(done.delivered.length, 1);
    assert.equal(sink.delivered.length, 1);
    assert.equal(sink.calls, 4);
    assert.deepEqual(await ledger.pendingOutbox(), []);
    assert.deepEqual((await ledger.listFacts(event!.taskId)).map((f) => `${f.data?.status}:${f.data?.attempts}`), ['deferred:1', 'deferred:2', 'deferred:3', 'delivered:4']);
    if (on === 'sqlite') {
      const [row] = await (ledger as SqliteLedger).listOutbox(event!.taskId);
      assert.equal(row!.state, 'delivered');
      assert.equal(row!.attempts, 4);
      assert.equal(row!.receipt, sink.receipts.get(event!.eventId));
      assert.equal(row!.retryAt, undefined);
      assert.ok(row!.settledAt);
    }
    await ledger.close();
  });

  test(`[${on}] a non-retryable answer: failed, with a fact, never offered again (also after a restart)`, async () => {
    let ledger = await family.open();
    const { event } = await finalize(ledger, 'op_fail');
    const sink = new MemorySink({ failNonRetryable: true });
    const { d } = deliverer(ledger, sink);
    const report = await d.runOnce();
    assert.deepEqual(report.failed.map((f) => f.reason), ['rejected by sink']);
    assert.deepEqual(await ledger.pendingOutbox(), []);
    const fact = (await ledger.listFacts(event!.taskId)).at(-1)!;
    assert.equal(fact.factKind, 'reconciliation');
    assert.equal(fact.data?.kind, 'outbox_delivery');
    assert.equal(fact.data?.status, 'failed');
    assert.equal(fact.data?.error, 'rejected by sink');
    ledger = await family.reopen(ledger);
    assert.deepEqual(await ledger.pendingOutbox(), []);
    await deliverer(ledger, sink).d.runOnce();
    assert.equal(sink.calls, 1);
    if (on === 'sqlite') assert.equal((await (ledger as SqliteLedger).listOutbox(event!.taskId))[0]!.lastError, 'rejected by sink');
    await ledger.close();
  });

  test(`[${on}] the same task at the same revision finalized twice is one event`, async () => {
    const ledger = await family.open();
    const task = await seedTask(ledger, 'op_twice');
    const writer = new OutboxWriter({ ledger, log });
    const first = await writer.finalize(task.taskId, 'cancelled', task.revision, T0, undefined, (t) => taskFinalDraft(t, { stateReason: 'cancelled' }));
    const draft = taskFinalDraft(first.task, { stateReason: 'cancelled' });
    assert.equal((await writer.enqueue(draft)).eventId, first.event!.eventId);
    assert.equal((await new OutboxWriter({ ledger, log }).enqueue(draft)).eventId, first.event!.eventId, 'a second writer joins the existing row');
    assert.equal((await ledger.pendingOutbox()).length, 1);
    if (on === 'sqlite') {
      // Even the raw port call is idempotent on the triple: the unique index of migration 0003.
      const raw = await ledger.enqueueOutbox(draft);
      assert.equal(raw.eventId, first.event!.eventId);
      assert.equal((await (ledger as SqliteLedger).listOutbox(task.taskId)).length, 1);
    }
    await ledger.close();
  });

  test(`[${on}] two concurrent delivery cycles deliver each event once`, async () => {
    const ledger = await family.open();
    for (let i = 0; i < 4; i += 1) await finalize(ledger, `op_conc_${i}`);
    const before = (await ledger.pendingOutbox()).length;
    assert.ok(before >= 4);
    const sink = new MemorySink();
    const { d } = deliverer(ledger, sink);
    const { d: other } = deliverer(ledger, sink);
    const reports = await Promise.all([d.runOnce(), other.runOnce(), d.runOnce()]);
    assert.equal(reports.reduce((n, r) => n + r.delivered.length, 0), before, 'each pending event delivered once across the three cycles');
    assert.equal(sink.delivered.length, before);
    assert.equal(sink.duplicates, 0, 'nothing replayed within one process');
    assert.deepEqual(await ledger.pendingOutbox(), []);
    await ledger.close();
  });
}

// ---------------------------------------------------------------- SQLite only: atomicity and a real SIGKILL

test('[sqlite] the terminal transition and its outbox event are one transaction: cut before commit leaves neither', async () => {
  const file = path.join(tmpDir(), 'ledger.sqlite');
  let armed = false;
  let ledger = await openLedger(file, { faultInjection: { beforeCommit: (op) => { if (armed && op === 'transitionTaskWithOutbox') throw new Error('cut'); } } });
  assert.ok(outboxExtension(ledger), 'the SQLite ledger offers the extension');
  const task = await seedTask(ledger, 'op_atomic');
  const writer = new OutboxWriter({ ledger, log });
  assert.equal(writer.atomic, true);
  armed = true;
  await assert.rejects(writer.finalize(task.taskId, 'cancelled', task.revision, T0, undefined, (t) => taskFinalDraft(t)), /cut/);
  armed = false;
  ledger = await (async () => { await ledger.close(); return openLedger(file); })();
  const stored = (await ledger.getTask(task.taskId))!;
  assert.equal(stored.state, 'created', 'the transition did not land');
  assert.equal(stored.revision, task.revision);
  assert.deepEqual(await (ledger as SqliteLedger).listOutbox(task.taskId), [], 'and neither did the event');
  // Without the cut, both land, and the event is at the new revision.
  const { task: final, event } = await new OutboxWriter({ ledger, log }).finalize(task.taskId, 'cancelled', task.revision, T0, undefined, (t) => taskFinalDraft(t));
  assert.equal(final.revision, task.revision + 1);
  assert.equal(event!.revision, final.revision);
  assert.equal((await (ledger as SqliteLedger).listOutbox(task.taskId)).length, 1);
  await ledger.close();
});

const CHILD = fileURLToPath(new URL('../src/outbox-crash-child.ts', import.meta.url));

function crashChild(dbPath: string, sinkFile: string, scenario: string): { taskId: string; revision: number; eventId: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dbPath, sinkFile, scenario], { encoding: 'utf8', timeout: 60_000, cwd: path.dirname(CHILD) });
  assert.equal(result.signal, 'SIGKILL', `child must die by SIGKILL, got status ${result.status} signal ${result.signal}\n${result.stderr}`);
  const line = result.stdout.trim().split('\n').at(-1);
  assert.ok(line, `child printed nothing\n${result.stderr}`);
  return JSON.parse(line) as { taskId: string; revision: number; eventId: string };
}

test('[sqlite] SIGKILL after enqueue, before delivery: the next process delivers the event once to the file sink', async () => {
  const dir = tmpDir();
  const db = path.join(dir, 'ledger.sqlite');
  const file = path.join(dir, 'outbox.jsonl');
  const ids = crashChild(db, file, 'before_deliver');
  const ledger = await openLedger(db);
  assert.equal((await ledger.getTask(ids.taskId))!.revision, ids.revision);
  const pending = await ledger.pendingOutbox();
  assert.deepEqual(pending.map((e) => e.eventId), [ids.eventId]);
  const d = new OutboxDeliverer({ ledger, sink: new FileSink(file, () => T0), now: clock(T0).now, scheduler: new ManualScheduler(), log });
  assert.equal((await d.runOnce()).delivered.length, 1);
  assert.equal((await d.runOnce()).delivered.length, 0);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]!) as { eventId: string }).eventId, ids.eventId);
  assert.deepEqual(await ledger.pendingOutbox(), []);
  await ledger.close();
});

test('[sqlite] SIGKILL after the file sink took the event, before markOutbox: the next process replays it, the file keeps one line, the ledger ends delivered', async () => {
  const dir = tmpDir();
  const db = path.join(dir, 'ledger.sqlite');
  const file = path.join(dir, 'outbox.jsonl');
  const ids = crashChild(db, file, 'after_deliver');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'the sink had written the line before the crash');
  const ledger = await openLedger(db);
  assert.deepEqual((await ledger.pendingOutbox()).map((e) => e.eventId), [ids.eventId], 'the ledger never learned of the delivery');
  const sink = new FileSink(file, () => T0);
  const d = new OutboxDeliverer({ ledger, sink, now: clock(T0).now, scheduler: new ManualScheduler(), log });
  const report = await d.runOnce();
  assert.deepEqual(report.delivered, [ids.eventId]);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'no second line');
  assert.deepEqual(await ledger.pendingOutbox(), []);
  const [row] = await (ledger as SqliteLedger).listOutbox(ids.taskId);
  assert.equal(row!.state, 'delivered');
  assert.match(row!.receipt!, /^file:1:/);
  await ledger.close();
});

// ---------------------------------------------------------------- the real stack end to end

function detailPage(buttons: { text: string }[] = [{ text: '接受' }]) {
  return pageFacts({
    page: 'request_detail',
    detail: {
      name: NAME, wechatId: 'wxid_fixture_a', region: '测试', message: `你好，我是${NAME}`,
      buttons: buttons.map((b, i) => ({ text: b.text, rect: { x: 1500, y: 900 + i * 100, width: 200, height: 80 }, confidence: 0.95 })), confidence: 0.95,
    },
  });
}
const acceptStack = () => [newFriendsPage([requestRow(NAME, 'pending')]), detailPage(), detailPage(), newFriendsPage([requestRow(NAME, 'added')])];

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('[real stack] accept → confirmed: friend_added and task_final events at the right revisions, delivered by the app loop with no extra platform call; a restart delivers nothing twice', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'ledger.sqlite');
  const ledger = await openLedger(file);
  const sink = new MemorySink();
  const slice = await createSlice({ app: 'real', ledger, handlers: createHandlers(), facts: acceptStack(), outboxSink: sink, now: () => new Date().toISOString(), appConfig: { dataDir: dir, lockPath: null, outbox: { baseMs: 10, maxMs: 50, maxAttempts: 5, deliverTimeoutMs: 1000 } } });
  const { service } = slice.app;
  await slice.app.start();
  const created = await createAccept(service, { operationId: 'op_outbox_real' });
  await waitForTask(service, created.taskId, ['waiting_approval']);
  await approve(service, created.taskId, slice.now);
  const done = await waitForTask(service, created.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed');
  const actsAfterTask = slice.driver.countCalls('act');
  const callsAfterTask = slice.driver.calls.length;

  await waitFor(() => sink.delivered.length === 2, 'both events delivered by the app loop');
  await waitFor(async () => (await ledger.pendingOutbox()).length === 0, 'ledger marked delivered');
  const rows = await (ledger as SqliteLedger).listOutbox(created.taskId);
  assert.equal(rows.length, 2);
  const factEvent = rows.find((e) => e.payload.kind === 'fact')!;
  const finalEvent = rows.find((e) => e.payload.kind === 'task_final')!;
  assert.equal(factEvent.payload.factKind, 'friend_added');
  assert.ok(factEvent.revision < done.revision);
  assert.equal(finalEvent.revision, done.revision);
  assert.equal(finalEvent.payload.state, 'confirmed');
  assert.equal(finalEvent.payload.outcome, 'confirmed');
  assert.deepEqual(finalEvent.payload.keyFactIds, [factEvent.payload.factId]);
  assert.equal(finalEvent.payloadHash, payloadHashOf(finalEvent.payload));
  assert.ok(rows.every((r) => r.state === 'delivered' && r.receipt === sink.receipts.get(r.eventId)));
  assert.equal(sink.duplicates, 0);
  assert.equal(slice.driver.countCalls('act'), actsAfterTask, 'delivery clicks nothing');
  assert.equal(slice.driver.calls.length, callsAfterTask, 'delivery makes no platform call');
  const view = await service.call('task.show', { taskId: created.taskId });
  assert.equal(view.timeline.filter((t) => t.label.includes('外发已送达')).length, 2, view.timeline.map((t) => t.label).join(' > '));
  assert.equal(view.facts.filter((f) => f.data?.kind === 'outbox_delivery' && f.data?.status === 'delivered').length, 2);
  await slice.app.stop();
  await ledger.close();

  // Restart over the same file with a fresh sink: start() recovers pending events, of which there are none.
  const reopened = await openLedger(file);
  const fresh = new MemorySink();
  const again = await createSlice({ app: 'real', ledger: reopened, handlers: createHandlers(), facts: [], outboxSink: fresh, account: false, appConfig: { dataDir: dir, lockPath: null } });
  await again.app.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fresh.calls, 0, 'delivered events are not replayed after a restart');
  await again.app.stop();
  await reopened.close();
});

test('[real stack] the sink is down when the task ends; the app is stopped; a new app over the same ledger delivers the deferred event once after its retryAt', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'ledger.sqlite');
  const ledger = await openLedger(file);
  const down = new MemorySink({ failRetryable: 99 });
  const slice = await createSlice({ app: 'real', ledger, handlers: createHandlers(), facts: acceptStack(), outboxSink: down, now: () => new Date().toISOString(), appConfig: { dataDir: dir, lockPath: null, outbox: { baseMs: 20, maxMs: 40, maxAttempts: 50, deliverTimeoutMs: 1000 } } });
  await slice.app.start();
  const created = await createAccept(slice.app.service, { operationId: 'op_outbox_down' });
  await waitForTask(slice.app.service, created.taskId, ['waiting_approval']);
  await approve(slice.app.service, created.taskId, slice.now);
  const done = await waitForTask(slice.app.service, created.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed');
  await waitFor(() => down.calls >= 2, 'the loop tried the sink');
  await slice.app.stop();
  const pending = await ledger.pendingOutbox() as StoredOutboxEvent[];
  assert.equal(pending.length, 2, 'both events still pending');
  assert.ok(pending.every((e) => e.attempts >= 1 && e.retryAt !== undefined), 'retry state persisted');
  await ledger.close();

  const reopened = await openLedger(file);
  const up = new MemorySink();
  const again = await createSlice({ app: 'real', ledger: reopened, handlers: createHandlers(), facts: [], outboxSink: up, account: false, now: () => new Date().toISOString(), appConfig: { dataDir: dir, lockPath: null, outbox: { baseMs: 20, maxMs: 40, maxAttempts: 50, deliverTimeoutMs: 1000 } } });
  await again.app.start();
  await waitFor(() => up.delivered.length === 2, 'the new process delivered the deferred events');
  await waitFor(async () => (await reopened.pendingOutbox()).length === 0, 'ledger delivered');
  assert.equal(up.duplicates, 0);
  const rows = await (reopened as SqliteLedger).listOutbox(created.taskId);
  assert.ok(rows.every((r) => r.state === 'delivered' && r.attempts >= 2));
  assert.equal((again.app as RealApplication).internals.outbox.sinkName, 'memory');
  assert.equal(again.driver.countCalls('act'), 0, 'the restarted app acted on nothing');
  await again.app.stop();
  await reopened.close();
});
