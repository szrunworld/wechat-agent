// Runs one scenario against a ledger file and then kills itself with SIGKILL,
// so the parent test sees what a real crash leaves behind. Usage:
//   node --import tsx crash-child.ts <dbPath> <scenario>
// Each scenario prints a JSON line with the ids it created before dying.
import { openLedger } from '../../src/index.ts';
import type { SqliteLedger } from '../../src/index.ts';

const [, , dbPath, scenario] = process.argv;
const T0 = '2026-10-08T10:00:00+08:00';
const T1 = '2026-10-08T10:00:01+08:00';

const ledger = (await openLedger(dbPath)) as SqliteLedger;
const { task } = await ledger.intake({
  operationId: 'op_crash', fingerprint: 'fp_crash', type: 'accept_request', accountRevision: 1, targetId: 'tgt_1', targetRevision: 1,
  payload: { kind: 'accept_request', requestKey: '周十|我是周十' }, payloadHash: 'ph',
}, T0);
const attempt = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'accept' }, T0);
const out: Record<string, unknown> = { taskId: task.taskId, attemptId: attempt.attemptId };

if (scenario === 'after_prepare') {
  // nothing more: the attempt is prepared, no requestId was ever chosen
} else if (scenario === 'after_dispatching') {
  await ledger.markDispatching(attempt.attemptId, { requestId: 'rq_crash', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1);
} else if (scenario === 'after_receipt') {
  await ledger.markDispatching(attempt.attemptId, { requestId: 'rq_crash', canonicalDigest: 'd', snapshotId: 's', sessionId: 'ses', runId: 'run' }, T1);
  await ledger.recordReceipt(attempt.attemptId, 'rc_crash', { phase: 'delivered' }, T1);
} else if (scenario === 'after_transition') {
  await ledger.transitionTask(task.taskId, 'queued', 1, T1, 'crash test');
} else {
  throw new Error(`unknown scenario ${scenario}`);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
// No close(), no flush: die like a crashed process.
process.kill(process.pid, 'SIGKILL');
