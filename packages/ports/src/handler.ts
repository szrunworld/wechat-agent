// One handler per task type (方案 §06 Handlers, §09 algorithm). Lane D
// implements them; lane E runs them. A handler sees exactly three ports and
// a context; it never reaches the platform or the disk any other way.

import type {
  AccountBinding, ActionKind, BusinessApproval, DomainResult, Id, Policy, Revision, TargetRef, TaskType, Timestamp, WeChatTask,
} from './domain.ts';
import type { AgentDesktopDriver } from './driver.ts';
import type { Ledger } from './ledger.ts';
import type { Recognizer } from './recognizer.ts';

export class WriteGateClosedError extends Error {
  constructor(readonly why: 'paused' | 'stopping' | 'disconnected' | 'account_changed' | 'policy') {
    super(`write gate closed: ${why}`);
    this.name = 'WriteGateClosedError';
  }
}

/** The app's input gate: every outbound action checks it right before dispatch. */
export interface WriteGate {
  isOpen(): boolean;
  /** Throws WriteGateClosedError. */
  ensureOpen(): void;
}

export interface ApprovalRequest {
  taskId: Id;
  allowedAction: ActionKind;
  accountRevision: Revision;
  targetRevision: Revision;
  draftRevision: Revision;
  contentHash: string;
  summary: {
    targetLabel: string;
    visibleIdentifier?: string;
    contentPreview?: string;
    evidenceIds: Id[];
    identityConfidence: number;
  };
}

export type ApprovalDecision =
  | { kind: 'approved'; approval: BusinessApproval }
  | { kind: 'rejected' }
  | { kind: 'skipped' }
  | { kind: 'cancelled' };

export interface HandlerContext {
  driver: AgentDesktopDriver;
  recognizer: Recognizer;
  ledger: Ledger;
  policy: Policy;
  account: AccountBinding;
  /** The task's target as the app resolved it (conversation, request, search profile), when it has one. */
  target?: TargetRef;
  writeGate: WriteGate;
  /** Platform session and run the app acquired for this task (方案 §09 step 5). */
  session: { desktopId: Id; sessionId: Id; runId: Id };
  /** Blocks until a person decides; the app may release the run meanwhile and re-acquire after. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Fresh platform requestIds for attempts; the handler persists one before using it. */
  newId(): Id;
  now(): Timestamp;
  log(line: string): void;
  /** Set when the app pauses or stops; handlers check it between steps. */
  signal: AbortSignal;
}

/**
 * The 11 steps of 方案 §09 live inside `run`: intake and preflight are the
 * app's; the handler does prepare → approve → acquire → verify-before-write
 * → persist → dispatch → receipt → business-verify → finalize, and returns
 * the business result. It never returns `confirmed` from a receipt alone.
 */
export interface Handler<T extends TaskType = TaskType> {
  readonly type: T;
  /** Which platform capabilities and policy actions this handler needs; the app gates on them. */
  readonly requires: { methods: string[]; actions: ActionKind[] };
  run(task: WeChatTask & { type: T }, context: HandlerContext): Promise<DomainResult>;
}

export interface HandlerRegistry {
  get<T extends TaskType>(type: T): Handler<T> | undefined;
  all(): Handler[];
}
