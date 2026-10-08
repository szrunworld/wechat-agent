// Parses and validates docs/acceptance records (方案 §13 template). The rule
// that matters: a record may say `result: passed` only with a non-empty
// testedAt, appCommit and operator; a plan is never a pass.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const RESULTS = ['passed', 'failed', 'blocked', 'not_run'] as const;
export type AcceptanceResult = (typeof RESULTS)[number];

/** Every field of the 方案 §13 record, in its order. */
export const CASE_FIELDS = [
  'caseId', 'requirementId', 'result',
  'appCommit', 'platformCommit', 'contractSha256', 'versions', 'testedAt',
  'testAccountAlias', 'targetAlias', 'authorizationEvidenceId',
  'operationId', 'taskId', 'attemptId', 'requestId', 'platformRunId', 'receiptId',
  'beforeEvidenceHash', 'afterEvidenceHash', 'businessFactId',
  'cancelAcceptedAt', 'quiescenceConfirmedAt', 'unexpectedInputCount',
  'coverage', 'actualResult', 'defectId', 'operator', 'reviewer',
] as const;

export const REQUIRED_WHEN_PASSED = ['testedAt', 'appCommit', 'operator'] as const;

export interface CaseRecord {
  file: string;
  fields: Record<string, string>;
  body: string;
}

export const CASE_IDS = Array.from({ length: 42 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
export const STEP_IDS = Array.from({ length: 12 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);

/** Front matter is flat `key: value` lines between two `---` lines; quotes around a value are stripped. */
export function parseRecord(text: string, file = '<memory>'): CaseRecord {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new Error(`${file}: no front matter`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${file}: front matter not closed`);
  const fields: Record<string, string> = {};
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
    if (!m) throw new Error(`${file}: bad front matter line: ${raw}`);
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (m[1] in fields) throw new Error(`${file}: duplicate field ${m[1]}`);
    fields[m[1]] = value;
  }
  return { file, fields, body: lines.slice(end + 1).join('\n') };
}

export function validateCase(record: CaseRecord, expectedId?: string): string[] {
  const problems: string[] = [];
  const f = record.fields;
  for (const key of CASE_FIELDS) if (!(key in f)) problems.push(`missing field ${key}`);
  if (expectedId && f.caseId !== expectedId) problems.push(`caseId ${f.caseId} != ${expectedId}`);
  if (!RESULTS.includes(f.result as AcceptanceResult)) problems.push(`result "${f.result}" not in ${RESULTS.join('|')}`);
  if (f.result === 'passed') {
    for (const key of REQUIRED_WHEN_PASSED) if (!f[key]) problems.push(`result passed but ${key} is empty`);
    if (f.testedAt && Number.isNaN(Date.parse(f.testedAt))) problems.push(`testedAt "${f.testedAt}" is not a timestamp`);
  }
  if (f.result === 'not_run' && (f.testedAt || f.actualResult)) problems.push('not_run must not carry testedAt/actualResult');
  if (f.unexpectedInputCount && !/^\d+$/.test(f.unexpectedInputCount)) problems.push('unexpectedInputCount must be an integer');
  return problems;
}

export function readCases(dir: string): CaseRecord[] {
  return readdirSync(dir).filter((n) => /^T\d{2}\.md$/.test(n)).sort().map((n) => parseRecord(readFileSync(path.join(dir, n), 'utf8'), n));
}

export function listSteps(dir: string): string[] {
  return readdirSync(dir).filter((n) => /^A\d{2}\.md$/.test(n)).sort();
}

export function acceptanceDir(): string {
  return path.resolve(import.meta.dirname, '../../../docs/acceptance');
}
