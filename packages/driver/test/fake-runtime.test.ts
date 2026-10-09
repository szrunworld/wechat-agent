// The Fake Runtime is what every other lane tests against, so its own
// behaviour is pinned here: every implemented method answers with data that
// validates against the result schema of the snapshot, and the transport
// rules (handshake first, frame limit, schema_invalid, ledger) hold.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test, type TestContext } from 'node:test';
import { RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type { RequestContext, RuntimeResponse } from '@wechat-agent/ports';
import { FakeRuntime, METHODS, RpcConnection, resultProblems } from '../src/index.ts';
import { CLIENT } from './examples.ts';

let counter = 0;

async function raw(t: TestContext, endpoint: string, handshake = true) {
  const conn = await RpcConnection.connect(endpoint, 1_000);
  t.after(() => conn.destroy());
  const call = async (method: string, params: Record<string, unknown> = {}, context?: RequestContext, requestId?: string): Promise<RuntimeResponse> => {
    counter += 1;
    return conn.request({ apiVersion: RUNTIME_API_VERSION, requestId: requestId ?? `raw_${counter}`, method, ...(context ? { context } : {}), params }, 2_000);
  };
  const ok = async (method: string, params: Record<string, unknown> = {}, context?: RequestContext, requestId?: string): Promise<Record<string, unknown>> => {
    const response = await call(method, params, context, requestId);
    assert.ok(response.ok, `${method}: ${response.ok ? '' : JSON.stringify(response.error)}`);
    const problems = resultProblems(method, response.data);
    assert.deepEqual(problems, [], `${method} result: ${problems.join('; ')}`);
    return response.data;
  };
  if (handshake) await ok('runtime.handshake', { apiVersions: [RUNTIME_API_VERSION], client: CLIENT });
  return { conn, call, ok };
}

test('every implemented method answers with data that validates against its result schema', async (t) => {
  const fake = await FakeRuntime.start({ screenshot: { byteSize: 1000 } });
  t.after(() => fake.close());
  const { ok, call } = await raw(t, fake.endpoint);
  const validated = new Set<string>(['runtime.handshake']);
  const run_ = async (method: string, params: Record<string, unknown> = {}, context?: RequestContext, requestId?: string) => {
    const data = await ok(method, params, context, requestId);
    validated.add(method);
    return data;
  };
  await run_('runtime.status');
  await run_('runtime.capabilities');
  const desktops = (await run_('desktop.list')).desktops as { desktopId: string }[];
  const desktopId = desktops[0].desktopId;
  await run_('desktop.show', { desktopId });
  await run_('app.list', {});
  await run_('window.list', { pid: 777 }, { desktopId });
  const created = await run_('desktop.create', { name: 'scratch', width: 800, height: 600 });
  await run_('app.launch', { desktopId: created.desktopId as string, bundleId: 'com.example.app' });
  await run_('desktop.destroy', { desktopId: created.desktopId as string });
  await run_('window.unbind', { desktopId });
  await run_('window.bind', { desktopId, pid: 777 });
  const session = await run_('session.open', { desktopId });
  const sessionId = session.sessionId as string;
  await run_('session.show', { sessionId });
  const started = await run_('run.start', {}, { sessionId });
  const runId = (started.run as { runId: string }).runId;
  await run_('run.attach', { runId, token: started.attachToken as string });
  const observation = await run_('observe', { screenshot: true, elements: true }, { sessionId, runId });
  const snapshotId = observation.snapshotId as string;
  const artifactId = (observation.image as { artifactId: string }).artifactId;
  await run_('act', { snapshotId, action: { kind: 'type', text: 'hello', target: { elementRef: 'el_input' } } }, { sessionId, runId }, 'rq_fake_act');
  await run_('wait', { condition: { kind: 'elementPresent', role: 'AXButton' }, timeoutMs: 100 }, { sessionId, runId });
  await run_('request.show', { requestId: 'rq_fake_act' });
  await run_('run.show', { runId });
  await run_('run.events', { runId, after: 0, limit: 10 });
  await run_('run.wait', { runId, timeoutMs: 10 });
  await run_('run.list', { active: true });
  await run_('artifact.show', { artifactId });
  await run_('artifact.read', { artifactId, offset: 0, length: 512 });
  await run_('run.finish', { runId, exitCode: 0 });
  await run_('run.cancel', { runId });
  await run_('runtime.stopAll', { scope: 'all_platform_runs' });
  const pairing = await run_('hub.pairing.start', { agentName: 'WeChat Agent', requested: { capabilities: ['observe'], apps: ['com.tencent.xinWeChat'] } });
  await run_('hub.pairing.status', { pairingId: pairing.pairingId as string });
  await run_('session.close', { sessionId });
  // A Run stream for an ended Run closes the connection after the last event (per methods.json), so use the global stream here.
  await run_('events.subscribe', { after: 0 });
  // The subscribed connection refuses everything but events.unsubscribe.
  const refused = await call('runtime.status');
  assert.ok(!refused.ok && refused.error.code === 'conflict');
  await run_('events.unsubscribe');
  await run_('runtime.status');
  const missing = [...METHODS.keys()].filter((m) => !validated.has(m));
  assert.deepEqual(missing, [], `methods without a validated reply: ${missing.join(', ')}`);
});

test('handshake first: any other method before runtime.handshake is handshake_required', async (t) => {
  const fake = await FakeRuntime.start();
  t.after(() => fake.close());
  const { call } = await raw(t, fake.endpoint, false);
  const response = await call('runtime.status');
  assert.ok(!response.ok);
  assert.equal(response.error.code, 'handshake_required');
  assert.equal(response.error.phase, 'handshake');
});

test('transport rules: frame_too_large with requestId null, schema_invalid for bad params, capability_missing for unknown methods', async (t) => {
  const fake = await FakeRuntime.start();
  t.after(() => fake.close());
  const { call } = await raw(t, fake.endpoint);
  const bad = await call('observe', { screenshot: 'yes' } as unknown as Record<string, unknown>, { sessionId: 'ses_x' });
  assert.ok(!bad.ok && bad.error.code === 'schema_invalid' && bad.error.phase === 'request');
  const unknown = await call('inbox.list');
  assert.ok(!unknown.ok && unknown.error.code === 'capability_missing');
  const socket = net.createConnection({ path: fake.endpoint });
  socket.on('error', () => { /* EPIPE once the Runtime hangs up on us is expected */ });
  t.after(() => socket.destroy());
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const reply = new Promise<string>((resolve) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) resolve(buffer.split('\n')[0]);
    });
  });
  socket.write(`${'x'.repeat(1_100_000)}\n`);
  const frame = JSON.parse(await reply) as RuntimeResponse;
  assert.ok(!frame.ok);
  assert.equal(frame.requestId, null);
  assert.equal(frame.error.code, 'frame_too_large');
});

test('ADR-05: run.start with lifetime/ownership/origin is refused with ownership_escalation_denied', async (t) => {
  const fake = await FakeRuntime.start();
  t.after(() => fake.close());
  const { call, ok } = await raw(t, fake.endpoint);
  const session = await ok('session.open', { desktopId: 'desk_1' });
  const refused = await call('run.start', { lifetime: 'platform_durable' }, { sessionId: session.sessionId as string });
  assert.ok(!refused.ok && refused.error.code === 'ownership_escalation_denied');
  const alsoRefused = await call('run.start', { lifetime: 'connection_scoped' }, { sessionId: session.sessionId as string });
  assert.ok(!alsoRefused.ok && alsoRefused.error.code === 'ownership_escalation_denied');
  assert.equal(fake.runs.size, 0);
});

test('ledger: a mutation replayed with the same requestId returns the stored reply, even after a hang', async (t) => {
  const fake = await FakeRuntime.start();
  t.after(() => fake.close());
  const { call, ok } = await raw(t, fake.endpoint);
  const session = await ok('session.open', { desktopId: 'desk_1' });
  const sessionId = session.sessionId as string;
  const started = await ok('run.start', {}, { sessionId });
  const runId = (started.run as { runId: string }).runId;
  const snap = await ok('observe', { screenshot: false }, { sessionId, runId });
  const params = { snapshotId: snap.snapshotId as string, action: { kind: 'key', key: 'Return' } };
  fake.injectTimeout('act');
  const hung = call('act', params, { sessionId, runId }, 'rq_hang');
  const settled = await Promise.race([hung.then(() => 'replied'), new Promise((r) => setTimeout(() => r('silent'), 150))]);
  assert.equal(settled, 'silent');
  assert.equal(fake.receipts.size, 1, 'processed but unanswered');
  const retry = await ok('act', params, { sessionId, runId }, 'rq_hang');
  assert.equal(retry.receiptId, [...fake.receipts.keys()][0]);
  assert.equal(fake.receipts.size, 1);
  // stopAll closes input for new actions
  await ok('runtime.stopAll', { scope: 'all_platform_runs' });
  const run2 = await ok('run.start', {}, { sessionId });
  const disabled = await call('act', params, { sessionId, runId: (run2.run as { runId: string }).runId }, 'rq_disabled');
  assert.ok(!disabled.ok && disabled.error.code === 'input_disabled');
});
