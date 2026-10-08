import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IpcFailure, type ApplicationService, type AppSnapshot, type InputGateState, type IpcMethod, type IpcMethods } from '@wechat-agent/ports';
import { sampleSnapshots } from '@wechat-agent/ports/fakes';
import { gateSettles, quitPrompt, runQuitFlow, type QuitPhase } from '../src/index.ts';

/** A service whose pause behaviour and later snapshots the test scripts. */
class ScriptedService implements ApplicationService {
  readonly calls: { method: IpcMethod; params: unknown }[] = [];
  private listeners = new Set<(s: AppSnapshot) => void>();
  constructor(private snapshot: AppSnapshot, private pause: (p: IpcMethods['app.pause']['params']) => IpcMethods['app.pause']['result'] | Error) {}
  async call<M extends IpcMethod>(method: M, params: IpcMethods[M]['params']): Promise<IpcMethods[M]['result']> {
    this.calls.push({ method, params });
    if (method === 'app.getSnapshot') return this.snapshot as IpcMethods[M]['result'];
    if (method === 'app.pause') {
      const r = this.pause(params as IpcMethods['app.pause']['params']);
      if (r instanceof Error) throw r;
      return r as IpcMethods[M]['result'];
    }
    throw new IpcFailure({ code: 'unavailable', message: method });
  }
  subscribe(listener: (s: AppSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  push(gate: InputGateState): void { this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, inputGate: gate }; for (const l of this.listeners) l(this.snapshot); }
  get subscribers(): number { return this.listeners.size; }
}

const timers = () => {
  const pending: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; pending.push(t); return t; },
    clearTimer: (h: unknown) => { (h as { cleared: boolean }).cleared = true; },
    fire: () => { for (const t of pending) if (!t.cleared) t.fn(); },
  };
};

test('gateSettles', () => {
  assert.equal(gateSettles('closed'), 'closed');
  assert.equal(gateSettles('quiescence_unconfirmed'), 'unconfirmed');
  assert.equal(gateSettles('open'), 'pending');
  assert.equal(gateSettles('stopping'), 'pending');
});

test('open gate: pause is requested with the snapshot revision, then the flow waits for closed', async () => {
  const service = new ScriptedService(sampleSnapshots.ready_idle, () => ({ inputGate: 'stopping' }));
  const t = timers();
  const phases: QuitPhase[] = [];
  const flow = runQuitFlow({ service, timeoutMs: 100, operationId: 'quit:test', setTimer: t.setTimer, clearTimer: t.clearTimer, onProgress: (p) => phases.push(p) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(service.calls.map((c) => c.method), ['app.getSnapshot', 'app.pause']);
  assert.deepEqual(service.calls[1].params, { operationId: 'quit:test', expectedRevision: sampleSnapshots.ready_idle.revision });
  assert.equal(service.subscribers, 1);
  service.push('stopping');
  service.push('closed');
  const outcome = await flow;
  assert.equal(outcome.kind, 'quiescent');
  assert.equal(service.subscribers, 0, 'unsubscribed after settling');
  assert.ok(t.pending[0].cleared, 'timer cleared');
  assert.deepEqual(phases, ['reading', 'pausing', 'waiting', 'done']);
  assert.equal(quitPrompt(outcome), null, 'quiescent needs no prompt');
});

test('pause itself may already report closed', async () => {
  const service = new ScriptedService(sampleSnapshots.ready_idle, () => ({ inputGate: 'closed' }));
  const outcome = await runQuitFlow({ service, timeoutMs: 10 });
  assert.equal(outcome.kind, 'quiescent');
  assert.equal(service.subscribers, 0);
});

test('already closed gate: no pause call, exit is quiescent', async () => {
  const service = new ScriptedService({ ...sampleSnapshots.ready_idle, inputGate: 'closed' }, () => new Error('must not be called'));
  const outcome = await runQuitFlow({ service, timeoutMs: 10 });
  assert.equal(outcome.kind, 'quiescent');
  assert.deepEqual(service.calls.map((c) => c.method), ['app.getSnapshot']);
});

test('quiescence_unconfirmed is reported as such, never as quiescent', async () => {
  const service = new ScriptedService(sampleSnapshots.quiescence_unconfirmed, () => new Error('must not be called'));
  const outcome = await runQuitFlow({ service, timeoutMs: 10 });
  assert.equal(outcome.kind, 'quiescence_unconfirmed');
  assert.ok(quitPrompt(outcome)?.body.includes('不会把'), 'prompt says nothing is marked cancelled');

  const viaPause = new ScriptedService(sampleSnapshots.ready_idle, () => ({ inputGate: 'quiescence_unconfirmed' }));
  assert.equal((await runQuitFlow({ service: viaPause, timeoutMs: 10 })).kind, 'quiescence_unconfirmed');

  const viaStream = new ScriptedService(sampleSnapshots.ready_idle, () => ({ inputGate: 'stopping' }));
  const t = timers();
  const flow = runQuitFlow({ service: viaStream, timeoutMs: 10, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await new Promise((r) => setImmediate(r));
  viaStream.push('quiescence_unconfirmed');
  assert.equal((await flow).kind, 'quiescence_unconfirmed');
});

test('pause failure is surfaced; the flow does not keep waiting', async () => {
  const service = new ScriptedService(sampleSnapshots.ready_idle, () => new IpcFailure({ code: 'unavailable', message: 'fake service does not implement app.pause' }));
  const outcome = await runQuitFlow({ service, timeoutMs: 10 });
  assert.equal(outcome.kind, 'pause_failed');
  assert.equal(service.subscribers, 0);
  assert.equal(quitPrompt(outcome)?.title, '暂停失败');
});

test('stopping gate that never closes times out with the last gate, not a fake cancel', async () => {
  const service = new ScriptedService(sampleSnapshots.stopping, () => new Error('must not be called'));
  const t = timers();
  const flow = runQuitFlow({ service, timeoutMs: 50, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(service.calls.map((c) => c.method), ['app.getSnapshot'], 'no pause while already stopping');
  assert.equal(t.pending[0].ms, 50);
  t.fire();
  const outcome = await flow;
  assert.equal(outcome.kind, 'timeout');
  if (outcome.kind === 'timeout') assert.equal(outcome.lastGate, 'stopping');
  assert.equal(service.subscribers, 0);
  assert.equal(quitPrompt(outcome)?.title, '等待静止超时');
});

test('a stale snapshot push after settling is ignored (single resolution)', async () => {
  const service = new ScriptedService(sampleSnapshots.stopping, () => new Error('must not be called'));
  const t = timers();
  const flow = runQuitFlow({ service, timeoutMs: 50, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await new Promise((r) => setImmediate(r));
  service.push('closed');
  t.fire();
  service.push('quiescence_unconfirmed');
  assert.equal((await flow).kind, 'quiescent');
});
