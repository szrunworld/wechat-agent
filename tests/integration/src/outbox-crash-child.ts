// Runs one outbox scenario against a SQLite ledger file and then kills itself
// with SIGKILL, so the parent test sees what a real crash leaves behind.
//   node --import tsx outbox-crash-child.ts <dbPath> <sinkFile> <scenario>
//   before_deliver : task finalized + event enqueued (one transaction), no delivery
//   after_deliver  : the FileSink took the event, the ledger was never told
// Prints a JSON line with the ids before dying.
import { FileSink, OutboxWriter, taskFinalDraft } from '@wechat-agent/app';
import { openLedger } from '@wechat-agent/ledger';

const [, , dbPath, sinkFile, scenario] = process.argv;
const T0 = '2026-10-08T10:00:00+08:00';

const ledger = await openLedger(dbPath!);
const { task } = await ledger.intake({
  operationId: 'op_outbox_crash', fingerprint: 'fp_outbox_crash', type: 'accept_request', accountRevision: 1,
  payload: { kind: 'accept_request', requestKey: '测试联系人甲|测试联系人甲' }, payloadHash: 'ph',
}, T0);
const writer = new OutboxWriter({ ledger, log: () => undefined });
const { task: final, event } = await writer.finalize(task.taskId, 'cancelled', task.revision, T0, 'cancelled: crash test', (t) => taskFinalDraft(t, { stateReason: 'cancelled', reason: 'crash test' }));
if (!event) throw new Error('no event');
if (scenario === 'after_deliver') {
  const sink = new FileSink(sinkFile!, () => T0);
  const result = await sink.deliver(event);
  if (!result.ok) throw new Error(result.reason);
} else if (scenario !== 'before_deliver') {
  throw new Error(`unknown scenario ${scenario}`);
}
process.stdout.write(`${JSON.stringify({ taskId: final.taskId, revision: final.revision, eventId: event.eventId })}\n`);
// No close(), no settle: die like a crashed process.
process.kill(process.pid, 'SIGKILL');
