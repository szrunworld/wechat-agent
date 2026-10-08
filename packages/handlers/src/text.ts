// Text helpers shared by the handlers: OCR read-back comparison and label
// matching. Nothing here touches a port.

import { createHash } from 'node:crypto';
import type { Bubble, ButtonHit, PageFacts, PixelPoint, PixelRect, TextItem } from '@wechat-agent/ports';

const ZERO_WIDTH = /[​-‍﻿]/g;

/** Canonical form for comparing what we typed with what OCR read back: NFC, one newline style, no zero-width or trailing blanks. */
export function normText(text: string): string {
  return text
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t　]+$/g, ''))
    .join('\n')
    .trim();
}

/** Labels (buttons, names) compare without any whitespace. */
export function normLabel(text: string): string {
  return normText(text).replace(/\s+/g, '');
}

export function sameLabel(a: string, b: string): boolean {
  return normLabel(a) === normLabel(b);
}

/** Exact read-back equality after normalisation; emoji and newlines must survive OCR or the text is a mismatch. */
export function sameContent(typed: string, readBack: string): boolean {
  return normText(typed) === normText(readBack);
}

export function center(rect: PixelRect): PixelPoint {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

export function findButton(facts: PageFacts, labels: readonly string[]): ButtonHit | undefined {
  const pool = [...facts.buttons, ...(facts.detail?.buttons ?? [])];
  return pool.find((b) => labels.some((l) => sameLabel(b.text, l)));
}

export function findText(facts: PageFacts, pattern: RegExp): TextItem | undefined {
  return facts.texts.find((t) => pattern.test(normLabel(t.text)));
}

export function anyText(facts: PageFacts, pattern: RegExp): boolean {
  return facts.texts.some((t) => pattern.test(normLabel(t.text))) || facts.buttons.some((b) => pattern.test(normLabel(b.text)));
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Stable JSON for digests: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/**
 * The conversation context a draft or an approval was based on: a 32-bit FNV-1a
 * over the inbound bubbles' texts in order. A new inbound message changes it;
 * a scroll that keeps the same texts visible does not.
 */
export function contextRevisionOf(bubbles: readonly Bubble[] | undefined): number {
  let hash = 0x811c9dc5;
  for (const b of bubbles ?? []) {
    if (b.side !== 'other') continue;
    for (const ch of `${normText(b.text)}\u0000`) {
      hash ^= ch.codePointAt(0)!;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}
