// Driver-side assertions for the lane A test matrix (docs/lanes/lane-a.md):
// T02 incompatible handshake, T06 same requestId / different params,
// T08 disconnect before the receipt, T09 request.show not_found passthrough,
// T34 no automatic reconnect, T35 closing a subscription leaves the control
// connection alone, T36 run.start carries no escalation params,
// T37 events_cursor_expired passthrough. Everything runs against FakeRuntime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEFAULT_RUNTIME_ENDPOINT, DriverError, MAX_ARTIFACT_CHUNK_BYTES, RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type { Action, AgentDesktopDriver, DriverConfig, EventFrame } from '@wechat-agent/ports';
import { FakeRuntime, METHODS, createDriver, resolveEndpoint, type FakeRuntimeOptions } from '../src/index.ts';
import { CLIENT } from './examples.ts';

async function pair(t: TestContext, options: FakeRuntimeOptions = {}, config: Partial<DriverConfig> = {}) {
  const fake = await FakeRuntime.start(options);
  const driver = createDriver({ endpoint: fake.endpoint, client: CLIENT, requestTimeoutMs: 2_000, connectTimeoutMs: 2_000, ...config });
  t.after(async () => {
    await driver.close().catch(() => undefined);
    await fake.close();
  });
  return { fake, driver };
}

async function openRun(driver: AgentDesktopDriver) {
  const [desktop] = await driver.listDesktops();
  const session = await driver.openSession(desktop.desktopId);
  const run = await driver.startRun(session.sessionId);
  return { desktopId: desktop.desktopId, sessionId: session.sessionId, runId: run.runId, run };
}

async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function driverError(e: unknown, code: string, extra: Partial<DriverError['error']> = {}): boolean {
  assert.ok(e instanceof DriverError, `expected DriverError, got ${String(e)}`);
  assert.equal(e.error.code, code, `code ${e.error.code}, message: ${e.error.message}`);
  for (const [key, value] of Object.entries(extra)) assert.deepEqual((e.error as unknown as Record<string, unknown>)[key], value, `${key} on ${code}`);
  return true;
}

const click = (x: number, y: number): Action => ({ kind: 'click', target: { imagePoint: { x, y } } });

test('endpoint: config.endpoint ?? DEFAULT_RUNTIME_ENDPOINT, ~ expanded, nothing else rewritten', () => {
  assert.equal(resolveEndpoint(undefined), path.join(os.homedir(), DEFAULT_RUNTIME_ENDPOINT.slice(2)));
  assert.equal(resolveEndpoint('~/Library/x.sock'), path.join(os.homedir(), 'Library/x.sock'));
  assert.equal(resolveEndpoint('/tmp/abs.sock'), '/tmp/abs.sock');
  assert.throws(() => createDriver({ client: { name: '', version: '' } }), /invalid_argument/);
});

test('no Runtime at the endpoint: runtime_offline (connect, notSent) and no fallback probing', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wa-none-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = await FakeRuntime.start();
  t.after(() => fake.close());
  // A live Runtime exists elsewhere; the driver must not find it.
  const driver = createDriver({ endpoint: path.join(dir, 'nothing.sock'), client: CLIENT, connectTimeoutMs: 1_000 });
  await assert.rejects(driver.connect(), (e) => driverError(e, 'runtime_offline', { phase: 'connect', notSent: true, retryable: true }));
  assert.equal(driver.state, 'disconnected');
  assert.equal(fake.connectionsAccepted, 0);
  await assert.rejects(driver.status(), (e) => driverError(e, 'connection_lost', { notSent: true }));
});

test('connect: runtime.handshake with apiVersions + client, identity returned, state connected', async (t) => {
  const { fake, driver } = await pair(t, { principal: { clientId: 'app:wechat-agent', role: 'paired' } });
  assert.equal(driver.state, 'disconnected');
  const result = await driver.connect();
  assert.equal(driver.state, 'connected');
  assert.equal(result.identity.product, 'AgentDesktop');
  assert.ok(result.identity.apiVersions.includes(RUNTIME_API_VERSION));
  assert.equal(result.principal?.role, 'paired');
  assert.equal(result.raw.product, 'AgentDesktop');
  const handshake = fake.requests[0];
  assert.equal(handshake.method, 'runtime.handshake');
  assert.deepEqual(handshake.params, { apiVersions: [RUNTIME_API_VERSION], client: CLIENT });
  await assert.rejects(driver.connect(), (e) => driverError(e, 'invalid_argument'));
  await driver.close();
  assert.equal(driver.state, 'closed');
});

test('T02: a Runtime that is not AgentDesktop is refused: version_mismatch, state incompatible', async (t) => {
  const { fake, driver } = await pair(t, { identity: { product: 'OtherDesktop' } });
  await assert.rejects(driver.connect(), (e) => driverError(e, 'version_mismatch', { phase: 'handshake' }));
  assert.equal(driver.state, 'incompatible');
  await until(() => fake.connectionCount === 0);
  await assert.rejects(driver.capabilities(), (e) => driverError(e, 'connection_lost', { notSent: true }));
});

test('T02: a Runtime without agentdesktop.runtime/1 is refused by the driver even when it answers', async (t) => {
  const { driver } = await pair(t, { identity: { apiVersions: ['agentdesktop.runtime/2'] }, acceptAnyApiVersion: true });
  await assert.rejects(driver.connect(), (e) => {
    driverError(e, 'version_mismatch', { phase: 'handshake' });
    assert.equal((e as DriverError).error.details?.reason, 'apiVersion');
    return true;
  });
  assert.equal(driver.state, 'incompatible');
});

test('T02: the Runtime itself answering version_mismatch lands in the same state', async (t) => {
  const { driver } = await pair(t, { identity: { apiVersions: ['agentdesktop.runtime/2'] } });
  await assert.rejects(driver.connect(), (e) => driverError(e, 'version_mismatch', { phase: 'handshake' }));
  assert.equal(driver.state, 'incompatible');
});

test('T36: run.start carries no lifetime/ownership/origin and the attach token is never exposed', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const { run, sessionId } = await openRun(driver);
  const logged = fake.requests.filter((r) => r.method === 'run.start');
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].params, {}, 'run.start params must be empty');
  for (const key of ['lifetime', 'ownership', 'origin']) assert.ok(!(key in logged[0].params), `run.start must not send ${key}`);
  assert.deepEqual(logged[0].context, { sessionId });
  assert.equal(run.lifetime, 'connection_scoped');
  assert.equal(run.ownership, 'external_client');
  assert.ok(!('attachToken' in run), 'the driver must not hand the attach token to the app');
  assert.equal(fake.callCount('run.start'), 1);
});

test('T06: same requestId + same params replays the receipt; different params -> idempotency_conflict as sent by the Runtime', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const { sessionId, runId } = await openRun(driver);
  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  const context = { sessionId, runId };
  const params = { snapshotId: snap.snapshotId, action: click(10, 20) };
  const first = await driver.act(context, params, 'rq_act_1');
  const again = await driver.act(context, params, 'rq_act_1');
  assert.equal(again.receiptId, first.receiptId);
  assert.deepEqual(again, first);
  assert.equal(fake.callCount('act'), 1, 'the replay never reached the handler');
  assert.equal(fake.receipts.size, 1);
  await assert.rejects(
    driver.act(context, { snapshotId: snap.snapshotId, action: click(11, 20) }, 'rq_act_1'),
    (e) => driverError(e, 'idempotency_conflict', { phase: 'handler', retryable: false }),
  );
  assert.equal(fake.receipts.size, 1, 'nothing was dispatched for the conflicting request');
  // An injected conflict passes through unchanged too (phase/notSent as the Runtime sent them).
  fake.injectError('act', 'idempotency_conflict', { notSent: true, details: { injected: true } });
  await assert.rejects(
    driver.act(context, params, 'rq_act_2'),
    (e) => driverError(e, 'idempotency_conflict', { phase: 'handler', notSent: true, details: { injected: true } }),
  );
});

test('T08: connection dropped before the act receipt -> connection_lost with notSent=false; the Runtime kept the record', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const { sessionId, runId } = await openRun(driver);
  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  fake.injectDisconnectBeforeReply('act');
  await assert.rejects(
    driver.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: click(1, 1) }, 'rq_act_lost'),
    (e) => driverError(e, 'connection_lost', { phase: 'transport', notSent: false }),
  );
  assert.equal(driver.state, 'disconnected');
  assert.equal(fake.receipts.size, 1, 'the action was dispatched before the drop');
  // The caller verifies by requestId on a fresh connection instead of re-sending.
  const second = createDriver({ endpoint: fake.endpoint, client: CLIENT });
  t.after(() => second.close());
  await second.connect();
  const record = await second.showRequest('rq_act_lost');
  assert.equal(record.method, 'act');
  assert.equal(record.state, 'completed');
  assert.ok(record.outcome?.receiptId);
  // Delegated Runs are connection-scoped: the run ended with the connection.
  const run = await second.showRun(runId);
  assert.equal(run.phase, 'ended');
  assert.equal(run.closingReason, 'connection_closed');
});

test('T09: request.show not_found is returned unchanged (phase handler, retryable false)', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  await assert.rejects(driver.showRequest('rq_never_sent'), (e) => {
    driverError(e, 'not_found', { phase: 'handler', retryable: false });
    assert.match((e as DriverError).error.message, /rq_never_sent/);
    return true;
  });
  const { sessionId, runId } = await openRun(driver);
  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  await driver.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: click(1, 1) }, 'rq_old');
  assert.equal((await driver.showRequest('rq_old')).state, 'completed');
  fake.injectRequestNotFound(); // retention expired on the Runtime
  await assert.rejects(driver.showRequest('rq_old'), (e) => driverError(e, 'not_found', { phase: 'handler' }));
  assert.equal(driver.state, 'connected');
});

test('T34: after the control connection drops the driver is disconnected and does not reconnect by itself', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  assert.equal(fake.connectionsAccepted, 1);
  fake.dropConnections();
  await until(() => driver.state === 'disconnected');
  await sleep(150);
  assert.equal(fake.connectionsAccepted, 1, 'no reconnect attempt');
  assert.equal(fake.connectionCount, 0);
  await assert.rejects(driver.status(), (e) => driverError(e, 'connection_lost', { phase: 'transport', notSent: true }));
  await sleep(50);
  assert.equal(fake.connectionsAccepted, 1, 'a failed call does not trigger a reconnect either');
  // The app decides to reconnect, explicitly.
  await driver.connect();
  assert.equal(driver.state, 'connected');
  assert.equal(fake.connectionsAccepted, 2);
});

test('T35: closing a subscription leaves the control connection untouched', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const { runId } = await openRun(driver);
  const stream = await driver.subscribe({ runId });
  await until(() => fake.connectionCount === 2);
  await stream.close();
  await until(() => fake.connectionCount === 1);
  assert.equal(driver.state, 'connected');
  const status = await driver.status();
  assert.equal(status.state, 'running');
  assert.equal(fake.connectionsAccepted, 2);
});

test('T37: a cursor before the retained range -> events_cursor_expired thrown from subscribe, control connection intact', async (t) => {
  const { fake, driver } = await pair(t, { retainedEventsFrom: 5 });
  await driver.connect();
  await assert.rejects(driver.subscribe({ after: 2 }), (e) => driverError(e, 'events_cursor_expired', { phase: 'handler' }));
  assert.equal(driver.state, 'connected');
  await until(() => fake.connectionCount === 1);
  const { runId } = await openRun(driver);
  fake.injectCursorExpired();
  await assert.rejects(driver.subscribe({ runId, after: 0 }), (e) => driverError(e, 'events_cursor_expired'));
  await until(() => fake.connectionCount === 1);
  assert.equal(driver.state, 'connected');
});

test('subscribe: own connection, frames parsed, cursor follows, iterator ends when the Run stream closes; resume from cursor', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const { sessionId, runId } = await openRun(driver);
  const stream = await driver.subscribe({ runId });
  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  await driver.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: click(5, 5) }, 'rq_ev_1');
  await driver.finishRun(runId, 'success');
  const frames: EventFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  assert.deepEqual(frames.map((f) => f.event.type), ['run.started', 'action.accepted', 'action.dispatched', 'action.completed', 'run.quiescent', 'run.ended']);
  assert.deepEqual(frames.map((f) => f.event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal(stream.cursor, 6);
  assert.equal(frames[1].event.data.requestId, 'rq_ev_1');
  // Resume from the cursor: nothing new, the stream ends again without throwing.
  const resumed = await driver.subscribe({ runId, after: stream.cursor });
  const later: EventFrame[] = [];
  for await (const frame of resumed) later.push(frame);
  assert.deepEqual(later, []);
  assert.equal(resumed.cursor, 6);
  assert.equal(driver.state, 'connected');
  const subscribes = fake.requests.filter((r) => r.method === 'events.subscribe');
  assert.deepEqual(subscribes.map((r) => r.params), [{ runId }, { runId, after: 6 }]);
  assert.ok(subscribes.every((r) => r.connectionId !== fake.requests[0].connectionId), 'subscriptions use their own connection');
});

test('subscribe: a dropped subscription ends the iterator instead of throwing, keeping the cursor for re-subscription', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const stream = await driver.subscribe();
  const iterator = stream[Symbol.asyncIterator]();
  const { runId } = await openRun(driver);
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.event.type, 'run.started');
  assert.equal(first.value?.event.runId, runId);
  const cursor = stream.cursor;
  assert.ok(cursor >= 1);
  fake.dropSubscriptions();
  const end = await iterator.next();
  assert.equal(end.done, true);
  assert.equal(stream.cursor, cursor);
  assert.equal(driver.state, 'connected');
  const resumed = await driver.subscribe({ after: cursor });
  fake.emitEvent(runId, 'test.ping', { n: 1 });
  const next = await resumed[Symbol.asyncIterator]().next();
  assert.equal(next.value?.event.type, 'test.ping');
  await resumed.close();
});

test('readArtifact: chunks of at most 512 KiB until eof, byteSize and sha256 verified', async (t) => {
  const byteSize = 1_200_000;
  const { fake, driver } = await pair(t, { screenshot: { byteSize } });
  await driver.connect();
  const { sessionId, runId } = await openRun(driver);
  const observation = await driver.observe({ sessionId, runId });
  assert.ok(observation.image);
  const bytes = await driver.readArtifact(observation.image.artifactId);
  assert.equal(bytes.byteLength, byteSize);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), observation.image.sha256);
  const reads = fake.requests.filter((r) => r.method === 'artifact.read');
  assert.equal(reads.length, 3);
  assert.ok(reads.every((r) => (r.params.length as number) <= MAX_ARTIFACT_CHUNK_BYTES));
  assert.deepEqual(reads.map((r) => r.params.offset), [0, MAX_ARTIFACT_CHUNK_BYTES, 2 * MAX_ARTIFACT_CHUNK_BYTES]);
  fake.corruptArtifact(observation.image.artifactId);
  await assert.rejects(driver.readArtifact(observation.image.artifactId), (e) => driverError(e, 'internal_error', { phase: 'local' }));
  await assert.rejects(driver.readArtifact('art_missing'), (e) => driverError(e, 'not_found'));
});

test('requestTimeoutMs: deadline_exceeded (transport, notSent=false); the connection survives and a late reply is ignored', async (t) => {
  const { fake, driver } = await pair(t, {}, { requestTimeoutMs: 200 });
  await driver.connect();
  const { sessionId, runId } = await openRun(driver);
  fake.injectTimeout('observe');
  await assert.rejects(driver.observe({ sessionId, runId }), (e) => driverError(e, 'deadline_exceeded', { phase: 'transport', notSent: false }));
  assert.equal(driver.state, 'connected');
  assert.equal(fake.snapshots.size, 1, 'the Runtime did process the request');
  const again = await driver.observe({ sessionId, runId }, { screenshot: false });
  assert.ok(again.snapshotId);
});

test('frame_too_large is refused locally before anything is written (notSent=true)', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const { sessionId } = await openRun(driver);
  await assert.rejects(
    driver.wait({ sessionId }, { condition: { kind: 'elementPresent', label: 'x'.repeat(1_100_000) }, timeoutMs: 100 }),
    (e) => driverError(e, 'frame_too_large', { phase: 'local', notSent: true }),
  );
  assert.ok(!fake.requests.some((r) => r.method === 'wait'));
  assert.equal(driver.state, 'connected');
});

test('outbound requests are validated against runtime.schema.json before sending (schema_invalid, local, notSent)', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const { sessionId, runId } = await openRun(driver);
  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  const bogus = { kind: 'teleport', target: { elementRef: 'el_1' } } as unknown as Action;
  await assert.rejects(driver.act({ sessionId, runId }, { snapshotId: snap.snapshotId, action: bogus }, 'rq_bad'), (e) => {
    driverError(e, 'schema_invalid', { phase: 'local', notSent: true });
    assert.ok(((e as DriverError).error.details?.problems as string[]).length > 0);
    return true;
  });
  assert.ok(!fake.requests.some((r) => r.method === 'act'));
  await assert.rejects(driver.wait({ sessionId }, { condition: { kind: 'elementPresent' }, timeoutMs: 1 }), (e) => driverError(e, 'schema_invalid'));
});

test('methods use the snapshot names and param shapes; listWindows puts desktopId in the context', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const caps = await driver.capabilities();
  assert.ok(caps.interface.methods.some((m) => m.method === 'act' && m.mutation));
  const [desktop] = await driver.listDesktops();
  const windows = await driver.listWindows({ desktopId: desktop.desktopId, pid: 777 });
  assert.equal(windows.length, 1);
  const logged = fake.requests.find((r) => r.method === 'window.list')!;
  assert.deepEqual(logged.params, { pid: 777 });
  assert.deepEqual(logged.context, { desktopId: desktop.desktopId });
  const unbound = await driver.unbindWindow({ desktopId: desktop.desktopId });
  assert.equal(unbound.binding, null);
  const bound = await driver.bindWindow({ desktopId: desktop.desktopId, pid: 777, windowId: 11 });
  assert.equal((bound.binding as { windowId: number }).windowId, 11);
  const session = await driver.openSession(desktop.desktopId);
  const run = await driver.startRun(session.sessionId);
  assert.equal((await driver.showRun(run.runId)).phase, 'running');
  const observation = await driver.observe({ sessionId: session.sessionId, runId: run.runId }, { elements: true, screenshot: false, query: 'Accept' });
  assert.equal(observation.image, null);
  assert.deepEqual(observation.elements.map((e) => e.label), ['Accept']);
  const waited = await driver.wait({ sessionId: session.sessionId, runId: run.runId }, { condition: { kind: 'elementPresent', role: 'AXButton' }, timeoutMs: 100 });
  assert.equal(waited.satisfied, true);
  const receipt = await driver.act({ sessionId: session.sessionId, runId: run.runId }, { snapshotId: observation.snapshotId, action: { kind: 'click', target: { elementRef: 'el_accept' } } }, 'rq_names_1');
  assert.equal(receipt.delivery, 'dispatched');
  assert.equal(receipt.target.elementRef, 'el_accept');
  assert.equal((await driver.waitRun(run.runId, 50)).phase, 'running');
  const cancelled = await driver.cancelRun(run.runId);
  assert.equal(cancelled.cancelRequest.scope.id, run.runId);
  assert.equal(cancelled.execution.outcome, 'cancelled');
  const runs = await driver.listRuns();
  assert.equal(runs.length, 1);
  const run2 = await driver.startRun(session.sessionId);
  assert.equal((await driver.finishRun(run2.runId, 'success')).outcome, 'success');
  const run3 = await driver.startRun(session.sessionId);
  assert.equal((await driver.finishRun(run3.runId, 'failed')).outcome, 'failed');
  assert.deepEqual(fake.requests.filter((r) => r.method === 'run.finish').map((r) => r.params.exitCode), [0, 1]);
  assert.equal((await driver.closeSession(session.sessionId)).state, 'closed');
  await assert.rejects(driver.showArtifact('art_none'), (e) => driverError(e, 'not_found', { phase: 'handler' }));
  const used = new Set(fake.requests.map((r) => r.method));
  for (const method of used) assert.ok(METHODS.has(method), `${method} is not in methods.json`);
  assert.deepEqual(
    [...used].sort(),
    ['act', 'artifact.show', 'desktop.list', 'observe', 'run.cancel', 'run.finish', 'run.list', 'run.show', 'run.start', 'run.wait', 'runtime.capabilities', 'runtime.handshake', 'session.close', 'session.open', 'wait', 'window.bind', 'window.list', 'window.unbind'],
  );
});

test('platform errors pass through untouched: input_disabled, stale_observation, act notSent, receipt overrides', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const { sessionId, runId } = await openRun(driver);
  const snap = await driver.observe({ sessionId, runId }, { screenshot: false });
  const context = { sessionId, runId };
  fake.injectInputDisabled();
  await assert.rejects(driver.act(context, { snapshotId: snap.snapshotId, action: click(1, 1) }, 'rq_p1'), (e) => driverError(e, 'input_disabled', { phase: 'handler' }));
  fake.injectStaleObservation();
  await assert.rejects(driver.act(context, { snapshotId: snap.snapshotId, action: click(1, 1) }, 'rq_p2'), (e) => driverError(e, 'stale_observation'));
  fake.injectActNotSent();
  await assert.rejects(driver.act(context, { snapshotId: snap.snapshotId, action: click(1, 1) }, 'rq_p3'), (e) => driverError(e, 'invalid_target', { notSent: true }));
  fake.injectReceipt({ delivery: 'unknown', execution: 'unknown' });
  const unknown = await driver.act(context, { snapshotId: snap.snapshotId, action: click(1, 1) }, 'rq_p4');
  assert.equal(unknown.delivery, 'unknown');
  assert.equal((await driver.showRun(runId)).unknownActions, 1);
  await assert.rejects(driver.act(context, { snapshotId: 'snap_nope', action: click(1, 1) }, 'rq_p5'), (e) => driverError(e, 'not_found'));
  assert.equal(driver.state, 'connected');
});

test('close(): control connection and subscriptions are closed; state closed', async (t) => {
  const { fake, driver } = await pair(t);
  await driver.connect();
  const stream = await driver.subscribe();
  await until(() => fake.connectionCount === 2);
  await driver.close();
  assert.equal(driver.state, 'closed');
  await until(() => fake.connectionCount === 0);
  const end = await stream[Symbol.asyncIterator]().next();
  assert.equal(end.done, true);
});
