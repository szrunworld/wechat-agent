// Which rows could be the person a task names. Pure; the handler decides
// what an ambiguous answer means for its task (方案 §09: target_ambiguous).
import type { RequestRow } from '@wechat-agent/ports';
import { isTruncated, norm, untruncate } from './text.ts';

/** Whether a row's name, as the list shows it (it may be cut short with …), is this name. */
export function sameName(shown: string, full: string): boolean {
  const a = untruncate(shown);
  const b = norm(full);
  return a.length > 0 && (a === b || (a.length >= 2 && b.startsWith(a)) || (b.length >= 2 && a.startsWith(b)));
}

export type AmbiguityReason = 'duplicate_name' | 'truncated_name' | 'low_confidence' | 'not_found';

export interface IdentityCandidates {
  candidates: RequestRow[];
  /** True unless exactly one row matches, by its full (untruncated) name, with usable confidence. */
  ambiguous: boolean;
  reason?: AmbiguityReason;
}

/** Apple Vision reports 1, 0.5 or 0.3: a 0.3 read is doubtful, 0.5 is usable. */
export const MIN_IDENTITY_CONFIDENCE = 0.5;

/**
 * Rows that could be `name`. One exact, confident match is unambiguous; two
 * matches, a match the list cut short, or a low-confidence read are not
 * (T11). An empty answer is not ambiguous, it is `not_found`.
 */
export function identityCandidates(rows: readonly RequestRow[], name: string, minConfidence = MIN_IDENTITY_CONFIDENCE): IdentityCandidates {
  const candidates = rows.filter((r) => sameName(r.name, name));
  if (candidates.length === 0) return { candidates, ambiguous: false, reason: 'not_found' };
  if (candidates.length > 1) return { candidates, ambiguous: true, reason: 'duplicate_name' };
  const [only] = candidates;
  if (isTruncated(only.name) || untruncate(only.name) !== norm(name)) return { candidates, ambiguous: true, reason: 'truncated_name' };
  if (only.confidence < minConfidence) return { candidates, ambiguous: true, reason: 'low_confidence' };
  return { candidates, ambiguous: false };
}
