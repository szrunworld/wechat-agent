// Stage 3 of docs/plan/00-parallel-work-plan.md §5: the vertical slice and
// the key fault scenarios over the REAL stack that has merged into
// app-skeleton — lane E's application core, lane D's handlers and lane B's
// SQLite ledger — with FakeDriver (lane A's Fake Runtime server API is not
// in ports yet) and a scripted recognizer (the slice is about flows, not
// pixels). Everything is driven through the typed IPC and asserted through
// the ports, so these are Fake-level evidence: the T records in
// docs/acceptance/cases stay not_run (see docs/acceptance/README.md).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Application as RealApplication } from '@wechat-agent/app';
import { createHandlers } from '@wechat-agent/handlers';
import { openLedger } from '@wechat-agent/ledger';
import { IpcFailure } from '@wechat-agent/ports';
import type { ActionAttempt, AppSnapshot, Ledger, PageFacts, TaskView } from '@wechat-agent/ports';
import { newFriendsPage, pageFacts, requestRow } from '../src/fixtures.ts';
import { approve, createAccept, NAME, shownContentHash, TERMINAL, waitForTask } from '../src/scenario.ts';
import { createSlice, type Slice, type SliceOptions } from '../src/wiring.ts';

const tmpLedger = () => path.join(mkdtempSync(path.join(tmpdir(), 'wechat-agent-real-')), 'ledger.sqlite');

/** 新的朋友 detail pane for NAME with the accept control; `buttons` overrides it (e.g. 发消息 once added). */
function detailPage(buttons: { text: string }[] = [{ text: '接受' }]): PageFacts {
  return pageFacts({
    page: 'request_detail',
    detail: {
      name: NAME, wechatId: 'wxid_fixture_a', region: '测试', message: `你好，我是${NAME}`,
      buttons: buttons.map((b, i) => ({ text: b.text, rect: { x: 1500, y: 900 + i * 100, width: 200, height: 80 }, confidence: 0.95 })), confidence: 0.95,
    },
  });
}

/** What lane D's AcceptRequest sees: list (pending) → detail → detail again after the approval → list with the row 已添加. */
function acceptStack(): PageFacts[] {
  return [newFriendsPage([requestRow(NAME, 'pending')]), detailPage(), detailPage(), newFriendsPage([requestRow(NAME, 'added')])];
}

/** The real stack: lane E app + lane D handlers + lane B SQLite ledger on a temp file. */
async function realSlice(over: Omit<SliceOptions, 'app' | 'ledger' | 'handlers'> = {}): Promise<Slice & { ledger: Ledger }> {
  const ledger = await openLedger(tmpLedger());
  return createSlice({ app: 'real', ledger, handlers: createHandlers(), facts: acceptStack(), ...over });
}

async function teardown(slice: Slice): Promise<void> {
  await slice.app.stop();
  await slice.ledger.close();
}

const timeline = (view: { timeline: { label: string }[] }) => view.timeline.map((t) => t.label).join(' > ');

async function waitForSnapshot(slice: Slice, predicate: (s: AppSnapshot) => boolean, timeoutMs = 3000): Promise<AppSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await slice.app.service.call('app.getSnapshot', {});
    if (predicate(s)) return s;
    if (Date.now() > deadline) throw new Error(`snapshot never matched: inputGate=${s.inputGate} connection=${s.connection.state}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const byStep = (attempts: ActionAttempt[]) => Object.fromEntries(attempts.map((a) => [a.stepId, a]));

/** Lane E's dispatcher: resolves when no handler runs (a cancelled task's late continuation included). */
const idle = (slice: Slice) => (slice.app as RealApplication).internals.idle();

async function waitForView(slice: Slice, taskId: string, predicate: (v: TaskView) => boolean, timeoutMs = 3000): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await slice.app.service.call('task.show', { taskId });
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`task ${taskId} never matched; state ${view.state}; timeline: ${timeline(view)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------- 竖切 (T05 / T21 / T36)

test('real stack: task.create → waiting_approval (pendingContentHash) → task.approve → re-observe → one dangerous act → 已添加 → confirmed; attempt chain verified', async () => {
  const slice = await realSlice();
  const { service } = slice.app;
  const { ledger } = slice;
  await slice.app.start();

  const before = await service.call('app.getSnapshot', {});
  assert.equal(before.connection.state, 'ready');
  assert.equal(before.inputGate, 'open');
  assert.deepEqual(before.features.accept_request, { enabled: true });
  assert.equal(before.connection.steps.find((s) => s.key === 'baseline')?.state, 'done', 'baseline is configured off for the slice');
  assert.equal(slice.driver.countCalls('observe'), 0, 'the real app made no observation of its own before the task');

  const created = await createAccept(service, { operationId: 'op_real_slice' });
  const waiting = await waitForTask(service, created.taskId, ['waiting_approval']);
  // ports/src/ipc.ts: the app computed the hash; the UI sends exactly it back. No approval exists yet.
  assert.ok(waiting.pendingContentHash, timeline(waiting));
  assert.match(waiting.pendingContentHash!, /^[0-9a-f]{64}$/);
  assert.equal(waiting.approval, undefined);
  assert.equal(waiting.target?.displayName, NAME);
  assert.equal(waiting.target?.visibleIdentifier, 'wxid_fixture_a');
  // Only the navigation click so far: the detail pane was opened, nothing dangerous.
  assert.equal(slice.driver.countCalls('act'), 1);
  assert.equal(slice.driver.countCalls('finishRun'), 1, 'the run is released while the person decides');

  const approval = await approve(service, created.taskId, slice.now);
  assert.equal(approval.taskId, created.taskId);
  assert.equal(approval.contentHash, waiting.pendingContentHash, 'the approval records the hash the app showed');
  assert.equal(approval.allowedAction, 'accept_request');

  const done = await waitForTask(service, created.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed', timeline(done));
  assert.equal(done.approval?.approvalId, approval.approvalId);
  assert.equal(done.approval?.consumed, true, 'the approval was consumed by the dangerous click');
  assert.equal((await ledger.getApproval(approval.approvalId))?.consumedAt !== undefined, true);

  // Attempts: per run of the handler one navigation click + (second run) the accept. Every one verified, distinct requestIds.
  const attempts = await ledger.listAttempts(created.taskId);
  const accepts = attempts.filter((a) => a.stepId === 'accept');
  assert.equal(accepts.length, 1, 'exactly one dangerous attempt');
  assert.ok(attempts.every((a) => a.state === 'verified'), attempts.map((a) => `${a.stepId}:${a.state}`).join(','));
  assert.equal(new Set(attempts.map((a) => a.requestId)).size, attempts.length);
  assert.deepEqual(await ledger.findOpenAttempts(), []);
  assert.equal(slice.driver.countCalls('act'), attempts.length);
  const accept = accepts[0]!;
  assert.equal(done.platform?.requestId, accept.requestId);
  assert.ok(await ledger.getReceipt(accept.attemptId), 'the platform receipt is stored verbatim');
  const acted = slice.driver.acts.get(accept.requestId!)!;
  assert.equal(acted.receipt.receiptId, accept.receiptId);
  // The click used the re-observed detail button, after the approval, inside a run started after it (T21/T36).
  assert.deepEqual(acted.params.action, { kind: 'click', target: { imagePoint: { x: 1600, y: 940 } } });
  const acceptIndex = slice.driver.calls.findIndex((c) => c.method === 'act' && c.args[2] === accept.requestId);
  const lastStart = slice.driver.calls.map((c, i) => [c.method, i] as const).filter(([m]) => m === 'startRun').at(-1)![1];
  assert.ok(acceptIndex > lastStart, 'the dangerous act rides the run acquired after the approval');
  assert.equal(slice.driver.calls[lastStart].args.length, 1, 'run.start carries only the sessionId');
  assert.equal(slice.driver.runs.get(accept.runId!)?.phase, 'ended');
  assert.equal(slice.driver.runs.get(accept.runId!)?.outcome, 'success');

  // Facts: receipts observed; the business fact confirms; the outbox carries the result.
  const kinds = (await ledger.listFacts(created.taskId)).map((f) => `${f.factKind}:${f.outcome}`);
  assert.ok(kinds.includes('platform_receipt:observed'), kinds.join(','));
  assert.ok(kinds.includes('friend_added:confirmed'), kinds.join(','));
  assert.ok(kinds.includes('request_read:observed'));
  // The app core writes the outbox (plan §8): the final state as an event at the task's revision, delivered by the app's own loop
  // (tests/integration/test/outbox.test.ts covers the crash/retry matrix on this ledger).
  const outbox = await (ledger as Ledger & { listOutbox(taskId: string): Promise<{ revision: number; state: string; payload: Record<string, unknown> }[]> }).listOutbox(created.taskId);
  const final = outbox.find((e) => e.payload.kind === 'task_final');
  assert.ok(final, 'a task_final outbox event exists');
  assert.equal(final.revision, done.revision);
  assert.equal(final.payload.state, 'confirmed');
  assert.equal((await ledger.health()).writable, true);

  const after = await service.call('app.getSnapshot', {});
  assert.equal(after.counts.confirmed, 1);
  assert.equal(after.inputGate, 'open');
  await teardown(slice);
  assert.equal(slice.driver.countCalls('act'), attempts.length, 'stop adds no action');
});

test('real stack: a content hash the UI made up is refused; the task re-prepares and asks again for the same identity with the same hash', async () => {
  // Lane E runs the handler again from scratch after a refused (stale) approval: list → detail once more, then the approved click.
  const slice = await realSlice({ facts: [newFriendsPage([requestRow(NAME, 'pending')]), detailPage(), ...acceptStack()] });
  const { service } = slice.app;
  await slice.app.start();
  const created = await createAccept(service, { operationId: 'op_bad_hash' });
  const waiting = await waitForTask(service, created.taskId, ['waiting_approval']);
  await assert.rejects(
    service.call('task.approve', { taskId: created.taskId, approvalRevision: waiting.revision, approvedContentHash: 'f'.repeat(64), expiresAt: '2099-01-01T00:00:00+08:00' }),
    (e: unknown) => e instanceof IpcFailure && e.error.code === 'blocked' && e.error.details?.reasonCode === 'approval_invalid',
  );
  assert.equal(slice.driver.countCalls('act'), 1, 'the refusal clicks nothing');
  const again = await waitForView(slice, created.taskId, (v) => v.state === 'waiting_approval' && v.timeline.some((t) => t.label.includes('重新准备')));
  assert.equal(again.pendingContentHash, waiting.pendingContentHash, 'same identity, same content hash');
  assert.equal(again.approval, undefined);
  assert.equal(slice.driver.countCalls('act'), 2, 'the second preparation opened the detail pane again (navigation only)');
  await approve(service, created.taskId, slice.now);
  const done = await waitForTask(service, created.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed', timeline(done));
  assert.equal(slice.driver.countCalls('act'), 3);
  assert.equal((await slice.ledger.listAttempts(created.taskId)).filter((a) => a.stepId === 'accept').length, 1);
  await teardown(slice);
});

test('real stack T05: the same intent twice is one task and one accept; a changed intent under the same operationId is refused', async () => {
  const slice = await realSlice();
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
  assert.equal(done.state, 'confirmed', timeline(done));
  assert.equal((await service.call('task.list', {})).tasks.length, 1);
  const attempts = await slice.ledger.listAttempts(fromUi.taskId);
  assert.equal(attempts.filter((a) => a.stepId === 'accept').length, 1);
  // The confirmed intent is not executed again under a new operationId.
  const again = await createAccept(service, { operationId: 'op_same_again' });
  assert.equal(again.taskId, fromUi.taskId);
  await teardown(slice);
});

// ---------------------------------------------------------------- T08 派发后断连

test('real stack T08: the connection drops after the accept click → attempt unknown, needs_reconciliation after the platform settles, same requestId, never re-sent', async () => {
  const slice = await realSlice({
    driver: { faults: [{ method: 'act', onCall: 2, error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] },
  });
  const { service } = slice.app;
  const { ledger } = slice;
  await slice.app.start();
  const created = await createAccept(service, { operationId: 'op_t08' });
  await waitForTask(service, created.taskId, ['waiting_approval']);
  await approve(service, created.taskId, slice.now);

  // Lane E parks the run as stopping until the platform confirms quiescence; lane D already marked the attempt unknown.
  const parked = await waitForTask(service, created.taskId, ['stopping', ...TERMINAL]);
  const { accept } = byStep(await ledger.listAttempts(created.taskId));
  assert.ok(accept, 'the dangerous attempt was persisted before the call');
  assert.equal(accept.state, 'unknown');
  assert.ok(accept.requestId);
  assert.equal(parked.platform?.requestId, accept.requestId);
  assert.equal(parked.platform?.execution, 'unknown');
  const dropped = await waitForSnapshot(slice, (s) => s.connection.state === 'disconnected');
  assert.equal(dropped.inputGate, 'quiescence_unconfirmed');
  assert.equal(dropped.features.accept_request.enabled, false);
  assert.equal(slice.driver.countCalls('act'), 2);
  const actCall = slice.driver.calls.filter((c) => c.method === 'act').at(-1)!;
  assert.equal(actCall.args[2], accept.requestId, 'the act used the persisted requestId');
  await assert.rejects(service.call('task.reconcile', { taskId: created.taskId, expectedRevision: parked.revision }), (e: unknown) => e instanceof IpcFailure && e.error.code === 'unavailable');

  // Reconnect while the platform still reports the run as running: lane E only looks (run.show), never cancels or resumes it.
  await service.call('connection.check', {});
  assert.equal((await service.call('app.getSnapshot', {})).connection.state, 'ready');
  const stillParked = await service.call('task.show', { taskId: created.taskId });
  assert.equal(stillParked.state, 'stopping', 'no quiescence claim without the platform');
  assert.equal(slice.driver.countCalls('cancelRun'), 0);
  assert.equal(slice.driver.countCalls('act'), 2);

  // The Runtime ends a connection_scoped run when its connection dies (ADR v2.2 Delegated runs); FakeDriver leaves it
  // running, so the test plays the platform here. The next reconnect review settles the parked task.
  slice.driver.confirmQuiescence(accept.runId!);
  slice.driver.dropConnection();
  await waitForSnapshot(slice, (s) => s.connection.state === 'disconnected');
  const check = await service.call('connection.check', {});
  assert.equal(check.state, 'ready');
  const settled = await waitForTask(service, created.taskId, TERMINAL);
  assert.equal(settled.state, 'needs_reconciliation', timeline(settled));
  assert.equal(settled.stateReason, 'platform_unknown');
  assert.equal(settled.platform?.quiescence, 'confirmed', 'ended + unknown coexist (T33)');
  assert.equal((await ledger.getAttempt(accept.attemptId))?.state, 'unknown');
  const reconciled = await service.call('task.reconcile', { taskId: created.taskId, expectedRevision: settled.revision });
  assert.equal(reconciled.state, 'needs_reconciliation');
  const shown = slice.driver.calls.filter((c) => c.method === 'showRequest').map((c) => c.args[0]);
  assert.ok(shown.includes(accept.requestId), 'reconciliation queries the original requestId');
  assert.equal(slice.driver.countCalls('act'), 2, 'no re-dispatch');
  assert.equal((await ledger.listAttempts(created.taskId)).filter((a) => a.stepId === 'accept').length, 1, 'no second accept attempt');
  assert.deepEqual(await ledger.findOpenAttempts(), [], 'unknown is settled by reconciliation facts, not left open');
  // Quota for the unknown outcome stays held: the same intent is refused, not sent twice (T40).
  const again = await createAccept(service, { operationId: 'op_t08_again' });
  assert.equal(again.taskId, created.taskId, 'an unresolved intent is the same task');
  // Lane E: a drop pauses the gate; quiescence lifts the "unconfirmed" flag but only an explicit resume reopens it (nothing is replayed).
  const afterSettle = await service.call('app.getSnapshot', {});
  assert.equal(afterSettle.inputGate, 'closed', 'quiescence confirmed, still paused by the drop');
  assert.equal(afterSettle.counts.needsReconciliation, 1);
  await service.call('app.resume', { operationId: 'op_resume', expectedRevision: 0 });
  const resumed = await service.call('app.getSnapshot', {});
  assert.equal(resumed.inputGate, 'open');
  assert.equal(slice.driver.countCalls('act'), 2, 'resume replays nothing');
  assert.equal((await service.call('task.show', { taskId: created.taskId })).state, 'needs_reconciliation');
  await teardown(slice);
});

// ---------------------------------------------------------------- T31 暂停后晚到动作

test('real stack T31: pause while the handler is between re-observe and the click: the late continuation never acts (act = 1, only the earlier navigation)', async () => {
  const slice = await realSlice({ facts: [...acceptStack().slice(0, 3), newFriendsPage([requestRow(NAME, 'pending')]), detailPage()] });
  const { service } = slice.app;
  await slice.app.start();
  // recognize calls: 1 list, 2 detail (before approval), 3 fresh detail (after approval) ← held, 4 verification.
  const hold = slice.recognizer.hold(3);
  const created = await createAccept(service, { operationId: 'op_t31' });
  await waitForTask(service, created.taskId, ['waiting_approval']);
  const approval = await approve(service, created.taskId, slice.now);
  await hold.reached;
  assert.equal((await service.call('task.show', { taskId: created.taskId })).state, 'executing');
  const paused = await service.call('app.pause', { operationId: 'op_pause', expectedRevision: 0 });
  assert.equal(paused.inputGate, 'closed', 'the fake run reaches quiescence at once');
  hold.release();
  const done = await waitForTask(service, created.taskId, TERMINAL);
  assert.equal(done.state, 'cancelled', timeline(done));
  await idle(slice); // the late continuation of the handler runs to its end here
  assert.equal(slice.driver.countCalls('act'), 1, 'only the navigation click before the approval');
  assert.equal(slice.driver.countCalls('cancelRun'), 1);
  const attempts = await slice.ledger.listAttempts(created.taskId);
  assert.equal(attempts.filter((a) => a.stepId === 'accept').length, 0, 'no dangerous attempt was even prepared');
  assert.ok(attempts.every((a) => a.state === 'verified'));
  assert.equal((await service.call('task.show', { taskId: created.taskId })).state, 'cancelled', 'the late continuation cannot move a cancelled task');
  assert.equal((await service.call('app.getSnapshot', {})).inputGate, 'closed');
  assert.ok(await slice.ledger.getApproval(approval.approvalId), 'the approval row exists; whether the late continuation consumed it before its signal check is recorded, not asserted');

  // A task cancelled while waiting for approval refuses the approval that arrives late.
  await service.call('app.resume', { operationId: 'op_resume', expectedRevision: 0 });
  const second = await createAccept(service, { operationId: 'op_t31_late' });
  const waiting = await waitForTask(service, second.taskId, ['waiting_approval']);
  await service.call('task.cancel', { taskId: second.taskId, expectedRevision: waiting.revision });
  await assert.rejects(
    service.call('task.approve', { taskId: second.taskId, approvalRevision: waiting.revision, approvedContentHash: shownContentHash(waiting), expiresAt: '2099-01-01T00:00:00+08:00' }),
    (e: unknown) => e instanceof IpcFailure && (e.error.code === 'invalid_state' || e.error.code === 'revision_conflict'),
  );
  assert.equal((await waitForTask(service, second.taskId, TERMINAL)).state, 'cancelled');
  assert.equal(slice.driver.countCalls('act'), 2, 'the second task only opened its detail pane');
  await teardown(slice);
});

// ---------------------------------------------------------------- T32 取消待静止

test('real stack T32: cancel is accepted but quiescence is pending: the task stays stopping, the gate is unconfirmed, no next task starts, resume is a decision not a replay', async () => {
  const slice = await realSlice({ driver: { cancel: { quiescence: 'pending' } } });
  const { service } = slice.app;
  await slice.app.start();
  const hold = slice.recognizer.hold(3);
  const created = await createAccept(service, { operationId: 'op_t32' });
  await waitForTask(service, created.taskId, ['waiting_approval']);
  await approve(service, created.taskId, slice.now);
  await hold.reached;
  const executing = await service.call('task.show', { taskId: created.taskId });
  assert.equal(executing.state, 'executing');
  const cancelled = await service.call('task.cancel', { taskId: created.taskId, expectedRevision: executing.revision });
  assert.equal(cancelled.state, 'stopping', timeline(cancelled));
  assert.equal(cancelled.platform?.quiescence, 'pending');
  hold.release();
  await new Promise((r) => setTimeout(r, 20));
  const view = await service.call('task.show', { taskId: created.taskId });
  assert.equal(view.state, 'stopping', 'the late continuation cannot move a stopping task');
  const snapshot = await service.call('app.getSnapshot', {});
  assert.equal(snapshot.inputGate, 'quiescence_unconfirmed');
  assert.equal(snapshot.features.accept_request.enabled, false);
  assert.equal(slice.driver.countCalls('cancelRun'), 1);
  assert.equal(slice.driver.countCalls('act'), 1, 'no dangerous act');
  const next = await createAccept(service, { operationId: 'op_t32_next', requestKey: '另一人|另一人' });
  assert.equal((await waitForTask(service, next.taskId, ['blocked'])).stateReason, 'write_gate_closed', 'nothing new starts under an unconfirmed stop');
  const handback = await service.call('window.requestHandback', { operationId: 'op_hb' });
  assert.equal(handback.mode, 'manual', 'CR03: no platform handback is claimed');

  // The platform confirms quiescence later: reconcile settles the stop as cancelled (nothing dangerous was dispatched) and the gate opens.
  slice.driver.confirmQuiescence(view.platform!.runId!);
  const settled = await service.call('task.reconcile', { taskId: created.taskId, expectedRevision: view.revision });
  assert.equal(settled.state, 'cancelled', timeline(settled));
  assert.equal(settled.platform?.quiescence, 'confirmed');
  assert.equal((await service.call('app.getSnapshot', {})).inputGate, 'open');
  assert.equal(slice.driver.countCalls('act'), 1);
  await teardown(slice);
});

// ---------------------------------------------------------------- T16 审批后已添加

test('real stack T16: after the approval the re-observed detail already shows 发消息: no_op(already_friend), no click, approval unconsumed, quota released', async () => {
  const slice = await realSlice({ facts: [newFriendsPage([requestRow(NAME, 'pending')]), detailPage(), detailPage([{ text: '发消息' }])] });
  const { service } = slice.app;
  await slice.app.start();
  const created = await createAccept(service, { operationId: 'op_t16' });
  await waitForTask(service, created.taskId, ['waiting_approval']);
  const approval = await approve(service, created.taskId, slice.now);
  const done = await waitForTask(service, created.taskId, TERMINAL);
  assert.equal(done.state, 'no_op', timeline(done));
  assert.equal(done.stateReason, 'already_friend');
  assert.equal(slice.driver.countCalls('act'), 1, 'only the navigation click');
  const attempts = await slice.ledger.listAttempts(created.taskId);
  assert.equal(attempts.filter((a) => a.stepId === 'accept').length, 0);
  assert.equal((await slice.ledger.getApproval(approval.approvalId))?.consumedAt, undefined, 'an unused approval is not consumed');
  assert.ok(!(await slice.ledger.listFacts(created.taskId)).some((f) => f.factKind === 'friend_added'), 'no business fact claims we added anyone');
  await teardown(slice);
});

test('real stack T16: the row is 已添加 when the list is re-observed after the approval: no_op, no click', async () => {
  const slice = await realSlice({ facts: [newFriendsPage([requestRow(NAME, 'pending')]), detailPage(), newFriendsPage([requestRow(NAME, 'added')])] });
  await slice.app.start();
  const created = await createAccept(slice.app.service, { operationId: 'op_t16b' });
  await waitForTask(slice.app.service, created.taskId, ['waiting_approval']);
  await approve(slice.app.service, created.taskId, slice.now);
  const done = await waitForTask(slice.app.service, created.taskId, TERMINAL);
  assert.equal(done.state, 'no_op', timeline(done));
  assert.equal(done.stateReason, 'already_friend');
  assert.equal(slice.driver.countCalls('act'), 1);
  await teardown(slice);
});

// ---------------------------------------------------------------- baseline: the mismatch that blocked stage 3

test('real stack: with baseline on, the app reads 新的朋友 once at connect through lane D before any task, and the task script starts after it', async () => {
  const slice = await realSlice({ appConfig: { baselineOnConnect: true }, facts: [newFriendsPage([requestRow(NAME, 'pending')], 'end_confirmed'), ...acceptStack()] });
  const { service } = slice.app;
  await slice.app.start();
  const snapshot = await waitForSnapshot(slice, (s) => s.connection.steps.find((st) => st.key === 'baseline')?.state === 'done');
  assert.equal(snapshot.connection.steps.find((st) => st.key === 'baseline')?.detail, '基线读取完成');
  const baseline = (await slice.ledger.listTasks({ types: ['read_requests'] })).tasks;
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0]!.state, 'confirmed');
  assert.equal(slice.driver.countCalls('act'), 0, 'the baseline is read-only');
  assert.equal(snapshot.patrol.coverage, 'end_confirmed');
  const created = await createAccept(service, { operationId: 'op_after_baseline' });
  await waitForTask(service, created.taskId, ['waiting_approval']);
  await approve(service, created.taskId, slice.now);
  assert.equal((await waitForTask(service, created.taskId, TERMINAL)).state, 'confirmed');
  await teardown(slice);
});
