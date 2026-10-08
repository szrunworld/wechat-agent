import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acts, attemptsFor, button, clickPoints, facts, harness, mid, r, text } from './helpers.ts';

const ID = 'abc_123';
const NOTE = '你好，我是陈一';
const SEARCH = button('搜索', r(20, 10, 200, 30));
const LOOKUP = button(`网络查找微信号：${ID}`, r(20, 60, 300, 40));
const ADD = button('添加到通讯录', r(900, 700, 120, 36));
const SEND = button('发送', r(900, 800, 80, 32));
const FIELD = r(600, 500, 400, 80);
const home = facts({ page: 'chats', buttons: [SEARCH] });
const results = (hits = [LOOKUP]) => facts({ page: 'search_results', buttons: hits });
const profile = (buttons = [ADD]) => facts({ page: 'contact_detail', detail: { name: '王二', wechatId: ID, region: '上海', buttons, confidence: 0.9 } });
const sheet = (fieldText: string | undefined, buttons = [SEND, button('取消', r(800, 800, 80, 32))]) => facts({ page: 'add_friend', buttons, inputBox: fieldText === undefined ? undefined : { rect: FIELD, text: fieldText, empty: fieldText === '', confidence: 0.9 } });
const task = { type: 'add_friend' as const, payload: { kind: 'add_friend' as const, typedId: ID, idKind: 'wechat_id' as const, note: NOTE } };

test('add friend: search → 网络查找 → profile → sheet → note read back → approval → re-observe → 发送 → 等待验证', async () => {
  const h = await harness({ task, facts: [home, results(), profile(), sheet('我是 测试号'), sheet(NOTE), sheet(NOTE), facts({ page: 'contact_detail', texts: [text('等待验证')] })] });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed', result.reason);
  const sent = acts(h.driver);
  assert.deepEqual(sent.map((a) => a.action.kind), ['click', 'type', 'click', 'click', 'click', 'key', 'type', 'click']);
  assert.equal(sent[1].action.text, ID);
  assert.equal(sent[6].action.text, NOTE);
  assert.deepEqual(clickPoints(h.driver), [mid(SEARCH.rect), mid(LOOKUP.rect), mid(ADD.rect), mid(FIELD), mid(SEND.rect)]);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].summary.contentPreview, NOTE);
  assert.equal(h.approvals[0].summary.visibleIdentifier, ID);
  assert.ok(h.granted[0].consumedAt);
  assert.equal(attemptsFor(h.ledger, 'send')[0].state, 'verified');
  assert.ok(result.facts.some((f) => f.factKind === 'friend_request_sent' && f.outcome === 'confirmed'));
});

test('T20: the verification message field cannot be located → content_mismatch, no approval, no 发送 click', async () => {
  const h = await harness({ task, facts: [home, results(), profile(), sheet(undefined)] });
  const result = await h.run();
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reasonCode, 'content_mismatch');
  assert.equal(h.approvals.length, 0);
  assert.equal(attemptsFor(h.ledger, 'send').length, 0);
  assert.equal(acts(h.driver).length, 4, 'search, type id, open result, open sheet');
  assert.ok(!clickPoints(h.driver).some((p) => p.x === mid(SEND.rect).x && p.y === mid(SEND.rect).y), 'nothing clicked 发送');
});

test('T20: the note read back differs from the approved text → waiting_user content_mismatch, nothing sent', async () => {
  const h = await harness({ task, facts: [home, results(), profile(), sheet('我是 测试号'), sheet('你好,我是陈一')] });
  const result = await h.run();
  assert.equal(result.outcome, 'waiting_user');
  assert.equal(result.reasonCode, 'content_mismatch');
  assert.equal(h.approvals.length, 0);
  assert.equal(attemptsFor(h.ledger, 'send').length, 0);
  assert.ok(result.facts.some((f) => f.factKind === 'input_mismatch'));
  assert.deepEqual(await h.ledger.findOpenAttempts(), []);
});

test('T22: no 等待验证/已发送 after the click → sent_unconfirmed, attempt unknown', async () => {
  const h = await harness({ task, facts: [home, results(), profile(), sheet('我是 测试号'), sheet(NOTE), sheet(NOTE), facts({ page: 'contact_detail', detail: { name: '王二', buttons: [ADD], confidence: 0.9 } })] });
  const result = await h.run();
  assert.equal(result.outcome, 'sent_unconfirmed');
  assert.equal(result.reasonCode, 'verification_missing');
  assert.equal(attemptsFor(h.ledger, 'send')[0].state, 'unknown');
  assert.equal(acts(h.driver).length, 8);
  assert.ok(!result.facts.some((f) => f.factKind === 'friend_request_sent'));
});

test('T22: a 频繁 text after the click is sent_unconfirmed with rate_limited', async () => {
  const h = await harness({ task, facts: [home, results(), profile(), sheet('我是 测试号'), sheet(NOTE), sheet(NOTE), facts({ page: 'dialog', texts: [text('操作过于频繁')] })] });
  const result = await h.run();
  assert.equal(result.outcome, 'sent_unconfirmed');
  assert.equal(result.reasonCode, 'rate_limited');
});

test('no 网络查找 entry or a not-found text is failed/not_found; a friend already is no_op', async () => {
  const none = await harness({ task, facts: [home, results([button('联系人', r(20, 60, 100, 40))])] });
  const rn = await none.run();
  assert.equal(rn.outcome, 'failed');
  assert.equal(rn.reasonCode, 'not_found');
  assert.equal(acts(none.driver).length, 2);
  const missing = await harness({ task, facts: [home, results(), facts({ page: 'contact_detail', texts: [text('该用户不存在')] })] });
  const rm = await missing.run();
  assert.equal(rm.outcome, 'failed');
  assert.equal(rm.reasonCode, 'not_found');
  const friend = await harness({ task, facts: [home, results(), profile([button('发消息', r(900, 700, 120, 36))])] });
  const rf = await friend.run();
  assert.equal(rf.outcome, 'no_op');
  assert.equal(rf.reasonCode, 'already_friend');
  for (const h of [none, missing, friend]) assert.equal(h.approvals.length, 0);
});

test('a popup the platform cannot click, or a missing 添加到通讯录, blocks with capability_missing (CR02), never a bypass', async () => {
  const popup = await harness({ task, facts: [home, results(), results()] });
  const rp = await popup.run();
  assert.equal(rp.outcome, 'blocked');
  assert.equal(rp.reasonCode, 'capability_missing');
  assert.equal(acts(popup.driver).length, 3);
  const noAdd = await harness({ task, facts: [home, results(), profile([])] });
  const ra = await noAdd.run();
  assert.equal(ra.outcome, 'blocked');
  assert.equal(ra.reasonCode, 'capability_missing');
  const noSearch = await harness({ task, facts: [facts({ page: 'chats' })] });
  const rs = await noSearch.run();
  assert.equal(rs.outcome, 'blocked');
  assert.equal(rs.reasonCode, 'layout_unreadable');
  assert.equal(acts(noSearch.driver).length, 0);
});

test('the sheet changing during approval blocks before 发送', async () => {
  const h = await harness({ task, facts: [home, results(), profile(), sheet('我是 测试号'), sheet(NOTE), sheet('我是 测试号')] });
  const result = await h.run();
  assert.equal(result.outcome, 'waiting_user');
  assert.equal(result.reasonCode, 'content_mismatch');
  assert.equal(attemptsFor(h.ledger, 'send').length, 0);
  assert.equal(h.granted[0].consumedAt, undefined);
});
