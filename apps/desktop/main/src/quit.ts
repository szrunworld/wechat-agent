// Explicit quit = stop flow, not a kill. The shell asks the application
// service to pause (close the write gate, cancel the owning Run, wait for
// quiescence) and leaves only once the snapshot says the gate is closed. If
// quiescence is never confirmed the outcome says so; nothing here writes a
// "cancelled" that the platform did not confirm.
import type { ApplicationService, AppSnapshot, InputGateState } from '@wechat-agent/ports';

export type QuitOutcome =
  | { kind: 'quiescent'; detail: string }
  | { kind: 'quiescence_unconfirmed'; detail: string }
  | { kind: 'pause_failed'; detail: string }
  | { kind: 'timeout'; detail: string; lastGate: InputGateState | 'unknown' };

export interface QuitFlowOptions {
  service: ApplicationService;
  /** How long to wait for the gate to close after app.pause; default 15 s. */
  timeoutMs?: number;
  operationId?: string;
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onProgress?: (phase: QuitPhase) => void;
}

export type QuitPhase = 'reading' | 'pausing' | 'waiting' | 'done';

const closedGates: ReadonlySet<InputGateState> = new Set(['closed']);

export function gateSettles(gate: InputGateState): 'closed' | 'unconfirmed' | 'pending' {
  if (closedGates.has(gate)) return 'closed';
  if (gate === 'quiescence_unconfirmed') return 'unconfirmed';
  return 'pending';
}

/** Runs the stop flow once and resolves with the honest outcome. */
export async function runQuitFlow(options: QuitFlowOptions): Promise<QuitOutcome> {
  const { service } = options;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const progress = options.onProgress ?? (() => {});

  progress('reading');
  let snapshot: AppSnapshot;
  try {
    snapshot = await service.call('app.getSnapshot', {});
  } catch (error) {
    // No snapshot means no service to pause; the gate state is unknown and we say so.
    return { kind: 'timeout', detail: `snapshot unavailable: ${describe(error)}`, lastGate: 'unknown' };
  }

  const initial = gateSettles(snapshot.inputGate);
  if (initial === 'closed') { progress('done'); return { kind: 'quiescent', detail: 'input gate already closed' }; }
  if (initial === 'unconfirmed') { progress('done'); return { kind: 'quiescence_unconfirmed', detail: 'gate was already quiescence_unconfirmed' }; }

  if (snapshot.inputGate === 'open') {
    progress('pausing');
    try {
      const paused = await service.call('app.pause', {
        operationId: options.operationId ?? `quit:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        expectedRevision: snapshot.revision,
      });
      const settled = gateSettles(paused.inputGate);
      if (settled === 'closed') { progress('done'); return { kind: 'quiescent', detail: 'app.pause closed the gate' }; }
      if (settled === 'unconfirmed') { progress('done'); return { kind: 'quiescence_unconfirmed', detail: 'app.pause returned quiescence_unconfirmed' }; }
    } catch (error) {
      progress('done');
      return { kind: 'pause_failed', detail: describe(error) };
    }
  }

  // Gate is stopping (ours or someone else's pause): wait for the snapshot stream.
  progress('waiting');
  return new Promise<QuitOutcome>((resolve) => {
    let lastGate: InputGateState = snapshot.inputGate;
    let unsubscribe: (() => void) | null = null;
    let finished = false;
    const finish = (outcome: QuitOutcome) => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      unsubscribe?.();
      progress('done');
      resolve(outcome);
    };
    const timer = setTimer(() => finish({ kind: 'timeout', detail: `gate still ${lastGate} after ${timeoutMs} ms`, lastGate }), timeoutMs);
    unsubscribe = service.subscribe((next) => {
      lastGate = next.inputGate;
      const settled = gateSettles(next.inputGate);
      if (settled === 'closed') finish({ kind: 'quiescent', detail: 'snapshot reported the gate closed' });
      else if (settled === 'unconfirmed') finish({ kind: 'quiescence_unconfirmed', detail: 'snapshot reported quiescence_unconfirmed' });
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the shell tells the person before exiting on a non-quiescent outcome. */
export function quitPrompt(outcome: QuitOutcome): { title: string; body: string } | null {
  switch (outcome.kind) {
    case 'quiescent':
      return null;
    case 'quiescence_unconfirmed':
      return { title: '静止未确认', body: `平台没有确认动作已静止（${outcome.detail}）。现在退出不会把未完成的动作记为已取消；下次启动会先核实。` };
    case 'pause_failed':
      return { title: '暂停失败', body: `无法请求暂停：${outcome.detail}。现在退出不会把进行中的动作记为已取消。` };
    case 'timeout':
      return { title: '等待静止超时', body: `${outcome.detail}。现在退出不会把进行中的动作记为已取消；下次启动会先核实。` };
  }
}
