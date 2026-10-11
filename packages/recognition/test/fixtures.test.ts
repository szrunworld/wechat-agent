// The synthetic fixtures under fixtures/wechat, read through the real OCR
// helper (Apple Vision). Each PNG has an .expected.json with the PageFacts
// subset it must produce. Needs ocr/ocr (npm run build:ocr); without it the
// whole file is skipped loudly, never silently passed.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { PageFacts, Recognizer } from '@wechat-agent/ports';
import { identityCandidates } from '../src/identity.ts';
import { DEFAULT_OCR_PATH, ocrAvailable } from '../src/ocr.ts';
import { pngSize } from '../src/png.ts';
import { createRecognizer } from '../src/recognizer.ts';
import { norm } from '../src/text.ts';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures/wechat');

interface Expected {
  scene: string;
  image: { width: number; height: number; scale: number };
  applicability: 'applicable' | 'size_mismatch' | 'scale_mismatch' | 'theme_mismatch';
  page?: PageFacts['page'];
  coverage?: PageFacts['coverage'];
  requests?: { name: string; note?: string; status: string; actionRect?: boolean }[];
  requestsAtLeast?: number;
  chats?: { name: string; time: string; unread: boolean }[];
  detail?: { name: string; wechatId?: string; region?: string; message?: string };
  bubbles?: { side: string; text: string }[];
  inputBox?: { empty: boolean; text?: string };
  buttons?: string[];
  buttonsInclude?: string[];
  warningsInclude?: string[];
}

const expectedFiles = readdirSync(FIXTURES).filter((f) => f.endsWith('.expected.json')).sort();
const available = await ocrAvailable();
const timings: Record<string, number> = {};
let current = '';
const results = new Map<string, PageFacts>();
let recognizer: Recognizer | undefined;

async function read(name: string): Promise<PageFacts> {
  const cached = results.get(name);
  if (cached) return cached;
  const expected = JSON.parse(readFileSync(resolve(FIXTURES, `${name}.expected.json`), 'utf8')) as Expected;
  recognizer ??= createRecognizer({ onTiming: (t) => { timings[current] = t.totalMs; } });
  const path = resolve(FIXTURES, `${name}.png`);
  const size = pngSize(readFileSync(path));
  current = name;
  const facts = await recognizer.recognize({ ...size, scale: expected.image.scale, path, artifactId: `fixture:${name}` }, recognizer.profiles()[0]);
  results.set(name, facts);
  return facts;
}

const same = (got: string, want: string) => norm(got) === norm(want);

for (const file of expectedFiles) {
  const expected = JSON.parse(readFileSync(resolve(FIXTURES, file), 'utf8')) as Expected;
  const name = expected.scene;
  test(`fixture ${name}`, { skip: available ? false : `ocr helper missing at ${DEFAULT_OCR_PATH}` }, async () => {
    const path = resolve(FIXTURES, `${name}.png`);
    const size = pngSize(readFileSync(path));
    assert.deepEqual(size, { width: expected.image.width, height: expected.image.height }, 'the PNG matches its expected size');
    recognizer ??= createRecognizer({ onTiming: (t) => { timings[current] = t.totalMs; } });
    const fit = recognizer.applicability({ ...size, scale: expected.image.scale });
    if (expected.applicability !== 'applicable') {
      assert.equal(fit.applicable, false);
      assert.equal((fit as { reason: string }).reason, expected.applicability);
    } else {
      assert.ok(fit.applicable, `expected applicable, got ${JSON.stringify(fit)}`);
    }
    const facts = await read(name);
    assert.equal(facts.profileId, recognizer.profiles()[0].profileId);
    assert.deepEqual(facts.evidenceRef, { artifactId: `fixture:${name}`, sha256: undefined });
    const detailMsg = () => JSON.stringify({ page: facts.page, coverage: facts.coverage, warnings: facts.warnings, requests: facts.requests?.map((r) => [r.name, r.status]), texts: facts.texts.map((t) => t.text) });
    if (expected.page) assert.equal(facts.page, expected.page, detailMsg());
    if (expected.coverage) assert.equal(facts.coverage, expected.coverage, detailMsg());
    if (expected.requests) {
      assert.equal(facts.requests?.length, expected.requests.length, detailMsg());
      expected.requests.forEach((want, i) => {
        const got = facts.requests![i];
        assert.ok(same(got.name, want.name), `row ${i}: name ${JSON.stringify(got.name)} vs ${JSON.stringify(want.name)}; ${detailMsg()}`);
        assert.equal(got.status, want.status, `row ${i} (${want.name}) status`);
        if (want.note !== undefined) assert.ok(same(got.note, want.note), `row ${i} note ${JSON.stringify(got.note)}`);
        if (want.actionRect !== undefined) assert.equal(Boolean(got.actionRect), want.actionRect, `row ${i} actionRect`);
        assert.ok(got.confidence > 0 && got.confidence <= 1);
        assert.ok(got.rect.width > 0 && got.rect.height > 0);
      });
    }
    if (expected.requestsAtLeast !== undefined) assert.ok((facts.requests?.length ?? 0) >= expected.requestsAtLeast, detailMsg());
    if (expected.chats) {
      assert.deepEqual(facts.chats?.map((c) => [norm(c.name), norm(c.time), c.unread]), expected.chats.map((c) => [norm(c.name), norm(c.time), c.unread]), detailMsg());
    }
    if (expected.detail) {
      assert.ok(facts.detail, detailMsg());
      assert.ok(same(facts.detail.name, expected.detail.name), `detail name ${facts.detail.name}`);
      for (const key of ['wechatId', 'region', 'message'] as const) {
        if (expected.detail[key] !== undefined) assert.ok(same(facts.detail[key] ?? '', expected.detail[key]!), `detail ${key}: ${facts.detail[key]}`);
      }
    }
    if (expected.bubbles) {
      assert.deepEqual(facts.bubbles?.map((b) => [b.side, norm(b.text)]), expected.bubbles.map((b) => [b.side, norm(b.text)]), detailMsg());
      assert.equal(new Set(facts.bubbles!.map((b) => b.anchorKey)).size, facts.bubbles!.length, 'anchorKeys are distinct');
    }
    if (expected.inputBox) {
      assert.equal(facts.inputBox?.empty, expected.inputBox.empty, detailMsg());
      if (expected.inputBox.text !== undefined) assert.ok(same(facts.inputBox!.text, expected.inputBox.text), facts.inputBox!.text);
    }
    if (expected.buttons) assert.deepEqual(facts.buttons.map((b) => b.text), expected.buttons, detailMsg());
    for (const label of expected.buttonsInclude ?? []) assert.ok(facts.buttons.some((b) => b.text === label), `button ${label}: ${detailMsg()}`);
    for (const fragment of expected.warningsInclude ?? []) assert.ok(facts.warnings.some((w) => w.includes(fragment)), `warning containing ${fragment}: ${detailMsg()}`);
    assert.ok(facts.texts.every((t) => t.confidence >= 0 && t.confidence <= 1 && t.rect.width > 0));
  });
}

test('T11 on fixture: the duplicated name is ambiguous, the unique one is not', { skip: !available }, async () => {
  const facts = await read('new-friends-mixed');
  const dup = identityCandidates(facts.requests!, '林小雨');
  assert.equal(dup.ambiguous, true);
  assert.equal(dup.reason, 'duplicate_name');
  assert.equal(dup.candidates.length, 2);
  const one = identityCandidates(facts.requests!, '王大为');
  assert.equal(one.ambiguous, false);
  const cut = identityCandidates(facts.requests!, '昵称特别长的合成用户名');
  assert.equal(cut.ambiguous, true);
  assert.equal(cut.reason, 'truncated_name');
});

test('T13 on fixtures: light theme, wrong size and 1x are unreadable, never read', { skip: !available }, async () => {
  for (const name of ['light-theme', 'wrong-size', 'scale-1x']) {
    const facts = await read(name);
    assert.equal(facts.coverage, 'unreadable', name);
    assert.equal(facts.page, 'unknown', name);
    assert.equal(facts.requests, undefined, name);
    assert.equal(facts.confidence, 0, name);
  }
});

test('T14 on fixtures: zero rows carries three different coverages', { skip: !available }, async () => {
  const empty = await read('new-friends-empty');
  assert.deepEqual([empty.requests, empty.coverage], [[], 'end_confirmed']);
  const headerOnly = await read('new-friends-header-only');
  assert.deepEqual([headerOnly.requests, headerOnly.coverage], [[], 'current_viewport']);
  const partial = await read('new-friends-partial');
  assert.equal(partial.coverage, 'partial');
  const unreadable = await read('light-theme');
  assert.deepEqual([unreadable.requests, unreadable.coverage], [undefined, 'unreadable']);
});

test('T15 on fixture: WeChat-green rows are not pending without the text', { skip: !available }, async () => {
  const facts = await read('new-friends-green-selected');
  assert.deepEqual(facts.requests!.map((r) => [norm(r.name), r.status, Boolean(r.actionRect)]), [
    ['林小雨', 'added', false], ['王大为', 'unknown', false], ['张小明', 'pending', true],
  ]);
  const pending = facts.requests![2];
  // The actionRect covers the green button (250,296 48x24 points) around the 接受 text.
  assert.ok(pending.actionRect!.x <= 502 && pending.actionRect!.x + pending.actionRect!.width >= 594, JSON.stringify(pending.actionRect));
  assert.ok(pending.actionRect!.y <= 594 && pending.actionRect!.y + pending.actionRect!.height >= 640, JSON.stringify(pending.actionRect));
});

test('T26 on fixture: same text twice gives two bubbles with different anchorKeys', { skip: !available }, async () => {
  const facts = await read('chat-open');
  const others = facts.bubbles!.filter((b) => b.side === 'other');
  const selfs = facts.bubbles!.filter((b) => b.side === 'self');
  assert.equal(others.length, 2);
  assert.equal(selfs.length, 2);
  assert.equal(norm(others[0].text), norm(others[1].text));
  assert.notEqual(others[0].anchorKey, others[1].anchorKey);
  assert.notEqual(selfs[0].anchorKey, selfs[1].anchorKey);
  assert.ok(others[1].rect.y > others[0].rect.y);
  assert.ok(same((facts as { conversation?: { title: string } }).conversation?.title ?? '', '林小雨'), 'conversation title');
  assert.ok(!facts.warnings.some((w) => w.includes('colour says')), 'colour agrees with position on every bubble: ' + facts.warnings.join('; '));
  assert.ok(facts.bubbles!.every((b) => b.confidence >= 0.5));
});

test('performance: one 2560x1750 capture', { skip: !available }, async () => {
  await read('new-friends-mixed');
  const ms = timings['new-friends-mixed'];
  console.log(`# recognize(new-friends-mixed) took ${ms.toFixed(0)} ms (all: ${Object.entries(timings).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(', ')})`);
  assert.ok(ms > 0);
});
