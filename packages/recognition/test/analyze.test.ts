// The legacy parse tests (legacy/src/parse.test.ts, 7 cases) migrated to the
// PageFacts shape: geometry in points as measured, converted to 2x pixels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TextItem } from '@wechat-agent/ports';
import { analyze, chatRows, detailPane, requestSection } from '../src/analyze.ts';
import { sameName } from '../src/identity.ts';
import { profile, pxRect, S, scriptedSampler, word } from './helpers.ts';

function sidebarWithRequests(): TextItem[] {
  return [
    word('搜索', 97, 23, 24, 13),
    word('通讯录管理', 159, 62, 70, 15),
    word('新的朋友', 75, 114, 76, 17),
    // A request waiting for an answer: a green 接受 button on the right.
    word('陈一', 133, 160, 42, 16), word('接受', 258, 164, 30, 10), word('我是陈一，BOSS直聘看到的', 133, 184, 140, 13),
    // Already added.
    word('Lin Er', 133, 230, 43, 13), word('已添加.', 258, 232, 30, 11), word('我是 Lin Er', 133, 253, 62, 13),
    // A long name runs into its status.
    word('York•张三 at dy..• 已添加', 133, 506, 155, 16), word('我：我是"Chinese founder..', 132, 529, 154, 13),
    // Expired.
    word('HH', 133, 575, 23, 14), word('已过期', 258, 577, 29, 10), word('我：我是"Chinese founder..', 133, 598, 152, 14),
    // The next section.
    word('群聊', 75, 660, 30, 16), word('23', 270, 662, 16, 12),
    word('某个群', 133, 700, 42, 15),
  ];
}

test('reads 新的朋友 rows, their notes and statuses (legacy 1)', () => {
  const section = requestSection(sidebarWithRequests(), profile);
  assert.ok(section);
  assert.deepEqual(section.rows.map((r) => [r.name, r.status, r.note]), [
    ['陈一', 'pending', '我是陈一，BOSS直聘看到的'],
    ['Lin Er', 'added', '我是 Lin Er'],
    ['York•张三 at dy', 'added', '我：我是"Chinese founder..'],
    ['HH', 'expired', '我：我是"Chinese founder..'],
  ]);
  // Row rect centre in pixels: the legacy centre (168 pt) plus the row's offset below the name.
  const r0 = section.rows[0];
  assert.ok(Math.abs((r0.rect.y + r0.rect.height / 2) / S - 178) < 3, `row centre ${r0.rect.y + r0.rect.height / 2}`);
  assert.ok(r0.actionRect, 'the pending row carries its accept control');
  assert.ok(Math.abs(r0.actionRect!.x / S - 258) < 2);
  assert.equal(section.rows[1].actionRect, undefined);
  assert.equal(section.coverage, 'end_confirmed', 'the next section header proves the list ended');
  for (const r of section.rows) {
    assert.ok(r.confidence > 0 && r.confidence <= 1);
    assert.ok(r.rowKey.length > 0);
  }
});

test('rows stop at the next section, and a collapsed list reads as empty (legacy 2)', () => {
  assert.equal(requestSection(sidebarWithRequests(), profile)!.rows.some((r) => r.name === '某个群'), false);
  const collapsed = requestSection([word('新的朋友', 75, 114), word('群聊', 75, 170), word('联系人', 75, 226)], profile);
  assert.deepEqual(collapsed!.rows, []);
  assert.equal(collapsed!.coverage, 'end_confirmed');
  assert.equal(requestSection([word('聊天', 118, 100)], profile), undefined, 'no 新的朋友 header: no section');
});

test('a row with no status text is unknown, not pending, whatever its colour (legacy 3, tightened by T15)', () => {
  const texts = [word('新的朋友', 75, 114), word('王五', 133, 160), word('你好', 133, 184)];
  const plain = requestSection(texts, profile)!;
  assert.equal(plain.rows[0].status, 'unknown');
  assert.equal(plain.rows[0].actionRect, undefined);
  assert.ok(plain.warnings.some((w) => w.includes('no status text')));
  const green = requestSection(texts, profile, scriptedSampler({ green: [pxRect(250, 156, 48, 24)] }))!;
  assert.equal(green.rows[0].status, 'unknown');
  assert.equal(green.rows[0].actionRect, undefined);
  assert.ok(green.warnings.some((w) => w.includes('green') && w.includes('not treated as pending')));
});

test('reads the chat list (legacy 4)', () => {
  const rows = chatRows([
    word('搜索', 150, 23),
    word('陈一', 118, 70, 40, 16), word('20:19', 255, 72, 36, 12), word('"陈一" 拍了拍我', 118, 95, 150, 13),
    word('Some Group', 118, 138, 120, 16), word('昨天 14:07', 240, 140, 60, 12), word('李四: 好的', 118, 163, 100, 13),
    word('文件传输助手', 118, 206, 90, 16), word('星期日', 262, 208, 30, 12),
    word('HopInnovations~Al... 19:47', 118, 274, 170, 16), word('能不能约个电话', 118, 299, 100, 13),
  ], profile);
  assert.deepEqual(rows.map((r) => [r.name, r.time, r.preview, r.unread]), [
    ['陈一', '20:19', '"陈一" 拍了拍我', false],
    ['Some Group', '昨天 14:07', '李四: 好的', false],
    ['文件传输助手', '星期日', '', false],
    ['HopInnovations~Al', '19:47', '能不能约个电话', false],
  ]);
  assert.ok(rows.every((r) => r.rect.width === 240 * S && r.confidence > 0));
});

test('unread comes from a badge count or the red badge', () => {
  const texts = [word('陈一', 118, 70, 40, 16), word('20:19', 255, 72, 36, 12), word('3', 272, 92, 8, 10)];
  assert.equal(chatRows(texts, profile)[0].unread, true);
  const noCount = texts.slice(0, 2);
  assert.equal(chatRows(noCount, profile)[0].unread, false);
  assert.equal(chatRows(noCount, profile, scriptedSampler({ red: [pxRect(275, 88, 10, 10)] }))[0].unread, true);
});

test('reads the pane: name, WeChat ID, region and buttons (legacy 5)', () => {
  const seen = detailPane([
    word('陈一 2', 708, 72, 66, 17), word('•••', 924, 75, 15, 5),
    word('微信号：wxid_abc123', 707, 102, 179, 13), word('地区：中国大陆', 707, 120, 83, 13),
    word('验证消息：我是陈一，BOSS直聘看到的', 707, 150, 200, 13),
    word('备注', 631, 199, 28, 15), word('添加备注名', 705, 198, 72, 15),
    word('通过验证', 760, 530, 48, 16),
  ], profile);
  assert.ok(seen);
  assert.equal(seen.name, '陈一 2');
  assert.equal(seen.wechatId, 'wxid_abc123');
  assert.equal(seen.region, '中国大陆');
  assert.equal(seen.message, '我是陈一，BOSS直聘看到的');
  assert.deepEqual(seen.buttons, [{ text: '通过验证', rect: { x: 760 * S, y: 530 * S, width: 48 * S, height: 16 * S }, confidence: 1 }]);
  assert.equal(detailPane([word('新的朋友', 75, 114)], profile), undefined);
});

test('a value may be its own word to the right of its label (legacy 6)', () => {
  const seen = detailPane([word('陈一', 708, 72, 40, 17), word('微信号', 707, 102, 40, 13), word('abc_123', 760, 102, 60, 13)], profile);
  assert.equal(seen?.wechatId, 'abc_123');
});

test('matches a name the list cut short (legacy 7)', () => {
  assert.ok(sameName('York•张三 at dy…', 'York•张三 at dynamics'));
  assert.ok(sameName('陈一', '陈一'));
  assert.ok(sameName('陈一 2', '陈一'));
  assert.ok(!sameName('陈一', '李四'));
  assert.ok(!sameName('', '李四'));
});

test('analyze() assembles PageFacts: page kind, coverage, evidence, per-item confidence', () => {
  const texts = [
    ...sidebarWithRequests(),
    word('陈一', 708, 72, 40, 17), word('微信号：wxid_abc123', 707, 102, 179, 13),
    word('验证消息：我是陈一，BOSS直聘看到的', 707, 150, 200, 13), word('通过验证', 760, 530, 48, 16),
  ];
  const facts = analyze({ texts, evidenceRef: { artifactId: 'art-1', sha256: 'abc' } }, profile);
  assert.equal(facts.page, 'request_detail');
  assert.equal(facts.coverage, 'end_confirmed');
  assert.equal(facts.profileId, profile.profileId);
  assert.deepEqual(facts.evidenceRef, { artifactId: 'art-1', sha256: 'abc' });
  assert.equal(facts.requests?.length, 4);
  assert.equal(facts.detail?.name, '陈一');
  assert.ok(facts.buttons.some((b) => b.text === '通过验证' && b.rect.x === 760 * S));
  assert.ok(facts.confidence > 0 && facts.confidence <= 1);
  assert.equal(facts.texts.length, texts.length);
  assert.ok(facts.texts.every((t) => typeof t.confidence === 'number' && t.rect.width > 0));

  const list = analyze({ texts: sidebarWithRequests() }, profile);
  assert.equal(list.page, 'new_friends');
  const contactsOnly = analyze({ texts: [word('新的朋友', 75, 114), word('群聊', 75, 170)] }, profile);
  assert.equal(contactsOnly.page, 'new_friends', 'an empty, ended list is still the 新的朋友 page');
  assert.equal(contactsOnly.coverage, 'end_confirmed');
  assert.equal(analyze({ texts: [] }, profile).coverage, 'unreadable');
});

test('page kinds: chats, chat, dialog, add_friend, search_results, contact_detail, unknown', () => {
  const chatList = [word('陈一', 118, 70, 40, 16), word('20:19', 255, 72, 36, 12)];
  assert.equal(analyze({ texts: chatList }, profile).page, 'chats');
  const open = analyze({ texts: [...chatList, word('陈一', 640, 20, 40, 18), word('你好', 372, 120, 40, 16)] }, profile);
  assert.equal(open.page, 'chat');
  assert.equal(open.bubbles?.length, 1);
  assert.equal(open.inputBox?.empty, true);
  const dialog = analyze({ texts: [...chatList, word('确定要删除吗？', 560, 400, 120, 16), word('取消', 580, 470, 30, 14), word('确定', 660, 470, 30, 14)] }, profile);
  assert.equal(dialog.page, 'dialog');
  assert.deepEqual(dialog.buttons.map((b) => b.text), ['取消', '确定']);
  assert.equal(analyze({ texts: [word('发送添加朋友申请', 560, 200, 120, 16), word('发送', 700, 600, 30, 14)] }, profile).page, 'add_friend');
  assert.equal(analyze({ texts: [word('网络查找', 70, 60, 60, 14), word('查找手机/微信号：abc', 118, 90, 120, 14)] }, profile).page, 'search_results');
  assert.equal(analyze({ texts: [word('李四', 708, 72, 40, 17), word('微信号：li_si', 707, 102, 100, 13), word('发消息', 760, 530, 48, 16)] }, profile).page, 'contact_detail');
  assert.equal(analyze({ texts: [word('随便什么', 500, 500, 60, 14)] }, profile).page, 'unknown');
});
