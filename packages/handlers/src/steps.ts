// The observe → recognize → act → verify primitives every handler is built
// from (方案 §09). A Flow owns the facts and evidence a task accumulates and
// enforces, before every act: the abort signal, the write gate, a persisted
// attempt with a requestId chosen once, and, for the dangerous ones, a
// re-observed scene plus a valid approval. A receipt alone never confirms.

import { DriverError, LedgerConflictError, WriteGateClosedError } from '@wechat-agent/ports';
import type {
  Action, ActionAttempt, ActionKind, ActionReceipt, BusinessApproval, DomainFact, DomainOutcome, DomainReasonCode, DomainResult, FactKind,
  HandlerContext, Id, ImageMeta, Observation, ObservedTarget, PageFacts, Revision, Timestamp, WeChatTask,
} from '@wechat-agent/ports';
import { canonicalJson, sha256 } from './text.ts';

export interface Scene {
  observation: Observation;
  facts: PageFacts;
  evidenceId: Id;
}

export interface FlowOptions {
  /** Called between an act and the observation that checks it (real pacing); the default returns at once. */
  settle: () => Promise<void>;
  /** How long captured evidence is kept, in days. */
  evidenceRetentionDays: number;
}

export const DEFAULT_FLOW_OPTIONS: FlowOptions = { settle: async () => {}, evidenceRetentionDays: 30 };

/** Thrown to unwind a handler with its result; `Flow.run` turns it back into the return value. */
export class Halt {
  constructor(readonly result: DomainResult) {}
}

export interface ActOutcome {
  attempt: ActionAttempt;
  receipt: ActionReceipt;
  requestId: Id;
}

export interface ApprovalExpectation {
  action: ActionKind;
  contentHash: string;
  targetRevision: Revision;
}

/** Texts WeChat shows when something went wrong; any of them stops a flow. */
export const ERROR_TEXT = /已过期|已被拒绝|操作失败|频繁|异常|失败|不存在|无法|找不到/;

export class Flow {
  readonly facts: DomainFact[] = [];
  readonly evidenceIds: Id[] = [];
  /** Set once a dangerous act may have reached WeChat; a later cancel then means reconciliation, not "nothing happened". */
  dangerDispatched = false;
  private anchor: ObservedTarget | undefined;
  /** Attempts with a receipt whose business verdict is still open. */
  private readonly open: { outcome: ActOutcome; danger: boolean }[] = [];

  constructor(readonly ctx: HandlerContext, readonly task: WeChatTask, readonly options: FlowOptions = DEFAULT_FLOW_OPTIONS) {}

  /** Runs a handler body, turning a Halt into its result. Other errors propagate to the app. */
  static async run(ctx: HandlerContext, task: WeChatTask, options: FlowOptions, body: (flow: Flow) => Promise<DomainResult>): Promise<DomainResult> {
    const flow = new Flow(ctx, task, options);
    let result: DomainResult;
    try {
      result = await body(flow);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
      result = e.result;
    }
    await flow.closeOpenAttempts(result);
    return result;
  }

  /** No attempt is left half-open: a dangerous one without a verdict is unknown, a navigation one is settled by its receipt. */
  private async closeOpenAttempts(result: DomainResult): Promise<void> {
    for (const entry of [...this.open]) {
      await this.settleAttempt(entry.outcome, entry.danger ? 'unknown' : 'verified', `${result.outcome}${result.reasonCode ? ` (${result.reasonCode})` : ''}: ${result.reason ?? 'flow ended'}`);
    }
  }

  result(outcome: DomainOutcome, reasonCode?: DomainReasonCode, reason?: string): DomainResult {
    const result: DomainResult = { outcome, facts: [...this.facts], evidenceIds: [...this.evidenceIds] };
    if (reasonCode) result.reasonCode = reasonCode;
    if (reason) result.reason = reason;
    return result;
  }

  halt(outcome: DomainOutcome, reasonCode?: DomainReasonCode, reason?: string): never {
    throw new Halt(this.result(outcome, reasonCode, reason));
  }

  log(line: string): void {
    this.ctx.log(`[${this.task.type} ${this.task.taskId}] ${line}`);
  }

  /** Pause/stop between steps: before a dangerous act it is a clean no_op, after one it needs reconciliation. */
  checkSignal(): void {
    if (!this.ctx.signal.aborted) return;
    this.halt(this.dangerDispatched ? 'needs_reconciliation' : 'no_op', 'cancelled', 'cancelled by the app');
  }

  async settle(): Promise<void> {
    await this.options.settle();
  }

  async fact(factKind: FactKind, outcome: DomainFact['outcome'], data: Record<string, unknown> | undefined, extra: { evidenceIds?: Id[]; confidence?: number; reason?: string } = {}): Promise<DomainFact> {
    const saved = await this.ctx.ledger.appendFact({
      taskId: this.task.taskId, factKind, outcome, evidenceIds: extra.evidenceIds ?? [...this.evidenceIds], observedAt: this.ctx.now(),
      confidence: extra.confidence ?? 1, reason: extra.reason, data,
    });
    this.facts.push(saved);
    return saved;
  }

  private retentionUntil(now: Timestamp): Timestamp {
    return new Date(Date.parse(now) + this.options.evidenceRetentionDays * 86_400_000).toISOString();
  }

  /** observe → applicability → recognize → evidence. Unreadable captures stop the flow instead of being guessed at. */
  async observe(): Promise<Scene> {
    this.checkSignal();
    const { driver, recognizer, ledger } = this.ctx;
    const session = this.ctx.session;
    let observation: Observation;
    try {
      observation = await driver.observe({ sessionId: session.sessionId, runId: session.runId }, { screenshot: true, elements: false });
    } catch (e) {
      this.driverFailure(e, 'observe');
    }
    const image = observation.image;
    if (!image) this.halt('blocked', 'layout_unreadable', 'the observation carried no screenshot');
    const meta: ImageMeta = {
      width: image.width, height: image.height, scale: image.transform.scale, artifactId: image.artifactId, sha256: image.sha256,
      windowFrame: observation.target ? { width: observation.target.windowFrame.width, height: observation.target.windowFrame.height } : undefined,
      windowTitle: observation.target?.title,
    };
    const applicability = recognizer.applicability(meta);
    if (!applicability.applicable) this.halt('blocked', 'layout_unreadable', `no layout profile applies: ${applicability.reason}`);
    let bytes: Uint8Array;
    try {
      bytes = await driver.readArtifact(image.artifactId);
    } catch (e) {
      this.driverFailure(e, 'artifact.read');
    }
    const facts = await recognizer.recognize({ ...meta, bytes }, applicability.profile);
    const now = this.ctx.now();
    const evidence = await ledger.putEvidence({
      artifactId: image.artifactId, sha256: image.sha256, captureTime: observation.capturedAt, coverage: facts.coverage, retentionUntil: this.retentionUntil(now),
    });
    this.evidenceIds.push(evidence.evidenceId);
    if (!this.anchor && observation.target) this.anchor = observation.target;
    this.log(`observed ${facts.page} (${facts.coverage}, confidence ${facts.confidence})`);
    for (const entry of [...this.open]) if (!entry.danger) await this.settleAttempt(entry.outcome, 'verified', 'observed after');
    if (facts.coverage === 'unreadable') this.halt('blocked', 'layout_unreadable', facts.warnings.join('; ') || 'capture unreadable');
    return { observation, facts, evidenceId: evidence.evidenceId };
  }

  /** The window the flow started in; a different pid/windowId means the scene is not what was approved. */
  sameWindow(scene: Scene): boolean {
    const target = scene.observation.target;
    if (!this.anchor || !target) return false;
    return this.anchor.process.pid === target.process.pid && this.anchor.windowId === target.windowId;
  }

  requireSameWindow(scene: Scene): void {
    if (!this.anchor || !scene.observation.target) this.halt('blocked', 'approval_invalid', 'window identity is unknown; refusing to write');
    if (!this.sameWindow(scene)) this.halt('blocked', 'approval_invalid', 'the WeChat window changed since the approval');
  }

  requireSameAccount(): void {
    const account = this.ctx.account;
    if (account.status !== 'confirmed' || account.revision !== this.task.accountRevision) {
      this.halt('blocked', 'account_changed', `account ${account.status} at revision ${account.revision}, task expects ${this.task.accountRevision}`);
    }
  }

  /** Non-consuming approval checks: task, action, content, revisions, expiry. */
  requireApprovalValid(approval: BusinessApproval, expected: ApprovalExpectation, allowConsumed = false): void {
    this.requireSameAccount();
    if (approval.taskId !== this.task.taskId) this.halt('blocked', 'approval_invalid', 'approval belongs to another task');
    if (approval.allowedAction !== expected.action) this.halt('blocked', 'approval_invalid', `approval allows ${approval.allowedAction}, not ${expected.action}`);
    if (approval.contentHash !== expected.contentHash) this.halt('blocked', 'approval_invalid', 'approved content differs from what would be sent');
    if (approval.targetRevision !== expected.targetRevision) this.halt('blocked', 'approval_invalid', 'target changed since the approval');
    if (approval.accountRevision !== this.ctx.account.revision) this.halt('blocked', 'account_changed', 'account changed since the approval');
    if (Date.parse(approval.expiresAt) <= Date.parse(this.ctx.now())) this.halt('blocked', 'approval_expired', 'approval expired');
    if (approval.consumedAt && !allowConsumed) this.halt('blocked', 'approval_invalid', 'approval already consumed');
  }

  /** The ledger's own copy of the approval, re-read right before the dangerous act; the decision object alone is not trusted. */
  async reloadApproval(approval: BusinessApproval): Promise<BusinessApproval> {
    const stored = await this.ctx.ledger.getApproval(approval.approvalId);
    if (!stored) this.halt('blocked', 'approval_invalid', `approval ${approval.approvalId} is not in the ledger`);
    return stored;
  }

  /** Single-use consumption right before the dangerous act, validated against the ledger's copy. */
  async consumeApproval(approval: BusinessApproval, expected: ApprovalExpectation): Promise<BusinessApproval> {
    this.requireApprovalValid(await this.reloadApproval(approval), expected);
    try {
      return await this.ctx.ledger.consumeApproval(approval.approvalId, {
        taskId: this.task.taskId, contentHash: expected.contentHash, targetRevision: expected.targetRevision, accountRevision: this.ctx.account.revision,
      }, this.ctx.now());
    } catch (e) {
      if (e instanceof LedgerConflictError && e.kind === 'approval') {
        this.halt('blocked', /expired/.test(e.message) ? 'approval_expired' : 'approval_invalid', e.message);
      }
      throw e;
    }
  }

  /**
   * One platform action: signal → write gate → prepared attempt → requestId persisted as dispatching → act.
   * A failure after dispatch marks the attempt unknown and halts with needs_reconciliation; the requestId is never replaced.
   */
  async act(stepId: string, action: Action, scene: Scene, danger = false): Promise<ActOutcome> {
    this.checkSignal();
    try {
      this.ctx.writeGate.ensureOpen();
    } catch (e) {
      if (e instanceof WriteGateClosedError) this.halt('blocked', 'write_gate_closed', `write gate closed: ${e.why}`);
      throw e;
    }
    const { ledger, driver } = this.ctx;
    const session = this.ctx.session;
    const snapshotId = scene.observation.snapshotId;
    const attempt = await ledger.prepareAttempt({ taskId: this.task.taskId, stepId, sessionId: session.sessionId, runId: session.runId }, this.ctx.now());
    const requestId = this.ctx.newId();
    const canonicalDigest = sha256(canonicalJson({ sessionId: session.sessionId, runId: session.runId, snapshotId, action }));
    await ledger.markDispatching(attempt.attemptId, { requestId, canonicalDigest, snapshotId, sessionId: session.sessionId, runId: session.runId }, this.ctx.now());
    if (danger) this.dangerDispatched = true;
    this.log(`act ${stepId} ${action.kind} requestId=${requestId}${danger ? ' (dangerous)' : ''}`);
    let receipt: ActionReceipt;
    try {
      receipt = await driver.act({ sessionId: session.sessionId, runId: session.runId }, { snapshotId, action }, requestId);
    } catch (e) {
      if (!(e instanceof DriverError)) {
        await ledger.markUnknown(attempt.attemptId, `act threw: ${String(e)}`, this.ctx.now());
        this.halt('needs_reconciliation', 'platform_unknown', `act ${stepId} threw before a receipt: ${String(e)}`);
      }
      const error = e.error;
      if (error.notSent === true) {
        // The platform certainly never saw it; the intent may be re-planned with a fresh attempt.
        // (INTERFACE REQUEST: an AttemptState for "not sent" would say this better than unknown+reason.)
        await ledger.markUnknown(attempt.attemptId, `not_sent:${error.code}`, this.ctx.now());
        if (danger) this.dangerDispatched = false;
        this.haltForDriverError(error, `act ${stepId} was not sent`);
      }
      await ledger.markUnknown(attempt.attemptId, error.code, this.ctx.now());
      await this.fact('platform_receipt', 'needs_reconciliation', { stepId, requestId, error: error.code, phase: error.phase }, { reason: error.message });
      this.halt('needs_reconciliation', error.code === 'connection_lost' ? 'disconnected' : 'platform_unknown', `act ${stepId} failed after dispatch (${error.code}); requestId ${requestId} must be reconciled, not re-sent`);
    }
    await ledger.recordReceipt(attempt.attemptId, receipt.receiptId, receipt as unknown as Record<string, unknown>, this.ctx.now());
    await this.fact('platform_receipt', 'observed', { stepId, requestId, receiptId: receipt.receiptId, delivery: receipt.delivery, execution: receipt.execution, route: receipt.route, reason: receipt.reason });
    if (receipt.delivery === 'unknown' || receipt.execution === 'unknown') {
      await ledger.markUnknown(attempt.attemptId, `receipt ${receipt.delivery}/${receipt.execution}`, this.ctx.now());
      this.halt('needs_reconciliation', 'platform_unknown', `receipt for ${stepId} is ${receipt.delivery}/${receipt.execution}`);
    }
    if (receipt.delivery === 'not_dispatched') {
      // The receipt proves nothing reached WeChat; the attempt is settled by it.
      await ledger.markVerified(attempt.attemptId, this.ctx.now());
      if (danger) this.dangerDispatched = false;
      const code = receipt.reason?.code ?? 'not_dispatched';
      if (code === 'input_disabled' || code === 'stop_pending') this.halt('blocked', 'write_gate_closed', `platform refused ${stepId}: ${code}`);
      if (code === 'capability_missing') this.halt('blocked', 'capability_missing', `platform lacks a route for ${stepId}`);
      this.halt('failed', undefined, `platform did not dispatch ${stepId}: ${code} ${receipt.reason?.message ?? ''}`.trim());
    }
    const outcome: ActOutcome = { attempt, receipt, requestId };
    this.open.push({ outcome, danger });
    return outcome;
  }

  async settleAttempt(outcome: ActOutcome, verdict: 'verified' | 'unknown', reason: string): Promise<void> {
    const index = this.open.findIndex((entry) => entry.outcome.attempt.attemptId === outcome.attempt.attemptId);
    if (index >= 0) this.open.splice(index, 1);
    const state = (await this.ctx.ledger.getAttempt(outcome.attempt.attemptId))?.state;
    if (state === 'verified' || state === 'unknown') return;
    if (verdict === 'verified') await this.ctx.ledger.markVerified(outcome.attempt.attemptId, this.ctx.now());
    else await this.ctx.ledger.markUnknown(outcome.attempt.attemptId, reason, this.ctx.now());
  }

  private haltForDriverError(error: DriverError['error'], what: string): never {
    switch (error.code) {
      case 'connection_lost':
      case 'runtime_offline':
        this.halt('blocked', 'disconnected', `${what}: ${error.code}`);
      case 'input_disabled':
      case 'stop_pending':
        this.halt('blocked', 'write_gate_closed', `${what}: ${error.code}`);
      case 'capability_missing':
      case 'unsupported_backend':
        this.halt('blocked', 'capability_missing', `${what}: ${error.code}`);
      case 'pairing_required':
      case 'grant_missing':
      case 'grant_expired':
      case 'client_revoked':
        this.halt('blocked', 'pairing_missing', `${what}: ${error.code}`);
      default:
        this.halt('failed', undefined, `${what}: ${error.code}: ${error.message}`);
    }
  }

  private driverFailure(e: unknown, what: string): never {
    if (e instanceof DriverError) this.haltForDriverError(e.error, what);
    throw e;
  }
}

/** The dialog WeChat may show after accepting (remark/tags); only these texts and buttons are allowed to be dismissed. */
export const FINISH_BUTTONS = ['完成', '确定'] as const;
export const ACCEPT_BUTTONS = ['接受', '通过验证'] as const;
export const BENIGN_DIALOG_TEXT = /^(设置?备注(和标签)?|备注|标签|朋友权限|仅聊天|聊天、朋友圈、微信运动等|添加标签|完成|确定|取消)$/;
