// The input gate (方案 E03 InputGate): every outbound action checks it right
// before dispatch. It closes immediately on pause, disconnect or an account
// change; it reopens only through an explicit resume.
import { WriteGateClosedError } from '@wechat-agent/ports';
import type { InputGateState, WriteGate } from '@wechat-agent/ports';

export type PauseReason = 'paused' | 'disconnected' | 'account_changed';

export class InputGate implements WriteGate {
  private pauseReason: PauseReason | undefined;
  private stoppingCount = 0;
  /** A stop whose quiescence the platform never confirmed (disconnect mid-stop, run.wait timeout). */
  quiescenceUnconfirmed = false;
  connectionReady = false;
  accountConfirmed = false;

  constructor(private readonly onChange: () => void) {}

  get state(): InputGateState {
    if (this.stoppingCount > 0) return 'stopping';
    if (this.quiescenceUnconfirmed) return 'quiescence_unconfirmed';
    return this.isOpen() ? 'open' : 'closed';
  }

  get reason(): PauseReason | undefined {
    return this.pauseReason;
  }

  isOpen(): boolean {
    return this.stoppingCount === 0 && !this.quiescenceUnconfirmed && !this.pauseReason && this.connectionReady && this.accountConfirmed;
  }

  ensureOpen(): void {
    if (this.isOpen()) return;
    throw new WriteGateClosedError(this.why());
  }

  why(): WriteGateClosedError['why'] {
    if (this.stoppingCount > 0) return 'stopping';
    if (this.quiescenceUnconfirmed || !this.connectionReady || this.pauseReason === 'disconnected') return 'disconnected';
    if (this.pauseReason === 'account_changed') return 'account_changed';
    if (this.pauseReason === 'paused') return 'paused';
    return 'policy';
  }

  pause(reason: PauseReason): void {
    // An account change is the strongest reason; a later disconnect must not weaken it.
    if (this.pauseReason === 'account_changed' && reason !== 'account_changed') return;
    this.pauseReason = reason;
    this.onChange();
  }

  /** Explicit resume: clears the pause and any unconfirmed stop. Nothing is replayed by this. */
  resume(): void {
    this.pauseReason = undefined;
    this.quiescenceUnconfirmed = false;
    this.onChange();
  }

  setConnection(ready: boolean): void {
    this.connectionReady = ready;
    this.onChange();
  }

  setAccount(confirmed: boolean): void {
    this.accountConfirmed = confirmed;
    this.onChange();
  }

  beginStopping(): void {
    this.stoppingCount += 1;
    this.onChange();
  }

  /** A stop that was unconfirmed has been confirmed after all (reconcile, reconnect review). The pause reason, if any, stays. */
  confirmQuiescence(): void {
    if (!this.quiescenceUnconfirmed) return;
    this.quiescenceUnconfirmed = false;
    this.onChange();
  }

  endStopping(confirmed: boolean): void {
    this.stoppingCount = Math.max(0, this.stoppingCount - 1);
    if (!confirmed) this.quiescenceUnconfirmed = true;
    this.onChange();
  }
}
