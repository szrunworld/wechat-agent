// T13: a capture the profile does not fit (size, scale, theme) or that OCR
// cannot read is `unreadable`, with the reason spelled out; never guessed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { TextItem } from '@wechat-agent/ports';
import { createRecognizer } from '../src/recognizer.ts';
import { OcrError } from '../src/ocr.ts';
import { flatPng, profile, S, word } from './helpers.ts';

const DARK: [number, number, number] = [28, 28, 30];
const LIGHT: [number, number, number] = [245, 245, 245];
const meta = { width: 1280 * S, height: 875 * S, scale: S };

function scriptedOcr(texts: TextItem[] | Error) {
  const calls: string[] = [];
  return {
    calls,
    runner: { readText: async (path: string) => { calls.push(path); if (texts instanceof Error) throw texts; return texts; } },
  };
}

test('T13 applicability names the mismatch', () => {
  const r = createRecognizer({ ocr: scriptedOcr([]).runner });
  assert.deepEqual(r.profiles().map((p) => p.profileId), [profile.profileId]);
  assert.deepEqual(r.applicability({ width: 1920, height: 1080, scale: 2 }), { applicable: false, reason: 'size_mismatch' });
  assert.deepEqual(r.applicability({ width: 2560, height: 1750, scale: 1 }), { applicable: false, reason: 'scale_mismatch' });
  assert.deepEqual(r.applicability({ ...meta, windowFrame: { width: 1440, height: 900 } }), { applicable: false, reason: 'size_mismatch' });
  const fit = r.applicability({ ...meta, windowFrame: { width: 1280, height: 875 } });
  assert.ok(fit.applicable && fit.profile.profileId === profile.profileId && fit.profile.scale === 2);
  assert.ok(r.applicability({ width: 2560 + 2, height: 1750 - 3, scale: 2 }).applicable, 'within the profile tolerance');
  assert.equal(r.applicability({ width: 2560 + 6, height: 1750, scale: 2 }).applicable, false);
});

test('T13 wrong size: unreadable, OCR never runs', async () => {
  const ocr = scriptedOcr([word('新的朋友', 75, 114)]);
  const r = createRecognizer({ ocr: ocr.runner });
  const facts = await r.recognize({ width: 1920, height: 1080, scale: 2, bytes: flatPng(DARK, 1920, 1080) }, r.profiles()[0]);
  assert.equal(facts.coverage, 'unreadable');
  assert.equal(facts.page, 'unknown');
  assert.ok(facts.warnings.some((w) => w.startsWith('size_mismatch')), facts.warnings.join('; '));
  assert.equal(ocr.calls.length, 0);
});

test('T13 metadata that lies about the file size is unreadable', async () => {
  const ocr = scriptedOcr([]);
  const r = createRecognizer({ ocr: ocr.runner });
  const facts = await r.recognize({ ...meta, bytes: flatPng(DARK, 1000, 700) }, r.profiles()[0]);
  assert.equal(facts.coverage, 'unreadable');
  assert.ok(facts.warnings.some((w) => w.includes('file is 1000x700')));
  assert.equal(ocr.calls.length, 0);
});

test('T13 light theme on a dark profile: theme_mismatch, OCR never runs', async () => {
  const ocr = scriptedOcr([word('新的朋友', 75, 114)]);
  const r = createRecognizer({ ocr: ocr.runner });
  const facts = await r.recognize({ ...meta, bytes: flatPng(LIGHT) }, r.profiles()[0]);
  assert.equal(facts.coverage, 'unreadable');
  assert.ok(facts.warnings.some((w) => w.startsWith('theme_mismatch') && w.includes('light')), facts.warnings.join('; '));
  assert.equal(ocr.calls.length, 0);
});

test('T13 a background between the bands is not guessed either way', async () => {
  const r = createRecognizer({ ocr: scriptedOcr([]).runner });
  const facts = await r.recognize({ ...meta, bytes: flatPng([128, 128, 128]) }, r.profiles()[0]);
  assert.equal(facts.coverage, 'unreadable');
  assert.ok(facts.warnings.some((w) => w.includes('reads as unknown')));
});

test('T13 OCR failure is unreadable with the helper message', async () => {
  const r = createRecognizer({ ocr: scriptedOcr(new OcrError('ocr helper not found at /nowhere')).runner });
  const facts = await r.recognize({ ...meta, bytes: flatPng(DARK), artifactId: 'a1', sha256: 'h' }, r.profiles()[0]);
  assert.equal(facts.coverage, 'unreadable');
  assert.ok(facts.warnings.some((w) => w.startsWith('ocr_failed') && w.includes('/nowhere')));
  assert.deepEqual(facts.evidenceRef, { artifactId: 'a1', sha256: 'h' });
});

test('T13 an unknown profile or a stale revision is unreadable', async () => {
  const r = createRecognizer({ ocr: scriptedOcr([]).runner });
  const p = r.profiles()[0];
  const other = await r.recognize({ ...meta, bytes: flatPng(DARK) }, { ...p, profileId: 'wechat-9.9-unknown' });
  assert.equal(other.coverage, 'unreadable');
  assert.ok(other.warnings[0].startsWith('no_profile'));
  const stale = await r.recognize({ ...meta, bytes: flatPng(DARK) }, { ...p, revision: p.revision + 1 });
  assert.equal(stale.coverage, 'unreadable');
  assert.ok(stale.warnings[0].includes('revision'));
});

test('a fitting dark capture goes through OCR to PageFacts; bytes leave no temp file behind', async () => {
  const ocr = scriptedOcr([word('新的朋友', 75, 114), word('林小雨', 133, 160, 42, 16), word('已添加', 258, 164, 30, 10), word('群聊', 75, 230)]);
  const timings: unknown[] = [];
  const r = createRecognizer({ ocr: ocr.runner, onTiming: (t) => timings.push(t) });
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith('wechat-agent-recognition-')).length;
  const facts = await r.recognize({ ...meta, bytes: flatPng(DARK), artifactId: 'a2', sha256: 's2' }, r.profiles()[0]);
  assert.equal(facts.page, 'new_friends');
  assert.equal(facts.coverage, 'end_confirmed');
  assert.deepEqual(facts.requests?.map((x) => [x.name, x.status]), [['林小雨', 'added']]);
  assert.deepEqual(facts.evidenceRef, { artifactId: 'a2', sha256: 's2' });
  assert.equal(ocr.calls.length, 1);
  assert.ok(ocr.calls[0].includes('wechat-agent-recognition-'));
  assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith('wechat-agent-recognition-')).length, before);
  assert.equal(timings.length, 1);
});
