// T15: green is not acceptance. A selected row painted WeChat green with a
// 已添加 label stays `added`; green with no label is `unknown`; only the
// text 接受 makes `pending`, and green then only refines the actionRect.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, requestSection } from '../src/analyze.ts';
import { profile, pxRect, S, scriptedSampler, word } from './helpers.ts';

const header = word('新的朋友', 75, 114, 76, 17);
const next = word('群聊', 75, 400, 30, 16);

test('T15 a green selected row labelled 已添加 is added, not pending', () => {
  const texts = [header, word('林小雨', 133, 160, 42, 16), word('已添加', 258, 164, 30, 10), word('来自群聊', 133, 184, 60, 13), next];
  const wholeRowGreen = scriptedSampler({ green: [pxRect(61, 143, 240, 69)] });
  const section = requestSection(texts, profile, wholeRowGreen)!;
  assert.equal(section.rows[0].status, 'added');
  assert.equal(section.rows[0].actionRect, undefined);
  assert.ok(section.warnings.some((w) => w.includes('green') && w.includes('"已添加"') && w.includes('not treated as pending')));
});

test('T15 a green row with no status text is unknown', () => {
  const texts = [header, word('王大为', 133, 160, 42, 16), word('你好', 133, 184, 30, 13), next];
  const section = requestSection(texts, profile, scriptedSampler({ green: [pxRect(61, 143, 240, 69)] }))!;
  assert.equal(section.rows[0].status, 'unknown');
  assert.equal(section.rows[0].actionRect, undefined);
  assert.ok(section.rows[0].confidence < 0.8, 'no status lowers the row confidence');
});

test('T15 接受 text makes pending; green refines the actionRect, its absence only warns', () => {
  const texts = [header, word('林小雨', 133, 160, 42, 16), word('接受', 258, 164, 30, 10), next];
  const withGreen = requestSection(texts, profile, scriptedSampler({ green: [pxRect(250, 156, 48, 24)] }))!;
  assert.equal(withGreen.rows[0].status, 'pending');
  assert.deepEqual(withGreen.rows[0].actionRect, { x: 250 * S, y: 156 * S, width: 48 * S, height: 24 * S });
  const noGreen = requestSection(texts, profile, scriptedSampler({ green: [] }))!;
  assert.equal(noGreen.rows[0].status, 'pending');
  assert.deepEqual(noGreen.rows[0].actionRect, { x: 258 * S, y: 164 * S, width: 30 * S, height: 10 * S });
  assert.ok(noGreen.warnings.some((w) => w.includes('without a green control')));
});

test('T15 end to end: no pending row comes out of colour alone', () => {
  const texts = [
    header,
    word('林小雨', 133, 160, 42, 16), word('已添加', 258, 164, 30, 10),
    word('王大为', 133, 229, 42, 16),
    word('张小明', 133, 298, 42, 16), word('接受', 258, 302, 30, 10),
    next,
  ];
  const everythingGreen = scriptedSampler({ green: [pxRect(61, 50, 240, 825)] });
  const facts = analyze({ texts, sampler: everythingGreen }, profile);
  assert.deepEqual(facts.requests!.map((r) => [r.name, r.status, Boolean(r.actionRect)]), [
    ['林小雨', 'added', false], ['王大为', 'unknown', false], ['张小明', 'pending', true],
  ]);
});
