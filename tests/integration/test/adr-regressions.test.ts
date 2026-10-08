// Platform ADR-01…10 as consumer-side regressions (方案 §12 末段). This
// repository asserts only what the WeChat Agent does with the Delegated run
// it owns; whatever the platform must guarantee is marked platform_owned and
// skipped here (the platform's own suite is the version gate).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptScript } from '../src/fixtures.ts';
import { acceptToEnd, approve, createAccept, createRead, indexOfCall, TERMINAL, waitForTask } from '../src/scenario.ts';
import { createSlice } from '../src/wiring.ts';

const PLATFORM_OWNED = (what: string) => ({ skip: `platform_owned: ${what}` });

test('ADR-01 Delegated 正常执行: the app starts a connection-scoped external run, acts inside it, and finishes it', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'confirmed');
  const run = slice.driver.runs.get(done.platform!.runId!)!;
  assert.equal(run.ownership, 'external_client');
  assert.equal(run.lifetime, 'connection_scoped');
  assert.equal(run.phase, 'ended');
  assert.equal(run.outcome, 'success');
  assert.equal(run.receipts.length, 1);
  assert.ok(indexOfCall(slice, 'startRun') < indexOfCall(slice, 'act') && indexOfCall(slice, 'act') < indexOfCall(slice, 'finishRun'));
  await slice.app.stop();
});

test('ADR-02 Hub 关页不影响: closing the event subscription leaves the control connection and the run untouched', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  await slice.app.start();
  const stream = await slice.driver.subscribe();
  await stream.close();
  assert.equal(slice.driver.state, 'connected');
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'confirmed');
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});

test('ADR-03 控制失联停止: once the control connection is lost the app sends nothing more', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  const { service } = slice.app;
  await slice.app.start();
  slice.driver.dropConnection();
  const created = await createAccept(service);
  const blocked = await waitForTask(service, created.taskId, ['blocked']);
  assert.equal(blocked.stateReason, 'disconnected');
  const read = await createRead(service);
  assert.equal((await waitForTask(service, read.taskId, ['blocked'])).stateReason, 'disconnected');
  assert.equal(slice.driver.countCalls('act'), 0);
  assert.equal(slice.driver.countCalls('observe'), 0);
  await slice.app.stop();
});

test('ADR-04 重连不恢复: after a new connection the old run is settled and a fresh run serves the next task', async () => {
  const slice = await createSlice({ facts: [...acceptScript().slice(0, 2), ...acceptScript()] });
  const { service } = slice.app;
  await slice.app.start();
  const hold = slice.recognizer.hold(2);
  const first = await createAccept(service, { operationId: 'op_a' });
  await waitForTask(service, first.taskId, ['waiting_approval']);
  const oldRun = (await service.call('task.show', { taskId: first.taskId })).platform!.runId!;
  await approve(service, first.taskId, slice.now);
  await hold.reached;
  slice.driver.dropConnection();
  hold.release();
  await waitForTask(service, first.taskId, [...TERMINAL, 'waiting_user', 'blocked']);
  await service.call('connection.check', {});
  const second = await createAccept(service, { operationId: 'op_b' });
  await waitForTask(service, second.taskId, ['waiting_approval']);
  await approve(service, second.taskId, slice.now);
  const done = await waitForTask(service, second.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed');
  assert.notEqual(done.platform?.runId, oldRun);
  assert.equal(slice.driver.countCalls('startRun'), 2);
  assert.equal(slice.driver.runs.get(oldRun)?.phase, 'ended');
  for (const { receipt } of slice.driver.acts.values()) assert.notEqual(receipt.runId, oldRun, 'no delivered action rides the old run');
  const afterReconnect = slice.driver.calls.slice(indexOfCall(slice, 'connect', 2)).filter((c) => c.method === 'act');
  assert.equal(afterReconnect.length, 1);
  assert.notEqual((afterReconnect[0].args[0] as { runId: string }).runId, oldRun);
  await slice.app.stop();
});

test('ADR-05 Durable 提升拒绝: the app never asks for platform_durable or any ownership; run.start carries only the sessionId', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  await slice.app.start();
  await acceptToEnd(slice);
  for (const call of slice.driver.calls.filter((c) => c.method === 'startRun')) {
    assert.equal(call.args.length, 1);
    assert.equal(typeof call.args[0], 'string');
  }
  const wire = JSON.stringify(slice.driver.calls);
  assert.ok(!wire.includes('platform_durable') && !wire.includes('lifetime') && !wire.includes('ownership'));
  await slice.app.stop();
});

test('ADR-05 (platform): a platform_durable request from an external client is rejected', PLATFORM_OWNED('ownership escalation is refused by the Runtime, not by this app'));

test('ADR-06 Explorer 关页继续', PLATFORM_OWNED('GUI Explorer runs are platform runs; this app has none'));

test('ADR-07 重载保留 Run: after a restart the app settles open attempts by request.show and never re-dispatches (consumer side)', async () => {
  const slice = await createSlice({ facts: acceptScript() });
  await slice.driver.connect();
  const session = await slice.driver.openSession('desk_fake');
  const run = await slice.driver.startRun(session.sessionId);
  await slice.driver.act({ sessionId: session.sessionId, runId: run.runId }, { snapshotId: 's', action: { kind: 'click', target: { imagePoint: { x: 1, y: 1 } } } }, 'rq_before_reload');
  const { task } = await slice.ledger.intake({ operationId: 'op_reload', fingerprint: 'fp', type: 'accept_request', accountRevision: 1, payload: { kind: 'accept_request', requestKey: 'k|k' }, payloadHash: 'p' }, slice.now());
  let t = task;
  for (const to of ['queued', 'preparing', 'ready', 'executing'] as const) t = await slice.ledger.transitionTask(t.taskId, to, t.revision, slice.now());
  const attempt = await slice.ledger.prepareAttempt({ taskId: t.taskId, stepId: 'accept_click', sessionId: session.sessionId, runId: run.runId }, slice.now());
  await slice.ledger.markDispatching(attempt.attemptId, { requestId: 'rq_before_reload', canonicalDigest: 'd', snapshotId: 's', sessionId: session.sessionId, runId: run.runId }, slice.now());
  await slice.app.start();
  assert.equal((await slice.app.service.call('task.show', { taskId: t.taskId })).state, 'needs_reconciliation');
  assert.equal(slice.driver.calls[indexOfCall(slice, 'showRequest')].args[0], 'rq_before_reload');
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});

test('ADR-07 (platform): the Runtime keeps the run across its own reload', PLATFORM_OWNED('run retention across Runtime reload'));

test('ADR-08 停止待静止: a stop shows stopping until the platform confirms quiescence; nothing new starts meanwhile', async () => {
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
  const snapshot = await service.call('app.getSnapshot', {});
  assert.equal(snapshot.inputGate, 'stopping');
  const next = await createRead(service);
  assert.equal((await waitForTask(service, next.taskId, ['blocked'])).stateReason, 'write_gate_closed');
  assert.equal(slice.driver.countCalls('act'), 0);
  await slice.app.stop();
});

test('ADR-09 全局停止两类 Run', PLATFORM_OWNED('global stop covers platform and external runs inside the Runtime'));

test('ADR-10 Runtime 崩溃不盲重做: a crash between dispatch and receipt leaves an unknown attempt that is queried, never redone', async () => {
  const slice = await createSlice({
    facts: acceptScript(),
    driver: { faults: [{ method: 'act', error: { code: 'runtime_offline', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] },
  });
  const { service } = slice.app;
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'needs_reconciliation');
  await service.call('connection.check', {});
  await service.call('task.reconcile', { taskId: done.taskId, expectedRevision: done.revision });
  assert.equal(slice.driver.countCalls('showRequest'), 1);
  assert.equal(slice.driver.countCalls('act'), 1);
  await slice.app.stop();
});
