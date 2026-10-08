// Stopping: T32 (cancel accepted but not quiescent), T33 (ended + unknown
// after recovery) and the dedicated "a pause lets no late action through".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from '@wechat-agent/ports';
import { FakeDriver, InMemoryLedger } from '@wechat-agent/ports/fakes';
import { expectIpc, Gate, makeHarness, PendingCancelDriver, sendStub, waitFor, waitState } from './harness.ts';

const FAR = '2099-01-01T00:00:00+08:00';
const sendParams = (operationId: string, accountRevision: number, content = '你好') => ({
  operationId, type: 'send_message' as const, expectedAccountRevision: accountRevision,
  payload: { kind: 'send_message' as const, conversationTargetId: 'chat_a', content, contentHash: `h:${content}`, contextRevision: 1 },
});

async function allowChat(h: Awaited<ReturnType<typeof makeHarness>>) {
  const policy = await h.ledger.getPolicy();
  await h.ledger.setPolicy({ ...policy, allowlist: ['chat_a'] }, policy.revision);
}

test('T32: cancel accepted but quiescence pending → task stopping, gate unconfirmed, no further task starts; settles after the platform confirms', async () => {
  const driver = new PendingCancelDriver({ principalRole: 'paired' });
  const parked = new Gate();
  const h = await makeHarness({ driver, handlers: [sendStub({ beforeAct: parked.wait })] });
  await h.confirmAccount();
  await allowChat(h);
  const account = (await h.ledger.getAccount())!;
  const a = await h.call('task.create', sendParams('op1', account.revision, '甲'));
  await waitState(h, a.taskId, 'waiting_approval');
  const waiting = await h.call('task.show', { taskId: a.taskId });
  await h.call('task.approve', { taskId: a.taskId, approvalRevision: waiting.revision, approvedContentHash: 'h:甲', expiresAt: FAR });
  await parked.reached;
  const runId = h.app.internals.dispatcher.runtimes.get(a.taskId)!.runId!;

  const executing = await h.call('task.show', { taskId: a.taskId });
  assert.equal(executing.state, 'executing');
  const stopping = await h.call('task.cancel', { taskId: a.taskId, expectedRevision: executing.revision });
  assert.equal(stopping.state, 'stopping');
  assert.deepEqual(driver.cancelled, [runId]);
  assert.equal(h.calls('waitRun'), 1);
  let snap = await h.snapshot();
  assert.equal(snap.inputGate, 'quiescence_unconfirmed');
  assert.equal(snap.activeTask?.state, 'stopping');
  assert.equal(snap.activeTask?.platform?.quiescence, 'pending');

  // The parked handler wakes up: its write is refused.
  parked.release();
  await h.idle();
  assert.equal(h.acts(), 0);
  assert.equal((await h.call('task.show', { taskId: a.taskId })).state, 'stopping');
  // A second cancel on a stopping task is a no-op; skip is refused.
  const again = await h.call('task.cancel', { taskId: a.taskId, expectedRevision: (await h.call('task.show', { taskId: a.taskId })).revision });
  assert.equal(again.state, 'stopping');

  // Nothing else starts while the stop is unconfirmed.
  const b = await h.call('task.create', sendParams('op2', account.revision, '乙'));
  assert.equal(b.state, 'blocked', 'the gate is unconfirmed, so the new intent is blocked rather than queued');
  assert.equal(h.calls('startRun'), 2, 'one run for prepare, one after approval; none for the new task');

  // The platform finally confirms: reconcile settles the task as cancelled (nothing was dispatched).
  driver.confirmStop(runId);
  const parkedView = await h.call('task.show', { taskId: a.taskId });
  const settled = await h.call('task.reconcile', { taskId: a.taskId, expectedRevision: parkedView.revision });
  assert.equal(settled.state, 'cancelled');
  assert.equal(settled.platform?.quiescence, 'confirmed');
  assert.ok(settled.facts.some((f) => f.factKind === 'reconciliation'));
  snap = await h.snapshot();
  assert.equal(snap.inputGate, 'open');
  assert.equal(h.acts(), 0);
  await h.app.stop();
});

test('T33: recovery finds a dispatching attempt whose run ended and whose request is unknown → needs_reconciliation with both facts, no re-dispatch', async () => {
  const ledger = new InMemoryLedger();
  const driver = new FakeDriver({ principalRole: 'paired' });
  const now = () => '2026-10-08T09:00:00+08:00';
  const evidence = await ledger.putEvidence({ sha256: 'a'.repeat(64), captureTime: now(), coverage: 'current_viewport', retentionUntil: FAR });
  const account = await ledger.confirmAccount({ accountId: 'acct_seed', visibleLabel: '示例账号', evidenceIds: [evidence.evidenceId], confirmedAt: now(), status: 'confirmed' }, undefined);
  const policy = await ledger.getPolicy();
  await ledger.setPolicy({ ...policy, allowlist: ['chat_a'] }, policy.revision);
  const { task } = await ledger.intake({ operationId: 'crashed', fingerprint: 'fp', type: 'send_message', accountRevision: account.revision, payload: sendParams('crashed', account.revision).payload, payloadHash: 'ph' }, now());
  let current = task;
  for (const state of ['queued', 'preparing', 'ready', 'executing'] as const) current = await ledger.transitionTask(current.taskId, state, current.revision, now());
  const attempt = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'send', sessionId: 'ses_old', runId: 'run_old' }, now());
  await ledger.markDispatching(attempt.attemptId, { requestId: 'rq_old', canonicalDigest: 'd', snapshotId: 'snap_old', sessionId: 'ses_old', runId: 'run_old' }, now());
  driver.requests.set('rq_old', { requestId: 'rq_old', method: 'act', state: 'unknown', acceptedAt: now() });
  const endedRun: Run = {
    runId: 'run_old', kind: 'act', origin: 'agent_hub', ownership: 'external_client', lifetime: 'connection_scoped', clientId: 'app:wechat-agent', connectionId: 'conn_old',
    sessionId: 'ses_old', desktopId: 'desk_fake', phase: 'ended', outcome: 'unknown', quiescence: 'confirmed', closingReason: 'connection_lost', revision: 3, createdAt: now(), endedAt: now(), receipts: [], unknownActions: 1,
  };
  driver.runs.set('run_old', endedRun);

  const h = await makeHarness({ driver, ledger, handlers: [sendStub()] });
  await h.idle();
  const view = await h.call('task.show', { taskId: task.taskId });
  assert.equal(view.state, 'needs_reconciliation');
  assert.equal(view.stateReason, 'platform_unknown');
  assert.deepEqual(view.platform, { runId: 'run_old', requestId: 'rq_old', delivery: 'unknown', execution: 'unknown', quiescence: 'confirmed' });
  assert.equal((await ledger.getAttempt(attempt.attemptId))?.state, 'unknown');
  const fact = view.facts.find((f) => f.factKind === 'reconciliation');
  assert.ok(fact);
  assert.deepEqual((fact.data as { run: { phase: string; outcome: string } }).run.phase, 'ended');
  assert.equal(h.acts(), 0);
  assert.equal(h.calls('startRun'), 0);
  const snap = await h.snapshot();
  assert.equal(snap.counts.needsReconciliation, 1);
  assert.equal(snap.inputGate, 'open');
  // A manual conclusion is recorded as a fact; the state stays terminal.
  const concluded = await h.call('task.concludeManually', { taskId: task.taskId, expectedRevision: view.revision, conclusion: '人工核对：消息未发出', evidenceIds: [] });
  assert.equal(concluded.state, 'needs_reconciliation');
  assert.ok(concluded.facts.some((f) => f.factKind === 'manual_conclusion'));
  await h.app.stop();
});

test('recovery never reads not_found as not_sent: the task still needs reconciliation', async () => {
  const ledger = new InMemoryLedger();
  const driver = new FakeDriver({ principalRole: 'paired' });
  const now = () => '2026-10-08T09:00:00+08:00';
  const evidence = await ledger.putEvidence({ sha256: 'b'.repeat(64), captureTime: now(), coverage: 'current_viewport', retentionUntil: FAR });
  const account = await ledger.confirmAccount({ accountId: 'acct_seed', visibleLabel: '示例账号', evidenceIds: [evidence.evidenceId], confirmedAt: now(), status: 'confirmed' }, undefined);
  const { task } = await ledger.intake({ operationId: 'crashed', fingerprint: 'fp', type: 'accept_request', accountRevision: account.revision, payload: { kind: 'accept_request', requestKey: 'r1' }, payloadHash: 'ph' }, now());
  let current = task;
  for (const state of ['queued', 'preparing', 'ready', 'executing'] as const) current = await ledger.transitionTask(current.taskId, state, current.revision, now());
  const attempt = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'accept', runId: 'run_gone' }, now());
  await ledger.markDispatching(attempt.attemptId, { requestId: 'rq_gone', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run_gone' }, now());
  const h = await makeHarness({ driver, ledger, handlers: [] });
  const view = await h.call('task.show', { taskId: task.taskId });
  assert.equal(view.state, 'needs_reconciliation');
  assert.equal(view.platform?.delivery, 'unknown');
  assert.match(view.facts.find((f) => f.factKind === 'reconciliation')?.reason ?? '', /not_found/);
  assert.equal(h.acts(), 0);
  await h.app.stop();
});

test('a pause lets no late action through: a parked handler (well-behaved or not) cannot act after app.pause, and resume replays nothing', async () => {
  for (const ignoreGate of [false, true]) {
    const parked = new Gate();
    const h = await makeHarness({ handlers: [sendStub({ beforeAct: parked.wait, ignoreGate })] });
    await h.confirmAccount();
    await allowChat(h);
    const account = (await h.ledger.getAccount())!;
    const a = await h.call('task.create', sendParams('op1', account.revision));
    await waitState(h, a.taskId, 'waiting_approval');
    const waiting = await h.call('task.show', { taskId: a.taskId });
    await h.call('task.approve', { taskId: a.taskId, approvalRevision: waiting.revision, approvedContentHash: 'h:你好', expiresAt: FAR });
    await parked.reached;
    const paused = await h.call('app.pause', { operationId: 'p', expectedRevision: 0 });
    assert.equal(paused.inputGate, 'closed', 'the fake confirms quiescence at once');
    assert.equal((await h.call('task.show', { taskId: a.taskId })).state, 'cancelled');
    parked.release();
    await h.idle();
    assert.equal(h.acts(), 0, `ignoreGate=${ignoreGate}: the late action was refused`);
    assert.equal((await h.call('task.show', { taskId: a.taskId })).state, 'cancelled');
    await assert.rejects(h.call('task.create', sendParams('op2', account.revision, '乙')).then((v) => { if (v.state === 'blocked') throw new Error('blocked'); }), /blocked/);
    await h.call('app.resume', { operationId: 'r', expectedRevision: 0 });
    await h.idle();
    assert.equal(h.acts(), 0, 'resume replays nothing');
    assert.equal((await h.call('task.show', { taskId: a.taskId })).state, 'cancelled');
    await h.app.stop();
  }
});

test('a cancelled task whose handler is still in flight cannot act after app.resume (T31 late act, well-behaved or not)', async () => {
  for (const ignoreGate of [false, true]) {
    const parked = new Gate();
    const h = await makeHarness({ handlers: [sendStub({ beforeAct: parked.wait, ignoreGate })] });
    await h.confirmAccount();
    await allowChat(h);
    const account = (await h.ledger.getAccount())!;
    const a = await h.call('task.create', sendParams('op1', account.revision));
    await waitState(h, a.taskId, 'waiting_approval');
    const waiting = await h.call('task.show', { taskId: a.taskId });
    await h.call('task.approve', { taskId: a.taskId, approvalRevision: waiting.revision, approvedContentHash: 'h:你好', expiresAt: FAR });
    await parked.reached;
    const executing = await h.call('task.show', { taskId: a.taskId });
    const cancelled = await h.call('task.cancel', { taskId: a.taskId, expectedRevision: executing.revision });
    assert.equal(cancelled.state, 'cancelled', 'the fake confirms quiescence at once');
    // The gate is open again for everyone else (a cancel is not a pause); resume is a no-op here but must not help the stray handler.
    assert.equal((await h.snapshot()).inputGate, 'open');
    await h.call('app.resume', { operationId: 'r', expectedRevision: 0 });
    const b = await h.call('task.create', sendParams('op2', account.revision, '乙'));
    assert.equal(b.state, 'queued');
    parked.release();
    await h.idle();
    assert.equal(h.acts(), 0, `ignoreGate=${ignoreGate}: the cancelled task's late action was refused`);
    assert.equal((await h.call('task.show', { taskId: a.taskId })).state, 'cancelled');
    await waitState(h, b.taskId, 'waiting_approval');
    await h.app.stop();
  }
});

test('app.pause with a snapshot revision the UI did not see is a revision_conflict', async () => {
  const h = await makeHarness({ handlers: [] });
  const snap = await h.snapshot();
  await assert.rejects(h.call('app.pause', { operationId: 'p', expectedRevision: snap.revision + 100 }), expectIpc('revision_conflict'));
  const seen = await new Promise<number>((resolve) => { const off = h.app.service.subscribe((s) => { resolve(s.revision); queueMicrotask(() => off()); }); });
  await h.call('app.pause', { operationId: 'p', expectedRevision: seen });
  assert.equal((await h.snapshot()).inputGate, 'closed');
  await waitFor(() => true);
  await h.app.stop();
});
