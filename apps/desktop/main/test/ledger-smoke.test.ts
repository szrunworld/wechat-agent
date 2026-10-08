// The ledger smoke under Node's ABI (tsx). The same code runs inside the
// packaged app on Electron's ABI from packaging/verify-install.sh; here it
// proves the smoke itself is sound, so a failure there is an ABI/packaging
// problem and not a bug in the probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateLedgerSmoke, runLedgerSmoke } from '../src/ledger-smoke.ts';

test('ledger smoke opens a real ledger, writes and reads back a legacy suppression, closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-smoke-'));
  try {
    const report = await runLedgerSmoke(join(dir, 'ledger'));
    assert.equal(report.error, undefined);
    assert.equal(report.ok, true);
    assert.equal(report.modules, process.versions.modules);
    assert.equal(report.steps.added, 1);
    assert.equal(report.steps.suppressed, true);
    assert.equal(report.steps.otherSuppressed, false);
    assert.equal(report.steps.readBackAfterReopen, true);
    assert.deepEqual(report.steps.healthAfterClose, { writable: false, reason: 'closed', schemaVersion: report.steps.schemaVersion });
    assert.ok(existsSync(report.path));
    assert.ok(report.path.startsWith(dir), 'the smoke writes only under the directory it is given');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger smoke reports failure instead of throwing when the file is not a database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-smoke-bad-'));
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'ledger'), { recursive: true });
    writeFileSync(join(dir, 'ledger', 'ledger-smoke.sqlite'), 'not a database\n');
    const report = await runLedgerSmoke(join(dir, 'ledger'));
    assert.equal(report.ok, false);
    assert.match(report.error ?? '', /LedgerUnavailableError/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluateLedgerSmoke requires every step', () => {
  const good = { fileIsSqlite: true, health: { writable: true }, quickCheck: 'ok', added: 1, suppressed: true, otherSuppressed: false, readBackAfterReopen: true, healthAfterClose: { writable: false, reason: 'closed' } };
  assert.equal(evaluateLedgerSmoke(good), true);
  for (const [key, bad] of [['added', 0], ['suppressed', false], ['otherSuppressed', true], ['quickCheck', 'failed'], ['readBackAfterReopen', false], ['healthAfterClose', { writable: true }]] as const) {
    assert.equal(evaluateLedgerSmoke({ ...good, [key]: bad }), false, key);
  }
});
