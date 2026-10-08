// Test helpers: text boxes given in WINDOW POINTS of profile 1 (as the legacy
// tests measured them) and converted to image pixels; a scripted sampler.
import type { PixelRect, TextItem } from '@wechat-agent/ports';
import { loadProfiles, type WeChatLayoutProfile } from '../src/profile.ts';
import type { ColourShares, Sampler } from '../src/png.ts';

export const profile: WeChatLayoutProfile = loadProfiles().find((p) => p.profileId === 'wechat-4.1-1280x875-2x-dark')!;
export const S = profile.scale;

/** A text box at (x, y) points with size (w, h) points, as Vision would report it at 2x. */
export const word = (text: string, x: number, y: number, w = text.length * 12, h = 15, confidence = 1): TextItem => ({
  text, rect: { x: x * S, y: y * S, width: w * S, height: h * S }, confidence,
});

const intersects = (a: PixelRect, b: PixelRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** A sampler that reports green inside the given pixel rectangles, red inside others, and a flat background luma. */
export function scriptedSampler(opts: { green?: PixelRect[]; red?: PixelRect[]; luma?: number; lumaAt?: (r: PixelRect) => number } = {}): Sampler {
  const greens = opts.green ?? [], reds = opts.red ?? [];
  return {
    meanLuma: (r) => opts.lumaAt ? opts.lumaAt(r) : (opts.luma ?? 30),
    shares: (r): ColourShares => ({
      green: greens.some((g) => intersects(g, r)) ? 0.6 : 0,
      red: reds.some((g) => intersects(g, r)) ? 0.1 : 0,
      white: 0,
      count: Math.max(1, r.width * r.height),
    }),
    greenBounds: (r) => {
      const hit = greens.find((g) => intersects(g, r));
      return hit ? { ...hit } : undefined;
    },
  };
}

/** A pixel rectangle given in points. */
export const pxRect = (x: number, y: number, w: number, h: number): PixelRect => ({ x: x * S, y: y * S, width: w * S, height: h * S });

// A minimal PNG writer for synthetic test images (RGB, filter 0).
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** Encodes an RGB image; `pixel(x, y)` returns [r, g, b]. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array()),
  ]);
}

/** A flat image of one colour at the profile's pixel size. */
export const flatPng = (rgb: [number, number, number], width = 1280 * S, height = 875 * S) => encodePng(width, height, () => rgb);
