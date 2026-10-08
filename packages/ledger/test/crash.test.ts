// Crash boundaries. Two kinds:
//  1. the write is cut before commit (beforeCommit throws): a reopen sees the
//     state from before the call, for every task and attempt transition;
//  2. the process is SIGKILLed after a commit, in a child: a reopen sees
//     exactly the committed state, and recovery finds the right attempts.
// T07 is the second kind at `prepared`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ATTEMPT_TRANSITIONS, TASK_TRANSITIONS } from '@wechat-agent/ports';
import type { ActionAttempt, AttemptState, Ledger, TaskIntake, TaskState } from '@wechat-agent/ports';
import { openLedger, SqliteLedger } from '../src/index.ts';
import { tmpLedgerPath } from './helpers/tmp.ts';

const T0 = '2026-10-08T10:00:00+08:00';
const T1 = '2026-10-08T10:00:01+08:00';
const intake = (over: Partial<TaskIntake> = {}): TaskIntake => ({
  operationId: 'op_1', fingerprint: 'fp_1', type: 'send_message', accountRevision: 1, targetId: 'tgt_1', targetRevision: 1,
  payload: { kind: 'send_message', conversationTargetId: 'tgt_1', content: '你好', contentHash: 'ch', contextRevision: 1 }, payloadHash: 'ph_1', ...over,
});

class CutBeforeCommit extends Error {}

/** A ledger whose next write is cut just before commit when `cut.armed` is true. */
async function openCuttable(path: string): Promise<{ ledger: SqliteLedger; cut: { armed: boolean; seen: string[] } }> {
  const cut = { armed: false, seen: [] as string[] };
  const ledger = (await openLedger(path, { faultInjection: { beforeCommit: (op) => { if (cut.armed) { cut.seen.push(op); throw new CutBeforeCommit(op); } } } })) as SqliteLedger;
  return { ledger, cut };
}

/** Walks the task state machine from `created` to `from` along the shortest path that TASK_TRANSITIONS allows. */
function pathTo(target: TaskState): TaskState[] {
  const queue: TaskState[][] = [['created']];
  const seen = new Set<TaskState>(['created']);
  while (queue.length) {
    const path = queue.shift()!;
    const last = path.at(-1)!;
    if (last === target) return path;
    for (const next of TASK_TRANSITIONS[last]) if (!seen.has(next)) { seen.add(next); queue.push([...path, next]); }
  }
  throw new Error(`${target} unreachable`);
}

async function driveTask(ledger: Ledger, taskId: string, path: TaskState[]): Promise<number> {
  let revision = 1;
  for (const state of path.slice(1)) {
    revision = (await ledger.transitionTask(taskId, state, revision, T1)).revision;
  }
  return revision;
}

test('every task transition cut before commit leaves the task, its revision and its audit untouched on reopen', async () => {
  const edges = Object.entries(TASK_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => [from as TaskState, to] as const));
  assert.ok(edges.length > 30);
  let checked = 0;
  for (const [from, to] of edges) {
    const path = tmpLedgerPath();
    const { ledger, cut } = await openCuttable(path);
    const { task } = await ledger.intake(intake(), T0);
    const revision = await driveTask(ledger, task.taskId, pathTo(from));
    const auditBefore = ledger.listAudit(task.taskId);
    cut.armed = true;
    await assert.rejects(ledger.transitionTask(task.taskId, to, revision, T1, 'cut'), CutBeforeCommit);
    assert.deepEqual(cut.seen, ['transitionTask']);
    assert.equal((await ledger.health()).writable, true, 'a cut is not a storage failure');
    await ledger.close();
    const again = (await openLedger(path)) as SqliteLedger;
    const after = await again.getTask(task.taskId);
    assert.equal(after?.state, from, `${from} → ${to}`);
    assert.equal(after?.revision, revision);
    assert.deepEqual(again.listAudit(task.taskId), auditBefore, `audit row of ${from} → ${to} must roll back with the state`);
    // The transition is still possible afterwards, with the same revision, and audit matches state.
    const done = await again.transitionTask(task.taskId, to, revision, T1, 'retry');
    assert.equal(done.revision, revision + 1);
    assert.deepEqual(again.listAudit(task.taskId).at(-1)?.to, to);
    await again.close();
    checked += 1;
  }
  assert.equal(checked, edges.length);
});

async function driveAttempt(ledger: Ledger, taskId: string, target: AttemptState): Promise<ActionAttempt> {
  let attempt = await ledger.prepareAttempt({ taskId, stepId: 'send' }, T0);
  const dispatch = { requestId: `rq_${attempt.attemptId}`, canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' };
  if (target === 'prepared') return attempt;
  attempt = await ledger.markDispatching(attempt.attemptId, dispatch, T1);
  if (target === 'dispatching') return attempt;
  if (target === 'unknown') return ledger.markUnknown(attempt.attemptId, 'disconnected', T1);
  if (target === 'not_sent') return ledger.markNotSent(attempt.attemptId, 'frame_too_large', T1);
  attempt = await ledger.recordReceipt(attempt.attemptId, 'rc', { phase: 'done' }, T1);
  if (target === 'receipt_received') return attempt;
  return ledger.markVerified(attempt.attemptId, T1);
}

async function step(ledger: Ledger, attempt: ActionAttempt, to: AttemptState): Promise<ActionAttempt> {
  if (to === 'dispatching') return ledger.markDispatching(attempt.attemptId, { requestId: 'rq_cut', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1);
  if (to === 'receipt_received') return ledger.recordReceipt(attempt.attemptId, 'rc_cut', { phase: 'done' }, T1);
  if (to === 'verified') return ledger.markVerified(attempt.attemptId, T1);
  if (to === 'not_sent') return ledger.markNotSent(attempt.attemptId, 'cut', T1);
  return ledger.markUnknown(attempt.attemptId, 'cut', T1);
}

test('every attempt transition cut before commit leaves the attempt as it was, and the requestId is not burnt', async () => {
  const edges = Object.entries(ATTEMPT_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => [from as AttemptState, to] as const));
  assert.equal(edges.length, 7);
  for (const [from, to] of edges) {
    const path = tmpLedgerPath();
    const { ledger, cut } = await openCuttable(path);
    const { task } = await ledger.intake(intake(), T0);
    const attempt = await driveAttempt(ledger, task.taskId, from);
    assert.equal(attempt.state, from);
    cut.armed = true;
    await assert.rejects(step(ledger, attempt, to), CutBeforeCommit);
    await ledger.close();
    const again = (await openLedger(path)) as SqliteLedger;
    assert.deepEqual(await again.getAttempt(attempt.attemptId), attempt, `${from} → ${to}`);
    const open = await again.findOpenAttempts();
    assert.equal(open.length, from === 'dispatching' || from === 'receipt_received' ? 1 : 0, `open attempts after cut ${from} → ${to}`);
    const done = await step(again, attempt, to);
    assert.equal(done.state, to);
    if (to === 'dispatching') assert.equal(done.requestId, 'rq_cut', 'the requestId chosen before the cut is reused, not swapped');
    await again.close();
  }
});

test('prepareAttempt, approvals, quota and intake cut before commit leave no row behind', async () => {
  const path = tmpLedgerPath();
  const { ledger, cut } = await openCuttable(path);
  const { task } = await ledger.intake(intake(), T0);
  const policy = await ledger.getPolicy();
  const approval = await ledger.recordApproval({ taskId: task.taskId, accountRevision: 1, targetRevision: 1, draftRevision: 1, contentHash: 'c1', allowedAction: 'send_message', expiresAt: '2026-10-08T11:00:00+08:00', createdAt: T0 });
  const quota = await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i1' }, policy, T0);
  assert.ok(quota.ok);
  cut.armed = true;
  await assert.rejects(ledger.intake(intake({ operationId: 'op_2', fingerprint: 'fp_2' }), T1), CutBeforeCommit);
  await assert.rejects(ledger.prepareAttempt({ taskId: task.taskId, stepId: 'send' }, T1), CutBeforeCommit);
  await assert.rejects(ledger.recordApproval({ taskId: task.taskId, accountRevision: 1, targetRevision: 1, draftRevision: 1, contentHash: 'c2', allowedAction: 'send_message', expiresAt: '2026-10-08T11:00:00+08:00', createdAt: T0 }), CutBeforeCommit);
  await assert.rejects(ledger.consumeApproval(approval.approvalId, { taskId: task.taskId, contentHash: 'c1', targetRevision: 1, accountRevision: 1 }, T1), CutBeforeCommit);
  await assert.rejects(ledger.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i2' }, policy, T1), CutBeforeCommit);
  await assert.rejects(ledger.holdQuota(quota.reservation.reservationId), CutBeforeCommit);
  await assert.rejects(ledger.importLegacySuppressions([{ key: 'k', sourceHash: 'h' }], T1), CutBeforeCommit);
  await assert.rejects(ledger.confirmAccount({ accountId: 'acct', visibleLabel: '测试', evidenceIds: [], confirmedAt: T0, status: 'confirmed' }, undefined), CutBeforeCommit);
  await ledger.close();
  const again = (await openLedger(path)) as SqliteLedger;
  assert.equal((await again.listTasks()).tasks.length, 1);
  assert.equal(again.diagnostics().rows?.attempts, 0);
  assert.equal(again.diagnostics().rows?.approvals, 1);
  assert.equal((await again.getApproval(approval.approvalId))?.consumedAt, undefined, 'the approval is still unconsumed');
  assert.equal((await again.getQuota(quota.reservation.reservationId))?.state, 'reserved');
  assert.equal(again.diagnostics().rows?.quota_reservations, 1);
  assert.equal(await again.isSuppressed('k'), false);
  assert.equal(await again.getAccount(), undefined);
  // The approval can still be consumed exactly once after the cut.
  const consumed = await again.consumeApproval(approval.approvalId, { taskId: task.taskId, contentHash: 'c1', targetRevision: 1, accountRevision: 1 }, T1);
  assert.equal(consumed.consumedAt, T1);
  // The next attempt still gets ordinal 1: the cut one never counted.
  assert.equal((await again.prepareAttempt({ taskId: task.taskId, stepId: 'send' }, T1)).attemptOrdinal, 1);
  await again.close();
});

const CHILD = fileURLToPath(new URL('./helpers/crash-child.ts', import.meta.url));

function crashChild(dbPath: string, scenario: string): { taskId: string; attemptId: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dbPath, scenario], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.signal, 'SIGKILL', `child must die by SIGKILL, got status ${result.status} signal ${result.signal}\n${result.stderr}`);
  const line = result.stdout.trim().split('\n').at(-1);
  assert.ok(line, `child printed nothing\n${result.stderr}`);
  return JSON.parse(line) as { taskId: string; attemptId: string };
}

test('T07: killed after prepareAttempt: on reopen the attempt is still prepared, has no requestId, and recovery does not list it', async () => {
  const path = tmpLedgerPath();
  const ids = crashChild(path, 'after_prepare');
  const ledger = (await openLedger(path)) as SqliteLedger;
  assert.equal((await ledger.health()).writable, true);
  const attempt = await ledger.getAttempt(ids.attemptId);
  assert.equal(attempt?.state, 'prepared');
  assert.equal(attempt?.requestId, undefined, 'nothing was ever sent, so nothing can be re-sent');
  assert.equal(attempt?.attemptOrdinal, 1);
  assert.deepEqual(await ledger.findOpenAttempts(), [], 'a prepared attempt is not an open platform action; recovery must not dispatch it');
  assert.equal((await ledger.getTask(ids.taskId))?.state, 'created');
  // The step may be retried as a new ordinal; the prepared one stays as a record.
  const retry = await ledger.prepareAttempt({ taskId: ids.taskId, stepId: 'accept' }, T1);
  assert.equal(retry.attemptOrdinal, 2);
  assert.equal((await ledger.getAttempt(ids.attemptId))?.state, 'prepared');
  await ledger.close();
});

test('killed after markDispatching: on reopen recovery finds the attempt with its requestId and the requestId cannot be reused', async () => {
  const path = tmpLedgerPath();
  const ids = crashChild(path, 'after_dispatching');
  const ledger = (await openLedger(path)) as SqliteLedger;
  const open = await ledger.findOpenAttempts();
  assert.equal(open.length, 1);
  assert.equal(open[0].attemptId, ids.attemptId);
  assert.equal(open[0].state, 'dispatching');
  assert.equal(open[0].requestId, 'rq_crash');
  assert.equal(open[0].snapshotId, 's');
  const fresh = await ledger.prepareAttempt({ taskId: ids.taskId, stepId: 'accept' }, T1);
  await assert.rejects(ledger.markDispatching(fresh.attemptId, { requestId: 'rq_crash', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1));
  // Recovery settles it as unknown (request.show happens elsewhere); it is then no longer open and cannot be re-dispatched.
  const unknown = await ledger.markUnknown(ids.attemptId, 'crashed while dispatching', T1);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.requestId, 'rq_crash');
  assert.deepEqual(await ledger.findOpenAttempts(), []);
  await assert.rejects(ledger.markDispatching(ids.attemptId, { requestId: 'rq_new', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1));
  await ledger.close();
});

test('killed after recordReceipt: on reopen the receipt is there verbatim and the attempt is still open', async () => {
  const path = tmpLedgerPath();
  const ids = crashChild(path, 'after_receipt');
  const ledger = (await openLedger(path)) as SqliteLedger;
  const open = await ledger.findOpenAttempts();
  assert.equal(open.length, 1);
  assert.equal(open[0].state, 'receipt_received');
  assert.equal(open[0].receiptId, 'rc_crash');
  assert.deepEqual(await ledger.getReceipt(ids.attemptId), { phase: 'delivered' });
  assert.equal((await ledger.markVerified(ids.attemptId, T1)).state, 'verified');
  assert.deepEqual(await ledger.findOpenAttempts(), []);
  await ledger.close();
});

test('killed after transitionTask: state, revision and audit row are all there or all absent', async () => {
  const path = tmpLedgerPath();
  const ids = crashChild(path, 'after_transition');
  const ledger = (await openLedger(path)) as SqliteLedger;
  const task = await ledger.getTask(ids.taskId);
  assert.equal(task?.state, 'queued');
  assert.equal(task?.revision, 2);
  const audit = ledger.listAudit(ids.taskId);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].from, audit[0].to, audit[0].toRevision, audit[0].reason], ['created', 'queued', 2, 'crash test']);
  await ledger.close();
});
