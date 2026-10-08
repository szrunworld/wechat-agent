// T26: two bubbles with the same text are two bubbles: their anchorKeys
// differ by position, so a send verification cannot mistake the old one for
// the new one. Side comes from position; colour only confirms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, bubbles, inputBox } from '../src/analyze.ts';
import { profile, pxRect, S, scriptedSampler, word } from './helpers.ts';

const title = word('林小雨', 640, 20, 42, 18);
const chatList = [word('林小雨', 118, 70, 42, 16), word('20:19', 255, 72, 36, 12)];

test('T26 same text at two positions: two bubbles, two anchorKeys', () => {
  const texts = [
    ...chatList, title,
    word('你好，在吗？', 372, 120, 100, 16),
    word('在的', 1120, 200, 40, 16),
    word('你好，在吗？', 372, 330, 100, 16),
  ];
  const out = bubbles(texts, profile);
  assert.deepEqual(out.map((b) => [b.side, b.text]), [['other', '你好，在吗？'], ['self', '在的'], ['other', '你好，在吗？']]);
  assert.notEqual(out[0].anchorKey, out[2].anchorKey);
  assert.ok(out[0].anchorKey.includes('#0') && out[2].anchorKey.includes('#1'));
  // Reading the same capture again gives the same keys: stable within a snapshot.
  assert.deepEqual(bubbles(texts, profile).map((b) => b.anchorKey), out.map((b) => b.anchorKey));
  const facts = analyze({ texts }, profile);
  assert.equal(facts.page, 'chat');
  assert.equal(facts.bubbles?.length, 3);
  assert.equal(new Set(facts.bubbles!.map((b) => b.anchorKey)).size, 3);
});

test('T26 a new bubble below an old one with the same text is the one with the larger y', () => {
  const before = bubbles([title, word('好的', 1120, 200, 40, 16)], profile);
  const after = bubbles([title, word('好的', 1120, 200, 40, 16), word('好的', 1120, 420, 40, 16)], profile);
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
  assert.equal(after[0].anchorKey, before[0].anchorKey, 'the old bubble keeps its key');
  const fresh = after.filter((b) => !before.some((o) => o.anchorKey === b.anchorKey));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].rect.y, 420 * S);
});

test('side by position, colour agreement raises nothing, disagreement lowers confidence', () => {
  const texts = [title, word('你好', 372, 120, 40, 16), word('在的', 1120, 200, 40, 16)];
  const agreeing = scriptedSampler({ green: [pxRect(1100, 195, 100, 26)] });
  const ok = bubbles(texts, profile, agreeing);
  assert.deepEqual(ok.map((b) => [b.side, b.confidence]), [['other', 1], ['self', 1]]);
  const disagreeing = scriptedSampler({ green: [pxRect(360, 115, 80, 26)] });
  const warnings: string[] = [];
  const odd = bubbles(texts, profile, disagreeing, warnings);
  assert.equal(odd[0].side, 'other');
  assert.ok(warnings.some((w) => w.includes('colour says self, position says other')));
  assert.ok(odd[0].confidence < 1);
  assert.ok(odd[1].confidence < 1, 'a self bubble that is not green is doubtful too');
});

test('consecutive lines of one bubble merge; time separators are not bubbles', () => {
  const out = bubbles([
    title, word('12:30', 630, 90, 36, 12),
    word('第一行很长的消息', 372, 120, 120, 16), word('第二行', 372, 139, 40, 16),
    word('昨天 14:07', 610, 200, 60, 12),
    word('单独一条', 372, 240, 60, 16),
  ], profile);
  assert.deepEqual(out.map((b) => b.text), ['第一行很长的消息\n第二行', '单独一条']);
  assert.equal(out[0].rect.height, (139 + 16 - 120) * S);
});

test('the input box reports typed text and emptiness', () => {
  assert.deepEqual(inputBox([title], profile), { rect: { x: 600, y: 1440, width: 1960, height: 310 }, text: '', empty: true, confidence: 0.7 });
  const typed = inputBox([title, word('还没发出去的草稿', 320, 740, 120, 16, 0.9)], profile);
  assert.equal(typed.empty, false);
  assert.equal(typed.text, '还没发出去的草稿');
  assert.equal(typed.confidence, 0.9);
  const facts = analyze({ texts: [...chatList, title, word('还没发出去的草稿', 320, 740, 120, 16)] }, profile);
  assert.equal(facts.inputBox?.empty, false);
  assert.equal(facts.bubbles?.length, 0, 'text in the input box is not a bubble');
});

test('a chat page carries its conversation title (coordinator\'s announced PageFacts.conversation)', () => {
  const facts = analyze({ texts: [...chatList, title, word('你好', 372, 120, 40, 16)] }, profile);
  assert.deepEqual(facts.conversation, { title: '林小雨', rect: { x: 640 * S, y: 20 * S, width: 42 * S, height: 18 * S } });
  const list = analyze({ texts: chatList }, profile);
  assert.equal(list.conversation, undefined, 'no open conversation, no title');
});
