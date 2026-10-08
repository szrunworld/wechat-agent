// Lane B unit assertions beyond the shared contract: T05, T38, T39, T40,
// durability across reopen, file permissions, paging, round trips.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { LedgerConflictError, LedgerUnavailableError } from '@wechat-agent/ports';
import type { Policy, TaskIntake } from '@wechat-agent/ports';
import { openLedger, SqliteLedger, SUPPORTED_SCHEMA_VERSION, peekSchemaVersion } from '../src/index.ts';
import { tmpLedgerPath } from './helpers/tmp.ts';

const T0 = '2026-10-08T10:00:00+08:00';
const T1 = '2026-10-08T10:00:01+08:00';
const intake = (over: Partial<TaskIntake> = {}): TaskIntake => ({
  operationId: 'op_1', fingerprint: 'fp_1', type: 'accept_request', accountRevision: 1, targetId: 'tgt_1', targetRevision: 1,
  payload: { kind: 'accept_request', requestKey: '李四|我是李四' }, payloadHash: 'ph_1', ...over,
});

async function open(path = tmpLedgerPath()): Promise<SqliteLedger> {
  return (await openLedger(path)) as SqliteLedger;
}

test('T05: one intent is one task, also when two connections race on the same operationId', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  const b = await open(path);
  const results = await Promise.all([a.intake(intake(), T0), b.intake(intake(), T1), a.intake(intake(), T1)]);
  const ids = new Set(results.map((r) => r.task.taskId));
  assert.equal(ids.size, 1, 'the same operationId never yields two tasks');
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal((await b.listTasks()).tasks.length, 1);
  // A different intent under the same operationId is refused, on either connection.
  await assert.rejects(b.intake(intake({ fingerprint: 'fp_other' }), T1), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'operation_fingerprint');
  await a.close();
  await b.close();
});

test('T05: the unique index on operationId holds in the file, not only in memory', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  const { task } = await a.intake(intake(), T0);
  await a.close();
  const b = await open(path);
  const again = await b.intake(intake(), T1);
  assert.equal(again.created, false);
  assert.equal(again.task.taskId, task.taskId);
  assert.deepEqual(again.task.payload, { kind: 'accept_request', requestKey: '李四|我是李四' });
  await b.close();
});

test('tasks, audit, approvals, attempts, facts, evidence and outbox survive a reopen unchanged', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  const { task } = await a.intake(intake(), T0);
  const queued = await a.transitionTask(task.taskId, 'queued', 1, T1, 'ui');
  const approval = await a.recordApproval({ taskId: task.taskId, accountRevision: 1, targetRevision: 1, draftRevision: 1, contentHash: 'c1', allowedAction: 'accept_request', expiresAt: '2026-10-08T11:00:00+08:00', createdAt: T0 });
  const attempt = await a.prepareAttempt({ taskId: task.taskId, stepId: 'accept', sessionId: 'ses', runId: 'run' }, T0);
  const dispatching = await a.markDispatching(attempt.attemptId, { requestId: 'rq_1', canonicalDigest: 'dg', snapshotId: 'snap', sessionId: 'ses', runId: 'run' }, T1);
  const receipt = await a.recordReceipt(attempt.attemptId, 'rc_1', { delivery: 'delivered', phase: 'done' }, T1);
  const evidence = await a.putEvidence({ artifactId: 'art', localPath: '/x/y.png', sha256: 'abc', captureTime: T0, coverage: 'current_viewport', crop: { x: 1, y: 2, width: 3, height: 4 }, retentionUntil: '2026-11-08T00:00:00+08:00' });
  const fact = await a.appendFact({ taskId: task.taskId, factKind: 'request_status', outcome: 'observed', evidenceIds: [evidence.evidenceId], observedAt: T1, confidence: 0.9, reason: 'seen', data: { status: '已添加' } });
  const event = await a.enqueueOutbox({ taskId: task.taskId, revision: 2, payloadHash: 'ph', payload: { state: 'queued' } });
  await a.close();

  const b = await open(path);
  assert.deepEqual(await b.getTask(task.taskId), queued);
  assert.deepEqual(b.listAudit(task.taskId).map((r) => [r.from, r.to, r.fromRevision, r.toRevision, r.reason]), [['created', 'queued', 1, 2, 'ui']]);
  assert.deepEqual(await b.getApproval(approval.approvalId), approval);
  assert.deepEqual(await b.getAttempt(attempt.attemptId), receipt);
  assert.equal(dispatching.requestId, 'rq_1');
  assert.deepEqual(await b.getReceipt(attempt.attemptId), { delivery: 'delivered', phase: 'done' });
  assert.deepEqual(await b.getEvidence(evidence.evidenceId), evidence);
  assert.deepEqual(await b.listFacts(task.taskId), [fact]);
  assert.deepEqual(await b.pendingOutbox(), [event]);
  const failed = await b.markOutbox(event.eventId, 'failed', T1);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retryAt, T1);
  assert.deepEqual(await b.pendingOutbox(), []);
  await b.close();
});

test('listTasks pages in creation order and filters by state and type', async () => {
  const ledger = await open();
  for (let i = 0; i < 5; i += 1) await ledger.intake(intake({ operationId: `op_${i}`, fingerprint: `fp_${i}`, type: i % 2 ? 'add_friend' : 'accept_request' }), `2026-10-08T10:00:0${i}+08:00`);
  const first = await ledger.listTasks({ limit: 2 });
  assert.equal(first.tasks.length, 2);
  assert.equal(first.next, '2');
  const second = await ledger.listTasks({ limit: 2, cursor: first.next });
  assert.deepEqual(second.tasks.map((t) => t.operationId), ['op_2', 'op_3']);
  const last = await ledger.listTasks({ limit: 2, cursor: second.next });
  assert.deepEqual(last.tasks.map((t) => t.operationId), ['op_4']);
  assert.equal(last.next, undefined);
  assert.equal((await ledger.listTasks({ types: ['add_friend'] })).tasks.length, 2);
  await ledger.transitionTask(first.tasks[0].taskId, 'cancelled', 1, T1);
  assert.deepEqual((await ledger.listTasks({ states: ['cancelled'] })).tasks.map((t) => t.operationId), ['op_0']);
  await ledger.close();
});

test('policy: default on first open, set with the expected revision, kept across reopen', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  const initial = await a.getPolicy();
  assert.equal(initial.revision, 1);
  assert.equal(initial.timezone, 'Asia/Shanghai');
  await assert.rejects(a.setPolicy({ ...initial, maxDaily: { send_message: 3 } }, 7), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'revision');
  const next = await a.setPolicy({ ...initial, maxDaily: { send_message: 3 } }, 1);
  assert.equal(next.revision, 2);
  await a.close();
  const b = await open(path);
  assert.deepEqual(await b.getPolicy(), next);
  await b.close();
});

test('account binding is kept across reopen and the old revision stops matching', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  assert.equal(await a.getAccount(), undefined);
  const first = await a.confirmAccount({ accountId: 'acct', visibleLabel: '测试账号甲', evidenceIds: ['ev1'], confirmedAt: T0, status: 'confirmed' }, undefined);
  await a.close();
  const b = await open(path);
  assert.deepEqual(await b.getAccount(), first);
  await assert.rejects(b.confirmAccount({ ...first, visibleLabel: '测试账号乙' }, undefined), (e: unknown) => e instanceof LedgerConflictError && e.kind === 'revision');
  const second = await b.confirmAccount({ ...first, visibleLabel: '测试账号乙' }, 1);
  assert.equal(second.revision, 2);
  await b.close();
});

test('the ledger file is 0600 and a directory it creates is 0700', async () => {
  const path = tmpLedgerPath();
  const ledger = await open(path);
  await ledger.intake(intake(), T0);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) assert.equal(statSync(path + suffix).mode & 0o777, 0o600, suffix);
  await ledger.close();
});

test('T38: a real SQLITE_FULL stops all later writes, health says so, reads still work, diagnostics are exported', async () => {
  const path = tmpLedgerPath();
  const warm = await open(path);
  const { task } = await warm.intake(intake(), T0);
  await warm.close();
  // Cap the file at its current size: the next insert that needs a page gets SQLITE_FULL.
  const ledger = (await openLedger(path, { faultInjection: { maxPageCount: 3 } })) as SqliteLedger;
  assert.equal((await ledger.health()).writable, true);
  let failed = false;
  for (let i = 0; i < 200 && !failed; i += 1) {
    try {
      await ledger.putEvidence({ sha256: 'x'.repeat(2000), captureTime: T0, coverage: 'current_viewport', retentionUntil: T1 });
    } catch (error) {
      assert.ok(error instanceof LedgerUnavailableError, String(error));
      assert.equal(error.reason, 'disk_full');
      failed = true;
    }
  }
  assert.ok(failed, 'the capped file must fill up');
  const health = await ledger.health();
  assert.equal(health.writable, false);
  assert.equal(health.reason, 'disk_full');
  // Every later write is refused up front, with the same reason, including ones that would fit.
  await assert.rejects(ledger.intake(intake({ operationId: 'op_2', fingerprint: 'fp_2' }), T1), (e: unknown) => e instanceof LedgerUnavailableError && e.reason === 'disk_full');
  await assert.rejects(ledger.transitionTask(task.taskId, 'queued', 1, T1), LedgerUnavailableError);
  await assert.rejects(ledger.importLegacySuppressions([{ key: 'k', sourceHash: 'h' }], T1), LedgerUnavailableError);
  // Reads keep answering from the committed state.
  assert.equal((await ledger.getTask(task.taskId))?.state, 'created');
  const diagnostics = ledger.diagnostics();
  assert.equal(diagnostics.writable, false);
  assert.equal(diagnostics.lastError?.code, 'SQLITE_FULL');
  assert.equal(diagnostics.lastError?.operation, 'putEvidence');
  assert.equal(diagnostics.quickCheck, 'ok');
  const exported = JSON.parse(readFileSync(`${path}.diagnostics.json`, 'utf8'));
  assert.equal(exported.reason, 'disk_full');
  assert.equal(statSync(`${path}.diagnostics.json`).mode & 0o777, 0o600);
  await ledger.close();
  // The failed transaction left nothing half-written: a fresh open sees the task and no torn evidence row count.
  const again = await open(path);
  assert.equal((await again.health()).writable, true);
  assert.equal((await again.getTask(task.taskId))?.state, 'created');
  await again.close();
});

test('T38: a file that is not a database is refused, never replaced by an empty one', async () => {
  const path = tmpLedgerPath();
  const ledger = await open(path);
  await ledger.close();
  writeFileSync(path, 'this is not sqlite, it is a corrupt file with some length to it..........................');
  const before = readFileSync(path);
  await assert.rejects(openLedger(path), (e: unknown) => e instanceof LedgerUnavailableError && /corrupt|not a database/i.test(e.reason));
  assert.deepEqual(readFileSync(path), before, 'the corrupt file is left for diagnosis');
  // A LedgerConflictError-free programmer error (not SQLite) does not trip the write stop.
  const fresh = await open();
  await assert.rejects(fresh.listTasks({ cursor: 'nope' }), LedgerConflictError);
  assert.equal((await fresh.health()).writable, true);
  await fresh.close();
});

test('T38: an unwritable file is refused at open instead of silently starting over', async () => {
  const path = tmpLedgerPath();
  const ledger = await open(path);
  await ledger.intake(intake(), T0);
  await ledger.close();
  chmodSync(dirname(path), 0o500);
  try {
    // The directory is read-only, so the WAL cannot be created: open must fail and leave the file alone.
    const result = await openLedger(path).then(() => 'opened', (e: unknown) => e);
    if (result === 'opened') {
      // Root or a lenient FS: nothing to assert about refusal, but the data must be intact.
      const again = await open(path);
      assert.equal((await again.listTasks()).tasks.length, 1);
      await again.close();
    } else {
      assert.ok(result instanceof LedgerUnavailableError, String(result));
    }
  } finally {
    chmodSync(dirname(path), 0o700);
  }
  const again = await open(path);
  assert.equal((await again.listTasks()).tasks.length, 1);
  await again.close();
});

test('T39: a file from a newer schema is refused, and the refusal does not touch it', async () => {
  const path = tmpLedgerPath();
  const ledger = await open(path);
  await ledger.intake(intake(), T0);
  await ledger.close();
  const future = [
    ...(await import('../src/migrations.ts')).MIGRATIONS,
    { version: SUPPORTED_SCHEMA_VERSION + 1, name: 'future_table', sql: 'CREATE TABLE future (x INTEGER);' },
  ];
  const upgraded = (await openLedger(path, { migrations: future })) as SqliteLedger;
  assert.equal((await upgraded.health()).schemaVersion, SUPPORTED_SCHEMA_VERSION + 1);
  await upgraded.close();
  const sizeBefore = statSync(path).size;
  await assert.rejects(openLedger(path), (e: unknown) => e instanceof LedgerUnavailableError && e.reason.startsWith('newer_schema'));
  assert.equal(peekSchemaVersion(path), SUPPORTED_SCHEMA_VERSION + 1);
  assert.equal(statSync(path).size, sizeBefore);
  // Same version, different migration name: refused as a mismatch, not migrated over.
  const renamed = future.map((m, i) => (i === 0 ? { ...m, name: 'something_else' } : m));
  await assert.rejects(openLedger(path, { migrations: renamed }), (e: unknown) => e instanceof LedgerUnavailableError && e.reason.startsWith('migration_mismatch'));
  await assert.rejects(openLedger(path, { migrations: future.slice(0, 1).concat({ version: 2, name: 'gap', sql: '' }, { version: 4, name: 'gap2', sql: '' }) }), LedgerUnavailableError);
  await assert.rejects(openLedger(path, { migrations: future.map((m) => ({ ...m, version: m.version + 1 })) }), LedgerUnavailableError);
});

test('T39: migrations are recorded one per transaction and a reopen applies none again', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  assert.equal((await a.health()).schemaVersion, SUPPORTED_SCHEMA_VERSION);
  assert.equal(a.diagnostics().rows?.policy, 1);
  await a.close();
  const b = await open(path);
  assert.equal((await b.health()).schemaVersion, SUPPORTED_SCHEMA_VERSION);
  assert.equal(peekSchemaVersion(path), SUPPORTED_SCHEMA_VERSION);
  await b.close();
});

test('T39: legacy handled keys become suppressions only: no task, no success, kept across reopen', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  const added = await a.importLegacySuppressions([{ key: '王五|我是王五', sourceHash: 'h1' }, { key: '赵六|你好', sourceHash: 'h1' }], T0);
  assert.equal(added, 2);
  assert.equal(await a.importLegacySuppressions([{ key: '王五|我是王五', sourceHash: 'h2' }], T1), 0, 'an existing key is not rewritten');
  await a.close();
  const b = await open(path);
  assert.equal(await b.isSuppressed('王五|我是王五'), true);
  assert.equal(await b.isSuppressed('赵六|你好'), true);
  assert.equal(await b.isSuppressed('钱七|我是钱七'), false);
  assert.deepEqual(await b.listTasks(), { tasks: [], next: undefined });
  assert.deepEqual(await b.findOpenAttempts(), []);
  assert.equal(b.diagnostics().rows?.facts, 0, 'no success fact is implied');
  await b.close();
});

test('T40: quota rolls over at local midnight in the policy timezone, not UTC', async () => {
  const ledger = await open();
  const policy: Policy = { ...(await ledger.getPolicy()), maxDaily: { send_friend_request: 1 } };
  const lateEvening = '2026-10-08T23:59:00+08:00';
  const nextMorning = '2026-10-09T00:01:00+08:00'; // 2026-10-08T16:01Z: still the 8th in UTC
  const one = await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_friend_request', intentId: 'i1' }, policy, lateEvening);
  assert.ok(one.ok && one.reservation.policyDay === '2026-10-08');
  assert.deepEqual(await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_friend_request', intentId: 'i2' }, policy, lateEvening), { ok: false, reason: 'daily_limit' });
  const two = await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_friend_request', intentId: 'i2' }, policy, nextMorning);
  assert.ok(two.ok && two.reservation.policyDay === '2026-10-09');
  // Another account and another action kind have their own counters.
  assert.ok((await ledger.reserveQuota({ accountId: 'b', actionKind: 'send_friend_request', intentId: 'i3' }, policy, lateEvening)).ok);
  assert.ok((await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i4' }, policy, lateEvening)).ok);
  await ledger.close();
});

test('T40: outside active hours, min interval and disallowed actions are refused with their reason', async () => {
  const ledger = await open();
  const base = await ledger.getPolicy();
  const hours: Policy = { ...base, activeHours: [{ start: '09:00', end: '18:00' }] };
  assert.deepEqual(await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i1' }, hours, '2026-10-08T20:00:00+08:00'), { ok: false, reason: 'outside_hours' });
  assert.ok((await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i1' }, hours, '2026-10-08T12:00:00+08:00')).ok);
  const interval: Policy = { ...base, minIntervalSeconds: 60 };
  assert.deepEqual(await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i2' }, interval, '2026-10-08T12:00:30+08:00'), { ok: false, reason: 'min_interval' });
  assert.ok((await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i2' }, interval, '2026-10-08T12:01:00+08:00')).ok);
  const narrow: Policy = { ...base, allowedActions: ['read'] };
  assert.deepEqual(await ledger.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i3' }, narrow, T0), { ok: false, reason: 'action_not_allowed' });
  await ledger.close();
});

test('T40: concurrent reservations from two connections never exceed the daily limit', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  const b = await open(path);
  const policy: Policy = { ...(await a.getPolicy()), maxDaily: { send_friend_request: 3 } };
  const attempts = Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).reserveQuota({ accountId: 'a', actionKind: 'send_friend_request', intentId: `i${i}` }, policy, T0));
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(results.filter((r) => !r.ok && r.reason === 'daily_limit').length, 7);
  // The same intent from both connections at once is one reservation.
  const same = await Promise.all([a.reserveQuota({ accountId: 'c', actionKind: 'send_message', intentId: 'dup' }, policy, T0), b.reserveQuota({ accountId: 'c', actionKind: 'send_message', intentId: 'dup' }, policy, T0)]);
  assert.ok(same[0].ok && same[1].ok && same[0].reservation.reservationId === same[1].reservation.reservationId);
  await a.close();
  await b.close();
});

test('T40: an unknown outcome holds the reservation; release and consume after hold do not free it, also after a reopen', async () => {
  const path = tmpLedgerPath();
  const a = await open(path);
  const policy: Policy = { ...(await a.getPolicy()), maxDaily: { send_message: 1 } };
  const one = await a.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i1' }, policy, T0);
  assert.ok(one.ok);
  assert.equal((await a.holdQuota(one.reservation.reservationId)).state, 'held');
  assert.equal((await a.releaseQuota(one.reservation.reservationId)).state, 'held');
  assert.equal((await a.consumeQuota(one.reservation.reservationId)).state, 'held');
  await a.close();
  const b = await open(path);
  assert.equal((await b.getQuota(one.reservation.reservationId))?.state, 'held');
  assert.equal((await b.releaseQuota(one.reservation.reservationId)).state, 'held');
  assert.deepEqual(await b.reserveQuota({ accountId: 'a', actionKind: 'send_message', intentId: 'i2' }, policy, T1), { ok: false, reason: 'daily_limit' });
  // A released reservation frees the slot and lets the same intent reserve again.
  const two = await b.reserveQuota({ accountId: 'z', actionKind: 'send_message', intentId: 'r1' }, policy, T0);
  assert.ok(two.ok);
  assert.equal((await b.releaseQuota(two.reservation.reservationId)).state, 'released');
  const three = await b.reserveQuota({ accountId: 'z', actionKind: 'send_message', intentId: 'r1' }, policy, T1);
  assert.ok(three.ok && three.reservation.reservationId !== two.reservation.reservationId);
  await assert.rejects(b.holdQuota('quota_missing'), LedgerConflictError);
  await b.close();
});

test('after close every call is refused and health says closed', async () => {
  const ledger = await open();
  await ledger.close();
  await ledger.close();
  assert.deepEqual(await ledger.health(), { writable: false, reason: 'closed', schemaVersion: SUPPORTED_SCHEMA_VERSION });
  await assert.rejects(ledger.listTasks(), (e: unknown) => e instanceof LedgerUnavailableError && e.reason === 'closed');
  await assert.rejects(ledger.intake(intake(), T0), LedgerUnavailableError);
});
