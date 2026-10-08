// Connection, pairing and disconnect behaviour: T01, T03, T34, and the
// dedicated "a reconnect never resumes an old Run" test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeDriver } from '@wechat-agent/ports/fakes';
import { acceptStub, expectIpc, Gate, makeHarness, readStub, sendStub, waitFor, waitState } from './harness.ts';

const sendParams = (operationId: string, accountRevision: number, content = '你好', contextRevision = 1) => ({
  operationId, type: 'send_message' as const, expectedAccountRevision: accountRevision,
  payload: { kind: 'send_message' as const, conversationTargetId: 'chat_a', content, contentHash: `h:${content}`, contextRevision },
});

test('T01: platform unreachable → connection page, every feature platform_offline, act=0', async () => {
  const driver = new FakeDriver({ principalRole: 'paired', faults: [{ method: 'connect', error: { code: 'runtime_offline', phase: 'connect', retryable: true, notSent: true } }] });
  const h = await makeHarness({ driver, handlers: [readStub(() => []), acceptStub(), sendStub()] });
  const snap = await h.snapshot();
  assert.equal(snap.connection.state, 'disconnected');
  assert.equal(snap.connection.steps.find((s) => s.key === 'discover')?.state, 'failed');
  assert.match(snap.connection.steps.find((s) => s.key === 'discover')?.detail ?? '', /AgentDesktop/);
  for (const feature of Object.values(snap.features)) assert.deepEqual(feature, { enabled: false, reason: 'platform_offline', detail: 'AgentDesktop 不可达' });
  assert.equal(snap.account, null);
  assert.equal(snap.inputGate, 'closed');
  // No account can be confirmed while offline; a task cannot even be created, and nothing was ever sent.
  await assert.rejects(h.call('task.create', sendParams('op1', 0)), expectIpc('blocked'));
  assert.equal(h.acts(), 0);
  // The backoff timer exists and only observes: flushing it reconnects (second connect succeeds), still act=0.
  assert.equal(h.scheduler.size, 1);
  h.scheduler.flush();
  await waitFor(() => h.app.internals.connector.ready, 'reconnect');
  assert.equal((await h.snapshot()).connection.state, 'ready');
  assert.equal(h.acts(), 0);
  await h.app.stop();
});

test('T03: unpaired principal → outbound features pairing_missing, tasks blocked, act=0; reading still works', async () => {
  const driver = new FakeDriver({ principalRole: 'owner' });
  const h = await makeHarness({ driver, handlers: [readStub(() => [{ rowKey: 'r1', status: 'pending', name: '陈一' }]), acceptStub(), sendStub()] });
  let snap = await h.snapshot();
  assert.equal(snap.connection.state, 'unpaired');
  assert.equal(snap.connection.principal?.role, 'owner');
  assert.equal(snap.connection.steps.find((s) => s.key === 'pairing')?.state, 'blocked');
  await h.confirmAccount();
  snap = await h.snapshot();
  assert.equal(snap.account?.status, 'confirmed');
  assert.deepEqual(snap.features.read_list, { enabled: true });
  for (const key of ['accept_request', 'send_message'] as const) {
    assert.equal(snap.features[key].enabled, false);
    assert.equal((snap.features[key] as { reason: string }).reason, 'pairing_missing');
  }
  const policy = await h.ledger.getPolicy();
  await h.ledger.setPolicy({ ...policy, allowlist: ['chat_a'] }, policy.revision);
  const view = await h.call('task.create', sendParams('op-send', snap.account!.revision));
  assert.equal(view.state, 'blocked');
  assert.equal(view.stateReason, 'pairing_missing');
  const accept = await h.call('task.create', { operationId: 'op-accept', type: 'accept_request', expectedAccountRevision: snap.account!.revision, payload: { kind: 'accept_request', requestKey: 'r1' } });
  assert.equal(accept.state, 'blocked');
  assert.equal(accept.stateReason, 'pairing_missing');
  // A read-only task runs to completion through the platform without any act.
  const read = await h.call('task.create', { operationId: 'op-read', type: 'read_requests', expectedAccountRevision: snap.account!.revision, payload: { kind: 'read_requests' } });
  await waitState(h, read.taskId, 'confirmed');
  assert.ok(h.calls('observe') >= 1);
  assert.equal(h.acts(), 0);
  await h.app.stop();
});

test('T34: a drop mid-run closes the gate, blocks input, parks the run; reconnect never resumes it', async () => {
  const driver = new FakeDriver({ principalRole: 'paired', faults: [{ method: 'act', error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] });
  const h = await makeHarness({ driver, handlers: [readStub(() => []), sendStub()] });
  await h.confirmAccount();
  const policy = await h.ledger.getPolicy();
  await h.ledger.setPolicy({ ...policy, allowlist: ['chat_a'] }, policy.revision);
  const account = (await h.ledger.getAccount())!;
  const view = await h.call('task.create', sendParams('op1', account.revision));
  await waitState(h, view.taskId, 'waiting_approval');
  const waiting = await h.call('task.show', { taskId: view.taskId });
  await h.call('task.approve', { taskId: view.taskId, approvalRevision: waiting.revision, approvedContentHash: 'h:你好', expiresAt: '2099-01-01T00:00:00+08:00' });
  await waitState(h, view.taskId, 'stopping');
  await h.idle();
  const oldRunId = h.app.internals.dispatcher.runtimes.get(view.taskId)!.runId!;
  assert.equal(h.acts(), 1, 'the one act that was cut off');

  let snap = await h.snapshot();
  assert.equal(snap.connection.state, 'disconnected');
  assert.equal(snap.inputGate, 'quiescence_unconfirmed');
  assert.equal(snap.activeTask?.taskId, view.taskId);
  assert.equal(snap.activeTask?.state, 'stopping');
  assert.equal(snap.activeTask?.platform?.quiescence, 'not_confirmed');
  for (const feature of Object.values(snap.features)) assert.equal(feature.enabled, false);
  // Input is blocked while disconnected: a new intent is recorded but blocked, nothing runs.
  const blocked = await h.call('task.create', sendParams('op2', account.revision, '第二条'));
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.stateReason, 'disconnected');
  await assert.rejects(h.call('app.resume', { operationId: 'r1', expectedRevision: 0 }), expectIpc('blocked'));

  // Backoff reconnect (observation only).
  const callsBefore = driver.calls.length;
  h.scheduler.flush();
  await waitFor(() => h.app.internals.connector.ready, 'reconnect');
  await h.idle();
  const after = driver.calls.slice(callsBefore);
  assert.equal(after.filter((c) => c.method === 'act').length, 0, 'no act after reconnect');
  assert.equal(after.filter((c) => c.method === 'startRun').length, 0, 'no run started by the reconnect');
  assert.equal(after.filter((c) => c.method === 'waitRun').length, 0, 'no waiting on the old run');
  assert.ok(after.some((c) => c.method === 'showRun' && c.args[0] === oldRunId), 'the old run is only looked at');
  assert.ok(after.some((c) => c.method === 'capabilities'), 'preflight ran again');
  // The fake never ends the old run by itself, so the parked task stays stopping: the reconnect did not touch it.
  let parked = await h.call('task.show', { taskId: view.taskId });
  assert.equal(parked.state, 'stopping');
  assert.equal(parked.platform?.runId, oldRunId);

  snap = await h.snapshot();
  assert.equal(snap.connection.state, 'ready');
  assert.equal(snap.inputGate, 'quiescence_unconfirmed', 'stays unconfirmed until an explicit resume');
  assert.equal((snap.features.send_message as { reason: string }).reason, 'input_gate_closed');
  await h.call('app.resume', { operationId: 'r2', expectedRevision: 0 });
  assert.equal((await h.snapshot()).inputGate, 'open');
  assert.equal(h.acts(), 1, 'resume replays nothing');
  // Resume gives the old run up as unknown (an act was dispatched with notSent=false): never not_sent, never re-sent.
  parked = await h.call('task.show', { taskId: view.taskId });
  assert.equal(parked.state, 'needs_reconciliation');
  assert.equal(parked.stateReason, 'platform_unknown');
  assert.equal(parked.platform?.requestId, [...driver.calls.filter((c) => c.method === 'act')][0]!.args[2]);

  // A new task goes through preflight and a fresh run.
  const next = await h.call('task.create', sendParams('op3', account.revision, '第三条'));
  await waitState(h, next.taskId, 'waiting_approval');
  const rt = h.app.internals.dispatcher.runtimes.get(next.taskId)!;
  assert.notEqual(rt.runId, oldRunId);
  await h.app.stop();
});

test('a reconnect never resumes an old Run: a drop before the write leaves act=0, no run.start/run.wait/act after reconnect, resume gives the run up', async () => {
  const driver = new FakeDriver({ principalRole: 'paired' });
  const parked = new Gate();
  const h = await makeHarness({ driver, handlers: [sendStub({ beforeAct: parked.wait })] });
  await h.confirmAccount();
  const policy = await h.ledger.getPolicy();
  await h.ledger.setPolicy({ ...policy, allowlist: ['chat_a'] }, policy.revision);
  const account = (await h.ledger.getAccount())!;
  const view = await h.call('task.create', sendParams('op1', account.revision));
  await waitState(h, view.taskId, 'waiting_approval');
  const waiting = await h.call('task.show', { taskId: view.taskId });
  await h.call('task.approve', { taskId: view.taskId, approvalRevision: waiting.revision, approvedContentHash: 'h:你好', expiresAt: '2099-01-01T00:00:00+08:00' });
  await parked.reached;
  const runId = h.app.internals.dispatcher.runtimes.get(view.taskId)!.runId!;
  // The platform drops while the handler is parked before its write.
  driver.dropConnection();
  h.app.internals.connector.noteDisconnected('connection_lost');
  parked.release();
  await h.idle();
  assert.equal((await h.ledger.getTask(view.taskId))?.state, 'stopping');
  assert.equal(h.acts(), 0, 'the write after the drop was refused by the gate');

  const before = driver.calls.length;
  h.scheduler.flush();
  await waitFor(() => h.app.internals.connector.ready, 'reconnect');
  await h.idle();
  const after = driver.calls.slice(before);
  assert.equal(after.filter((c) => c.method === 'act').length, 0);
  assert.equal(after.filter((c) => c.method === 'startRun').length, 0);
  assert.equal(after.filter((c) => c.method === 'waitRun').length, 0);
  const task = await h.call('task.show', { taskId: view.taskId });
  // Nothing was dispatched and the fake's run is still "running" (it was never ended): the task stays parked until resume gives it up.
  assert.equal(task.state, 'stopping');
  await h.call('app.resume', { operationId: 'r', expectedRevision: 0 });
  const settled = await h.call('task.show', { taskId: view.taskId });
  assert.equal(settled.state, 'needs_reconciliation');
  assert.equal(settled.platform?.runId, runId);
  assert.equal(h.acts(), 0);
  await h.app.stop();
});
