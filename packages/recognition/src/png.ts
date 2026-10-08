// A small PNG reader for artifact screenshots: 8-bit greyscale/RGB(A),
// non-interlaced, which is what screen captures are. Everything else is
// refused (the caller reports `unreadable`), never approximated.
import { inflateSync } from 'node:zlib';
import type { PixelRect } from '@wechat-agent/ports';

export class PngError extends Error {
  override name = 'PngError';
}

export interface Pixels {
  width: number;
  height: number;
  /** Packed RGB, row-major, 3 bytes per pixel. */
  rgb: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from the header alone, without inflating anything. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new PngError('not a PNG file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function decodePng(bytes: Uint8Array): Pixels {
  const { width, height } = pngSize(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bitDepth = bytes[24], colorType = bytes[25], interlace = bytes[28];
  if (bitDepth !== 8) throw new PngError(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new PngError('interlaced PNG is not supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new PngError(`unsupported colour type ${colorType}`);

  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const start = offset + 8;
    if (type === 'IDAT') idat.push(bytes.subarray(start, start + length));
    if (type === 'IEND') break;
    offset = start + length + 4;
  }
  if (idat.length === 0) throw new PngError('no image data');
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d.buffer, d.byteOffset, d.byteLength))));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new PngError('truncated image data');

  const rgb = new Uint8Array(width * height * 3);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new PngError(`bad filter ${filter} on row ${y}`);
      }
      line[i] = v & 0xff;
    }
    const row = y * width * 3;
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = row + x * 3;
      if (channels >= 3) { rgb[d] = line[s]; rgb[d + 1] = line[s + 1]; rgb[d + 2] = line[s + 2]; }
      else { rgb[d] = rgb[d + 1] = rgb[d + 2] = line[s]; }
    }
    prev.set(line);
  }
  return { width, height, rgb };
}

/** Colour shares of a rectangle, in the same terms as the OCR helper's `color` mode. */
export interface ColourShares { green: number; red: number; white: number; count: number }

/** Reads colours out of decoded pixels. Analysis takes this interface so tests can script it. */
export interface Sampler {
  /** Mean luminance 0..255 of the rectangle (clipped to the image); NaN when it lies outside. */
  meanLuma(rect: PixelRect): number;
  shares(rect: PixelRect): ColourShares;
  /** The tightest rectangle of WeChat-green pixels inside `rect`, or undefined when fewer than `minShare` are green. */
  greenBounds(rect: PixelRect, minShare?: number): PixelRect | undefined;
}

export const isGreen = (r: number, g: number, b: number) => g > 140 && r < 90 && b < 130 && g > r + 60;
export const isRed = (r: number, g: number, b: number) => r > 200 && g < 90 && b < 90;
export const isWhite = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;

export class PixelSampler implements Sampler {
  constructor(readonly pixels: Pixels) {}

  private clip(rect: PixelRect) {
    const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(this.pixels.width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(this.pixels.height, Math.ceil(rect.y + rect.height));
    return { x0, y0, x1, y1, empty: x1 <= x0 || y1 <= y0 };
  }

  meanLuma(rect: PixelRect): number {
    const { x0, y0, x1, y1, empty } = this.clip(rect);
    if (empty) return NaN;
    const { rgb, width } = this.pixels;
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 3;
      sum += 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
      n++;
    }
    return sum / n;
  }

  shares(rect: PixelRect): ColourShares {
    const { x0, y0, x1, y1, empty } = this.clip(rect);
    if (empty) return { green: 0, red: 0, white: 0, count: 0 };
    const { rgb, width } = this.pixels;
    let green = 0, red = 0, white = 0, count = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 3, r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      count++;
      if (isGreen(r, g, b)) green++;
      else if (isRed(r, g, b)) red++;
      else if (isWhite(r, g, b)) white++;
    }
    return { green: green / count, red: red / count, white: white / count, count };
  }

  greenBounds(rect: PixelRect, minShare = 0.15): PixelRect | undefined {
    const { x0, y0, x1, y1, empty } = this.clip(rect);
    if (empty) return undefined;
    const { rgb, width } = this.pixels;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, green = 0, count = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 3;
      count++;
      if (!isGreen(rgb[p], rgb[p + 1], rgb[p + 2])) continue;
      green++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (count === 0 || green / count < minShare) return undefined;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }
}

/** A sampler for text-only analysis: sees no colour at all. */
export const NO_PIXELS: Sampler = {
  meanLuma: () => NaN,
  shares: () => ({ green: 0, red: 0, white: 0, count: 0 }),
  greenBounds: () => undefined,
};
