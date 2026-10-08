// AcceptRequest: locate the approved row, open its detail, ask for approval,
// re-observe, verify before writing, click accept once, dismiss only the
// known follow-up dialog, then confirm from the same identity turning 已添加.

import type { ApprovalRequest, BusinessApproval, DomainResult, Handler, HandlerContext, RequestRow, WeChatTask } from '@wechat-agent/ports';
import { errorTextOf, isDialog, openNewFriends, stopOnDialog } from './navigate.ts';
import { ACCEPT_BUTTONS, BENIGN_DIALOG_TEXT, FINISH_BUTTONS, Flow, type ActOutcome, type ApprovalExpectation, type FlowOptions, type Scene } from './steps.ts';
import { anyText, center, findButton, normLabel, sameLabel, sha256 } from './text.ts';

const MIN_IDENTITY_CONFIDENCE = 0.6;
const VERIFY_ROUNDS = 4;

export function createAcceptRequestHandler(options: FlowOptions): Handler<'accept_request'> {
  return {
    type: 'accept_request',
    requires: { methods: ['observe', 'act', 'artifact.read'], actions: ['accept_request', 'navigate', 'read'] },
    run(task: WeChatTask & { type: 'accept_request' }, ctx: HandlerContext): Promise<DomainResult> {
      return Flow.run(ctx, task, options, async (flow) => acceptRequest(flow, task));
    },
  };
}

function rowsFor(scene: Scene, requestKey: string): RequestRow[] {
  return (scene.facts.requests ?? []).filter((r) => r.rowKey === requestKey);
}

/** The row for this task, or a halt: missing, duplicated, or already settled rows are never clicked. */
function locateRow(flow: Flow, scene: Scene, requestKey: string): RequestRow {
  const rows = rowsFor(scene, requestKey);
  if (rows.length === 0) {
    if (scene.facts.coverage === 'end_confirmed') flow.halt('no_op', 'not_found', `no row ${requestKey} in the whole list`);
    flow.halt('ambiguous', 'coverage_partial', `row ${requestKey} is not in the current viewport; the list was not read to its end`);
  }
  if (rows.length > 1) flow.halt('ambiguous', 'target_ambiguous', `${rows.length} rows share key ${requestKey}`);
  const row = rows[0];
  switch (row.status) {
    case 'pending':
      break;
    case 'added':
      flow.halt('no_op', 'already_friend', `${row.name} is already added`);
    case 'expired':
      flow.halt('no_op', 'request_expired', `${row.name}'s request expired`);
    case 'rejected':
      flow.halt('no_op', 'request_expired', `${row.name}'s request was rejected`);
    case 'waiting_verification':
      flow.halt('no_op', 'request_expired', `${row.name} is waiting for the other side's verification; nothing to accept`);
    default:
      flow.halt('ambiguous', 'identity_unproven', `${row.name}'s status could not be read`);
  }
  if (row.confidence < MIN_IDENTITY_CONFIDENCE) flow.halt('ambiguous', 'identity_unproven', `row ${requestKey} read with confidence ${row.confidence}`);
  return row;
}

async function acceptRequest(flow: Flow, task: WeChatTask & { type: 'accept_request' }): Promise<DomainResult> {
  const payload = task.payload;
  if (payload.kind !== 'accept_request') flow.halt('failed', undefined, 'payload is not an accept_request');
  const requestKey = payload.requestKey;

  // 1. list → row
  const list = await openNewFriends(flow);
  const row = locateRow(flow, list, requestKey);
  await flow.fact('request_read', 'observed', { rowKey: row.rowKey, name: row.name, note: row.note, status: row.status }, { evidenceIds: [list.evidenceId], confidence: row.confidence });

  // 2. open the detail pane
  await flow.act('open_detail', { kind: 'click', target: { imagePoint: center(row.rect) } }, list);
  await flow.settle();
  const opened = await flow.observe();
  stopOnDialog(flow, opened);
  const detail = opened.facts.detail;
  if (opened.facts.page !== 'request_detail' || !detail) flow.halt('failed', 'verification_missing', `the request detail did not open (page ${opened.facts.page})`);
  if (!sameLabel(detail.name, row.name)) flow.halt('ambiguous', 'target_ambiguous', `detail shows ${detail.name}, list row says ${row.name}`);
  await flow.fact('request_read', 'observed', { rowKey: requestKey, name: detail.name, wechatId: detail.wechatId, region: detail.region, message: detail.message }, { evidenceIds: [opened.evidenceId], confidence: detail.confidence });

  // 3. approval for this identity and this action
  const contentHash = sha256(`accept_request\u0000${requestKey}\u0000${normLabel(detail.name)}\u0000${detail.wechatId ?? ''}`);
  const expectation: ApprovalExpectation = { action: 'accept_request', contentHash, targetRevision: task.targetRevision ?? 0 };
  const request: ApprovalRequest = {
    taskId: task.taskId, allowedAction: 'accept_request', accountRevision: flow.ctx.account.revision, targetRevision: expectation.targetRevision,
    draftRevision: 0, contentHash,
    summary: {
      targetLabel: detail.name, visibleIdentifier: detail.wechatId, contentPreview: detail.message, evidenceIds: [list.evidenceId, opened.evidenceId],
      identityConfidence: Math.min(row.confidence, detail.confidence),
    },
  };
  flow.checkSignal();
  const decision = await flow.ctx.requestApproval(request);
  if (decision.kind === 'rejected') return flow.result('no_op', undefined, 'the person rejected the request');
  if (decision.kind === 'skipped') return flow.result('no_op', undefined, 'the person skipped the request');
  if (decision.kind === 'cancelled') return flow.result('no_op', 'cancelled', 'approval cancelled');
  const approval = decision.approval;

  // 4. re-observe; verify before write with the fresh scene only (old coordinates are never reused)
  const fresh = await flow.observe();
  stopOnDialog(flow, fresh);
  flow.requireSameWindow(fresh);
  flow.requireApprovalValid(approval, expectation);
  const target = locateAcceptControl(flow, fresh, row, requestKey);

  // 5. persist + dispatch the one dangerous click
  await flow.consumeApproval(approval, expectation);
  const click = await flow.act('accept', { kind: 'click', target: { imagePoint: target } }, fresh, true);

  // 6. follow-up dialogs and business verification
  return verifyAccepted(flow, approval, expectation, requestKey, row, click);
}

/** Where the accept control is in the re-observed scene: the detail button, or the row's own control when the list is showing. */
function locateAcceptControl(flow: Flow, fresh: Scene, row: RequestRow, requestKey: string): { x: number; y: number } {
  const facts = fresh.facts;
  if (facts.page === 'request_detail' && facts.detail) {
    if (!sameLabel(facts.detail.name, row.name)) flow.halt('ambiguous', 'target_ambiguous', `detail now shows ${facts.detail.name}, not ${row.name}`);
    if (facts.detail.buttons.some((b) => sameLabel(b.text, '发消息'))) flow.halt('no_op', 'already_friend', `${row.name} is already a friend`);
    const button = findButton(facts, ACCEPT_BUTTONS);
    if (button) return center(button.rect);
    const text = errorTextOf(facts);
    if (text) flow.halt('no_op', 'request_expired', `WeChat says: ${text}`);
  }
  if (facts.requests) {
    const again = locateRow(flow, fresh, requestKey);
    if (again.actionRect) return center(again.actionRect);
  }
  flow.halt('blocked', 'verification_missing', `no accept control is visible for ${row.name} after re-observing (page ${facts.page})`);
}

async function verifyAccepted(flow: Flow, approval: BusinessApproval, expectation: ApprovalExpectation, requestKey: string, row: RequestRow, click: ActOutcome): Promise<DomainResult> {
  let dialogs = 0;
  for (let round = 0; round < VERIFY_ROUNDS; round++) {
    await flow.settle();
    const scene = await flow.observe();
    const facts = scene.facts;
    if (isDialog(facts)) {
      const finish = findButton(facts, FINISH_BUTTONS);
      const foreign = facts.texts.filter((t) => !BENIGN_DIALOG_TEXT.test(normLabel(t.text)) && !sameLabel(t.text, row.name));
      if (!finish || foreign.length > 0 || anyText(facts, /已过期|已被拒绝|操作失败|频繁|异常|失败/)) {
        stopOnDialog(flow, scene);
        flow.halt('needs_reconciliation', 'unexpected_dialog', 'dialog is not the known remark/tag sheet');
      }
      if (++dialogs > 2) flow.halt('needs_reconciliation', 'unexpected_dialog', 'the follow-up dialog keeps reappearing');
      // The approval covered the accept; the dialog click only closes WeChat's own remark/tag sheet.
      flow.requireSameWindow(scene);
      flow.requireApprovalValid(approval, expectation, true);
      await flow.act(`finish_dialog:${dialogs}`, { kind: 'click', target: { imagePoint: center(finish.rect) } }, scene, true);
      continue;
    }
    const verdict = acceptedVerdict(facts, requestKey, row);
    if (verdict === 'added') {
      await flow.settleAttempt(click, 'verified', 'accepted');
      await flow.fact('request_status', 'confirmed', { rowKey: requestKey, name: row.name, status: 'added' }, { evidenceIds: [scene.evidenceId], confidence: facts.confidence });
      await flow.fact('friend_added', 'confirmed', { rowKey: requestKey, name: row.name }, { evidenceIds: [scene.evidenceId], confidence: facts.confidence });
      return flow.result('confirmed', undefined, `${row.name} is now added`);
    }
    if (verdict === 'error') {
      await flow.settleAttempt(click, 'unknown', errorTextOf(facts) ?? 'error text');
      return flow.result('needs_reconciliation', 'unexpected_dialog', `WeChat says: ${errorTextOf(facts)}`);
    }
  }
  await flow.settleAttempt(click, 'unknown', 'no 已添加 for the same identity after the click');
  return flow.result('needs_reconciliation', 'verification_missing', `${row.name} did not turn 已添加 within ${VERIFY_ROUNDS} observations; a missing row does not count`);
}

function acceptedVerdict(facts: Scene['facts'], requestKey: string, row: RequestRow): 'added' | 'pending' | 'error' | 'unknown' {
  if (errorTextOf(facts)) return 'error';
  const sameRow = (facts.requests ?? []).filter((r) => r.rowKey === requestKey);
  if (sameRow.length === 1 && sameRow[0].status === 'added') return 'added';
  if (sameRow.length === 1 && sameRow[0].status === 'pending') return 'pending';
  const detail = facts.detail;
  if ((facts.page === 'request_detail' || facts.page === 'contact_detail') && detail && sameLabel(detail.name, row.name)
    && detail.buttons.some((b) => sameLabel(b.text, '发消息')) && !findButton(facts, ACCEPT_BUTTONS)) return 'added';
  return 'unknown';
}
