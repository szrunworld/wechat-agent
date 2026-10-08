// Lane H's minimal handler stubs. They exist only to walk the ports in the
// order of 方案 §09 (observe → approve → re-observe → verify-before-write →
// persist requestId → act → receipt → business-verify → facts) so the
// vertical slice and the fault matrix can run before lane D merges. Nothing
// here navigates, retries, or knows WeChat; swap for lane D's
// `createHandlers()` in wiring.ts and the tests stay the same.
import { createHash } from 'node:crypto';
import { DriverError, LedgerConflictError, WriteGateClosedError } from '@wechat-agent/ports';
import type {
  ActionReceipt, DomainFact, DomainReasonCode, DomainResult, Handler, HandlerContext, HandlerRegistry, Id, ImageMeta, Observation,
  PageFacts, RequestRow, WeChatTask,
} from '@wechat-agent/ports';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

type Read = { ok: true; observation: Observation; facts: PageFacts; evidenceId: Id } | { ok: false; result: DomainResult };

const result = (outcome: DomainResult['outcome'], reasonCode?: DomainReasonCode, facts: DomainFact[] = [], evidenceIds: Id[] = []): DomainResult =>
  ({ outcome, reasonCode, reason: reasonCode, facts, evidenceIds });

async function observeAndRead(ctx: HandlerContext): Promise<Read> {
  const observation = await ctx.driver.observe({ sessionId: ctx.session.sessionId, runId: ctx.session.runId }, { screenshot: true, elements: false });
  const image = observation.image;
  if (!image) return { ok: false, result: result('blocked', 'layout_unreadable') };
  const meta: ImageMeta = {
    width: image.width, height: image.height, scale: image.transform.scale, artifactId: image.artifactId, sha256: image.sha256,
    windowFrame: observation.target ? { width: observation.target.windowFrame.width, height: observation.target.windowFrame.height } : undefined,
    windowTitle: observation.target?.title,
  };
  const fit = ctx.recognizer.applicability(meta);
  if (!fit.applicable) return { ok: false, result: result('blocked', 'layout_unreadable') };
  const facts = await ctx.recognizer.recognize(meta, fit.profile);
  const evidence = await ctx.ledger.putEvidence({
    artifactId: image.artifactId, sha256: image.sha256, captureTime: observation.capturedAt, coverage: facts.coverage,
    retentionUntil: new Date(Date.parse(ctx.now()) + 7 * 86_400_000).toISOString(),
  });
  if (facts.coverage === 'unreadable') return { ok: false, result: result('blocked', 'layout_unreadable', [], [evidence.evidenceId]) };
  return { ok: true, observation, facts, evidenceId: evidence.evidenceId };
}

function findRows(facts: PageFacts, requestKey: string): RequestRow[] {
  return (facts.requests ?? []).filter((r) => r.rowKey === requestKey);
}

const center = (r: { x: number; y: number; width: number; height: number }) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });

const readRequests: Handler<'read_requests'> = {
  type: 'read_requests',
  requires: { methods: ['observe', 'artifact.read'], actions: ['read'] },
  async run(task, ctx) {
    const read = await observeAndRead(ctx);
    if (!read.ok) return read.result;
    const rows = read.facts.requests ?? [];
    const fact = await ctx.ledger.appendFact({
      taskId: task.taskId, factKind: 'list_read', outcome: 'observed', evidenceIds: [read.evidenceId], observedAt: ctx.now(), confidence: read.facts.confidence,
      data: { page: read.facts.page, coverage: read.facts.coverage, rows: rows.map((r) => ({ rowKey: r.rowKey, status: r.status, confidence: r.confidence })) },
    });
    // A viewport is not the whole list: the fact carries coverage; the outcome never claims "all handled".
    return result('confirmed', undefined, [fact], [read.evidenceId]);
  },
};

const acceptRequest: Handler<'accept_request'> = {
  type: 'accept_request',
  requires: { methods: ['observe', 'act', 'request.show'], actions: ['accept_request'] },
  async run(task: WeChatTask & { type: 'accept_request' }, ctx: HandlerContext) {
    if (task.payload.kind !== 'accept_request') return result('failed', 'content_mismatch');
    const key = task.payload.requestKey;
    const { ledger, driver } = ctx;
    const { sessionId, runId } = ctx.session;

    // 1. prepare: read the list, locate the request, decide if there is anything to do.
    const before = await observeAndRead(ctx);
    if (!before.ok) return before.result;
    const rows = findRows(before.facts, key);
    if (rows.length === 0) return result('no_op', 'not_found', [], [before.evidenceId]);
    if (rows.length > 1) return result('ambiguous', 'target_ambiguous', [], [before.evidenceId]);
    const row = rows[0];
    if (row.status === 'added') return result('no_op', 'already_friend', [], [before.evidenceId]);
    if (row.status === 'expired') return result('no_op', 'request_expired', [], [before.evidenceId]);
    if (row.status !== 'pending' || !row.actionRect) return result('ambiguous', 'target_ambiguous', [], [before.evidenceId]);

    // 2. approve: one approval per action, bound to what the person saw.
    const contentHash = sha256(`accept:${key}:${row.name}:${row.note}`);
    const decision = await ctx.requestApproval({
      taskId: task.taskId, allowedAction: 'accept_request', accountRevision: ctx.account.revision, targetRevision: task.targetRevision ?? 0,
      draftRevision: 0, contentHash,
      summary: { targetLabel: row.name, contentPreview: row.note, evidenceIds: [before.evidenceId], identityConfidence: row.confidence },
    });
    if (decision.kind === 'cancelled') return result('failed', 'cancelled', [], [before.evidenceId]);
    if (decision.kind !== 'approved') return result('no_op', 'cancelled', [], [before.evidenceId]);
    if (ctx.signal.aborted) return result('failed', 'cancelled', [], [before.evidenceId]);

    // 3. re-observe after the wait (T21): never act on the pre-approval snapshot.
    const after = await observeAndRead(ctx);
    if (!after.ok) return after.result;
    const fresh = findRows(after.facts, key);
    if (fresh.length !== 1) return result(fresh.length === 0 ? 'no_op' : 'ambiguous', fresh.length === 0 ? 'not_found' : 'target_ambiguous', [], [after.evidenceId]);
    const target = fresh[0];
    if (target.status === 'added') return result('no_op', 'already_friend', [], [after.evidenceId]);
    if (target.status !== 'pending' || !target.actionRect) return result('no_op', 'request_expired', [], [after.evidenceId]);
    if (after.observation.target?.windowId !== before.observation.target?.windowId) return result('blocked', 'unexpected_dialog', [], [after.evidenceId]);

    // 4. verify-before-write: same account revision, approval still valid, write gate open.
    const account = await ledger.getAccount();
    if (!account || account.revision !== decision.approval.accountRevision) return result('blocked', 'account_changed', [], [after.evidenceId]);
    try {
      await ledger.consumeApproval(decision.approval.approvalId, { taskId: task.taskId, contentHash, targetRevision: task.targetRevision ?? 0, accountRevision: account.revision }, ctx.now());
    } catch (e) {
      if (e instanceof LedgerConflictError) return result('blocked', e.message.includes('expired') ? 'approval_expired' : 'approval_invalid', [], [after.evidenceId]);
      throw e;
    }
    try {
      ctx.writeGate.ensureOpen();
    } catch (e) {
      if (e instanceof WriteGateClosedError) return result('blocked', e.why === 'account_changed' ? 'account_changed' : 'write_gate_closed', [], [after.evidenceId]);
      throw e;
    }

    // 5. persist the requestId before the platform sees it; it is never swapped.
    const attempt = await ledger.prepareAttempt({ taskId: task.taskId, stepId: 'accept_click', sessionId, runId }, ctx.now());
    const requestId = ctx.newId();
    const params = { snapshotId: after.observation.snapshotId, action: { kind: 'click' as const, target: { imagePoint: center(target.actionRect) } } };
    await ledger.markDispatching(attempt.attemptId, { requestId, canonicalDigest: sha256(JSON.stringify(params)), snapshotId: params.snapshotId, sessionId, runId }, ctx.now());

    // 6. dispatch.
    let receipt: ActionReceipt;
    try {
      receipt = await driver.act({ sessionId, runId }, params, requestId);
    } catch (e) {
      if (!(e instanceof DriverError)) throw e;
      const notSent = e.error.notSent === true;
      await ledger.markUnknown(attempt.attemptId, notSent ? `not_sent:${e.error.code}` : e.error.code, ctx.now());
      const fact = await ledger.appendFact({
        taskId: task.taskId, factKind: 'platform_receipt', outcome: notSent ? 'failed' : 'needs_reconciliation', evidenceIds: [after.evidenceId],
        observedAt: ctx.now(), confidence: 1, reason: e.error.code,
        data: { attemptId: attempt.attemptId, requestId, runId, code: e.error.code, phase: e.error.phase, notSent },
      });
      // Proven not sent: the intent may be planned again. Otherwise the platform may have acted: reconcile by requestId, never re-dispatch.
      return result(notSent ? 'failed' : 'needs_reconciliation', ['connection_lost', 'runtime_offline'].includes(e.error.code) ? 'disconnected' : 'platform_unknown', [fact], [after.evidenceId]);
    }

    // 7. receipt: a platform receipt is not a business result.
    await ledger.recordReceipt(attempt.attemptId, receipt.receiptId, receipt as unknown as Record<string, unknown>, ctx.now());
    const receiptFact = await ledger.appendFact({
      taskId: task.taskId, factKind: 'platform_receipt', outcome: 'observed', evidenceIds: [after.evidenceId], observedAt: ctx.now(), confidence: 1,
      data: { attemptId: attempt.attemptId, requestId, runId, receiptId: receipt.receiptId, delivery: receipt.delivery, execution: receipt.execution },
    });
    if (receipt.delivery !== 'dispatched' || receipt.execution !== 'completed') {
      await ledger.markUnknown(attempt.attemptId, `${receipt.delivery}/${receipt.execution}`, ctx.now());
      return result('needs_reconciliation', 'platform_unknown', [receiptFact], [after.evidenceId]);
    }

    // 8. business-verify: the same identity now shows as added; a vanished row proves nothing.
    const verify = await observeAndRead(ctx);
    if (!verify.ok) {
      await ledger.markUnknown(attempt.attemptId, 'verification_unreadable', ctx.now());
      return result('needs_reconciliation', 'verification_missing', [receiptFact], [after.evidenceId]);
    }
    const settled = findRows(verify.facts, key);
    if (settled.length === 1 && settled[0].status === 'added' && settled[0].name === target.name) {
      await ledger.markVerified(attempt.attemptId, ctx.now());
      const fact = await ledger.appendFact({
        taskId: task.taskId, factKind: 'friend_added', outcome: 'confirmed', evidenceIds: [after.evidenceId, verify.evidenceId], observedAt: ctx.now(),
        confidence: settled[0].confidence, data: { attemptId: attempt.attemptId, requestId, name: settled[0].name, rowKey: key },
      });
      return result('confirmed', undefined, [receiptFact, fact], [after.evidenceId, verify.evidenceId]);
    }
    await ledger.markUnknown(attempt.attemptId, 'no_added_evidence', ctx.now());
    const fact = await ledger.appendFact({
      taskId: task.taskId, factKind: 'request_status', outcome: 'needs_reconciliation', evidenceIds: [verify.evidenceId], observedAt: ctx.now(), confidence: verify.facts.confidence,
      reason: 'verification_missing', data: { attemptId: attempt.attemptId, requestId, rows: settled.map((r) => r.status) },
    });
    return result('needs_reconciliation', 'verification_missing', [receiptFact, fact], [after.evidenceId, verify.evidenceId]);
  },
};

export function createStubHandlers(): HandlerRegistry {
  const all: Handler[] = [readRequests as Handler, acceptRequest as Handler];
  return {
    get<T extends WeChatTask['type']>(type: T) { return all.find((h) => h.type === type) as Handler<T> | undefined; },
    all() { return all; },
  };
}
