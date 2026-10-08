import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTEMPT_TRANSITIONS, canTransition, TASK_TRANSITIONS, TERMINAL_TASK_STATES, IPC_METHODS, DriverError } from '../src/index.ts';
import type { TaskState } from '../src/index.ts';
import { FakeDriver, FakeRecognizer, InMemoryLedger, sampleSnapshots, FakeApplicationService } from '../src/fakes/index.ts';
import { pageFacts } from '../src/fakes/recognizer.ts';
import { runLedgerContract } from './ledger-contract.ts';

test('terminal task states have no way out, and every state is reachable', () => {
  for (const state of TERMINAL_TASK_STATES) assert.deepEqual(TASK_TRANSITIONS[state], []);
  const reachable = new Set<TaskState>(['created']);
  for (const [from, tos] of Object.entries(TASK_TRANSITIONS)) for (const to of tos) reachable.add(to);
  for (const state of Object.keys(TASK_TRANSITIONS) as TaskState[]) assert.ok(reachable.has(state), `${state} unreachable`);
  assert.ok(canTransition('executing', 'stopping'));
  assert.ok(!canTransition('confirmed', 'executing'));
  assert.ok(!ATTEMPT_TRANSITIONS.unknown.includes('dispatching'), 'unknown attempts are never re-dispatched');
});

test('IPC whitelist is unique', () => {
  assert.equal(new Set(IPC_METHODS).size, IPC_METHODS.length);
});

runLedgerContract(async () => new InMemoryLedger());

test('the in-memory ledger stops writing after a failure instead of pretending', async () => {
  const ledger = new InMemoryLedger();
  ledger.breakWrites();
  await assert.rejects(ledger.intake({ operationId: 'o', fingerprint: 'f', type: 'read_requests', accountRevision: 1, payload: { kind: 'read_requests' }, payloadHash: 'p' }, '2026-10-08T10:00:00+08:00'));
  assert.equal((await ledger.health()).writable, false);
});

test('the fake driver answers the same requestId with the same receipt and refuses a changed one', async () => {
  const driver = new FakeDriver();
  await driver.connect();
  const session = await driver.openSession('desk_fake');
  const run = await driver.startRun(session.sessionId);
  const snap = await driver.observe({ sessionId: session.sessionId, runId: run.runId });
  const params = { snapshotId: snap.snapshotId, action: { kind: 'click' as const, target: { imagePoint: { x: 10, y: 20 } } } };
  const first = await driver.act({ sessionId: session.sessionId, runId: run.runId }, params, 'rq_1');
  const again = await driver.act({ sessionId: session.sessionId, runId: run.runId }, params, 'rq_1');
  assert.equal(again.receiptId, first.receiptId);
  assert.equal(first.businessResult, 'not_evaluated');
  await assert.rejects(driver.act({ sessionId: session.sessionId, runId: run.runId }, { ...params, action: { kind: 'key', key: 'return' } }, 'rq_1'), (e: unknown) => e instanceof DriverError && e.error.code === 'idempotency_conflict');
  assert.equal(driver.countCalls('act'), 3);
});

test('a fault can drop the connection before the receipt', async () => {
  const driver = new FakeDriver({ faults: [{ method: 'act', error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] });
  await driver.connect();
  const session = await driver.openSession('desk_fake');
  const run = await driver.startRun(session.sessionId);
  await assert.rejects(driver.act({ sessionId: session.sessionId, runId: run.runId }, { snapshotId: 's', action: { kind: 'key', key: 'return' } }, 'rq_x'), (e: unknown) => e instanceof DriverError && e.error.code === 'connection_lost' && e.error.notSent === false);
  assert.equal(driver.state, 'disconnected');
  await assert.rejects(driver.showRequest('rq_x'), (e: unknown) => e instanceof DriverError && e.error.code === 'connection_lost');
});

test('the fake recognizer hands out scripted facts and marks nothing readable past them', async () => {
  const recognizer = new FakeRecognizer([pageFacts({ page: 'new_friends', requests: [] })]);
  const image = { width: 2560, height: 1750, scale: 2 };
  const a = recognizer.applicability(image);
  assert.ok(a.applicable);
  const facts = await recognizer.recognize(image, a.profile);
  assert.equal(facts.page, 'new_friends');
  assert.equal((await recognizer.recognize(image, a.profile)).page, 'new_friends');
  assert.equal(recognizer.reads.length, 2);
});

test('every sample snapshot is distinct and self-consistent', async () => {
  const keys = Object.keys(sampleSnapshots);
  assert.equal(new Set(keys.map((k) => JSON.stringify(sampleSnapshots[k as keyof typeof sampleSnapshots]))).size, keys.length);
  for (const [key, snapshot] of Object.entries(sampleSnapshots)) {
    assert.equal(Object.keys(snapshot.features).length, 6, key);
    if (snapshot.connection.state !== 'ready') assert.notEqual(snapshot.inputGate, 'open', `${key}: no open gate without a platform`);
    assert.equal(snapshot.connection.steps.length, 6, key);
  }
  const service = new FakeApplicationService('platform_offline');
  const seen: string[] = [];
  const stop = service.subscribe((s) => seen.push(s.connection.state));
  service.show('ready_idle');
  stop();
  assert.deepEqual(seen, ['disconnected', 'ready']);
});
