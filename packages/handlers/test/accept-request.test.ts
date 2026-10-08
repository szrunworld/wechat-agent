import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageFacts, RequestStatus } from '@wechat-agent/ports';
import { acts, attemptsFor, button, clickPoints, facts, harness, mid, observation, r, text } from './helpers.ts';

const KEY = '陈一|我是陈一';
const ROW_RECT = r(40, 200, 300, 60);
const ACTION_RECT = r(300, 210, 48, 24);
const ACCEPT_RECT = r(900, 600, 80, 32);
const row = (status: RequestStatus, over: Record<string, unknown> = {}) => ({ name: '陈一', note: '我是陈一', status, rect: ROW_RECT, actionRect: status === 'pending' ? ACTION_RECT : undefined, confidence: 0.95, rowKey: KEY, ...over });
const list = (status: RequestStatus, coverage: PageFacts['coverage'] = 'end_confirmed') => facts({ page: 'new_friends', coverage, requests: [row(status)] });
const detail = (buttons = [button('接受', ACCEPT_RECT)], name = '陈一') => facts({ page: 'request_detail', requests: [row('pending')], detail: { name, wechatId: 'chen_one', region: '广东 深圳', message: '我是陈一', buttons, confidence: 0.92 } });
const task = { type: 'accept_request' as const, payload: { kind: 'accept_request' as const, requestKey: KEY } };

test('accept: approval → re-observe → one click → remark sheet 完成 → the same identity turns 已添加', async () => {
  const finish = button('完成', r(700, 700, 80, 32));
  const h = await harness({
    task,
    facts: [list('pending'), detail(), detail(), facts({ page: 'dialog', texts: [text('设置备注和标签'), text('陈一')], buttons: [finish, button('取消', r(600, 700, 80, 32))] }), list('added')],
  });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed', result.reason);
  assert.deepEqual(clickPoints(h.driver), [mid(ROW_RECT), mid(ACCEPT_RECT), mid(finish.rect)]);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].summary.targetLabel, '陈一');
  assert.equal(h.approvals[0].summary.visibleIdentifier, 'chen_one');
  assert.equal(h.approvals[0].summary.contentPreview, '我是陈一');
  assert.equal(h.approvals[0].summary.evidenceIds.length, 2);
  assert.ok(h.granted[0].consumedAt, 'the approval was consumed before the click');
  const accept = attemptsFor(h.ledger, 'accept');
  assert.equal(accept.length, 1);
  assert.equal(accept[0].state, 'verified');
  assert.equal(accept[0].requestId, acts(h.driver)[1].requestId);
  assert.deepEqual(result.facts.filter((f) => f.outcome === 'confirmed').map((f) => f.factKind).sort(), ['friend_added', 'request_status']);
  // the dangerous click came after the third observe (the one after the approval) and used that snapshot, not the detail's
  const order = h.driver.calls.map((c) => c.method);
  const thirdObserve = order.indexOf('observe', order.indexOf('observe', order.indexOf('observe') + 1) + 1);
  const acceptCall = order.indexOf('act', order.indexOf('act') + 1);
  assert.ok(thirdObserve >= 0 && acceptCall > thirdObserve, `accept act at ${acceptCall} must follow the post-approval observe at ${thirdObserve}`);
  assert.notEqual(acts(h.driver)[1].snapshotId, acts(h.driver)[0].snapshotId);
  assert.deepEqual(await h.ledger.findOpenAttempts(), [], 'no attempt is left half-open');
});

test('T16: an already added or expired request is a no_op with no click and no approval', async () => {
  for (const [status, code] of [['added', 'already_friend'], ['expired', 'request_expired'], ['rejected', 'request_expired']] as const) {
    const h = await harness({ task, facts: [list(status)] });
    const result = await h.run();
    assert.equal(result.outcome, 'no_op', status);
    assert.equal(result.reasonCode, code);
    assert.equal(acts(h.driver).length, 0);
    assert.equal(h.approvals.length, 0);
  }
});

test('T16: a request that turns 已添加 while waiting for approval is a no_op; the approval is not consumed', async () => {
  const h = await harness({ task, facts: [list('pending'), detail(), list('added')] });
  const result = await h.run();
  assert.equal(result.outcome, 'no_op');
  assert.equal(result.reasonCode, 'already_friend');
  assert.equal(acts(h.driver).length, 1, 'only the row was opened');
  assert.equal(h.granted[0].consumedAt, undefined);
});

test('T19: an error window after the click stops the flow; no further act, attempt unknown', async () => {
  const h = await harness({ task, facts: [list('pending'), detail(), detail(), facts({ page: 'dialog', texts: [text('操作失败')], buttons: [button('确定', r(500, 500))] })] });
  const result = await h.run();
  assert.equal(result.outcome, 'needs_reconciliation');
  assert.equal(result.reasonCode, 'unexpected_dialog');
  assert.equal(acts(h.driver).length, 2, 'row open + accept, nothing after the error window');
  assert.equal(attemptsFor(h.ledger, 'accept')[0].state, 'unknown');
  assert.equal(attemptsFor(h.ledger, 'open_detail')[0].state, 'verified', 'the navigation click is settled by the observe after it');
  assert.deepEqual(await h.ledger.findOpenAttempts(), []);
});

test('T19: an unknown question dialog with a 确定 button is not clicked either; 频繁 is rate_limited', async () => {
  const unknown = await harness({ task, facts: [list('pending'), detail(), detail(), facts({ page: 'dialog', texts: [text('是否同时设为星标朋友？')], buttons: [button('确定', r(500, 500)), button('取消', r(400, 500))] })] });
  const ru = await unknown.run();
  assert.equal(ru.outcome, 'needs_reconciliation');
  assert.equal(ru.reasonCode, 'unexpected_dialog');
  assert.equal(acts(unknown.driver).length, 2);
  const busy = await harness({ task, facts: [list('pending'), detail(), detail(), facts({ page: 'dialog', texts: [text('操作过于频繁，请稍后再试')], buttons: [button('确定', r(500, 500))] })] });
  const rb = await busy.run();
  assert.equal(rb.outcome, 'needs_reconciliation');
  assert.equal(rb.reasonCode, 'rate_limited');
  assert.equal(acts(busy.driver).length, 2);
});

test('T21: the page moved during approval → the click uses the re-observed coordinates, never the old ones', async () => {
  const moved = r(700, 500, 80, 32);
  const h = await harness({ task, facts: [list('pending'), detail(), detail([button('接受', moved)]), list('added')] });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed', result.reason);
  const points = clickPoints(h.driver);
  assert.deepEqual(points[1], mid(moved));
  assert.notDeepEqual(points[1], mid(ACCEPT_RECT));
  assert.equal(h.driver.countCalls('observe'), 4);
});

test('T21: the detail closed during approval → the row control from the fresh list is used; a foreign page blocks', async () => {
  const fresh = await harness({ task, facts: [list('pending'), detail(), list('pending'), list('added')] });
  const rf = await fresh.run();
  assert.equal(rf.outcome, 'confirmed', rf.reason);
  assert.deepEqual(clickPoints(fresh.driver)[1], mid(ACTION_RECT));
  const foreign = await harness({ task, facts: [list('pending'), detail(), facts({ page: 'chats' })] });
  const rr = await foreign.run();
  assert.equal(rr.outcome, 'blocked');
  assert.equal(rr.reasonCode, 'verification_missing');
  assert.equal(acts(foreign.driver).length, 1);
  assert.equal(foreign.granted[0].consumedAt, undefined);
});

test('a dropped connection after dispatch → attempt unknown → needs_reconciliation, and the same requestId is never re-sent', async () => {
  const h = await harness({
    task, facts: [list('pending'), detail(), detail(), list('added')],
    driver: { faults: [{ method: 'act', onCall: 2, error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] },
  });
  const result = await h.run();
  assert.equal(result.outcome, 'needs_reconciliation');
  assert.equal(result.reasonCode, 'disconnected');
  const sent = acts(h.driver);
  assert.equal(sent.length, 2, 'no re-dispatch after the drop');
  const accept = attemptsFor(h.ledger, 'accept');
  assert.equal(accept.length, 1, 'one attempt for the accept step');
  assert.equal(accept[0].state, 'unknown');
  assert.equal(accept[0].requestId, sent[1].requestId);
  assert.equal(h.driver.state, 'disconnected');
  assert.ok(result.facts.some((f) => f.factKind === 'platform_receipt' && f.outcome === 'needs_reconciliation'));
  assert.match(result.reason ?? '', /not re-sent/);
});

test('notSent=true is re-plannable: blocked, no reconciliation, attempt closed with a not_sent reason', async () => {
  const h = await harness({
    task, facts: [list('pending'), detail(), detail()],
    driver: { faults: [{ method: 'act', onCall: 2, error: { code: 'input_disabled', phase: 'request', retryable: true, notSent: true } }] },
  });
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'write_gate_closed');
  assert.equal(acts(h.driver).length, 2);
  assert.equal(attemptsFor(h.ledger, 'accept')[0].state, 'unknown');
});

test('a closed write gate blocks before the dangerous click, after the approval was consumed check', async () => {
  const h = await harness({ task, facts: [list('pending'), detail(), detail()], writeGateOpen: false });
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'write_gate_closed');
  assert.equal(acts(h.driver).length, 0, 'navigation is gated too');
});

test('account revision mismatch, expired approval, rejection and cancellation never click', async () => {
  const changed = await harness({ task, facts: [list('pending'), detail(), detail()], account: { revision: 2 } });
  const rc = await changed.run();
  assert.equal(rc.outcome, 'blocked');
  assert.equal(rc.reasonCode, 'account_changed');
  assert.equal(acts(changed.driver).length, 1);

  const expired = await harness({ task, facts: [list('pending'), detail(), detail()], expiresAt: '2026-10-08T09:00:00+08:00' });
  const re = await expired.run();
  assert.equal(re.outcome, 'blocked');
  assert.equal(re.reasonCode, 'approval_expired');
  assert.equal(acts(expired.driver).length, 1);

  const rejected = await harness({ task, facts: [list('pending'), detail()], decide: () => ({ kind: 'rejected' }) });
  const rr = await rejected.run();
  assert.equal(rr.outcome, 'no_op');
  assert.equal(acts(rejected.driver).length, 1);

  const cancelled = await harness({ task, facts: [list('pending')] });
  cancelled.abort.abort();
  const rx = await cancelled.run();
  assert.equal(rx.outcome, 'no_op');
  assert.equal(rx.reasonCode, 'cancelled');
  assert.equal(cancelled.driver.countCalls('observe'), 0);
});

test('the approval is re-read from the ledger before the click: a consumed or missing one blocks', async () => {
  const consumed = await harness({
    task, facts: [list('pending'), detail(), detail()],
    decide: async (request, h) => {
      const approval = await h.ledger.recordApproval({ taskId: request.taskId, accountRevision: request.accountRevision, targetRevision: request.targetRevision, draftRevision: request.draftRevision, contentHash: request.contentHash, allowedAction: request.allowedAction, expiresAt: '2026-10-08T11:00:00+08:00', createdAt: '2026-10-08T10:00:00+08:00' });
      await h.ledger.consumeApproval(approval.approvalId, { taskId: request.taskId, contentHash: request.contentHash, targetRevision: request.targetRevision, accountRevision: request.accountRevision }, '2026-10-08T10:00:01+08:00');
      return { kind: 'approved', approval: { ...approval, consumedAt: undefined } };
    },
  });
  const rc = await consumed.run();
  assert.equal(rc.outcome, 'blocked');
  assert.equal(rc.reasonCode, 'approval_invalid');
  assert.equal(acts(consumed.driver).length, 1);
  const missing = await harness({
    task, facts: [list('pending'), detail(), detail()],
    decide: (request) => ({ kind: 'approved', approval: { approvalId: 'appr_ghost', taskId: request.taskId, accountRevision: request.accountRevision, targetRevision: request.targetRevision, draftRevision: request.draftRevision, contentHash: request.contentHash, allowedAction: request.allowedAction, expiresAt: '2026-10-08T11:00:00+08:00', createdAt: '2026-10-08T10:00:00+08:00' } }),
  });
  const rm = await missing.run();
  assert.equal(rm.outcome, 'blocked');
  assert.equal(rm.reasonCode, 'approval_invalid');
  assert.equal(acts(missing.driver).length, 1);
});

test('a window change during approval blocks the write', async () => {
  const other = observation({ target: { generation: 2, process: { pid: 999, startedAt: null }, windowId: 12, windowFrame: { x: 0, y: 25, width: 1280, height: 875 }, title: '微信' } });
  const h = await harness({ task, facts: [list('pending'), detail(), detail()], observations: [observation(), observation(), other] });
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'approval_invalid');
  assert.match(result.reason ?? '', /window changed/);
  assert.equal(acts(h.driver).length, 1);
});

test('missing, duplicated or unreadable rows are never clicked', async () => {
  const gone = await harness({ task, facts: [facts({ page: 'new_friends', coverage: 'end_confirmed', requests: [] })] });
  assert.deepEqual([(await gone.run()).outcome, (await gone.run()).reasonCode], ['no_op', 'not_found']);
  const partial = await harness({ task, facts: [facts({ page: 'new_friends', coverage: 'partial', requests: [] })] });
  const rp = await partial.run();
  assert.equal(rp.outcome, 'ambiguous');
  assert.equal(rp.reasonCode, 'coverage_partial');
  const dup = await harness({ task, facts: [facts({ page: 'new_friends', requests: [row('pending'), row('pending', { rect: r(40, 260, 300, 60) })] })] });
  const rd = await dup.run();
  assert.equal(rd.outcome, 'ambiguous');
  assert.equal(rd.reasonCode, 'target_ambiguous');
  const low = await harness({ task, facts: [facts({ page: 'new_friends', requests: [row('pending', { confidence: 0.3 })] })] });
  const rl = await low.run();
  assert.equal(rl.outcome, 'ambiguous');
  assert.equal(rl.reasonCode, 'identity_unproven');
  for (const h of [gone, partial, dup, low]) assert.equal(acts(h.driver).length, 0);
});

test('the detail showing another name is ambiguous; a vanished row after the click is reconciliation, not success', async () => {
  const wrong = await harness({ task, facts: [list('pending'), detail(undefined, '陈一一')] });
  const rw = await wrong.run();
  assert.equal(rw.outcome, 'ambiguous');
  assert.equal(rw.reasonCode, 'target_ambiguous');
  assert.equal(wrong.approvals.length, 0);
  const vanished = await harness({ task, facts: [list('pending'), detail(), detail(), facts({ page: 'new_friends', requests: [] })] });
  const rv = await vanished.run();
  assert.equal(rv.outcome, 'needs_reconciliation');
  assert.equal(rv.reasonCode, 'verification_missing');
  assert.equal(attemptsFor(vanished.ledger, 'accept')[0].state, 'unknown');
  assert.equal(acts(vanished.driver).length, 2);
});
