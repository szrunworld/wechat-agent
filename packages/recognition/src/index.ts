// Lane C. See docs/lanes/lane-c.md.
import type { Recognizer } from '@wechat-agent/ports';
export * as legacyParse from './legacy-parse.ts';
export function createRecognizer(_options: { ocrPath?: string } = {}): Recognizer {
  throw new Error('lane C: not implemented yet');
}
