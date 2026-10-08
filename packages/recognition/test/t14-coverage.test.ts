// T14: zero rows is three different facts: the list is known to end, the
// viewport shows no row but may not be the whole list, or rows continue
// past the edge; the fourth, unreadable, is T13.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, requestSection, scrollbarVisible } from '../src/analyze.ts';
import { profile, scriptedSampler, word } from './helpers.ts';

const header = word('新的朋友', 75, 114, 76, 17);

test('T14a end marker or the next section header: zero rows, end_confirmed', () => {
  const marker = requestSection([header, word('暂无新的朋友', 120, 180, 90, 13)], profile)!;
  assert.deepEqual(marker.rows, []);
  assert.equal(marker.coverage, 'end_confirmed');
  const nextSection = requestSection([header, word('群聊', 75, 170, 30, 16)], profile)!;
  assert.deepEqual(nextSection.rows, []);
  assert.equal(nextSection.coverage, 'end_confirmed');
  const facts = analyze({ texts: [header, word('没有更多', 150, 180, 60, 13)] }, profile);
  assert.equal(facts.page, 'new_friends');
  assert.equal(facts.coverage, 'end_confirmed');
  assert.deepEqual(facts.requests, []);
});

test('T14b header alone, nothing proving the end: zero rows, current_viewport', () => {
  const section = requestSection([header], profile)!;
  assert.deepEqual(section.rows, []);
  assert.equal(section.coverage, 'current_viewport');
  const facts = analyze({ texts: [word('通讯录管理', 159, 62, 70, 15), header] }, profile);
  assert.equal(facts.page, 'contacts', 'no rows and no end: the contacts tree, not a read list');
  assert.equal(facts.coverage, 'current_viewport');
  assert.deepEqual(facts.requests, []);
});

test('T14c text at the sidebar bottom edge or a scrollbar thumb: zero rows, partial', () => {
  // The header itself sits at the bottom edge: whatever follows is cut off.
  const low = requestSection([word('新的朋友', 75, 858, 76, 17)], profile)!;
  assert.deepEqual(low.rows, []);
  assert.equal(low.coverage, 'current_viewport', 'the header is above the rows; nothing below is visible yet');
  const cut = requestSection([header, word('某人', 133, 868, 30, 14)], profile)!;
  assert.equal(cut.coverage, 'partial');
  assert.ok(cut.warnings.some((w) => w.includes('bottom edge')));
  // A scrollbar thumb: a lighter run at the sidebar's right edge.
  const thumb = scriptedSampler({ lumaAt: (r) => (r.x >= 294 * 2 && r.y > 400 && r.y < 700 ? 120 : 30) });
  assert.equal(scrollbarVisible(thumb, profile), true);
  assert.equal(scrollbarVisible(scriptedSampler({ luma: 30 }), profile), false);
  const scrolled = requestSection([header], profile, thumb)!;
  assert.deepEqual(scrolled.rows, []);
  assert.equal(scrolled.coverage, 'partial');
  const facts = analyze({ texts: [header], sampler: thumb }, profile);
  assert.equal(facts.coverage, 'partial');
  assert.equal(facts.page, 'new_friends');
});

test('T14 with rows: a scrollbar still makes the list partial, not end_confirmed', () => {
  const texts = [header, word('林小雨', 133, 160, 42, 16), word('已添加', 258, 164, 30, 10), word('群聊', 75, 300, 30, 16)];
  const thumb = scriptedSampler({ lumaAt: (r) => (r.x >= 294 * 2 && r.y > 100 && r.y < 300 ? 120 : 30) });
  assert.equal(requestSection(texts, profile)!.coverage, 'end_confirmed');
  assert.equal(requestSection(texts, profile, thumb)!.coverage, 'partial');
});
