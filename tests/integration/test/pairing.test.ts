// A4 pairing, end to end on the Fake Runtime in A4 mode: the real driver,
// the real app core, the real handlers and the SQLite ledger. The test plays
// the person at the AgentDesktop trusted window (fake.hub.approve / deny) and
// the owner (revoke, narrow). Chain: unpaired → pairing → paired → grant too
// narrow → revoked → pairing again (denied, cooldown, approved).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IpcFailure } from '@wechat-agent/ports';
import { REHEARSAL_GRANT, snapshotOf, startFakeStack, waitFor, type FakeStack } from '../src/fake-runtime-stack.ts';

const OWNER_ONLY = /^hub\.(pairing\.(approve|deny)|clients\.|grants\.|connections\.)|^runtime\.enableInput$|^ai\.|^gui\.runs\./;

async function state(stack: FakeStack, want: string, what = want) {
  return waitFor(() => snapshotOf(stack), (s) => s.connection.state === want, what);
}

/** Fires the app's pending timers (pairing poll, reconnect) until `done`. */
async function pump(stack: FakeStack, done: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await done()) return;
    stack.scheduler.flush();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never: ${what}`);
}

test('A4 chain: unpaired → pairing (person approves) → paired within its grant → grant narrowed → revoked → pairing again (denied, cooldown, approved)', async (t) => {
  const stack = await startFakeStack(t, { grant: null, appConfig: { pairing: { agentName: 'WeChat Agent', requested: REHEARSAL_GRANT, pollMs: 10 } } });
  const { fake, app, credentials } = stack;
  await app.start();

  // 1. Unpaired: the Runtime answers nothing but pairing, and the app asks for nothing else.
  let snap = await state(stack, 'unpaired');
  assert.equal(snap.connection.principal?.role, 'unpaired');
  for (const feature of Object.values(snap.features)) assert.equal((feature as { reason?: string }).reason, 'pairing_missing');
  assert.deepEqual([...new Set(stack.methods())].sort(), ['runtime.capabilities', 'runtime.handshake']);

  // 2. The person asks to pair; the app shows the code the trusted window shows.
  const asked = await app.service.call('pairing.start', {});
  assert.equal(asked.state, 'waiting');
  const pending = [...fake.hub.pairings.values()].find((p) => p.state === 'requested')!;
  assert.equal(asked.shortCode, pending.shortCode);
  assert.equal(pending.agentName, 'WeChat Agent');
  assert.deepEqual(pending.requested, REHEARSAL_GRANT);
  await pump(stack, async () => fake.callCount('hub.pairing.status') >= 1, 'first poll');
  assert.equal((await snapshotOf(stack)).connection.state, 'pairing');

  // 3. Approved with Touch ID: the credential comes once, is stored, and the app reconnects with it.
  const { clientId } = fake.hub.approve(pending.pairingId);
  await pump(stack, async () => (await snapshotOf(stack)).connection.state === 'ready', 'paired');
  snap = await snapshotOf(stack);
  assert.equal(snap.connection.principal?.clientId, clientId);
  assert.equal(snap.connection.pairing.state, 'paired');
  assert.equal(snap.connection.pairing.codeIdentityLevel, 'shared_interpreter');
  assert.equal((await credentials.load())?.clientId, clientId);
  assert.equal(snap.connection.steps.find((s) => s.key === 'window')?.state, 'done', 'the granted Desktop and app: WeChat bound');
  const token = (await credentials.load())!.token;
  assert.ok(!JSON.stringify(snap).includes(token), 'the token never reaches the snapshot');
  assert.ok(!app.internals.log.join('\n').includes(token), 'nor the log');
  const withToken = fake.requests.filter((r) => JSON.stringify(r.params).includes(token)).map((r) => r.method);
  assert.ok(withToken.length >= 1 && withToken.every((m) => m === 'runtime.handshake'), `only handshakes carry it: ${withToken.join(', ')}`);

  // 4. The owner narrows the grant (observe taken away): the Runtime cuts the connection; the app learns of the
  //    drop on its next call, reconnects, and reports the refusal as a permission error. It stays paired.
  fake.hub.setGrant(clientId, { capabilities: ['act', 'desktop.manage', 'run'] });
  app.internals.connector.noteDisconnected('connection_lost');
  await pump(stack, async () => (await snapshotOf(stack)).connection.steps.find((s) => s.key === 'window')?.state === 'failed', 'window refused');
  snap = await snapshotOf(stack);
  assert.equal(snap.connection.state, 'ready');
  assert.match(snap.connection.steps.find((s) => s.key === 'window')?.detail ?? '', /授权不足：缺少 observe 权限/);
  assert.equal(snap.connection.pairing.refusal?.code, 'grant_missing');

  // 5. The owner revokes the client: cut, and the next handshake is client_revoked. The credential is dropped,
  //    the gate is closed, and nothing reconnects by itself.
  fake.hub.revokeClient(clientId);
  app.internals.connector.noteDisconnected('connection_lost');
  await pump(stack, async () => (await snapshotOf(stack)).connection.state === 'revoked', 'revoked');
  snap = await snapshotOf(stack);
  assert.equal(snap.connection.pairing.state, 'revoked');
  assert.equal(snap.inputGate, 'closed');
  assert.equal(await credentials.load(), null);
  const accepted = fake.connectionsAccepted;
  for (let i = 0; i < 5; i += 1) { stack.scheduler.flush(); await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(fake.connectionsAccepted, accepted, 'no reconnect storm after a revocation');
  const refusedTask = await app.service.call('task.create', { operationId: 'op_after_revoke', type: 'read_requests', expectedAccountRevision: 1, payload: { kind: 'read_requests' } });
  assert.equal(refusedTask.state, 'blocked');
  assert.equal(refusedTask.stateReason, 'pairing_missing');

  // 6. Pairing again: a new unpaired connection; the person denies → a minute of cooldown on both sides.
  const again = await app.service.call('pairing.start', {});
  assert.equal(again.state, 'waiting');
  const second = [...fake.hub.pairings.values()].find((p) => p.state === 'requested')!;
  fake.hub.deny(second.pairingId);
  await pump(stack, async () => (await snapshotOf(stack)).connection.pairing.state === 'denied', 'denied');
  const startsBefore = fake.callCount('hub.pairing.start');
  await assert.rejects(app.service.call('pairing.start', {}), (e: unknown) => e instanceof IpcFailure && e.error.code === 'blocked');
  assert.equal(fake.callCount('hub.pairing.start'), startsBefore, 'the app does not even ask during the cooldown');
  // After the minute (both clocks), the person may ask again; approved → a new client, paired again.
  stack.clock.advance(61);
  fake.hub.clearCooldown();
  await app.service.call('pairing.start', {});
  const third = [...fake.hub.pairings.values()].find((p) => p.state === 'requested')!;
  const renewed = fake.hub.approve(third.pairingId);
  await pump(stack, async () => (await snapshotOf(stack)).connection.state === 'ready', 'paired again');
  assert.notEqual(renewed.clientId, clientId, 'a revoked client never comes back; pairing again makes a new one');
  assert.equal((await snapshotOf(stack)).connection.principal?.clientId, renewed.clientId);

  // Throughout: no owner call, and nothing was ever typed or clicked.
  assert.deepEqual(stack.methods().filter((m) => OWNER_ONLY.test(m)), []);
  assert.equal(fake.callCount('act'), 0);
});

test('A4: paired with the default request ("created" Desktops only) → no Desktop exists for the app; it says so and creates none', async (t) => {
  const stack = await startFakeStack(t, { grant: { capabilities: ['observe', 'act', 'desktop.manage', 'run'], desktops: ['created'], apps: ['com.tencent.xinWeChat'] } });
  await stack.app.start();
  const snap = await state(stack, 'ready');
  const window = snap.connection.steps.find((s) => s.key === 'window');
  assert.equal(window?.state, 'failed');
  assert.match(window?.detail ?? '', /授权范围内没有可用的桌面/);
  assert.equal(stack.fake.callCount('desktop.create'), 0);
  assert.equal(stack.fake.callCount('window.bind'), 0);
  assert.equal(stack.fake.callCount('act'), 0);
});

test('A4: grant expired while running → no_access, credential kept, no reconnect loop; renewed → paired again on "check again"', async (t) => {
  const stack = await startFakeStack(t, {});
  const { fake, app, credentials } = stack;
  await app.start();
  await state(stack, 'ready');
  fake.hub.expireGrant(stack.clientId!);
  app.internals.connector.noteDisconnected('connection_lost');
  await pump(stack, async () => (await snapshotOf(stack)).connection.state === 'no_access', 'no_access');
  const snap = await snapshotOf(stack);
  assert.equal(snap.connection.pairing.refusal?.code, 'grant_expired');
  for (const feature of Object.values(snap.features)) assert.equal((feature as { reason?: string }).reason, 'grant_missing');
  assert.ok(await credentials.load());
  const accepted = fake.connectionsAccepted;
  for (let i = 0; i < 5; i += 1) { stack.scheduler.flush(); await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(fake.connectionsAccepted, accepted, 'no retry loop on an expired grant');
  fake.hub.setGrant(stack.clientId!, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal((await app.service.call('connection.check', {})).state, 'ready');
});
