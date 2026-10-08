// One UTF-8 JSON message per LF-terminated line, at most MAX_FRAME_BYTES
// including the LF (methods.json transport.framing / maxFrameBytes).
import { DriverError, MAX_FRAME_BYTES } from '@wechat-agent/ports';

/** Encodes a frame; refuses locally when it would exceed the limit (nothing is sent). */
export function encodeFrame(value: unknown, maxBytes: number = MAX_FRAME_BYTES): Buffer {
  const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (line.byteLength > maxBytes) {
    throw new DriverError({
      code: 'frame_too_large',
      message: `frame is ${line.byteLength} bytes, limit is ${maxBytes} (LF included)`,
      phase: 'local',
      retryable: false,
      notSent: true,
      details: { byteLength: line.byteLength, maxBytes },
    });
  }
  return line;
}

/** Splits a byte stream into complete lines; throws when a line exceeds the limit. */
export class LineDecoder {
  private rest: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    const buf = this.rest.byteLength ? Buffer.concat([this.rest, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const lf = buf.indexOf(10, start);
      if (lf === -1) break;
      if (lf - start + 1 > this.maxBytes) {
        this.rest = Buffer.alloc(0);
        throw tooLarge(lf - start + 1, this.maxBytes);
      }
      lines.push(buf.subarray(start, lf).toString('utf8'));
      start = lf + 1;
    }
    const tail = buf.subarray(start);
    if (tail.byteLength >= this.maxBytes) {
      this.rest = Buffer.alloc(0);
      throw tooLarge(tail.byteLength + 1, this.maxBytes);
    }
    this.rest = tail.byteLength ? Buffer.from(tail) : Buffer.alloc(0);
    return lines;
  }
}

function tooLarge(byteLength: number, maxBytes: number): DriverError {
  return new DriverError({
    code: 'frame_too_large',
    message: `incoming frame of at least ${byteLength} bytes exceeds ${maxBytes}`,
    phase: 'transport',
    retryable: false,
    details: { byteLength, maxBytes },
  });
}
