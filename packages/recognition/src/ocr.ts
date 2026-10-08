// The OCR helper (ocr/ocr.swift, Apple Vision) as a subprocess. It reads an
// image FILE and prints text boxes in image pixels; it cannot capture, click
// or type, and neither can anything here.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PixelRect, TextItem } from '@wechat-agent/ports';

export class OcrError extends Error {
  override name = 'OcrError';
}

export const DEFAULT_OCR_PATH = resolve(import.meta.dirname, '../ocr/ocr');

export interface OcrRunner {
  /** Text boxes in image pixels, top-left origin; `region` restricts the read. */
  readText(imagePath: string, region?: PixelRect): Promise<TextItem[]>;
}

export async function ocrAvailable(binary = DEFAULT_OCR_PATH): Promise<boolean> {
  try {
    await access(binary);
    return true;
  } catch {
    return false;
  }
}

export function createOcrRunner(binary = DEFAULT_OCR_PATH, timeoutMs = 20_000): OcrRunner {
  return {
    readText(imagePath, region) {
      const args = [imagePath];
      if (region) args.push(...[region.x, region.y, region.width, region.height].map((n) => String(Math.round(n))));
      return new Promise((done, fail) => {
        execFile(binary, args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return fail(new OcrError(`ocr helper not found at ${binary}; run \`npm run build:ocr -w packages/recognition\``));
            return fail(new OcrError((stderr || error.message).trim()));
          }
          try {
            const raw = JSON.parse(stdout) as { text: string; x: number; y: number; w: number; h: number; confidence: number }[];
            done(raw.map((w) => ({ text: w.text, rect: { x: w.x, y: w.y, width: w.w, height: w.h }, confidence: w.confidence })));
          } catch (e) {
            fail(new OcrError(`ocr helper printed no JSON: ${(e as Error).message}`));
          }
        });
      });
    },
  };
}
