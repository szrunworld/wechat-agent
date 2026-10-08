import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePng, PixelSampler, PngError, pngSize } from '../src/png.ts';
import { encodePng } from './helpers.ts';

test('decodes an RGB PNG and samples colours', () => {
  const bytes = encodePng(40, 20, (x, y) => (x < 20 ? [7, 193, 96] : y < 10 ? [250, 40, 40] : [255, 255, 255]));
  assert.deepEqual(pngSize(bytes), { width: 40, height: 20 });
  const px = decodePng(bytes);
  assert.equal(px.rgb.length, 40 * 20 * 3);
  const s = new PixelSampler(px);
  const all = s.shares({ x: 0, y: 0, width: 40, height: 20 });
  assert.ok(Math.abs(all.green - 0.5) < 0.01 && Math.abs(all.red - 0.25) < 0.01 && Math.abs(all.white - 0.25) < 0.01);
  assert.deepEqual(s.greenBounds({ x: 0, y: 0, width: 40, height: 20 }), { x: 0, y: 0, width: 20, height: 20 });
  assert.equal(s.greenBounds({ x: 20, y: 0, width: 20, height: 20 }), undefined);
  assert.ok(s.meanLuma({ x: 20, y: 10, width: 20, height: 10 }) > 250);
  assert.ok(Number.isNaN(s.meanLuma({ x: 100, y: 100, width: 5, height: 5 })));
});

test('refuses what it cannot decode instead of guessing', () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), PngError);
  const bytes = encodePng(4, 4, () => [0, 0, 0]);
  bytes[24] = 16; // bit depth
  assert.throws(() => decodePng(bytes), /bit depth/);
});
