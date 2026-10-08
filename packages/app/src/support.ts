// Small helpers shared by the app modules: ids, hashing, a scheduler seam
// (tests drive timers by hand), a deferred and a FIFO mutex.
import { createHash, randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sortKeys(record[k])]));
  }
  return value;
}

/** JSON with sorted keys, so equal intents hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function hashContent(text: string): string {
  return sha256(text);
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Background timers never keep the process alive on their own (the shell does that). */
export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref(); return handle; },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** A scheduler tests drive explicitly: nothing fires until `flush()`. */
export class ManualScheduler implements Scheduler {
  private seq = 0;
  readonly pending = new Map<number, { fn: () => void; ms: number; order: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { fn, ms, order: id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fires every timer pending right now, shortest delay first; timers they schedule stay pending. */
  flush(): number {
    const batch = [...this.pending.entries()].sort((a, b) => a[1].ms - b[1].ms || a[1].order - b[1].order);
    for (const [id] of batch) this.pending.delete(id);
    for (const [, timer] of batch) timer.fn();
    return batch.length;
  }

  get size(): number {
    return this.pending.size;
  }

  delays(): number[] {
    return [...this.pending.values()].map((t) => t.ms);
  }
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;
  settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = (v) => { this.settled = true; resolve(v); };
      this.reject = (e) => { this.settled = true; reject(e); };
    });
  }
}

/** FIFO mutex; `acquire` resolves with the release function. */
export class Mutex {
  private waiters: (() => void)[] = [];
  private held = false;

  get locked(): boolean {
    return this.held;
  }

  async acquire(): Promise<() => void> {
    if (!this.held) this.held = true;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.held = false;
    };
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
