// A4 pairing on the app side, over the ports FakeDriver: the app asks to
// pair, waits for the person, stores the credential and reconnects with it;
// a refusal, a revocation or a lapsed grant each stop the app in a state the
// person can act on, without a reconnect loop and without any owner call.
// The end-to-end chain over the real driver and the A4 Fake Runtime is in
// tests/integration/test/pairing.test.ts.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DriverError } from '@wechat-agent/ports';
import { FakeDriver, FakeRecognizer, InMemoryLedger } from '@wechat-agent/ports/fakes';
import { MemoryCredentialStore } from '../src/credentials.ts';
import { createApplication } from '../src/index.ts';
import { ManualScheduler } from '../src/support.ts';
import { expectIpc, makeClock, makeHarness, readStub, registry, waitFor } from './harness.ts';

const STORED = { clientId: 'app:wechat-agent', token: 'adt1_stored-token-not-a-secret', pairedAt: '2026-10-08T09:00:00+08:00' };

async function unpairedHarness(store = new MemoryCredentialStore()) {
  const driver = new FakeDriver();
  const scheduler = new ManualScheduler();
  const clock = makeClock();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wechat-agent-pair-'));
  const app = createApplication({
    driver, ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: registry(readStub(() => [])), now: clock.now, scheduler, credentials: store,
    config: { dataDir, lockPath: null, reconnect: { baseMs: 0, maxMs: 0 }, cancelWaitMs: 5, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  const snapshot = () => app.service.call('app.getSnapshot', {});
  return { driver, scheduler, clock, app, store, snapshot, call: app.service.call.bind(app.service) };
}

test('pairing: asks once on an unpaired connection, shows the short code, waits; approved → credential stored, reconnect paired with it', async () => {
  const h = await unpairedHarness();
  assert.equal((await h.snapshot()).connection.state, 'unpaired');
  const view = await h.call('pairing.start', {});
  assert.equal(view.state, 'waiting');
  assert.equal(view.shortCode, '123456');
  const started = h.driver.calls.find((c) => c.method === 'startPairing')!.args[0] as { agentName: string; requested: { capabilities: string[]; apps: string[]; desktops: string[] } };
  assert.equal(started.agentName, 'WeChat Agent');
  assert.deepEqual(started.requested.capabilities, ['observe', 'act', 'desktop.manage', 'run']);
  assert.deepEqual(started.requested.apps, ['com.tencent.xinWeChat']);
  assert.deepEqual(started.requested.desktops, ['created']);
  let snap = await h.snapshot();
  assert.equal(snap.connection.state, 'pairing');
  assert.equal(snap.connection.pairing.state, 'waiting');
  // Asking again while one waits returns the same request; it does not start another.
  assert.equal((await h.call('pairing.start', {})).shortCode, '123456');
  assert.equal(h.driver.calls.filter((c) => c.method === 'startPairing').length, 1);

  // The person has not answered yet: the app keeps polling, nothing else.
  assert.equal(h.scheduler.size, 1);
  h.scheduler.flush();
  await waitFor(() => h.driver.calls.filter((c) => c.method === 'pairingStatus').length === 1, 'first poll');
  assert.equal((await h.snapshot()).connection.state, 'pairing');

  h.driver.options.pairingAnswer = 'approved';
  h.scheduler.flush();
  await waitFor(() => h.app.internals.connector.ready, 'paired reconnect');
  snap = await h.snapshot();
  assert.equal(snap.connection.state, 'ready');
  assert.equal(snap.connection.pairing.state, 'paired');
  assert.equal(snap.connection.pairing.clientId, 'app:wechat-agent');
  assert.deepEqual(snap.connection.pairing.grant?.apps, ['com.tencent.xinWeChat']);
  assert.equal(snap.connection.steps.find((s) => s.key === 'pairing')?.state, 'done');
  // Stored, and shown in the next handshake.
  assert.equal((await h.store.load())?.clientId, 'app:wechat-agent');
  assert.equal(h.driver.lastCredential?.clientId, 'app:wechat-agent');
  // The token never reaches the snapshot, the log or the diagnostics.
  const token = 'adt1_fake-token-not-a-secret';
  assert.ok(!JSON.stringify(snap).includes(token));
  assert.ok(!h.app.internals.log.join('\n').includes(token));
  assert.ok(!JSON.stringify(h.driver.calls).includes(token));
  const exported = await h.call('diagnostics.export', { includeEvidence: false, selectedEvidenceIds: [] });
  assert.ok(!(await readFile(exported.path, 'utf8')).includes(token));
  // Paired: the app never asks for anything but its own pairing (no owner calls exist on the driver at all).
  assert.equal(h.driver.calls.filter((c) => c.method === 'act').length, 0);
  await h.app.stop();
});

test('pairing: denied → not paired, a minute before the next request; then it may ask again', async () => {
  const h = await unpairedHarness();
  await h.call('pairing.start', {});
  h.driver.options.pairingAnswer = 'denied';
  h.scheduler.flush();
  await waitFor(async () => (await h.snapshot()).connection.pairing.state === 'denied', 'denied');
  const snap = await h.snapshot();
  assert.equal(snap.connection.state, 'unpaired');
  assert.ok(snap.connection.pairing.retryAfter);
  assert.equal(await h.store.load(), null);
  await assert.rejects(h.call('pairing.start', {}), expectIpc('blocked'));
  assert.equal(h.driver.calls.filter((c) => c.method === 'startPairing').length, 1, 'a refused program does not ask again within the minute');
  h.clock.advance(61_000);
  h.driver.options.pairingAnswer = 'requested';
  assert.equal((await h.call('pairing.start', {})).state, 'waiting');
  assert.equal(h.driver.calls.filter((c) => c.method === 'startPairing').length, 2);
  await h.app.stop();
});

test('pairing: expired request → the person may ask again at once', async () => {
  const h = await unpairedHarness();
  await h.call('pairing.start', {});
  h.driver.options.pairingAnswer = 'expired';
  h.scheduler.flush();
  await waitFor(async () => (await h.snapshot()).connection.pairing.state === 'expired', 'expired');
  h.driver.options.pairingAnswer = 'requested';
  assert.equal((await h.call('pairing.start', {})).state, 'waiting');
  await h.app.stop();
});

test('pairing: the Runtime refuses the request (cooldown) → blocked with its reason, retryAfter shown', async () => {
  const driver = new FakeDriver({ faults: [{ method: 'startPairing', error: { code: 'permission_denied', phase: 'request', notSent: true, details: { reason: 'pairing_cooldown' } } }] });
  const h = await makeHarness({ driver, config: { reconnect: { baseMs: 0, maxMs: 0 } } });
  await assert.rejects(h.call('pairing.start', {}), (error: unknown) => {
    assert.ok(error instanceof Error && /一分钟后/.test(error.message));
    return true;
  });
  const snap = await h.snapshot();
  assert.equal(snap.connection.pairing.refusal?.reason, 'pairing_cooldown');
  assert.ok(snap.connection.pairing.retryAfter);
  await h.app.stop();
});

test('revoked: client_revoked mid-session → credential dropped, gate closed, features off, no reconnect loop; pairing again is the way back', async () => {
  const store = new MemoryCredentialStore(STORED);
  const driver = new FakeDriver();
  const scheduler = new ManualScheduler();
  const app = createApplication({
    driver, ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: registry(readStub(() => [])), now: makeClock().now, scheduler, credentials: store,
    config: { lockPath: null, reconnect: { baseMs: 0, maxMs: 0 }, cancelWaitMs: 5, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  assert.equal(driver.lastCredential?.clientId, STORED.clientId);
  assert.equal(app.internals.connector.state, 'ready');
  // Any call that comes back client_revoked flips the app.
  assert.equal(app.internals.connector.observeError(new DriverError({ code: 'client_revoked', message: 'revoked', phase: 'request', retryable: false, notSent: true, details: { reason: 'client_revoked' } })), true);
  await waitFor(() => app.internals.connector.state === 'revoked', 'revoked');
  const snap = await app.service.call('app.getSnapshot', {});
  assert.equal(snap.connection.state, 'revoked');
  assert.equal(snap.connection.pairing.state, 'revoked');
  assert.equal(snap.connection.pairing.refusal?.code, 'client_revoked');
  assert.equal(snap.inputGate, 'closed');
  for (const feature of Object.values(snap.features)) assert.equal((feature as { reason?: string }).reason, 'pairing_missing');
  assert.equal(await store.load(), null, 'the revoked credential is gone');
  assert.equal(scheduler.size, 0, 'nothing reconnects by itself');
  assert.equal(driver.state, 'closed');
  // "Check again" does not reconnect a revoked app either.
  assert.equal((await app.service.call('connection.check', {})).state, 'revoked');
  const connects = driver.calls.filter((c) => c.method === 'connect').length;
  // Pairing again starts from an unpaired connection, without the old credential.
  await app.service.call('pairing.start', {});
  assert.equal(driver.calls.filter((c) => c.method === 'connect').length, connects + 1);
  assert.equal(driver.lastCredential, null);
  await app.stop();
});

test('revoked at the handshake (reconnect after the cut) → revoked once, no retry', async () => {
  const store = new MemoryCredentialStore(STORED);
  const driver = new FakeDriver({ faults: [{ method: 'connect', error: { code: 'client_revoked', phase: 'handshake', notSent: true, details: { reason: 'client_revoked' } } }] });
  const scheduler = new ManualScheduler();
  const app = createApplication({
    driver, ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: registry(), now: makeClock().now, scheduler, credentials: store,
    config: { lockPath: null, reconnect: { baseMs: 0, maxMs: 0 }, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  assert.equal(app.internals.connector.state, 'revoked');
  assert.equal(scheduler.size, 0);
  assert.equal(await store.load(), null);
  await app.stop();
});

test('a credential the Runtime does not recognise (bad_credential) is treated like a revocation', async () => {
  const store = new MemoryCredentialStore(STORED);
  const driver = new FakeDriver({ faults: [{ method: 'connect', error: { code: 'permission_denied', phase: 'handshake', notSent: true, details: { reason: 'bad_credential' } } }] });
  const scheduler = new ManualScheduler();
  const app = createApplication({
    driver, ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: registry(), now: makeClock().now, scheduler, credentials: store,
    config: { lockPath: null, reconnect: { baseMs: 0, maxMs: 0 }, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  const snap = await app.service.call('app.getSnapshot', {});
  assert.equal(snap.connection.state, 'revoked');
  assert.match(snap.connection.pairing.refusal?.message ?? '', /重新配对/);
  assert.equal(scheduler.size, 0);
  await app.stop();
});

test('grant expired → no_access: credential kept, gate closed, no reconnect loop; "check again" retries once', async () => {
  const store = new MemoryCredentialStore(STORED);
  const expired = { code: 'grant_expired', phase: 'request' as const, notSent: true, details: { reason: 'grant_expired' } };
  const driver = new FakeDriver({ faults: [{ method: 'listDesktops', error: expired }, { method: 'listDesktops', onCall: 2, error: expired }] });
  const scheduler = new ManualScheduler();
  const app = createApplication({
    driver, ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: registry(readStub(() => [])), now: makeClock().now, scheduler, credentials: store,
    config: { lockPath: null, reconnect: { baseMs: 0, maxMs: 0 }, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  let snap = await app.service.call('app.getSnapshot', {});
  assert.equal(snap.connection.state, 'no_access');
  assert.equal(snap.connection.pairing.state, 'no_access');
  assert.match(snap.connection.pairing.refusal?.message ?? '', /续期/);
  for (const feature of Object.values(snap.features)) assert.equal((feature as { reason?: string }).reason, 'grant_missing');
  assert.equal(scheduler.size, 0);
  assert.ok(await store.load(), 'the credential stays: the owner can renew the grant');
  // Re-pairing would make a second client for the same program: refused, the person renews instead.
  await assert.rejects(app.service.call('pairing.start', {}), expectIpc('invalid_state'));
  // Still expired on the person's retry → no_access again; renewed → ready.
  assert.equal((await app.service.call('connection.check', {})).state, 'no_access');
  assert.equal((await app.service.call('connection.check', {})).state, 'ready');
  snap = await app.service.call('app.getSnapshot', {});
  assert.equal(snap.connection.pairing.state, 'paired');
  await app.stop();
});

test('grant_missing for one capability is a clear permission error on that step, the app stays paired', async () => {
  const store = new MemoryCredentialStore(STORED);
  const driver = new FakeDriver({ faults: [{ method: 'bindWindow', error: { code: 'grant_missing', phase: 'request', notSent: true, details: { reason: 'bind_requires_grant' } } }] });
  const scheduler = new ManualScheduler();
  const app = createApplication({
    driver, ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: registry(), now: makeClock().now, scheduler, credentials: store,
    config: { lockPath: null, reconnect: { baseMs: 0, maxMs: 0 }, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  const snap = await app.service.call('app.getSnapshot', {});
  assert.equal(snap.connection.state, 'ready');
  const windowStep = snap.connection.steps.find((s) => s.key === 'window');
  assert.equal(windowStep?.state, 'failed');
  assert.match(windowStep?.detail ?? '', /授权不足/);
  assert.equal(snap.connection.pairing.refusal?.reason, 'bind_requires_grant');
  assert.equal(driver.calls.filter((c) => c.method === 'connect').length, 1, 'a refused step is not a reason to reconnect');
  await app.stop();
});
