import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DriverError, MAX_FRAME_BYTES } from '@wechat-agent/ports';
import { LineDecoder, encodeFrame } from '../src/index.ts';

test('encodeFrame: one line, LF terminated, limit counts the LF', () => {
  const line = encodeFrame({ a: 1 });
  assert.equal(line.toString('utf8'), '{"a":1}\n');
  // exactly at the limit: {"s":"<n chars>"}\n = 8 + n + 1 bytes... build to the byte
  const overhead = Buffer.byteLength('{"s":""}\n');
  const fits = encodeFrame({ s: 'x'.repeat(MAX_FRAME_BYTES - overhead) });
  assert.equal(fits.byteLength, MAX_FRAME_BYTES);
  assert.throws(() => encodeFrame({ s: 'x'.repeat(MAX_FRAME_BYTES - overhead + 1) }), (e: unknown) => {
    assert.ok(e instanceof DriverError);
    assert.equal(e.error.code, 'frame_too_large');
    assert.equal(e.error.phase, 'local');
    assert.equal(e.error.notSent, true);
    return true;
  });
  // multi-byte text is counted in bytes, not characters
  assert.throws(() => encodeFrame({ s: '微'.repeat(Math.ceil(MAX_FRAME_BYTES / 3)) }), /frame_too_large/);
});

test('LineDecoder: reassembles split chunks, keeps the remainder, rejects an overlong line', () => {
  const decoder = new LineDecoder(32);
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n{"b"')), ['{"a":1}']);
  assert.deepEqual(decoder.push(Buffer.from(':2}\n')), ['{"b":2}']);
  assert.deepEqual(decoder.push(Buffer.from('')), []);
  assert.deepEqual(decoder.push(Buffer.from('微信\n')), ['微信']);
  assert.throws(() => decoder.push(Buffer.from(`${'x'.repeat(32)}\n`)), /frame_too_large/);
  const slow = new LineDecoder(16);
  slow.push(Buffer.from('x'.repeat(10)));
  assert.throws(() => slow.push(Buffer.from('x'.repeat(10))), /frame_too_large/, 'a line that never ends is rejected once it exceeds the limit');
});
