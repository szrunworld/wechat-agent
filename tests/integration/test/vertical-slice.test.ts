// The vertical slice: task.create → approve → dispatch → receipt → fact → stop,
// through the typed IPC only. Fakes for the platform and pixels; lane H's
// stubs for handlers and app until lanes D/E merge (see src/wiring.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IpcFailure, LedgerConflictError } from '@wechat-agent/ports';
import type { ActionAttempt } from '@wechat-agent/ports';
import { InMemoryLedger } from '@wechat-agent/ports/fakes';
import { acceptScript, newFriendsPage, requestRow } from '../src/fixtures.ts';
import { acceptToEnd, approve, createAccept, createRead, indexOfCall, KEY, NAME, TERMINAL, waitForTask } from '../src/scenario.ts';
import { createSlice } from '../src/wiring.ts';

test('slice: create → approve → dispatch → receipt → fact → stop (T05/T21/T36 on the way)', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  const { service } = slice.app;
  await slice.app.start();

  const before = await service.call('app.getSnapshot', {});
  assert.equal(before.connection.state, 'ready');
  assert.equal(before.inputGate, 'open');
  assert.deepEqual(before.features.accept_request, { enabled: true });

  const created = await createAccept(service, { operationId: 'op_slice' });
  assert.ok(['queued', 'preparing', 'waiting_approval'].includes(created.state), created.state);

  const waiting = await waitForTask(service, created.taskId, ['waiting_approval']);
  assert.equal(waiting.target?.displayName, NAME);
  assert.ok(waiting.pendingContentHash, 'the UI is shown the content hash it approves');
  assert.equal(waiting.approval, undefined, 'no approval exists before the person decides');
  assert.equal(slice.driver.countCalls('act'), 0, 'nothing is clicked before approval');

  const approval = await approve(service, created.taskId, slice.now);
  assert.equal(approval.taskId, created.taskId);

  const done = await waitForTask(service, created.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed');

  // Exactly one platform action, with the requestId the ledger persisted first (T06 contract, ADR-10 consumer side).
  assert.equal(slice.driver.countCalls('act'), 1);
  const [requestId, acted] = [...slice.driver.acts.entries()][0];
  const ledger = slice.ledger as InMemoryLedger;
  const attempt = [...ledger.attempts.values()].find((a: ActionAttempt) => a.taskId === created.taskId)!;
  assert.equal(attempt.requestId, requestId);
  assert.equal(attempt.state, 'verified');
  assert.equal(attempt.receiptId, acted.receipt.receiptId);
  assert.equal(done.platform?.requestId, requestId);

  // Re-observed after the approval wait: the click used the fresh row position, not the pre-approval one (T21).
  assert.ok(indexOfCall(slice, 'act') > indexOfCall(slice, 'observe', 2), 'act comes after the second observe');
  const target = acted.params.action.kind === 'click' && 'imagePoint' in acted.params.action.target ? acted.params.action.target.imagePoint : undefined;
  assert.deepEqual(target, { x: 1670, y: 480 });

  // A Delegated run: start carries only the sessionId (T36 / ADR-05), and it was finished, not abandoned.
  const start = slice.driver.calls[indexOfCall(slice, 'startRun')];
  assert.deepEqual(start.args, [attempt.sessionId]);
  assert.equal(slice.driver.runs.get(attempt.runId!)?.phase, 'ended');
  assert.equal(slice.driver.runs.get(attempt.runId!)?.outcome, 'success');

  // Facts: a platform receipt is recorded as observed; the business fact is what confirms.
  const kinds = done.facts.map((f) => `${f.factKind}:${f.outcome}`);
  assert.ok(kinds.includes('platform_receipt:observed'), kinds.join(','));
  assert.ok(kinds.includes('friend_added:confirmed'), kinds.join(','));
  assert.equal((await ledger.pendingOutbox()).length, 1);
  assert.equal([...ledger.quotas.values()][0]?.state, 'consumed');

  // Stop: the gate closes, the run is quiescent, nothing else moves.
  const paused = await service.call('app.pause', { operationId: 'op_pause', expectedRevision: 0 });
  assert.equal(paused.inputGate, 'closed');
  const after = await service.call('app.getSnapshot', {});
  assert.equal(after.inputGate, 'closed');
  assert.equal(after.features.accept_request.enabled, false);
  assert.equal(after.counts.confirmed, 1);
  await slice.app.stop();
  assert.equal(slice.driver.countCalls('act'), 1, 'stop adds no action');
});

test('T05: the same intent from two entry points is one task and one action; a different intent under the same operationId is refused', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  const { service } = slice.app;
  await slice.app.start();
  const fromUi = await createAccept(service, { operationId: 'op_same' });
  const fromPatrol = await createAccept(service, { operationId: 'op_same' });
  assert.equal(fromPatrol.taskId, fromUi.taskId);
  await assert.rejects(createAccept(service, { operationId: 'op_same', requestKey: 'someone|else' }), (e: unknown) => e instanceof IpcFailure && e.error.code === 'operation_conflict');
  await waitForTask(service, fromUi.taskId, ['waiting_approval']);
  await approve(service, fromUi.taskId, slice.now);
  await assert.rejects(approve(service, fromUi.taskId, slice.now), (e: unknown) => e instanceof IpcFailure, 'a second approval of the same task is refused');
  const done = await waitForTask(service, fromUi.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed');
  assert.equal((await service.call('task.list', {})).tasks.length, 1);
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});

test('T16: the request is already added when re-observed after approval: no_op, no click', async () => {
  const slice = await createSlice({ facts: [newFriendsPage([requestRow(NAME, 'pending')]), newFriendsPage([requestRow(NAME, 'added')])] });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'no_op');
  assert.equal(done.stateReason, 'already_friend');
  assert.equal(slice.driver.countCalls('act'), 0);
  const ledger = slice.ledger as InMemoryLedger;
  assert.equal([...ledger.quotas.values()][0]?.state, 'released');
  await slice.app.stop();
});

test('T16: an expired request is no_op before any approval is even asked', async () => {
  const slice = await createSlice({ facts: [newFriendsPage([requestRow(NAME, 'expired')])] });
  await slice.app.start();
  const created = await createAccept(slice.app.service);
  const done = await waitForTask(slice.app.service, created.taskId, TERMINAL);
  assert.equal(done.state, 'no_op');
  assert.equal(done.stateReason, 'request_expired');
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

test('T11: two rows with the same name are ambiguous: no approval, no action', async () => {
  const slice = await createSlice({ facts: [newFriendsPage([requestRow(NAME, 'pending'), requestRow(NAME, 'pending', { rect: { x: 600, y: 500, width: 1200, height: 120 } })])] });
  await slice.app.start();
  const created = await createAccept(slice.app.service);
  const done = await waitForTask(slice.app.service, created.taskId, TERMINAL);
  assert.equal(done.state, 'failed');
  assert.equal(done.stateReason, 'target_ambiguous');
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

test('T14: a partial viewport is recorded as partial, never as "all handled"', async () => {
  const slice = await createSlice({ facts: [newFriendsPage([], 'partial')] });
  await slice.app.start();
  const created = await createRead(slice.app.service);
  const done = await waitForTask(slice.app.service, created.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed');
  const fact = done.facts.find((f) => f.factKind === 'list_read')!;
  assert.equal(fact.data?.coverage, 'partial');
  assert.deepEqual(fact.data?.rows, []);
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

test('T03: an owner principal is not a pairing: outbound is blocked with pairing_missing, reading still works, act = 0', async () => {
  const slice = await createSlice({ facts: acceptScript(), driver: { principalRole: 'owner' } });
  const { service } = slice.app;
  await slice.app.start();
  const snapshot = await service.call('app.getSnapshot', {});
  assert.equal(snapshot.connection.state, 'unpaired');
  assert.deepEqual(snapshot.features.accept_request, { enabled: false, reason: 'pairing_missing' });
  const outbound = await createAccept(service);
  const blocked = await waitForTask(service, outbound.taskId, ['blocked']);
  assert.equal(blocked.stateReason, 'pairing_missing');
  const read = await createRead(service);
  assert.equal((await waitForTask(service, read.taskId, TERMINAL)).state, 'confirmed');
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

test('T01: no platform: the app starts into the connection page and never calls the driver beyond connect', async () => {
  const slice = await createSlice({ facts: acceptScript(), driver: { faults: [{ method: 'connect', error: { code: 'runtime_offline', phase: 'connect', retryable: true, notSent: true } }] } });
  const { service } = slice.app;
  await slice.app.start();
  const snapshot = await service.call('app.getSnapshot', {});
  assert.equal(snapshot.connection.state, 'disconnected');
  assert.equal(snapshot.connection.steps.find((s) => s.key === 'discover')?.state, 'pending');
  assert.equal(snapshot.inputGate, 'closed');
  for (const feature of Object.values(snapshot.features)) assert.equal(feature.enabled, false);
  const task = await createAccept(service);
  const blocked = await waitForTask(service, task.taskId, ['blocked']);
  assert.equal(blocked.stateReason, 'disconnected');
  assert.deepEqual([...new Set(slice.driver.calls.map((c) => c.method))], ['connect']);
  await slice.app.stop();
});

test('T40: quota for an unknown outcome is held, survives resume, and blocks the same intent from being sent again', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'act', error: { code: 'deadline_exceeded', phase: 'transport', retryable: false, notSent: false } }] },
  });
  const { service } = slice.app;
  await slice.app.start();
  const first = await acceptToEnd(slice, { operationId: 'op_q1' });
  assert.equal(first.state, 'needs_reconciliation');
  const ledger = slice.ledger as InMemoryLedger;
  const reservation = [...ledger.quotas.values()][0];
  assert.equal(reservation.state, 'held');
  await service.call('app.pause', { operationId: 'op_p', expectedRevision: 0 });
  await service.call('app.resume', { operationId: 'op_r', expectedRevision: 0 });
  assert.equal([...ledger.quotas.values()][0].state, 'held', 'resume does not release a held reservation');
  assert.equal((await ledger.releaseQuota(reservation.reservationId)).state, 'held', 'a held reservation cannot be released by a later release');
  // Same fingerprint under a new operationId: blocked, not sent twice.
  const again = await createAccept(service, { operationId: 'op_q2' });
  const blocked = await waitForTask(service, again.taskId, ['blocked']);
  assert.equal(blocked.stateReason, 'platform_unknown');
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});

test('the ledger refuses a second intake under the same operationId with a different fingerprint even without the app', async () => {
  const ledger = new InMemoryLedger();
  const now = '2026-10-08T02:00:00.000Z';
  await ledger.intake({ operationId: 'op', fingerprint: 'f1', type: 'accept_request', accountRevision: 1, payload: { kind: 'accept_request', requestKey: KEY }, payloadHash: 'p1' }, now);
  await assert.rejects(ledger.intake({ operationId: 'op', fingerprint: 'f2', type: 'accept_request', accountRevision: 1, payload: { kind: 'accept_request', requestKey: 'x|y' }, payloadHash: 'p2' }, now), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'operation_fingerprint');
});
