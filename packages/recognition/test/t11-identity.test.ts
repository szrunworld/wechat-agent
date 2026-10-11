// T11: the same name twice, a name the list cut short, or a low-confidence
// read is ambiguous; one exact, confident match is not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestRow } from '@wechat-agent/ports';
import { identityCandidates } from '../src/identity.ts';
import { requestSection } from '../src/analyze.ts';
import { profile, word } from './helpers.ts';

const row = (name: string, confidence = 0.95, note = ''): RequestRow => ({
  name, note, status: 'pending', rect: { x: 0, y: 0, width: 10, height: 10 }, confidence, rowKey: `${name}|${note}`,
});

test('T11 one exact confident match is unambiguous', () => {
  const out = identityCandidates([row('林小雨'), row('王大为')], '林小雨');
  assert.equal(out.ambiguous, false);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.reason, undefined);
});

test('T11 duplicate names are ambiguous', () => {
  const out = identityCandidates([row('林小雨', 0.9, '来自群聊'), row('王大为'), row('林小雨', 0.9, '朋友推荐')], '林小雨');
  assert.equal(out.ambiguous, true);
  assert.equal(out.reason, 'duplicate_name');
  assert.equal(out.candidates.length, 2);
});

test('T11 a truncated name is ambiguous even when it is the only match', () => {
  const out = identityCandidates([row('林小雨的很长很长的昵…')], '林小雨的很长很长的昵称');
  assert.equal(out.ambiguous, true);
  assert.equal(out.reason, 'truncated_name');
  const prefix = identityCandidates([row('林小')], '林小雨');
  assert.equal(prefix.ambiguous, true, 'a shown name that is only a prefix of the full name is not proof');
});

test('T11 the truncation mark counts whichever ellipsis glyph Vision returns', () => {
  for (const mark of ['…', '⋯', '‥']) {
    const out = identityCandidates([row(`昵称特别长的合成${mark}`)], '昵称特别长的合成用户名');
    assert.equal(out.ambiguous, true, mark);
    assert.equal(out.reason, 'truncated_name', mark);
  }
  const other = identityCandidates([row('昵称特别长的合成⋯')], '王大为');
  assert.equal(other.reason, 'not_found', 'a cut name still has to match the name it is cut from');
});

test('T11 a low-confidence read is ambiguous', () => {
  const out = identityCandidates([row('林小雨', 0.4)], '林小雨');
  assert.equal(out.ambiguous, true);
  assert.equal(out.reason, 'low_confidence');
});

test('T11 nothing matching is not ambiguous, it is not found', () => {
  const out = identityCandidates([row('王大为')], '林小雨');
  assert.deepEqual(out, { candidates: [], ambiguous: false, reason: 'not_found' });
});

test('T11 duplicate rows surface in the section warnings too', () => {
  const section = requestSection([
    word('新的朋友', 75, 114),
    word('林小雨', 133, 160, 42, 16), word('接受', 258, 164, 30, 10), word('来自群聊', 133, 184, 60, 13),
    word('林小雨', 133, 229, 42, 16), word('已添加', 258, 233, 30, 10), word('朋友推荐', 133, 253, 60, 13),
    word('群聊', 75, 300, 30, 16),
  ], profile)!;
  assert.ok(section.warnings.some((w) => w.includes('duplicate name "林小雨"')));
  assert.notEqual(section.rows[0].rowKey, section.rows[1].rowKey, 'notes keep the rowKeys apart');
  assert.equal(identityCandidates(section.rows, '林小雨').ambiguous, true);
});
