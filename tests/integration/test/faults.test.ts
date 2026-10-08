// The fault-injection matrix (方案 §12, lane H item 2). Every entry injects a
// fault through FakeDriver (faults / dropConnection), the ledger (breakWrites)
// or the recognizer (hold) and asserts the consumer's behaviour: no blind
// re-dispatch, no "not sent" without proof, no action through a closed gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DriverError, IpcFailure, LedgerConflictError } from '@wechat-agent/ports';
import type { ActionAttempt, AppSnapshot, Ledger } from '@wechat-agent/ports';
import { InMemoryLedger } from '@wechat-agent/ports/fakes';
import { acceptScript } from '../src/fixtures.ts';
import { acceptToEnd, approve, createAccept, createRead, indexOfCall, KEY, plusSeconds, TERMINAL, waitForTask } from '../src/scenario.ts';
import { createSlice, type Slice } from '../src/wiring.ts';

const attemptsOf = (slice: Slice, taskId: string): ActionAttempt[] => [...(slice.ledger as InMemoryLedger).attempts.values()].filter((a) => a.taskId === taskId);

async function waitForSnapshot(slice: Slice, predicate: (s: AppSnapshot) => boolean, timeoutMs = 3000): Promise<AppSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await slice.app.service.call('app.getSnapshot', {});
    if (predicate(s)) return s;
    if (Date.now() > deadline) throw new Error(`snapshot never matched: inputGate=${s.inputGate} connection=${s.connection.state}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A task that reached `state` with one attempt in `attemptState`, as a crash would leave it. */
async function seedCrashedTask(ledger: Ledger, now: () => string, attemptState: 'prepared' | 'dispatching' | 'receipt_received', requestId?: string, receiptId?: string) {
  const { task } = await ledger.intake({ operationId: 'op_crashed', fingerprint: 'fp_crashed', type: 'accept_request', accountRevision: 1, targetId: 'tgt_a', targetRevision: 1, payload: { kind: 'accept_request', requestKey: KEY }, payloadHash: 'ph' }, now());
  let t = task;
  for (const to of ['queued', 'preparing', 'ready', 'executing'] as const) t = await ledger.transitionTask(t.taskId, to, t.revision, now());
  const attempt = await ledger.prepareAttempt({ taskId: t.taskId, stepId: 'accept_click', sessionId: 'ses_old', runId: 'run_old' }, now());
  if (attemptState !== 'prepared') await ledger.markDispatching(attempt.attemptId, { requestId: requestId!, canonicalDigest: 'd', snapshotId: 'snap_old', sessionId: 'ses_old', runId: 'run_old' }, now());
  if (attemptState === 'receipt_received') await ledger.recordReceipt(attempt.attemptId, receiptId!, {}, now());
  return { task: t, attempt };
}

// ---------------------------------------------------------------- 断连：派发前

test('T07: the platform proves the request was not sent (notSent=true): failed, re-plannable, no reconciliation, nothing on the platform', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'act', error: { code: 'runtime_offline', phase: 'connect', retryable: true, notSent: true }, disconnect: true }] },
  });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'failed');
  assert.equal(done.stateReason, 'disconnected');
  assert.equal(slice.driver.countCalls('act'), 1, 'one attempt was made');
  assert.equal(slice.driver.acts.size, 0, 'the platform never recorded it');
  const [attempt] = attemptsOf(slice, done.taskId);
  assert.equal(attempt.state, 'unknown');
  assert.ok(attempt.requestId, 'the requestId was persisted before the call');
  const fact = done.facts.find((f) => f.factKind === 'platform_receipt')!;
  assert.equal(fact.data?.notSent, true);
  assert.equal(fact.outcome, 'failed');
  const snapshot = await slice.app.service.call('app.getSnapshot', {});
  assert.equal(snapshot.connection.state, 'disconnected');
  assert.equal(snapshot.inputGate, 'quiescence_unconfirmed', 'the run was left on the dropped connection');
  await slice.app.stop();
});

test('T07: a crash after prepare but before a requestId was persisted: recovery fails the task without asking the platform and without re-dispatch', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  const { task, attempt } = await seedCrashedTask(slice.ledger, slice.now, 'prepared');
  await slice.app.start();
  const view = await slice.app.service.call('task.show', { taskId: task.taskId });
  assert.equal(view.state, 'failed');
  assert.equal((await slice.ledger.getAttempt(attempt.attemptId))?.state, 'prepared');
  assert.equal(slice.driver.countCalls('showRequest'), 0);
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

// ---------------------------------------------------------------- 断连：派发后

test('T08: the connection drops after the click and before the receipt: unknown, queried by the original requestId, never re-sent', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'act', error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] },
  });
  const { service } = slice.app;
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'needs_reconciliation');
  assert.equal(done.stateReason, 'disconnected');
  const [attempt] = attemptsOf(slice, done.taskId);
  assert.equal(attempt.state, 'unknown');
  const requestId = attempt.requestId!;
  assert.equal(done.platform?.requestId, requestId);
  assert.equal(slice.driver.calls[indexOfCall(slice, 'act')].args[2], requestId, 'the act used the persisted requestId');
  const dropped = await service.call('app.getSnapshot', {});
  assert.equal(dropped.connection.state, 'disconnected');
  assert.equal(dropped.inputGate, 'quiescence_unconfirmed');
  await assert.rejects(service.call('task.reconcile', { taskId: done.taskId, expectedRevision: done.revision }), (e: unknown) => e instanceof IpcFailure && e.error.code === 'unavailable');

  // Reconnect, then reconcile: request.show with the same requestId, no act.
  const check = await service.call('connection.check', {});
  assert.equal(check.state, 'ready');
  const reconciled = await service.call('task.reconcile', { taskId: done.taskId, expectedRevision: done.revision });
  assert.equal(slice.driver.calls[indexOfCall(slice, 'showRequest')].args[0], requestId);
  assert.equal(reconciled.state, 'needs_reconciliation', 'not_found on the platform is not proof of not sent');
  const fact = reconciled.facts.find((f) => f.factKind === 'reconciliation')!;
  assert.equal(fact.data?.notSentProven, false);
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});

test('T08/A10: a crash after the receipt and before it was written: recovery sees the platform completed it and reconciles, act = 0', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  // The platform already holds the request (it was sent before the crash).
  await slice.driver.connect();
  const session = await slice.driver.openSession('desk_fake');
  const run = await slice.driver.startRun(session.sessionId);
  await slice.driver.act({ sessionId: session.sessionId, runId: run.runId }, { snapshotId: 'snap_old', action: { kind: 'click', target: { imagePoint: { x: 1, y: 1 } } } }, 'rq_sent_before_crash');
  const { task, attempt } = await seedCrashedTask(slice.ledger, slice.now, 'dispatching', 'rq_sent_before_crash');
  await slice.app.start();
  const view = await slice.app.service.call('task.show', { taskId: task.taskId });
  assert.equal(view.state, 'needs_reconciliation');
  assert.equal((await slice.ledger.getAttempt(attempt.attemptId))?.state, 'unknown');
  const fact = view.facts.find((f) => f.factKind === 'reconciliation')!;
  assert.equal(fact.data?.platformState, 'completed');
  assert.equal(fact.data?.notSentProven, false);
  assert.equal(slice.driver.countCalls('showRequest'), 1);
  assert.equal(slice.driver.countCalls('act'), 1, 'only the pre-crash act exists');
  await slice.app.stop();
});

test('T08/A10: a crash after the receipt was written but before business verification: still unknown, still no re-dispatch', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  const { task, attempt } = await seedCrashedTask(slice.ledger, slice.now, 'receipt_received', 'rq_receipt_written', 'rcpt_written');
  await slice.app.start();
  assert.equal((await slice.app.service.call('task.show', { taskId: task.taskId })).state, 'needs_reconciliation');
  assert.equal((await slice.ledger.getAttempt(attempt.attemptId))?.state, 'unknown');
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

// ---------------------------------------------------------------- 超时

test('T08 (timeout): the act times out with the connection intact: unknown, run finished as failed, reconcile queries, act = 1', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'act', error: { code: 'deadline_exceeded', phase: 'transport', retryable: false, notSent: false } }] },
  });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'needs_reconciliation');
  assert.equal(done.stateReason, 'platform_unknown');
  assert.equal(slice.driver.state, 'connected');
  assert.equal(slice.driver.calls[indexOfCall(slice, 'finishRun')].args[1], 'failed');
  const reconciled = await slice.app.service.call('task.reconcile', { taskId: done.taskId, expectedRevision: done.revision });
  assert.equal(reconciled.state, 'needs_reconciliation');
  assert.equal(slice.driver.countCalls('showRequest'), 1);
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});

// ---------------------------------------------------------------- idempotency_conflict

test('T06: a requestId is single-use on both sides: the ledger refuses to reuse it, the platform refuses changed parameters', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'act', error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] },
  });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  const [attempt] = attemptsOf(slice, done.taskId);
  const requestId = attempt.requestId!;
  // Ledger side: a new attempt may not borrow the old requestId.
  const retry = await slice.ledger.prepareAttempt({ taskId: done.taskId, stepId: 'accept_click' }, slice.now());
  assert.equal(retry.attemptOrdinal, 2);
  await assert.rejects(slice.ledger.markDispatching(retry.attemptId, { requestId, canonicalDigest: 'x', snapshotId: 's', sessionId: 'ses', runId: 'run' }, slice.now()), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'attempt');
  // Platform side: same requestId with different parameters is a conflict; the original is the only action.
  await slice.driver.connect();
  const session = await slice.driver.openSession('desk_fake');
  const run = await slice.driver.startRun(session.sessionId);
  const params = { snapshotId: 'snap_x', action: { kind: 'click' as const, target: { imagePoint: { x: 5, y: 5 } } } };
  const first = await slice.driver.act({ sessionId: session.sessionId, runId: run.runId }, params, 'rq_fixed');
  const same = await slice.driver.act({ sessionId: session.sessionId, runId: run.runId }, params, 'rq_fixed');
  assert.equal(same.receiptId, first.receiptId);
  await assert.rejects(slice.driver.act({ sessionId: session.sessionId, runId: run.runId }, { ...params, action: { kind: 'key', key: 'return' } }, 'rq_fixed'), (e: unknown) => e instanceof DriverError && e.error.code === 'idempotency_conflict' && e.error.notSent === true);
  assert.equal(slice.driver.acts.size, 1);
  await slice.app.stop();
});

// ---------------------------------------------------------------- events_cursor_expired

test('T37: an expired event cursor is re-synced through run.list/run.show and a fresh subscription; no GUI action is redone', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'subscribe', onCall: 2, error: { code: 'events_cursor_expired', phase: 'request', retryable: false } }] },
  });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'confirmed');
  const check = await slice.app.service.call('connection.check', {});
  assert.equal(check.state, 'ready');
  assert.equal(slice.driver.countCalls('subscribe'), 3, 'resume attempt, then a fresh subscription');
  assert.equal(slice.driver.countCalls('listRuns'), 1);
  assert.equal(slice.driver.calls[indexOfCall(slice, 'subscribe', 3)].args[0], undefined, 'the fresh subscription carries no cursor');
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});

// ---------------------------------------------------------------- request.show not_found

test('T09: the platform no longer knows the request (not_found): stays to be reconciled, is not declared not-sent, act = 0', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  const { task, attempt } = await seedCrashedTask(slice.ledger, slice.now, 'dispatching', 'rq_forgotten_by_platform');
  await slice.app.start();
  const view = await slice.app.service.call('task.show', { taskId: task.taskId });
  assert.equal(view.state, 'needs_reconciliation');
  assert.equal((await slice.ledger.getAttempt(attempt.attemptId))?.state, 'unknown');
  const fact = view.facts.find((f) => f.factKind === 'reconciliation')!;
  assert.equal(fact.data?.code, 'not_found');
  assert.equal(fact.data?.notSentProven, false);
  assert.equal(fact.outcome, 'needs_reconciliation');
  assert.equal(slice.driver.countCalls('act'), 0);
  // Reconcile again later: still a query, still no action.
  const again = await slice.app.service.call('task.reconcile', { taskId: task.taskId, expectedRevision: view.revision });
  assert.equal(again.facts.filter((f) => f.factKind === 'reconciliation').length, 2);
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

// ---------------------------------------------------------------- 账号变化

test('T10: the account changes while an approval is pending: the gate closes and the old approval no longer matches, act = 0', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  const { service } = slice.app;
  await slice.app.start();
  const created = await createAccept(service);
  await waitForTask(service, created.taskId, ['waiting_approval']);
  const rebound = await service.call('account.confirm', { bindingEvidenceId: 'ev_other_account', expectedRevision: 1 });
  assert.equal(rebound.revision, 2);
  const closed = await service.call('app.getSnapshot', {});
  assert.equal(closed.inputGate, 'closed');
  assert.equal(closed.features.accept_request.enabled, false);
  const approval = await approve(service, created.taskId, slice.now);
  assert.equal(approval.accountRevision, 1, 'the approval was bound to the account the person saw');
  const done = await waitForTask(service, created.taskId, [...TERMINAL, 'waiting_user', 'blocked']);
  assert.notEqual(done.state, 'confirmed');
  assert.equal(done.stateReason, 'account_changed');
  await assert.rejects(slice.ledger.consumeApproval(approval.approvalId, { taskId: created.taskId, contentHash: approval.contentHash, targetRevision: approval.targetRevision, accountRevision: 2 }, slice.now()), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'approval');
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

// ---------------------------------------------------------------- 审批过期 / 旧 snapshot

test('T21: an approval that has already expired is refused at verify-before-write; nothing is clicked', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  await slice.app.start();
  const done = await acceptToEnd(slice, { expiresAt: plusSeconds(slice.now(), -1) });
  assert.notEqual(done.state, 'confirmed');
  assert.equal(done.stateReason, 'approval_expired');
  assert.equal(slice.driver.countCalls('act'), 0);
  assert.equal(attemptsOf(slice, done.taskId).length, 0, 'no attempt is even prepared');
  await slice.app.stop();
});

test('T21: the page moved while the approval was pending: the click targets the re-observed position, never the pre-approval one', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'confirmed');
  const [{ params }] = [...slice.driver.acts.values()];
  const point = params.action.kind === 'click' && 'imagePoint' in params.action.target ? params.action.target.imagePoint : undefined;
  assert.deepEqual(point, { x: 1670, y: 480 }, 'row at y=420 after re-observe, not y=300 before approval');
  assert.ok(indexOfCall(slice, 'observe', 2) < indexOfCall(slice, 'act'));
  assert.notEqual(params.snapshotId, 'snap_fixture');
  await slice.app.stop();
});

// ---------------------------------------------------------------- 账本损坏 / 磁盘满

test('T38: the ledger refuses writes right before dispatch: no action, outbound disabled, new tasks refused, no silent empty store', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  const { service } = slice.app;
  await slice.app.start();
  const hold = slice.recognizer.hold(2);
  const created = await createAccept(service);
  await waitForTask(service, created.taskId, ['waiting_approval']);
  await approve(service, created.taskId, slice.now);
  await hold.reached;
  (slice.ledger as InMemoryLedger).breakWrites();
  hold.release();
  const snapshot = await waitForSnapshot(slice, (s) => s.inputGate !== 'open');
  assert.equal(snapshot.features.accept_request.enabled, false);
  assert.equal(slice.driver.countCalls('act'), 0);
  assert.equal((await slice.ledger.health()).writable, false);
  await assert.rejects(createAccept(service, { operationId: 'op_after_break' }), (e: unknown) => e instanceof IpcFailure && e.error.code === 'unavailable');
  assert.equal((await slice.ledger.listTasks()).tasks.length, 1, 'the store is not replaced by an empty one');
  await slice.app.stop();
});

// ---------------------------------------------------------------- 停止：晚到回调 / 未静止

test('T31: pause while the handler is mid-step: the late continuation finds the gate closed, act = 0; a late approval of a cancelled task is refused', async () => {
  const slice = await createSlice({ facts: [...acceptScript().slice(0, 2), ...acceptScript()] });
  const { service } = slice.app;
  await slice.app.start();
  const hold = slice.recognizer.hold(2);
  const created = await createAccept(service);
  await waitForTask(service, created.taskId, ['waiting_approval']);
  await approve(service, created.taskId, slice.now);
  await hold.reached;
  const paused = await service.call('app.pause', { operationId: 'op_pause', expectedRevision: 0 });
  assert.equal(paused.inputGate, 'closed', 'the fake run reaches quiescence at once');
  hold.release();
  const done = await waitForTask(service, created.taskId, TERMINAL);
  assert.equal(done.state, 'cancelled');
  assert.equal(slice.driver.countCalls('act'), 0);
  assert.equal(slice.driver.countCalls('cancelRun'), 1);

  // The second half: a task cancelled while waiting for approval refuses the approval that arrives late.
  await service.call('app.resume', { operationId: 'op_resume', expectedRevision: 0 });
  const second = await createAccept(service, { operationId: 'op_late' });
  const waiting = await waitForTask(service, second.taskId, ['waiting_approval']);
  await service.call('task.cancel', { taskId: second.taskId, expectedRevision: waiting.revision });
  await assert.rejects(service.call('task.approve', { taskId: second.taskId, approvalRevision: waiting.revision, approvedContentHash: waiting.approval!.contentHash, expiresAt: plusSeconds(slice.now(), 600) }), (e: unknown) => e instanceof IpcFailure && e.error.code === 'invalid_state');
  assert.equal((await waitForTask(service, second.taskId, TERMINAL)).state, 'cancelled');
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

test('T32: cancel is accepted but quiescence is not confirmed: the UI stays stopping, no handback, no next task, no resume', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'waitRun', error: { code: 'wait_timeout', phase: 'request', retryable: true } }] },
    quiescenceTimeoutMs: 50,
  });
  const { service } = slice.app;
  await slice.app.start();
  const hold = slice.recognizer.hold(2);
  const created = await createAccept(service);
  await waitForTask(service, created.taskId, ['waiting_approval']);
  await approve(service, created.taskId, slice.now);
  await hold.reached;
  const paused = await service.call('app.pause', { operationId: 'op_pause', expectedRevision: 0 });
  assert.equal(paused.inputGate, 'stopping');
  hold.release();
  await new Promise((r) => setTimeout(r, 20));
  const view = await service.call('task.show', { taskId: created.taskId });
  assert.equal(view.state, 'stopping');
  await assert.rejects(service.call('window.requestHandback', { operationId: 'op_hb' }), (e: unknown) => e instanceof IpcFailure && e.error.code === 'invalid_state');
  await assert.rejects(service.call('app.resume', { operationId: 'op_resume', expectedRevision: 0 }), (e: unknown) => e instanceof IpcFailure && e.error.code === 'invalid_state');
  const next = await createAccept(service, { operationId: 'op_next' });
  assert.equal((await waitForTask(service, next.taskId, ['blocked'])).stateReason, 'write_gate_closed');
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

// ---------------------------------------------------------------- 静止与 unknown 共存 / 重连

test('T33: the run is ended and quiescent while the business outcome is still unknown: both are shown, neither overrides the other', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'act', error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] },
  });
  const { service } = slice.app;
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'needs_reconciliation');
  const oldRun = done.platform!.runId!;
  assert.equal(slice.driver.runs.get(oldRun)?.phase, 'running', 'the platform still has the run until the new connection settles it');
  await service.call('connection.check', {});
  assert.equal(slice.driver.runs.get(oldRun)?.phase, 'ended');
  assert.equal(slice.driver.runs.get(oldRun)?.quiescence, 'confirmed');
  const view = await service.call('task.show', { taskId: done.taskId });
  assert.equal(view.state, 'needs_reconciliation', 'quiescence does not settle the business question');
  assert.equal(view.platform?.quiescence, 'confirmed');
  assert.equal(attemptsOf(slice, done.taskId)[0].state, 'unknown');
  const snapshot = await service.call('app.getSnapshot', {});
  assert.equal(snapshot.inputGate, 'open', 'after quiescence the gate may open again');
  assert.equal(snapshot.counts.needsReconciliation, 1);
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});

test('T34: the control connection drops mid-task: input is blocked; after reconnect the old run is not resumed and the next task gets a new run', async () => {
  const slice = await createSlice({ facts: [...acceptScript().slice(0, 2), ...acceptScript()] });
  const { service } = slice.app;
  await slice.app.start();
  const hold = slice.recognizer.hold(2);
  const created = await createAccept(service, { operationId: 'op_first' });
  await waitForTask(service, created.taskId, ['waiting_approval']);
  const firstRun = (await service.call('task.show', { taskId: created.taskId })).platform!.runId!;
  await approve(service, created.taskId, slice.now);
  await hold.reached;
  slice.driver.dropConnection();
  hold.release();
  const done = await waitForTask(service, created.taskId, [...TERMINAL, 'waiting_user', 'blocked']);
  assert.notEqual(done.state, 'confirmed');
  assert.equal(slice.driver.acts.size, 0);
  const dropped = await service.call('app.getSnapshot', {});
  assert.equal(dropped.connection.state, 'disconnected');
  assert.equal(dropped.features.accept_request.enabled, false);
  const blocked = await createAccept(service, { operationId: 'op_while_down' });
  assert.equal((await waitForTask(service, blocked.taskId, ['blocked'])).stateReason, 'disconnected');

  await service.call('connection.check', {});
  assert.equal(slice.driver.countCalls('connect'), 2);
  const next = await createAccept(service, { operationId: 'op_after_reconnect' });
  await waitForTask(service, next.taskId, ['waiting_approval']);
  await approve(service, next.taskId, slice.now);
  const ok = await waitForTask(service, next.taskId, TERMINAL);
  assert.equal(ok.state, 'confirmed');
  assert.equal(slice.driver.countCalls('startRun'), 2);
  assert.notEqual(ok.platform?.runId, firstRun);
  for (const { receipt } of slice.driver.acts.values()) assert.notEqual(receipt.runId, firstRun, 'no delivered action rides the pre-drop run');
  const afterReconnect = slice.driver.calls.slice(indexOfCall(slice, 'connect', 2)).filter((c) => c.method === 'act').map((c) => (c.args[0] as { runId: string }).runId);
  assert.ok(afterReconnect.length === 1 && !afterReconnect.includes(firstRun), 'after reconnect only the new run is used');
  assert.equal(slice.driver.runs.get(firstRun)?.phase, 'ended', 'the stale run was settled, not resumed');
  await slice.app.stop();
});

test('T34: a read-only task also stops at a dropped connection and does not retry by itself', async () => {
  const slice = await createSlice({ facts: acceptScript(), driver: { faults: [{ method: 'observe', error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: true }, disconnect: true }] } });
  await slice.app.start();
  const created = await createRead(slice.app.service);
  const done = await waitForTask(slice.app.service, created.taskId, [...TERMINAL, 'blocked', 'waiting_user']);
  assert.equal(done.stateReason, 'disconnected');
  assert.equal(slice.driver.countCalls('observe'), 1);
  assert.equal(slice.driver.countCalls('connect'), 1, 'no automatic reconnect loop inside the task');
  await slice.app.stop();
});
