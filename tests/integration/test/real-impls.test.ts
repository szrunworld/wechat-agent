// The same vertical slice over the real implementations that have merged
// into app-skeleton: lane B's SQLite ledger and lane D's handlers. Only the
// wiring changes; the scenario helpers and the IPC calls are the ones the
// fake-based tests use. Assertions here go through the ports only, so they
// do not depend on which ledger is underneath.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHandlers } from '@wechat-agent/handlers';
import { openLedger } from '@wechat-agent/ledger';
import type { PageFacts } from '@wechat-agent/ports';
import { InMemoryLedger } from '@wechat-agent/ports/fakes';
import { acceptScript, newFriendsPage, pageFacts, requestRow } from '../src/fixtures.ts';
import { acceptToEnd, NAME } from '../src/scenario.ts';
import { createSlice } from '../src/wiring.ts';

const tmpLedger = () => path.join(mkdtempSync(path.join(tmpdir(), 'wechat-agent-h-')), 'ledger.sqlite');

/** What lane D's AcceptRequest expects to see: list → detail (接受) → detail again after approval → list with the row added. */
function laneDAcceptScript(): PageFacts[] {
  const detail = pageFacts({
    page: 'request_detail',
    detail: { name: NAME, wechatId: 'wxid_fixture_a', region: '测试', message: `你好，我是${NAME}`, buttons: [{ text: '接受', rect: { x: 1500, y: 900, width: 200, height: 80 }, confidence: 0.95 }], confidence: 0.95 },
  });
  return [newFriendsPage([requestRow(NAME, 'pending')]), detail, detail, newFriendsPage([requestRow(NAME, 'added')])];
}

test('real ledger (lane B, SQLite): the slice confirms, persists the attempt chain and the outbox, and leaves nothing open', async () => {
  const ledger = await openLedger(tmpLedger());
  const slice = await createSlice({ ledger, facts: acceptScript() });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'confirmed');
  assert.equal(slice.driver.countCalls('act'), 1);
  const receiptFact = done.facts.find((f) => f.factKind === 'platform_receipt')!;
  const attempt = await ledger.getAttempt(String(receiptFact.data?.attemptId));
  assert.equal(attempt?.state, 'verified');
  assert.equal(attempt?.requestId, [...slice.driver.acts.keys()][0]);
  assert.ok(await ledger.getReceipt(attempt!.attemptId), 'the platform receipt is stored');
  assert.deepEqual(await ledger.findOpenAttempts(), []);
  assert.equal((await ledger.pendingOutbox()).length, 1);
  assert.equal((await ledger.health()).writable, true);
  assert.ok((await ledger.diagnostics()).schemaVersion >= 1);
  await slice.app.stop();
  await ledger.close();
});

test('real handlers (lane D): AcceptRequest walks list → detail → approval → re-observe → one dangerous click → 已添加', async () => {
  const slice = await createSlice({ handlers: createHandlers(), facts: laneDAcceptScript() });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'confirmed', done.timeline.map((t) => t.label).join(' > '));
  // Two actions: opening the detail (navigation) and the approved accept; both verified, distinct requestIds.
  assert.equal(slice.driver.countCalls('act'), 2);
  const ledger = slice.ledger as InMemoryLedger;
  const attempts = [...ledger.attempts.values()].filter((a) => a.taskId === done.taskId);
  assert.deepEqual(attempts.map((a) => a.stepId), ['open_detail', 'accept']);
  assert.deepEqual(attempts.map((a) => a.state), ['verified', 'verified']);
  assert.equal(new Set(attempts.map((a) => a.requestId)).size, 2);
  const kinds = done.facts.map((f) => `${f.factKind}:${f.outcome}`);
  assert.ok(kinds.includes('friend_added:confirmed'), kinds.join(','));
  assert.ok(kinds.includes('request_read:observed'));
  assert.equal(slice.driver.countCalls('readArtifact'), 4, 'every observation is read through artifact.read');
  await slice.app.stop();
});

test('real handlers + real ledger: the slice is green end to end through the ports alone', async () => {
  const ledger = await openLedger(tmpLedger());
  const slice = await createSlice({ ledger, handlers: createHandlers(), facts: laneDAcceptScript() });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'confirmed', done.timeline.map((t) => t.label).join(' > '));
  assert.equal(slice.driver.countCalls('act'), 2);
  assert.deepEqual(await ledger.findOpenAttempts(), []);
  assert.equal((await ledger.listFacts(done.taskId)).some((f) => f.factKind === 'friend_added'), true);
  await slice.app.stop();
  await ledger.close();
});

test('real handlers under a fault: the connection drops after the accept click → unknown attempt, needs_reconciliation, no re-dispatch (T08)', async () => {
  const slice = await createSlice({
    handlers: createHandlers(), facts: laneDAcceptScript(),
    driver: { faults: [{ method: 'act', onCall: 2, error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] },
  });
  await slice.app.start();
  const done = await acceptToEnd(slice);
  assert.equal(done.state, 'needs_reconciliation', done.timeline.map((t) => t.label).join(' > '));
  assert.equal(slice.driver.countCalls('act'), 2);
  const ledger = slice.ledger as InMemoryLedger;
  const accept = [...ledger.attempts.values()].find((a) => a.taskId === done.taskId && a.stepId === 'accept')!;
  assert.equal(accept.state, 'unknown');
  assert.ok(accept.requestId);
  await slice.app.stop();
});
