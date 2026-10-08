// Delegated Run disconnect semantics (ADR v2.2 §三) proven over the wire:
// lane A's real client against lane A's Fake Runtime SERVER, then lane E's
// real app + lane D's real handlers + lane B's SQLite ledger on top of them.
// Written for docs/acceptance/driver-disconnect-review.md; nothing here uses
// FakeDriver or its endRunsOnDrop shortcut. Fake-level evidence only.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createDriver, FakeRuntime, type FakeRuntimeOptions } from '@wechat-agent/driver';
import { DriverError } from '@wechat-agent/ports';
import type { Action, PageFacts } from '@wechat-agent/ports';
import { newFriendsPage, pageFacts, requestRow } from '../src/fixtures.ts';
import { REHEARSAL_CLIENT, snapshotOf, startFakeStack, timeline, viewOf, waitFor, type FakeStack } from '../src/fake-runtime-stack.ts';
import { approve, createAccept, NAME, TERMINAL, waitForTask } from '../src/scenario.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const click = (x: number, y: number): Action => ({ kind: 'click', target: { imagePoint: { x, y } } });

function driverError(e: unknown, code: string, extra: Partial<DriverError['error']> = {}): boolean {
  assert.ok(e instanceof DriverError, `expected DriverError, got ${String(e)}`);
  assert.equal(e.error.code, code, e.error.message);
  for (const [key, value] of Object.entries(extra)) assert.deepEqual((e.error as unknown as Record<string, unknown>)[key], value, `${key} of ${code}`);
  return true;
}

async function pair(t: TestContext, options: FakeRuntimeOptions = {}) {
  const fake = await FakeRuntime.start(options);
  const driver = createDriver({ endpoint: fake.endpoint, client: REHEARSAL_CLIENT, requestTimeoutMs: 300, connectTimeoutMs: 1_000 });
  t.after(async () => { await driver.close().catch(() => undefined); await fake.close(); });
  await driver.connect();
  const [desktop] = await driver.listDesktops();
  const session = await driver.openSession(desktop.desktopId);
  const run = await driver.startRun(session.sessionId);
  return { fake, driver, sessionId: session.sessionId, runId: run.runId };
}

// ---------------------------------------------------------------- packages/driver

test('driver: the control connection drops with a request in flight → connection_lost (transport, notSent=false, requestId in details); later calls notSent=true; state disconnected; no reconnect by itself; the subscription ends without throwing', async (t) => {
  const { fake, driver, sessionId, runId } = await pair(t);
  const stream = await driver.subscribe({ runId });
  await waitFor(async () => fake.connectionCount, (n) => n === 2, 'subscription open');
  const frames: string[] = [];
  const pump = (async () => { for await (const f of stream) frames.push(f.event.type); })();

  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  fake.injectDisconnectBeforeReply('act');
  await assert.rejects(
    driver.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: click(1, 1) }, 'rq_inflight'),
    (e) => driverError(e, 'connection_lost', { phase: 'transport', notSent: false, retryable: false, details: { requestId: 'rq_inflight' } }),
  );
  assert.equal(driver.state, 'disconnected');
  await assert.rejects(driver.showRequest('rq_inflight'), (e) => driverError(e, 'connection_lost', { phase: 'transport', notSent: true }));
  await assert.rejects(driver.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: click(1, 1) }, 'rq_after'), (e) => driverError(e, 'connection_lost', { notSent: true }));
  const accepted = fake.connectionsAccepted;
  await sleep(150);
  assert.equal(fake.connectionsAccepted, accepted, 'no automatic reconnect (T34)');

  // The Run stream saw the platform end the Run and then the server closed it; the iterator ended, it did not throw.
  await pump;
  assert.deepEqual(frames, ['run.started', 'action.receipt', 'run.ended']);
  assert.equal(stream.cursor, 3);
});

test('driver: deadline_exceeded is transport/notSent=false and the driver keeps the socket (the app closes it; see the connector)', async (t) => {
  const { fake, driver, sessionId, runId } = await pair(t);
  fake.injectTimeout('observe');
  await assert.rejects(driver.observe({ sessionId, runId }, { screenshot: false }), (e) => driverError(e, 'deadline_exceeded', { phase: 'transport', notSent: false }));
  assert.equal(driver.state, 'connected');
  assert.equal(fake.runs.get(runId)?.phase, 'running', 'the platform still sees the Run on the open socket');
  await assert.rejects(driver.connect(), (e) => driverError(e, 'invalid_argument'), 'connect() refuses to run while connected: a reconnect must close first');
  await driver.close();
  await waitFor(async () => fake.runs.get(runId)?.phase, (p) => p === 'ended', 'closing the socket ends the Run');
  assert.equal(fake.runs.get(runId)?.closingReason, 'connection_closed');
});

// ---------------------------------------------------------------- Fake Runtime (the platform stand-in)

test('fake runtime: a connection that ends takes its connection_scoped Run with it (ended/cancelled/connection_closed, quiescence confirmed, run.ended event); an act processed before the drop stays findable by requestId', async (t) => {
  const { fake, driver, sessionId, runId } = await pair(t);
  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  fake.injectDisconnectBeforeReply('act');
  await assert.rejects(driver.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: click(2, 2) }, 'rq_before_drop'), (e) => driverError(e, 'connection_lost'));
  const run = fake.runs.get(runId)!;
  assert.equal(run.phase, 'ended');
  assert.equal(run.outcome, 'cancelled');
  assert.equal(run.closingReason, 'connection_closed');
  assert.equal(run.quiescence, 'confirmed');
  assert.equal(run.receipts.length, 1, 'the action went out before the socket died');
  assert.equal(run.unknownActions, 0, 'the platform knows it completed; only the client does not');
  assert.deepEqual(run.events.map((e) => e.type), ['run.started', 'action.receipt', 'run.ended']);
  // A fresh connection asks by requestId instead of re-sending.
  const second = createDriver({ endpoint: fake.endpoint, client: REHEARSAL_CLIENT });
  t.after(() => second.close());
  await second.connect();
  const record = await second.showRequest('rq_before_drop');
  assert.equal(record.state, 'completed');
  assert.equal(record.outcome?.receiptId, run.receipts[0]);
  assert.equal((await second.showRun(runId)).phase, 'ended');
  await assert.rejects(second.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: click(2, 2) }, 'rq_late'), (e) => driverError(e, 'run_not_active'));
});

test('fake runtime (quiescenceOnDrop: pending): the drop closes input at once (stopping, quiescence pending, act → run_not_active); the Run ends only when quiescence is confirmed', async (t) => {
  const { fake, driver, sessionId, runId } = await pair(t, { quiescenceOnDrop: 'pending' });
  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  fake.dropConnections();
  await waitFor(async () => fake.runs.get(runId)?.phase, (p) => p === 'stopping', 'run stopping');
  const run = fake.runs.get(runId)!;
  assert.equal(run.quiescence, 'pending');
  assert.equal(run.outcome, null);
  assert.equal(run.closingReason, 'connection_closed');
  const second = createDriver({ endpoint: fake.endpoint, client: REHEARSAL_CLIENT });
  t.after(() => second.close());
  await second.connect();
  await assert.rejects(second.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: click(3, 3) }, 'rq_stopping'), (e) => driverError(e, 'run_not_active'));
  assert.equal((await second.showRun(runId)).quiescence, 'pending');
  fake.confirmQuiescence(runId);
  const ended = await second.showRun(runId);
  assert.equal(ended.phase, 'ended');
  assert.equal(ended.outcome, 'cancelled');
  assert.equal(ended.quiescence, 'confirmed');
  assert.deepEqual(run.events.map((e) => e.type), ['run.started', 'run.stopping', 'run.ended']);
});

// ---------------------------------------------------------------- packages/app over the real driver + Fake Runtime

const detailPage = (): PageFacts => pageFacts({
  page: 'request_detail',
  detail: { name: NAME, wechatId: 'wxid_fixture_a', buttons: [{ text: '接受', rect: { x: 1500, y: 900, width: 200, height: 80 }, confidence: 0.95 }], confidence: 0.95 },
});
const acceptStack = (): PageFacts[] => [newFriendsPage([requestRow(NAME, 'pending')]), detailPage(), detailPage(), newFriendsPage([requestRow(NAME, 'added')])];

async function pairedStack(t: TestContext, fake: FakeRuntimeOptions = {}): Promise<FakeStack> {
  return startFakeStack(t, { fake: { principal: { clientId: 'app:wechat-agent', role: 'paired' }, ...fake }, facts: acceptStack() });
}

test('app T08 over the wire: the socket dies after the dangerous act → attempt unknown with the persisted requestId, gate quiescence_unconfirmed, task stopping; reconnect only looks (run.show), settles needs_reconciliation; reconcile asks request.show with the same requestId; nothing re-sent', async (t) => {
  const stack = await pairedStack(t);
  const { fake, app, ledger, driver } = stack;
  await app.start();
  fake.injectDisconnectBeforeReply('act', 2);
  const created = await createAccept(app.service, { operationId: 'op_wire_t08' });
  await waitForTask(app.service, created.taskId, ['waiting_approval']);
  await approve(app.service, created.taskId, stack.slice.now);
  const parked = await waitForTask(app.service, created.taskId, ['stopping', ...TERMINAL]);
  assert.equal(parked.state, 'stopping', timeline(parked));
  assert.equal(parked.stateReason, 'disconnected');

  // Ledger vs wire: the attempt is unknown, and its requestId is the envelope requestId the platform logged for act #2.
  const accept = (await ledger.listAttempts(created.taskId)).find((a) => a.stepId === 'accept')!;
  assert.equal(accept.state, 'unknown');
  const actRequests = fake.requests.filter((r) => r.method === 'act');
  assert.equal(actRequests.length, 2);
  assert.equal(actRequests[1].requestId, accept.requestId);
  assert.equal(parked.platform?.requestId, accept.requestId);
  assert.equal(parked.platform?.execution, 'unknown');
  const unknownFact = (await ledger.listFacts(created.taskId)).find((f) => f.factKind === 'platform_receipt' && f.outcome === 'needs_reconciliation');
  assert.equal(unknownFact?.data?.error, 'connection_lost');

  // App: write gate closed as unconfirmed; driver disconnected; platform: Run ended by the drop, no cancel from the client.
  const dropped = await waitFor(() => snapshotOf(stack), (s) => s.connection.state === 'disconnected', 'app disconnected');
  assert.equal(dropped.inputGate, 'quiescence_unconfirmed');
  assert.equal(dropped.features.accept_request.enabled, false);
  assert.equal(driver.state, 'disconnected');
  const run = fake.runs.get(accept.runId!)!;
  assert.equal(run.phase, 'ended');
  assert.equal(run.closingReason, 'connection_closed');
  assert.equal(run.receipts.length, 1, 'the platform did execute the click');
  assert.equal(fake.callCount('run.cancel'), 0);
  await assert.rejects(app.service.call('task.reconcile', { taskId: created.taskId, expectedRevision: parked.revision }), /unavailable/);

  // Reconnect: new handshake; the parked Run is looked at with run.show and, being ended, settled as needs_reconciliation. No run.attach, no act.
  stack.mark();
  const check = await app.service.call('connection.check', {});
  assert.equal(check.state, 'ready');
  const settled = await waitForTask(app.service, created.taskId, TERMINAL);
  assert.equal(settled.state, 'needs_reconciliation', timeline(settled));
  assert.equal(settled.stateReason, 'platform_unknown');
  assert.equal(settled.platform?.quiescence, 'confirmed');
  const afterReconnect = stack.methods(stack.since()).filter((m) => !['runtime.handshake', 'runtime.capabilities', 'desktop.list', 'window.list', 'window.bind', 'events.subscribe'].includes(m));
  assert.deepEqual(afterReconnect, ['run.show'], afterReconnect.join(' > '));
  assert.equal(fake.callCount('run.attach'), 0);
  assert.equal(fake.callCount('act'), 2);
  assert.equal(fake.callCount('run.cancel'), 0);
  assert.equal(fake.callCount('run.start'), 2, 'the two Runs of the accept flow (before and after the approval); none after the drop');

  // Reconcile: request.show with the original requestId; the platform's answer (completed) becomes a fact; still no re-dispatch.
  const reconciled = await app.service.call('task.reconcile', { taskId: created.taskId, expectedRevision: settled.revision });
  assert.equal(reconciled.state, 'needs_reconciliation');
  const shown = fake.requests.filter((r) => r.method === 'request.show').map((r) => r.params.requestId);
  const own = (await ledger.listAttempts(created.taskId)).map((a) => a.requestId);
  assert.ok(shown.includes(accept.requestId), shown.join(','));
  assert.ok(shown.every((id) => own.includes(id as string)), 'only the task\'s own persisted requestIds are queried');
  const reconciliation = (await ledger.listFacts(created.taskId)).filter((f) => f.factKind === 'reconciliation').at(-1)!;
  const requests = reconciliation.data?.requests as { requestId: string; state: string; outcome?: { receiptId?: string } }[];
  assert.equal(requests.find((r) => r.requestId === accept.requestId)?.state, 'completed');
  assert.equal(requests.find((r) => r.requestId === accept.requestId)?.outcome?.receiptId, run.receipts[0]);
  assert.equal(fake.callCount('act'), 2, 'no re-send');
  assert.equal((await ledger.listAttempts(created.taskId)).filter((a) => a.stepId === 'accept').length, 1);
  assert.deepEqual(await ledger.findOpenAttempts(), []);

  // Resume is a decision, not a replay.
  assert.equal((await snapshotOf(stack)).inputGate, 'closed');
  await app.service.call('app.resume', { operationId: 'op_wire_resume', expectedRevision: 0 });
  assert.equal((await snapshotOf(stack)).inputGate, 'open');
  assert.equal(fake.callCount('act'), 2);
  assert.equal((await viewOf(stack, created.taskId)).state, 'needs_reconciliation');
});

test('app over the wire (quiescenceOnDrop: pending): after the reconnect the platform still says stopping/pending → the task stays stopping, nothing is cancelled or re-sent; the next query after quiescence settles it', async (t) => {
  const stack = await pairedStack(t, { quiescenceOnDrop: 'pending' });
  const { fake, app, ledger } = stack;
  await app.start();
  fake.injectDisconnectBeforeReply('act', 2);
  const created = await createAccept(app.service, { operationId: 'op_wire_pending' });
  await waitForTask(app.service, created.taskId, ['waiting_approval']);
  await approve(app.service, created.taskId, stack.slice.now);
  const parked = await waitForTask(app.service, created.taskId, ['stopping', ...TERMINAL]);
  assert.equal(parked.state, 'stopping', timeline(parked));
  const accept = (await ledger.listAttempts(created.taskId)).find((a) => a.stepId === 'accept')!;
  assert.equal(accept.state, 'unknown');
  await waitFor(() => snapshotOf(stack), (s) => s.connection.state === 'disconnected', 'app disconnected');
  const run = fake.runs.get(accept.runId!)!;
  assert.equal(run.phase, 'stopping');
  assert.equal(run.quiescence, 'pending');

  const check = await app.service.call('connection.check', {});
  assert.equal(check.state, 'ready');
  await sleep(30);
  const still = await viewOf(stack, created.taskId);
  assert.equal(still.state, 'stopping', 'no quiescence claim while the platform says pending');
  assert.equal(still.platform?.quiescence, 'pending');
  assert.equal((await snapshotOf(stack)).inputGate, 'quiescence_unconfirmed');
  assert.equal(fake.callCount('run.cancel'), 0);
  assert.equal(fake.callCount('act'), 2);
  assert.equal(fake.callCount('run.start'), 2);

  // The platform reaches quiescence later; the app learns it by querying (reconcile → run.show), never by resuming the Run.
  fake.confirmQuiescence(run.runId);
  const settled = await app.service.call('task.reconcile', { taskId: created.taskId, expectedRevision: still.revision });
  assert.equal(settled.state, 'needs_reconciliation', timeline(settled));
  assert.equal(settled.platform?.quiescence, 'confirmed');
  assert.equal((await snapshotOf(stack)).inputGate, 'closed', 'quiescence lifts "unconfirmed"; the drop pause stays until app.resume');
  assert.equal(fake.callCount('act'), 2);
  assert.equal(fake.callCount('run.cancel'), 0);
});
