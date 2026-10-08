// AddFriend: search box → 网络查找 result → profile → 添加到通讯录 → the
// verification sheet, where the note is typed, read back and approved before
// the one dangerous click on 发送. No popup route (CR02) means blocked, never
// a foreground bypass; a default note is never sent.

import type { ApprovalRequest, DomainResult, Handler, HandlerContext, WeChatTask } from '@wechat-agent/ports';
import { errorTextOf, stopOnDialog } from './navigate.ts';
import { Flow, type ApprovalExpectation, type FlowOptions, type Scene } from './steps.ts';
import { anyText, center, findButton, findText, normLabel, normText, sameContent, sha256 } from './text.ts';

const LOOKUP = /网络查找|查找手机|查找微信号|查找/;
const NOT_FOUND = /该用户不存在|用户不存在|账号状态异常|无法找到|找不到相关账号|没有找到/;
const SENT = /等待验证|已发送|发送成功|请求已发送/;
const SEND_FAILED = /频繁|失败|异常/;
const VERIFY_ROUNDS = 3;

export function createAddFriendHandler(options: FlowOptions): Handler<'add_friend'> {
  return {
    type: 'add_friend',
    requires: { methods: ['observe', 'act', 'artifact.read'], actions: ['send_friend_request', 'navigate', 'read'] },
    run(task: WeChatTask & { type: 'add_friend' }, ctx: HandlerContext): Promise<DomainResult> {
      return Flow.run(ctx, task, options, async (flow) => addFriend(flow, task));
    },
  };
}

async function addFriend(flow: Flow, task: WeChatTask & { type: 'add_friend' }): Promise<DomainResult> {
  const payload = task.payload;
  if (payload.kind !== 'add_friend') flow.halt('failed', undefined, 'payload is not an add_friend');
  const typedId = payload.typedId.trim();
  if (!typedId) flow.halt('failed', 'not_found', 'empty id');
  const note = normText(payload.note);

  // 1. search box
  let scene = await flow.observe();
  stopOnDialog(flow, scene);
  const search = findButton(scene.facts, ['搜索']) ?? findText(scene.facts, /^搜索$/);
  if (!search) flow.halt('blocked', 'layout_unreadable', `page ${scene.facts.page} shows no search box`);
  await flow.act('focus_search', { kind: 'click', target: { imagePoint: center(search.rect) } }, scene);
  await flow.act('type_id', { kind: 'type', text: typedId }, scene);
  await flow.settle();
  scene = await flow.observe();
  stopOnDialog(flow, scene);
  if (scene.facts.page !== 'search_results') flow.halt('failed', 'not_found', `no search results appeared (page ${scene.facts.page})`);

  // 2. the 网络查找 entry for exactly this id
  const idKey = normLabel(typedId);
  const lookup = [...scene.facts.buttons, ...scene.facts.texts].find((t) => LOOKUP.test(normLabel(t.text)) && normLabel(t.text).includes(idKey));
  if (!lookup) {
    if (anyText(scene.facts, NOT_FOUND)) flow.halt('failed', 'not_found', `WeChat says: ${errorTextOf(scene.facts)}`);
    flow.halt('failed', 'not_found', `search shows no 网络查找 entry for ${typedId}`);
  }
  await flow.act('open_result', { kind: 'click', target: { imagePoint: center(lookup.rect) } }, scene);
  await flow.settle();
  scene = await flow.observe();
  stopOnDialog(flow, scene);
  if (anyText(scene.facts, NOT_FOUND)) flow.halt('failed', 'not_found', `WeChat says: ${errorTextOf(scene.facts)}`);
  if (scene.facts.page === 'search_results') {
    flow.halt('blocked', 'capability_missing', 'the click on the search popup did not land; the platform needs a popup input route (CR02)');
  }
  const profile = scene.facts.detail;
  await flow.fact('profile_read', 'observed', { typedId, idKind: payload.idKind, page: scene.facts.page, name: profile?.name, wechatId: profile?.wechatId, region: profile?.region }, { evidenceIds: [scene.evidenceId], confidence: profile?.confidence ?? scene.facts.confidence });
  if (findButton(scene.facts, ['发消息'])) flow.halt('no_op', 'already_friend', `${profile?.name ?? typedId} is already a friend`);
  const add = findButton(scene.facts, ['添加到通讯录']);
  if (!add) flow.halt('blocked', 'capability_missing', `no 添加到通讯录 control on page ${scene.facts.page}; the add-friend sheet needs CR02`);

  // 3. the verification sheet and its note field
  await flow.act('open_add_sheet', { kind: 'click', target: { imagePoint: center(add.rect) } }, scene);
  await flow.settle();
  scene = await flow.observe();
  if (scene.facts.page !== 'add_friend') {
    stopOnDialog(flow, scene);
    flow.halt('blocked', 'capability_missing', `the add-friend sheet did not open (page ${scene.facts.page}); needs CR02`);
  }
  if (!findButton(scene.facts, ['发送'])) flow.halt('failed', 'verification_missing', 'the add-friend sheet shows no 发送 button');
  const field = scene.facts.inputBox;
  if (!field) flow.halt('failed', 'content_mismatch', 'the verification message field could not be located; the default text is never sent');
  await flow.act('focus_note', { kind: 'click', target: { imagePoint: center(field.rect) } }, scene);
  await flow.act('select_note', { kind: 'key', key: 'a', modifiers: ['cmd'] }, scene);
  if (note) await flow.act('type_note', { kind: 'type', text: note }, scene);
  else await flow.act('clear_note', { kind: 'key', key: 'delete' }, scene);
  await flow.settle();
  scene = await flow.observe();
  stopOnDialog(flow, scene);
  const readBack = await requireNoteMatches(flow, scene, note);

  // 4. approval over what the sheet really shows
  const targetLabel = profile?.name ?? typedId;
  const contentHash = sha256(`send_friend_request\u0000${idKey}\u0000${note}`);
  const expectation: ApprovalExpectation = { action: 'send_friend_request', contentHash, targetRevision: task.targetRevision ?? 0 };
  const request: ApprovalRequest = {
    taskId: task.taskId, allowedAction: 'send_friend_request', accountRevision: flow.ctx.account.revision, targetRevision: expectation.targetRevision,
    draftRevision: 0, contentHash,
    summary: { targetLabel, visibleIdentifier: profile?.wechatId ?? typedId, contentPreview: readBack, evidenceIds: [...flow.evidenceIds], identityConfidence: profile?.confidence ?? 0 },
  };
  flow.checkSignal();
  const decision = await flow.ctx.requestApproval(request);
  if (decision.kind === 'rejected') return flow.result('waiting_user', undefined, 'the person rejected the request; the sheet is left for them to close');
  if (decision.kind === 'skipped') return flow.result('waiting_user', undefined, 'the person skipped the request; the sheet is left for them to close');
  if (decision.kind === 'cancelled') return flow.result('no_op', 'cancelled', 'approval cancelled');
  const approval = decision.approval;

  // 5. re-observe, verify before write, send once
  const fresh = await flow.observe();
  stopOnDialog(flow, fresh);
  flow.requireSameWindow(fresh);
  flow.requireApprovalValid(approval, expectation);
  if (fresh.facts.page !== 'add_friend') flow.halt('blocked', 'approval_invalid', `the add-friend sheet is gone (page ${fresh.facts.page})`);
  await requireNoteMatches(flow, fresh, note);
  const send = findButton(fresh.facts, ['发送']);
  if (!send) flow.halt('blocked', 'approval_invalid', 'the 发送 button is no longer visible');
  await flow.consumeApproval(approval, expectation);
  const click = await flow.act('send', { kind: 'click', target: { imagePoint: center(send.rect) } }, fresh, true);

  // 6. business verification: 等待验证 / 已发送 without a failure text
  for (let round = 0; round < VERIFY_ROUNDS; round++) {
    await flow.settle();
    const after = await flow.observe();
    if (anyText(after.facts, SEND_FAILED)) {
      await flow.settleAttempt(click, 'unknown', errorTextOf(after.facts) ?? 'failure text');
      const code = anyText(after.facts, /频繁/) ? 'rate_limited' : 'verification_missing';
      return flow.result('sent_unconfirmed', code, `WeChat says: ${errorTextOf(after.facts) ?? 'failure'}`);
    }
    if (anyText(after.facts, SENT)) {
      await flow.settleAttempt(click, 'verified', 'sent');
      await flow.fact('friend_request_sent', 'confirmed', { typedId, idKind: payload.idKind, name: targetLabel, note }, { evidenceIds: [after.evidenceId], confidence: after.facts.confidence });
      return flow.result('confirmed', undefined, `friend request to ${targetLabel} shows ${findText(after.facts, SENT)?.text ?? '已发送'}`);
    }
  }
  await flow.settleAttempt(click, 'unknown', 'no 等待验证/已发送 after the click');
  return flow.result('sent_unconfirmed', 'verification_missing', `clicked 发送 for ${targetLabel} but no 等待验证/已发送 appeared`);
}

/** The sheet's note field must show exactly the approved note; otherwise nothing is sent and the sheet is left as is. */
async function requireNoteMatches(flow: Flow, scene: Scene, note: string): Promise<string> {
  const box = scene.facts.inputBox;
  if (!box) flow.halt('failed', 'content_mismatch', 'the verification message field is no longer visible');
  if (!sameContent(note, box.text)) {
    await flow.fact('input_mismatch', 'observed', { expected: note, readBack: box.text }, { evidenceIds: [scene.evidenceId], confidence: box.confidence });
    flow.halt('waiting_user', 'content_mismatch', `the note field reads "${box.text}", not the approved text; nothing sent`);
  }
  return box.text;
}
