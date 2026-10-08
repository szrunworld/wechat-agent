// readLegacyState: the old `{ handled, wechatPid }` file becomes suppression
// entries and nothing else.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LegacyStateError, openLedger, readLegacyState } from '../src/index.ts';
import type { SqliteLedger } from '../src/index.ts';
import { tmpLedgerPath } from './helpers/tmp.ts';

function legacyFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'wechat-legacy-')), 'state.json');
  writeFileSync(path, content);
  return path;
}

test('T39: handled keys become entries with the file hash; wechatPid and unknown fields are dropped, duplicates and junk skipped', () => {
  const raw = JSON.stringify({ handled: ['孙八|我是孙八', '吴九|交个朋友', '孙八|我是孙八', '', 42, null], wechatPid: 4242, mode: 'auto' }, null, 1);
  const path = legacyFile(raw);
  const state = readLegacyState(path);
  const hash = createHash('sha256').update(raw).digest('hex');
  assert.deepEqual(state.entries, [{ key: '孙八|我是孙八', sourceHash: hash }, { key: '吴九|交个朋友', sourceHash: hash }]);
  assert.deepEqual(state.droppedFields.sort(), ['mode', 'wechatPid']);
  assert.ok(!JSON.stringify(state.entries).includes('4242'));
  assert.ok(!JSON.stringify(state.entries).includes('auto'));
});

test('a missing file is empty; a malformed file is an error, not an empty import', () => {
  assert.deepEqual(readLegacyState(join(tmpdir(), 'wechat-legacy-does-not-exist', 'state.json')), { entries: [], sourceHash: '', droppedFields: [] });
  assert.throws(() => readLegacyState(legacyFile('{not json')), LegacyStateError);
  assert.throws(() => readLegacyState(legacyFile('[1,2]')), LegacyStateError);
  assert.throws(() => readLegacyState(legacyFile('{"handled": "x"}')), LegacyStateError);
  assert.deepEqual(readLegacyState(legacyFile('{}')).entries, []);
});

test('T39: importing the legacy file into the ledger yields suppressions only', async () => {
  const path = legacyFile(JSON.stringify({ handled: ['郑十|我是郑十'], wechatPid: 99 }));
  const ledger = (await openLedger(tmpLedgerPath())) as SqliteLedger;
  const state = readLegacyState(path);
  assert.equal(await ledger.importLegacySuppressions(state.entries, '2026-10-08T10:00:00+08:00'), 1);
  assert.equal(await ledger.isSuppressed('郑十|我是郑十'), true);
  const rows = ledger.diagnostics().rows!;
  assert.equal(rows.legacy_suppression, 1);
  assert.equal(rows.tasks, 0);
  assert.equal(rows.facts, 0);
  assert.equal(rows.attempts, 0);
  assert.equal(await ledger.getAccount(), undefined, 'no account is bound from the old file');
  assert.deepEqual((await ledger.getPolicy()).allowedActions.length, 5, 'policy is the default, not an inherited auto mode');
  await ledger.close();
});
