// Lint for docs/acceptance: 42 case records, 12 step documents, the support
// matrix, and the one rule that keeps the plan honest: `result: passed` needs
// testedAt, appCommit and operator. scripts/ is not lane H's, so this is the
// lint (lane-h.md item 7).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { acceptanceDir, CASE_FIELDS, CASE_IDS, listSteps, parseRecord, readCases, STEP_IDS, validateCase } from '../src/acceptance-lint.ts';

const dir = acceptanceDir();

test('T01…T42 each have one record with every 方案 §13 field and a legal result', () => {
  const cases = readCases(path.join(dir, 'cases'));
  assert.deepEqual(cases.map((c) => c.file.replace('.md', '')), CASE_IDS);
  for (const record of cases) {
    const problems = validateCase(record, record.file.replace('.md', ''));
    assert.deepEqual(problems, [], `${record.file}: ${problems.join('; ')}`);
    assert.ok(record.fields.requirementId, `${record.file}: requirementId`);
    assert.ok(record.body.includes('## 条件') && record.body.includes('## 预期'), `${record.file}: body sections`);
  }
});

test('a passed record without evidence is rejected; a not_run record with evidence is rejected', () => {
  const template = CASE_FIELDS.map((k) => `${k}: ""`).join('\n');
  const passed = parseRecord(`---\n${template.replace('caseId: ""', 'caseId: T99').replace('result: ""', 'result: passed')}\n---\n`);
  const problems = validateCase(passed, 'T99');
  assert.ok(problems.some((p) => p.includes('testedAt is empty')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('appCommit is empty')));
  assert.ok(problems.some((p) => p.includes('operator is empty')));

  const complete = parseRecord(`---\n${template
    .replace('caseId: ""', 'caseId: T99').replace('result: ""', 'result: passed')
    .replace('testedAt: ""', 'testedAt: 2026-10-09T10:00:00+08:00').replace('appCommit: ""', 'appCommit: abc1234').replace('operator: ""', 'operator: coordinator')}\n---\n`);
  assert.deepEqual(validateCase(complete, 'T99'), []);

  const notRunWithEvidence = parseRecord(`---\n${template.replace('caseId: ""', 'caseId: T99').replace('result: ""', 'result: not_run').replace('testedAt: ""', 'testedAt: 2026-10-09T10:00:00+08:00')}\n---\n`);
  assert.ok(validateCase(notRunWithEvidence, 'T99').some((p) => p.includes('not_run must not carry')));

  const bogus = parseRecord(`---\n${template.replace('result: ""', 'result: pass')}\n---\n`);
  assert.ok(validateCase(bogus).some((p) => p.includes('not in passed|failed|blocked|not_run')));
  assert.throws(() => parseRecord('no front matter'));
  assert.throws(() => parseRecord('---\nresult: passed\nresult: failed\n---\n'), /duplicate/);
});

test('no record is marked passed by this lane: every real-device case is still not_run', () => {
  for (const record of readCases(path.join(dir, 'cases'))) {
    assert.equal(record.fields.result, 'not_run', `${record.file} was pre-marked ${record.fields.result}`);
  }
});

test('A01…A12 step documents exist with 执行与记录 and 通过条件', () => {
  const steps = listSteps(path.join(dir, 'steps'));
  assert.deepEqual(steps.map((s) => s.replace('.md', '')), STEP_IDS);
  for (const file of steps) {
    const text = readFileSync(path.join(dir, 'steps', file), 'utf8');
    assert.ok(text.includes('## 执行与记录'), `${file}: 执行与记录`);
    assert.ok(text.includes('## 通过条件'), `${file}: 通过条件`);
    assert.ok(text.includes('## 证据'), `${file}: 证据`);
  }
});

test('support matrix and README exist and the matrix starts untested', () => {
  const matrix = readFileSync(path.join(dir, 'support-matrix.md'), 'utf8');
  assert.ok(matrix.includes('not_tested'));
  const rows = matrix.split('\n').filter((l) => l.startsWith('|') && !l.includes('---'));
  assert.ok(!rows.some((l) => l.split('|').map((c) => c.trim()).includes('supported')), 'nothing is marked supported before a real-device run');
  assert.ok(existsSync(path.join(dir, 'README.md')));
  const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const word of ['testAccountAlias', 'targetAlias', 'authorizationEvidenceId', 'not_run']) assert.ok(readme.includes(word), `README: ${word}`);
});
