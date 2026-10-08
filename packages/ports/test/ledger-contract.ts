// Behaviour every Ledger implementation must show. Lane B runs this against
// SQLite: `runLedgerContract(() => openLedger(tmpfile))`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ledger, TaskIntake } from '../src/ledger.ts';
import { LedgerConflictError } from '../src/ledger.ts';
import { DEFAULT_POLICY } from '../src/fakes/ledger.ts';

const T0 = '2026-10-08T10:00:00+08:00';
const T1 = '2026-10-08T10:00:01+08:00';
const intake = (over: Partial<TaskIntake> = {}): TaskIntake => ({
  operationId: 'op_1', fingerprint: 'fp_1', type: 'accept_request', accountRevision: 1, targetId: 'tgt_1', targetRevision: 1,
  payload: { kind: 'accept_request', requestKey: '陈一|我是陈一' }, payloadHash: 'ph_1', ...over,
});

export function runLedgerContract(open: () => Promise<Ledger>): void {
  test('the same operationId with the same fingerprint returns the existing task', async () => {
    const ledger = await open();
    const first = await ledger.intake(intake(), T0);
    const again = await ledger.intake(intake(), T1);
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.task.taskId, first.task.taskId);
    await ledger.close();
  });

  test('the same operationId with a different fingerprint is a conflict', async () => {
    const ledger = await open();
    await ledger.intake(intake(), T0);
    await assert.rejects(ledger.intake(intake({ fingerprint: 'fp_2' }), T1), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'operation_fingerprint');
    await ledger.close();
  });

  test('task transitions follow the state machine and the revision', async () => {
    const ledger = await open();
    const { task } = await ledger.intake(intake(), T0);
    const queued = await ledger.transitionTask(task.taskId, 'queued', 1, T1);
    assert.equal(queued.revision, 2);
    await assert.rejects(ledger.transitionTask(task.taskId, 'confirmed', 2, T1), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'transition');
    await assert.rejects(ledger.transitionTask(task.taskId, 'preparing', 1, T1), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'revision');
    await ledger.close();
  });

  test('an approval is consumed once and only for the matching content, target and account', async () => {
    const ledger = await open();
    const { task } = await ledger.intake(intake(), T0);
    const approval = await ledger.recordApproval({ taskId: task.taskId, accountRevision: 1, targetRevision: 1, draftRevision: 1, contentHash: 'c1', allowedAction: 'accept_request', expiresAt: '2026-10-08T11:00:00+08:00', createdAt: T0 });
    const bad = { taskId: task.taskId, contentHash: 'c2', targetRevision: 1, accountRevision: 1 };
    await assert.rejects(ledger.consumeApproval(approval.approvalId, bad, T1), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'approval');
    const good = { ...bad, contentHash: 'c1' };
    const consumed = await ledger.consumeApproval(approval.approvalId, good, T1);
    assert.ok(consumed.consumedAt);
    await assert.rejects(ledger.consumeApproval(approval.approvalId, good, T1));
    await assert.rejects(ledger.consumeApproval(approval.approvalId, good, '2026-10-08T12:00:00+08:00'));
    await ledger.close();
  });

  test('an attempt keeps its requestId and is found while open', async () => {
    const ledger = await open();
    const { task } = await ledger.intake(intake(), T0);
    const attempt = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'accept' }, T0);
    assert.equal(attempt.attemptOrdinal, 1);
    assert.deepEqual(await ledger.findOpenAttempts(), []);
    const dispatching = await ledger.markDispatching(attempt.attemptId, { requestId: 'rq_1', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1);
    assert.equal(dispatching.state, 'dispatching');
    assert.equal((await ledger.findOpenAttempts()).length, 1);
    const second = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'accept' }, T1);
    await assert.rejects(ledger.markDispatching(second.attemptId, { requestId: 'rq_1', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1), (e: unknown) => e instanceof LedgerConflictError);
    const unknown = await ledger.markUnknown(attempt.attemptId, 'disconnected', T1);
    assert.equal(unknown.state, 'unknown');
    await assert.rejects(ledger.markDispatching(attempt.attemptId, { requestId: 'rq_2', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1));
    await ledger.close();
  });

  test('a proven not-sent dispatch ends the attempt without counting as open', async () => {
    const ledger = await open();
    const { task } = await ledger.intake(intake(), T0);
    const attempt = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'send' }, T0);
    await ledger.markDispatching(attempt.attemptId, { requestId: 'rq_ns', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1);
    const notSent = await ledger.markNotSent(attempt.attemptId, 'frame_too_large', T1);
    assert.equal(notSent.state, 'not_sent');
    assert.deepEqual(await ledger.findOpenAttempts(), []);
    await assert.rejects(ledger.recordReceipt(attempt.attemptId, 'r', {}, T1));
    const next = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'send' }, T1);
    assert.equal(next.attemptOrdinal, 2);
    const listed = await ledger.listAttempts(task.taskId);
    assert.deepEqual(listed.map((a) => [a.attemptOrdinal, a.state]), [[1, 'not_sent'], [2, 'prepared']]);
    assert.deepEqual(await ledger.listAttempts('task_missing'), []);
    await ledger.close();
  });

  test('quota: same intent reuses a reservation, limits block, held stays counted', async () => {
    const ledger = await open();
    const policy = { ...DEFAULT_POLICY, maxDaily: { send_friend_request: 1 } };
    const one = await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_friend_request', intentId: 'i1' }, policy, T0);
    assert.ok(one.ok);
    const same = await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_friend_request', intentId: 'i1' }, policy, T1);
    assert.ok(same.ok && same.reservation.reservationId === one.reservation.reservationId);
    const over = await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_friend_request', intentId: 'i2' }, policy, T1);
    assert.deepEqual(over, { ok: false, reason: 'daily_limit' });
    await ledger.holdQuota(one.reservation.reservationId);
    const released = await ledger.releaseQuota(one.reservation.reservationId);
    assert.equal(released.state, 'held');
    const next = await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_friend_request', intentId: 'i3' }, policy, T1);
    assert.equal(next.ok, false);
    await ledger.close();
  });

  test('approvals and receipts can be read back without consuming, and diagnostics never carry rows', async () => {
    const ledger = await open();
    const { task } = await ledger.intake(intake(), T0);
    const approval = await ledger.recordApproval({ taskId: task.taskId, accountRevision: 1, targetRevision: 1, draftRevision: 1, contentHash: 'c1', allowedAction: 'accept_request', expiresAt: '2026-10-08T11:00:00+08:00', createdAt: T0 });
    assert.equal((await ledger.getApproval(approval.approvalId))?.consumedAt, undefined);
    assert.equal(await ledger.getApproval('appr_missing'), undefined);
    const attempt = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'accept' }, T0);
    await ledger.markDispatching(attempt.attemptId, { requestId: 'rq_r', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1);
    assert.equal(await ledger.getReceipt(attempt.attemptId), undefined);
    await ledger.recordReceipt(attempt.attemptId, 'rcpt_1', { delivery: 'dispatched', execution: 'unknown' }, T1);
    assert.deepEqual(await ledger.getReceipt(attempt.attemptId), { delivery: 'dispatched', execution: 'unknown' });
    const diagnostics = await ledger.diagnostics();
    assert.equal(typeof diagnostics.writable, 'boolean');
    assert.equal(typeof diagnostics.schemaVersion, 'number');
    assert.ok(!JSON.stringify(diagnostics).includes('陈一'), 'diagnostics must not carry row contents');
    await ledger.close();
  });

  test('outbox: idempotent enqueue, atomic terminal transition, defer keeps pending, settle ends it', async () => {
    const ledger = await open();
    const { task } = await ledger.intake(intake(), T0);
    const queued = await ledger.transitionTask(task.taskId, 'queued', 1, T0);
    const draft = (t: typeof task) => ({ taskId: t.taskId, revision: t.revision, payloadHash: 'h1', payload: { kind: 'task_final', state: t.state } });
    await assert.rejects(ledger.transitionTaskWithOutbox(task.taskId, 'cancelled', 99, T1, undefined, draft), (e: unknown) => e instanceof LedgerConflictError);
    assert.deepEqual(await ledger.listOutbox(task.taskId), [], 'a refused transition leaves no event');
    const { task: ended, event } = await ledger.transitionTaskWithOutbox(task.taskId, 'cancelled', queued.revision, T1, 'test', draft);
    assert.equal(ended.state, 'cancelled');
    const again = await ledger.enqueueOutbox(draft(ended));
    assert.equal(again.eventId, event.eventId, 'same (taskId, revision, payloadHash) is one event');
    assert.equal((await ledger.listOutbox(task.taskId)).length, 1);
    assert.equal((await ledger.pendingOutbox()).some((e) => e.eventId === event.eventId), true);
    const deferred = await ledger.deferOutbox(event.eventId, '2999-01-01T00:00:00+08:00', 'sink down');
    assert.equal(deferred.state, 'pending');
    assert.equal(deferred.attempts, 1);
    const stillPending = (await ledger.pendingOutbox()).find((e) => e.eventId === event.eventId);
    assert.equal(stillPending?.retryAt, '2999-01-01T00:00:00+08:00', 'deferred events stay listed with their retryAt; the deliverer decides what is due');
    const settled = await ledger.settleOutbox(event.eventId, 'delivered', { receipt: 'r1' }, T1);
    assert.equal(settled.state, 'delivered');
    assert.equal(settled.receipt, 'r1');
    await ledger.close();
  });

  test('legacy keys become suppressions only', async () => {
    const ledger = await open();
    const added = await ledger.importLegacySuppressions([{ key: '陈一|我是陈一', sourceHash: 'h' }, { key: '陈一|我是陈一', sourceHash: 'h' }], T0);
    assert.equal(added, 1);
    assert.equal(await ledger.isSuppressed('陈一|我是陈一'), true);
    assert.equal((await ledger.listTasks()).tasks.length, 0);
    await ledger.close();
  });

  test('a new account binding bumps the revision', async () => {
    const ledger = await open();
    const first = await ledger.confirmAccount({ accountId: 'acct', visibleLabel: 'A', evidenceIds: [], confirmedAt: T0, status: 'confirmed' }, undefined);
    assert.equal(first.revision, 1);
    await assert.rejects(ledger.confirmAccount({ ...first }, 5));
    const second = await ledger.confirmAccount({ ...first, visibleLabel: 'B' }, 1);
    assert.equal(second.revision, 2);
    await ledger.close();
  });
}
