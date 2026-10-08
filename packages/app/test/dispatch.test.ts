// Intake, approval and policy behaviour: T05, T10, T28, T30, T31 and the
// dedicated "one intent executes once" test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptStub, expectIpc, makeHarness, noFacts, readStub, sendStub, stub, waitFor, waitState } from './harness.ts';

const FAR = '2099-01-01T00:00:00+08:00';

const sendParams = (operationId: string, accountRevision: number, content = '你好', contextRevision = 1, conversation = 'chat_a') => ({
  operationId, type: 'send_message' as const, expectedAccountRevision: accountRevision,
  payload: { kind: 'send_message' as const, conversationTargetId: conversation, content, contentHash: `h:${content}`, contextRevision },
});

async function allowChat(h: Awaited<ReturnType<typeof makeHarness>>, ...ids: string[]) {
  const policy = await h.ledger.getPolicy();
  await h.ledger.setPolicy({ ...policy, allowlist: ids }, policy.revision);
}

test('T05 / one intent executes once: UI and patrol land on the same accept task, one approval, one act, and a later scan does not redo it', async () => {
  const rows = [{ rowKey: 'r1', status: 'pending', name: '陈一' }];
  const h = await makeHarness({ handlers: [readStub(() => rows), acceptStub()], config: { patrolEnabled: true } });
  await h.confirmAccount();
  const account = (await h.ledger.getAccount())!;
  const ui = await h.call('task.create', { operationId: 'ui-accept-r1', type: 'accept_request', expectedAccountRevision: account.revision, payload: { kind: 'accept_request', requestKey: 'r1' } });
  await waitState(h, ui.taskId, 'waiting_approval');

  assert.ok(await h.app.internals.patrol.tick(), 'patrol scan queued');
  await h.idle();
  await waitFor(async () => (await h.ledger.listTasks({ types: ['read_requests'] })).tasks.every((t) => t.state === 'confirmed'), 'scan finished');
  await waitFor(async () => h.app.internals.patrol.lastScanAt !== undefined, 'scan processed');
  const accepts = (await h.ledger.listTasks({ types: ['accept_request'] })).tasks;
  assert.equal(accepts.length, 1, 'the patrol discovery joined the UI task');
  assert.equal(accepts[0]!.taskId, ui.taskId);

  const waiting = await h.call('task.show', { taskId: ui.taskId });
  assert.equal(waiting.target?.displayName, 'r1');
  await h.call('task.approve', { taskId: ui.taskId, approvalRevision: waiting.revision, approvedContentHash: 'accept_request:r1', expiresAt: FAR });
  await waitState(h, ui.taskId, 'confirmed');
  assert.equal(h.acts(), 1);
  const quota = [...h.ledger.quotas.values()];
  assert.equal(quota.length, 1);
  assert.equal(quota[0]!.state, 'consumed');

  // The stub still reports the row as pending (a stale list): the confirmed intent is not executed again.
  await h.app.internals.patrol.tick();
  await h.idle();
  await waitFor(async () => (await h.ledger.listTasks({ types: ['read_requests'] })).tasks.length === 2 && (await h.ledger.listTasks({ types: ['read_requests'] })).tasks.every((t) => t.state === 'confirmed'), 'second scan');
  await new Promise((r) => setImmediate(r));
  assert.equal((await h.ledger.listTasks({ types: ['accept_request'] })).tasks.length, 1);
  assert.equal(h.acts(), 1);
  const snap = await h.snapshot();
  assert.equal(snap.patrol.coverage, 'end_confirmed');
  assert.equal(snap.patrol.visibleSingleChats, 3);
  assert.equal(snap.counts.confirmed, 3);
  await h.app.stop();
});

test('task.create is idempotent on operationId and refuses a changed intent under the same operationId', async () => {
  const h = await makeHarness({ handlers: [sendStub()] });
  await h.confirmAccount();
  await allowChat(h, 'chat_a');
  const account = (await h.ledger.getAccount())!;
  const a = await h.call('task.create', sendParams('op', account.revision));
  const b = await h.call('task.create', sendParams('op', account.revision));
  assert.equal(a.taskId, b.taskId);
  await waitState(h, a.taskId, 'waiting_approval');
  await assert.rejects(h.call('task.create', sendParams('op', account.revision, '另一条')), expectIpc('operation_conflict'));
  await assert.rejects(h.call('task.create', sendParams('op9', account.revision + 1)), expectIpc('revision_conflict'));
  assert.equal(h.acts(), 0);
  await h.app.stop();
});

test('T10: re-confirming the account bumps the revision, closes the gate and voids every older approval', async () => {
  const h = await makeHarness({ handlers: [sendStub()] });
  await h.confirmAccount();
  await allowChat(h, 'chat_a');
  const first = (await h.ledger.getAccount())!;
  assert.equal(first.revision, 1);
  const view = await h.call('task.create', sendParams('op1', first.revision));
  await waitState(h, view.taskId, 'waiting_approval');
  const waiting = await h.call('task.show', { taskId: view.taskId });

  const second = await h.call('account.confirm', { bindingEvidenceId: first.evidenceIds[0]!, expectedRevision: first.revision });
  assert.equal(second.revision, 2);
  assert.equal(second.accountId, first.accountId, 'quota keeps counting on the same local account id');
  let snap = await h.snapshot();
  assert.equal(snap.inputGate, 'closed');
  assert.equal((snap.features.send_message as { reason: string }).reason, 'input_gate_closed');
  const blocked = await h.call('task.show', { taskId: view.taskId });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.stateReason, 'account_changed');
  // The old approval request is void: approving it is refused, nothing is sent.
  await assert.rejects(h.call('task.approve', { taskId: view.taskId, approvalRevision: waiting.revision, approvedContentHash: 'h:你好', expiresAt: FAR }), expectIpc('invalid_state'));
  await assert.rejects(h.call('task.create', sendParams('op2', first.revision)), expectIpc('revision_conflict'));
  assert.equal(h.acts(), 0);
  // The ledger itself refuses approvals recorded under the old revision.
  const stale = await h.ledger.recordApproval({ taskId: view.taskId, accountRevision: first.revision, targetRevision: 1, draftRevision: 0, contentHash: 'h:你好', allowedAction: 'send_message', expiresAt: FAR, createdAt: h.clock.now() });
  await assert.rejects(h.ledger.consumeApproval(stale.approvalId, { taskId: view.taskId, contentHash: 'h:你好', targetRevision: 1, accountRevision: second.revision }, h.clock.now()));

  await h.call('app.resume', { operationId: 'r', expectedRevision: 0 });
  snap = await h.snapshot();
  assert.equal(snap.inputGate, 'open');
  const fresh = await h.call('task.create', sendParams('op3', second.revision));
  await waitState(h, fresh.taskId, 'waiting_approval');
  assert.equal(h.acts(), 0);
  await h.app.stop();
});

test('T28a: a newer contextRevision for the same conversation supersedes the waiting send; the old approval cannot fire', async () => {
  const h = await makeHarness({ handlers: [sendStub()] });
  await h.confirmAccount();
  await allowChat(h, 'chat_a');
  const account = (await h.ledger.getAccount())!;
  const old = await h.call('task.create', sendParams('op1', account.revision, '旧内容', 1));
  await waitState(h, old.taskId, 'waiting_approval');
  const oldWaiting = await h.call('task.show', { taskId: old.taskId });
  const fresh = await h.call('task.create', sendParams('op2', account.revision, '新内容', 2));
  await waitState(h, fresh.taskId, 'waiting_approval');
  const superseded = await h.call('task.show', { taskId: old.taskId });
  assert.equal(superseded.state, 'cancelled');
  assert.equal(superseded.stateReason, 'content_mismatch');
  await assert.rejects(h.call('task.approve', { taskId: old.taskId, approvalRevision: oldWaiting.revision, approvedContentHash: 'h:旧内容', expiresAt: FAR }), expectIpc('invalid_state'));
  assert.equal(h.acts(), 0);
  const freshWaiting = await h.call('task.show', { taskId: fresh.taskId });
  await h.call('task.approve', { taskId: fresh.taskId, approvalRevision: freshWaiting.revision, approvedContentHash: 'h:新内容', expiresAt: FAR });
  await waitState(h, fresh.taskId, 'confirmed');
  assert.equal(h.acts(), 1);
  await h.app.stop();
});

test('T28b: an approval whose content no longer matches is refused and the task is re-reviewed from scratch', async () => {
  const content = { current: 'hash-1' };
  const runs = { count: 0 };
  const h = await makeHarness({ handlers: [sendStub({ contentHash: () => content.current, runs })] });
  await h.confirmAccount();
  await allowChat(h, 'chat_a');
  const account = (await h.ledger.getAccount())!;
  const view = await h.call('task.create', sendParams('op1', account.revision));
  await waitState(h, view.taskId, 'waiting_approval');
  const first = await h.call('task.show', { taskId: view.taskId });
  assert.equal(first.approval, undefined, 'no approval record while waiting');
  assert.equal(first.pendingContentHash, 'hash-1');
  // The context changed under the request: the handler would now compute hash-2.
  content.current = 'hash-2';
  await assert.rejects(h.call('task.approve', { taskId: view.taskId, approvalRevision: first.revision, approvedContentHash: 'hash-2', expiresAt: FAR }), (e: unknown) => {
    expectIpc('blocked')(e);
    assert.equal((e as { error: { details?: { reasonCode?: string } } }).error.details?.reasonCode, 'approval_invalid');
    return true;
  });
  assert.equal(h.acts(), 0);
  await waitFor(async () => runs.count === 2 && (await h.ledger.getTask(view.taskId))?.state === 'waiting_approval', 're-review');
  const second = await h.call('task.show', { taskId: view.taskId });
  assert.equal(second.pendingContentHash, 'hash-2');
  assert.notEqual(second.revision, first.revision);
  assert.ok(second.timeline.some((t) => t.label.includes('重新准备')));
  await h.call('task.approve', { taskId: view.taskId, approvalRevision: second.revision, approvedContentHash: 'hash-2', expiresAt: FAR });
  await waitState(h, view.taskId, 'confirmed');
  assert.equal(h.acts(), 1);
  assert.equal(runs.count, 2);
  await h.app.stop();
});

test('an expired approval is refused and never dispatched', async () => {
  const h = await makeHarness({ handlers: [sendStub()] });
  await h.confirmAccount();
  await allowChat(h, 'chat_a');
  const account = (await h.ledger.getAccount())!;
  const view = await h.call('task.create', sendParams('op1', account.revision));
  await waitState(h, view.taskId, 'waiting_approval');
  const waiting = await h.call('task.show', { taskId: view.taskId });
  await assert.rejects(h.call('task.approve', { taskId: view.taskId, approvalRevision: waiting.revision, approvedContentHash: 'h:你好', expiresAt: '2020-01-01T00:00:00+08:00' }), expectIpc('blocked'));
  await assert.rejects(h.call('task.approve', { taskId: view.taskId, approvalRevision: waiting.revision + 7, approvedContentHash: 'h:你好', expiresAt: FAR }), expectIpc('revision_conflict'));
  assert.equal((await h.call('task.show', { taskId: view.taskId })).state, 'waiting_approval');
  assert.equal(h.acts(), 0);
  await h.app.stop();
});

test('T30: with model upload off a manual draft is still accepted; a model draft is policy_disabled', async () => {
  const reply = stub('reply_draft', ['navigate'], async () => noFacts('waiting_user', { reason: '草稿已写入输入框，等待用户' }), ['observe']);
  const h = await makeHarness({ handlers: [reply, sendStub()] });
  await h.confirmAccount();
  await allowChat(h, 'chat_a');
  const account = (await h.ledger.getAccount())!;
  const snap = await h.snapshot();
  assert.equal(snap.policy.modelUpload, false);
  assert.deepEqual(snap.features.reply_draft, { enabled: true });

  const manual = await h.call('task.create', { operationId: 'd1', type: 'reply_draft', expectedAccountRevision: account.revision, payload: { kind: 'reply_draft', conversationTargetId: 'chat_a', source: 'manual' } });
  await waitState(h, manual.taskId, 'waiting_user');
  const drafted = await h.call('task.draft', { taskId: manual.taskId, text: '明天下午可以。', expectedDraftRevision: 0 });
  assert.deepEqual(drafted.draft, { text: '明天下午可以。', revision: 1, source: 'manual' });
  await assert.rejects(h.call('task.draft', { taskId: manual.taskId, text: '再改一次', expectedDraftRevision: 0 }), expectIpc('revision_conflict'));

  const model = await h.call('task.create', { operationId: 'd2', type: 'reply_draft', expectedAccountRevision: account.revision, payload: { kind: 'reply_draft', conversationTargetId: 'chat_a', source: 'model' } });
  assert.equal(model.state, 'blocked');
  assert.equal(model.stateReason, 'policy_disabled');
  assert.equal(h.acts(), 0);
  await h.app.stop();
});

test('T31: approvals and drafts that arrive after a cancel or during a pause produce no act', async () => {
  const h = await makeHarness({ handlers: [sendStub()] });
  await h.confirmAccount();
  await allowChat(h, 'chat_a');
  const account = (await h.ledger.getAccount())!;

  // Cancelled while waiting: the late approval and the late (model) draft are both refused.
  const a = await h.call('task.create', sendParams('op1', account.revision, '甲'));
  await waitState(h, a.taskId, 'waiting_approval');
  const aWaiting = await h.call('task.show', { taskId: a.taskId });
  const cancelled = await h.call('task.cancel', { taskId: a.taskId, expectedRevision: aWaiting.revision });
  assert.equal(cancelled.state, 'cancelled');
  await assert.rejects(h.call('task.approve', { taskId: a.taskId, approvalRevision: aWaiting.revision, approvedContentHash: 'h:甲', expiresAt: FAR }), expectIpc('invalid_state'));
  await assert.rejects(h.call('task.draft', { taskId: a.taskId, text: '模型晚到的草稿', expectedDraftRevision: 0 }), expectIpc('invalid_state'));
  await h.idle();
  assert.equal(h.acts(), 0);
  assert.ok([...h.ledger.quotas.values()].every((q) => q.state === 'released'));

  // Paused while waiting: approving is refused until resume; nothing is sent meanwhile.
  const b = await h.call('task.create', sendParams('op2', account.revision, '乙'));
  await waitState(h, b.taskId, 'waiting_approval');
  const bWaiting = await h.call('task.show', { taskId: b.taskId });
  const paused = await h.call('app.pause', { operationId: 'p1', expectedRevision: 0 });
  assert.equal(paused.inputGate, 'closed');
  await assert.rejects(h.call('task.approve', { taskId: b.taskId, approvalRevision: bWaiting.revision, approvedContentHash: 'h:乙', expiresAt: FAR }), expectIpc('blocked'));
  assert.equal((await h.call('task.show', { taskId: b.taskId })).state, 'waiting_approval');
  assert.equal(h.acts(), 0);
  await h.call('app.resume', { operationId: 'p2', expectedRevision: 0 });
  await h.call('task.approve', { taskId: b.taskId, approvalRevision: bWaiting.revision, approvedContentHash: 'h:乙', expiresAt: FAR });
  await waitState(h, b.taskId, 'confirmed');
  assert.equal(h.acts(), 1);
  await h.app.stop();
});

test('a conversation outside the allowlist, a missing handler and a missing method are blocked with a reason', async () => {
  const needsRoute = stub('add_friend', ['navigate', 'send_friend_request'], async () => noFacts('confirmed'), ['observe', 'act', 'input.route']);
  const h = await makeHarness({ handlers: [sendStub(), needsRoute] });
  await h.confirmAccount();
  const account = (await h.ledger.getAccount())!;
  const snap = await h.snapshot();
  assert.deepEqual(snap.features.accept_request, { enabled: false, reason: 'capability_missing', detail: '处理器 accept_request 未注册' });
  assert.equal((snap.features.add_friend as { detail: string }).detail, '平台缺少方法：input.route');
  const outside = await h.call('task.create', sendParams('op1', account.revision));
  assert.equal(outside.state, 'blocked');
  assert.equal(outside.stateReason, 'policy_disabled');
  const add = await h.call('task.create', { operationId: 'op2', type: 'add_friend', expectedAccountRevision: account.revision, payload: { kind: 'add_friend', typedId: 'example_wx', idKind: 'wechat_id', note: '你好' } });
  assert.equal(add.state, 'blocked');
  assert.equal(add.stateReason, 'capability_missing');
  assert.equal(h.acts(), 0);
  await h.app.stop();
});
