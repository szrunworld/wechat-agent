// Recovery (方案 E03): at start (and after each reconnect) every attempt a
// crash left in dispatching/receipt_received is looked up with request.show.
// The answer becomes a fact and the task goes to needs_reconciliation. A
// not_found or expired record is never read as "not sent"; nothing is
// re-dispatched here.
import { DriverError } from '@wechat-agent/ports';
import type { ActionAttempt, AgentDesktopDriver, Id, Ledger, RequestRecord, Run, Timestamp } from '@wechat-agent/ports';
import type { Dispatcher } from './dispatcher.ts';
import { isPlatformLost } from './connector.ts';
import { errorMessage } from './support.ts';
import { isTerminal } from './tasks.ts';

export interface RecoveryReport {
  attemptId: Id;
  taskId: Id;
  requestId?: Id;
  requestState: RequestRecord['state'] | 'not_found' | 'error';
  runQuiescence?: Run['quiescence'];
  taskState: string;
}

export interface RecoveryDeps {
  ledger: Ledger;
  driver: AgentDesktopDriver;
  dispatcher: Dispatcher;
  now(): Timestamp;
  log(line: string): void;
}

/** Returns what it settled; stops early (returns what it did so far) if the platform drops. */
export async function recoverOpenAttempts(deps: RecoveryDeps): Promise<RecoveryReport[]> {
  const { ledger, driver, dispatcher, now, log } = deps;
  const reports: RecoveryReport[] = [];
  let attempts: ActionAttempt[];
  try { attempts = await ledger.findOpenAttempts(); } catch (error) { log(`recovery: ${errorMessage(error)}`); return reports; }
  for (const attempt of attempts) {
    const task = await ledger.getTask(attempt.taskId);
    if (!task) continue;
    const rt = dispatcher.runtimeFor(task.taskId, 'ui', '恢复：发现未结清的平台动作');
    rt.attempts.set(attempt.attemptId, { requestId: attempt.requestId, state: attempt.state });
    rt.runId = attempt.runId ?? rt.runId;

    let record: RequestRecord | undefined;
    let requestState: RecoveryReport['requestState'] = 'not_found';
    if (attempt.requestId) {
      try {
        record = await driver.showRequest(attempt.requestId);
        requestState = record.state;
      } catch (error) {
        if (isPlatformLost(error)) { log('recovery: platform dropped; remaining attempts stay open'); return reports; }
        requestState = error instanceof DriverError && error.error.code === 'not_found' ? 'not_found' : 'error';
        log(`recovery: request.show ${attempt.requestId}: ${errorMessage(error)}`);
      }
    }
    let run: Run | undefined;
    if (attempt.runId) {
      try { run = await driver.showRun(attempt.runId); } catch (error) {
        if (isPlatformLost(error)) return reports;
      }
    }

    const at = now();
    if (record && (record.state === 'completed' || record.state === 'failed')) {
      if (attempt.state === 'dispatching') {
        const receiptId = (record.outcome?.receiptId as string | undefined) ?? `recovered:${attempt.requestId}`;
        await ledger.recordReceipt(attempt.attemptId, receiptId, { recovered: true, ...record.outcome, state: record.state }, at);
      }
      rt.attempts.set(attempt.attemptId, { requestId: attempt.requestId, state: 'receipt_received' });
    } else if (attempt.state === 'dispatching' || attempt.state === 'receipt_received') {
      await ledger.markUnknown(attempt.attemptId, `recovery: request.show ${requestState}`, at);
      rt.attempts.set(attempt.attemptId, { requestId: attempt.requestId, state: 'unknown' });
    }

    await ledger.appendFact({
      taskId: task.taskId, factKind: 'reconciliation', outcome: 'observed', evidenceIds: [], observedAt: at,
      confidence: record ? 1 : 0, reason: `恢复：request.show=${requestState}${run ? `，run=${run.phase}/${run.quiescence}` : ''}`,
      data: { requestId: attempt.requestId ?? null, requestState, outcome: record?.outcome ?? null, run: run ? { runId: run.runId, phase: run.phase, outcome: run.outcome, quiescence: run.quiescence } : null },
    });

    rt.platform = {
      ...rt.platform, runId: attempt.runId ?? rt.platform?.runId, requestId: attempt.requestId,
      delivery: record ? (record.state === 'completed' ? 'dispatched' : record.state) : 'unknown',
      execution: record?.state === 'completed' ? 'completed' : record?.state === 'failed' ? 'failed' : 'unknown',
      quiescence: run?.quiescence,
    };
    rt.runOpen = false;

    let current = task;
    if (!isTerminal(current.state)) {
      current = await dispatcher.settle(rt, current, 'needs_reconciliation', record?.state === 'completed' ? 'verification_missing' : 'platform_unknown', `恢复：request.show ${requestState}`);
      rt.timeline.push({ at, label: '恢复：平台记录已核实，业务结果待确认' });
    }
    reports.push({ attemptId: attempt.attemptId, taskId: task.taskId, requestId: attempt.requestId, requestState, runQuiescence: run?.quiescence, taskState: current.state });
  }
  dispatcher.notify();
  return reports;
}
