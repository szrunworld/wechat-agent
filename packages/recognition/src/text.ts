// Text helpers shared by the analysis and the identity check.
import type { PixelRect, TextItem } from '@wechat-agent/ports';

/**
 * Vision reads the list's truncation mark as … (U+2026) on one Mac and as ⋯
 * (U+22EF) or ‥ (U+2025) on another; they all mean "cut short", so they all
 * become … before anything looks at the text.
 */
export const canonicalEllipsis = (text: string) => text.replace(/[⋯‥]/g, '…');

/** Collapses whitespace and full-width brackets so OCR spacing does not matter. */
export const norm = (text: string) => canonicalEllipsis(text).replace(/\s+/g, '').replace(/[（]/g, '(').replace(/[）]/g, ')');

/** Strips the … / ... a list adds when it cuts a name short. */
export const untruncate = (text: string) => norm(text).replace(/[.…·]+$/, '');

export const isTruncated = (text: string) => /[.…]{1,3}$/.test(norm(text)) || /\.{2,}$/.test(text.trim());

export const centreY = (r: PixelRect) => r.y + r.height / 2;
export const centreX = (r: PixelRect) => r.x + r.width / 2;
export const right = (r: PixelRect) => r.x + r.width;
export const bottom = (r: PixelRect) => r.y + r.height;

/** Same line when the vertical centres are within `tolerance` pixels. */
export const sameLine = (a: TextItem, b: TextItem, tolerance: number) => Math.abs(centreY(a.rect) - centreY(b.rect)) < tolerance;

export const byPosition = (a: TextItem, b: TextItem) => a.rect.y - b.rect.y || a.rect.x - b.rect.x;

export function union(a: PixelRect, b: PixelRect): PixelRect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
}

export function inside(r: PixelRect, area: PixelRect): boolean {
  return centreX(r) >= area.x && centreX(r) <= right(area) && centreY(r) >= area.y && centreY(r) <= bottom(area);
}

export function roundRect(r: PixelRect): PixelRect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}
