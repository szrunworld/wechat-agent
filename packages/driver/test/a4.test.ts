// A4 caller identity (agentdesktop #137) through the real driver against the
// Fake Runtime in A4 mode: the credential goes only into the handshake (and
// each subscription's), unpaired connections may only pair, a paired client
// reaches only what its grant covers, and revocation, narrowing and expiry
// are refused as the Runtime refuses them. Replies validate against the
// bb02b59 contract snapshot.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DriverError, RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type { AgentDesktopDriver, Credential, GrantRequest } from '@wechat-agent/ports';
import { FakeRuntime, createDriver, resultProblems, type FakeRuntimeOptions } from '../src/index.ts';
import { CLIENT, HANDSHAKE_WITH_CREDENTIAL } from './examples.ts';
import { requestProblems } from '../src/schema.ts';

const WECHAT = 'com.tencent.xinWeChat';
const REQUEST: GrantRequest = { capabilities: ['observe', 'act', 'desktop.manage', 'run'], desktops: ['desk_1'], apps: [WECHAT], durationSeconds: 3600 };

async function start(t: TestContext, options: FakeRuntimeOptions = {}) {
  const fake = await FakeRuntime.start({ a4: true, ...options });
  const drivers: AgentDesktopDriver[] = [];
  const driver = () => {
    const d = createDriver({ endpoint: fake.endpoint, client: CLIENT, requestTimeoutMs: 2_000, connectTimeoutMs: 2_000 });
    drivers.push(d);
    return d;
  };
  t.after(async () => {
    for (const d of drivers) await d.close().catch(() => undefined);
    await fake.close();
  });
  return { fake, driver };
}

function refused(code: string, reason?: string) {
  return (e: unknown) => {
    assert.ok(e instanceof DriverError, `expected DriverError, got ${String(e)}`);
    assert.equal(e.error.code, code, `${e.error.code}: ${e.error.message}`);
    if (reason !== undefined) assert.equal(e.error.details?.reason, reason);
    return true;
  };
}

/** Pairs a fresh driver: start, the person approves, the credential comes back once. */
async function pairOnce(fake: FakeRuntime, d: AgentDesktopDriver, requested: GrantRequest = REQUEST): Promise<Credential> {
  await d.connect();
  const started = await d.startPairing({ agentName: 'WeChat Agent', requested });
  assert.equal(resultProblems('hub.pairing.start', started).length, 0);
  assert.match(started.shortCode, /^\d{6}$/);
  assert.equal((await d.pairingStatus(started.pairingId)).state, 'requested');
  fake.hub.approve(started.pairingId);
  const status = await d.pairingStatus(started.pairingId);
  assert.deepEqual(resultProblems('hub.pairing.status', status), []);
  assert.equal(status.state, 'approved');
  assert.ok(status.credential?.token.startsWith('adt1_'));
  assert.deepEqual(status.grant?.apps, requested.apps ?? []);
  // Once: asking again does not hand it out a second time.
  assert.equal((await d.pairingStatus(started.pairingId)).credential, undefined);
  await d.close();
  return status.credential!;
}

test('handshake contract: a credential is a valid runtime.handshake param; requests never carry one', () => {
  assert.deepEqual(requestProblems({ apiVersion: RUNTIME_API_VERSION, requestId: 'rq_1', method: 'runtime.handshake', params: HANDSHAKE_WITH_CREDENTIAL }), []);
  assert.ok(requestProblems({ apiVersion: RUNTIME_API_VERSION, requestId: 'rq_1', method: 'desktop.list', params: { credential: HANDSHAKE_WITH_CREDENTIAL.credential } }).length > 0);
});

test('unpaired: the principal says so; everything but pairing is pairing_required, refused before it was sent', async (t) => {
  const { driver } = await start(t);
  const d = driver();
  const hello = await d.connect();
  assert.equal(hello.principal?.role, 'unpaired');
  assert.match(hello.principal?.clientId ?? '', /^unpaired:conn_[0-9a-f]{16}$/);
  assert.deepEqual(resultProblems('runtime.handshake', hello.raw), []);
  await d.capabilities(); // open
  await assert.rejects(d.listDesktops(), refused('pairing_required'));
  await assert.rejects(d.listWindows(), refused('pairing_required'));
  await assert.rejects(d.status(), refused('pairing_required'));
  await assert.rejects(d.subscribe(), refused('pairing_required'));
});

test('pairing → paired handshake with the credential; the grant decides what exists for the app', async (t) => {
  const { fake, driver } = await start(t);
  const credential = await pairOnce(fake, driver(), { ...REQUEST, desktops: ['created'] });
  const d = driver();
  const hello = await d.connect({ credential });
  assert.equal(hello.principal?.role, 'paired');
  assert.equal(hello.principal?.clientId, credential.clientId);
  assert.equal(hello.principal?.codeIdentityLevel, 'shared_interpreter');
  await d.status(); // baseline
  // The owner's Desktop is not in a "created" grant: it does not exist for this app.
  assert.deepEqual(await d.listDesktops(), []);
  await assert.rejects(d.openSession('desk_1'), refused('not_found'));
  // Window lists show only the granted app.
  assert.deepEqual((await d.listWindows()).map((w) => w.bundleId), [WECHAT]);
});

test('paired within a granted Desktop: bind the granted app, observe, run, subscribe (the subscription shows the credential too)', async (t) => {
  const { fake, driver } = await start(t);
  const credential = await pairOnce(fake, driver());
  const d = driver();
  await d.connect({ credential });
  const [desktop] = await d.listDesktops();
  assert.equal(desktop.desktopId, 'desk_1');
  const [wechat] = await d.listWindows();
  await d.bindWindow({ desktopId: 'desk_1', pid: wechat.process.pid, windowId: wechat.windowId });
  const session = await d.openSession('desk_1');
  const run = await d.startRun(session.sessionId);
  assert.equal(run.clientId, credential.clientId);
  const observation = await d.observe({ sessionId: session.sessionId, runId: run.runId }, { screenshot: false });
  assert.equal(observation.desktopId, 'desk_1');
  const stream = await d.subscribe({ runId: run.runId });
  await stream.close();
  await d.finishRun(run.runId, 'success');
});

test('an app outside the grant cannot be bound: grant_missing bind_requires_grant, naming nothing', async (t) => {
  const { fake, driver } = await start(t);
  fake.windows.push({ windowId: 50, process: { pid: 4242, startedAt: new Date().toISOString() }, appName: 'Other', bundleId: 'com.example.other', title: 'Other', frame: { x: 0, y: 0, width: 10, height: 10 }, onScreen: true });
  const credential = await pairOnce(fake, driver());
  const d = driver();
  await d.connect({ credential });
  assert.ok(!(await d.listWindows()).some((w) => w.bundleId === 'com.example.other'));
  await assert.rejects(d.bindWindow({ desktopId: 'desk_1', pid: 4242 }), refused('grant_missing', 'bind_requires_grant'));
});

test('a capability not granted is grant_missing with the capability named', async (t) => {
  const { fake, driver } = await start(t);
  const credential = await pairOnce(fake, driver(), { capabilities: ['observe'], desktops: ['desk_1'], apps: [WECHAT] });
  const d = driver();
  await d.connect({ credential });
  await d.listDesktops();
  await assert.rejects(d.openSession('desk_1'), (e: unknown) => {
    assert.ok(e instanceof DriverError && e.error.code === 'grant_missing' && e.error.details?.capability === 'act');
    assert.equal(e.error.notSent, true);
    return true;
  });
});

test('revoked: open connections are cut, the credential no longer proves the app (client_revoked at the handshake)', async (t) => {
  const { fake, driver } = await start(t);
  const credential = await pairOnce(fake, driver());
  const d = driver();
  await d.connect({ credential });
  const session = await d.openSession('desk_1');
  const run = await d.startRun(session.sessionId);
  fake.hub.revokeClient(credential.clientId);
  await assert.rejects(d.listDesktops(), refused('connection_lost'));
  assert.equal(fake.runs.get(run.runId)?.phase, 'ended');
  assert.equal(fake.runs.get(run.runId)?.closingReason, 'client_revoked');
  const again = driver();
  await assert.rejects(again.connect({ credential }), (e: unknown) => {
    assert.ok(e instanceof DriverError && e.error.code === 'client_revoked' && e.error.phase === 'handshake');
    return true;
  });
  assert.equal(again.state, 'disconnected');
});

test('narrowing cuts the connection; the reconnect sees what is left; widening does not cut', async (t) => {
  const { fake, driver } = await start(t);
  const credential = await pairOnce(fake, driver());
  const d = driver();
  await d.connect({ credential });
  fake.hub.setGrant(credential.clientId, { capabilities: ['observe', 'act', 'desktop.manage', 'run', 'unit.run'] });
  await d.listDesktops(); // still connected
  fake.hub.setGrant(credential.clientId, { capabilities: ['run'] });
  await assert.rejects(d.listDesktops(), refused('connection_lost'));
  const again = driver();
  await again.connect({ credential });
  await assert.rejects(again.listDesktops(), (e: unknown) => e instanceof DriverError && e.error.code === 'grant_missing' && e.error.details?.capability === 'observe');
});

test('grant revoked: the handshake still works, every call is grant_missing no_grant; expired: grant_expired', async (t) => {
  const { fake, driver } = await start(t);
  const a = await pairOnce(fake, driver());
  fake.hub.revokeGrant(a.clientId);
  const d = driver();
  await d.connect({ credential: a });
  await assert.rejects(d.listDesktops(), refused('grant_missing', 'no_grant'));
  await assert.rejects(d.status(), refused('grant_missing', 'no_grant'));

  fake.hub.clearCooldown();
  const b = await pairOnce(fake, driver());
  fake.hub.expireGrant(b.clientId);
  const e = driver();
  await e.connect({ credential: b });
  await assert.rejects(e.listDesktops(), refused('grant_expired', 'grant_expired'));
});

test('a credential that proves nothing: bad_credential; claiming the owner on the socket: owner_not_on_socket', async (t) => {
  const { driver } = await start(t);
  await assert.rejects(driver().connect({ credential: { clientId: 'app:doesnotexist', token: 'adt1_nope-nope-nope' } }), refused('permission_denied', 'bad_credential'));
  await assert.rejects(driver().connect({ credential: { clientId: 'local:501', token: 'adt1_whatever-it-is' } }), refused('permission_denied', 'owner_not_on_socket'));
});

test('denied → a minute of cooldown (pairing_cooldown); one open request at a time (pairing_busy); a closed asking connection lapses its request', async (t) => {
  const { fake, driver } = await start(t);
  const d = driver();
  await d.connect();
  const first = await d.startPairing({ agentName: 'WeChat Agent', requested: REQUEST });
  await assert.rejects(d.startPairing({ agentName: 'WeChat Agent', requested: REQUEST }), refused('permission_denied', 'pairing_busy'));
  fake.hub.deny(first.pairingId);
  assert.equal((await d.pairingStatus(first.pairingId)).state, 'denied');
  await assert.rejects(d.startPairing({ agentName: 'WeChat Agent', requested: REQUEST }), refused('permission_denied', 'pairing_cooldown'));
  fake.hub.clearCooldown();
  const second = await d.startPairing({ agentName: 'WeChat Agent', requested: REQUEST });
  await d.close();
  // Another connection cannot read it, and it lapsed with its connection.
  const other = driver();
  await other.connect();
  await assert.rejects(other.pairingStatus(second.pairingId), refused('not_found'));
  assert.equal(fake.hub.pairings.get(second.pairingId)?.state, 'expired');
});
