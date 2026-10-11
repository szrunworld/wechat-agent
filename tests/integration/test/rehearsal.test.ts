// Stage 4 rehearsal (docs/acceptance/stage4-readonly-plan.md): the read-only
// baseline A01–A04 and its stop conditions, played against lane A's Fake
// Runtime SERVER through lane A's real client, lane E's real app, lane D's
// real handlers and lane B's SQLite ledger. Everything the real-device run
// will do — connect, capability check, bind the WeChat window, ReadRequests,
// list_read with coverage — happens here over the wire protocol, with no
// real WeChat anywhere. Fake-level evidence: docs/acceptance/cases stay not_run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { WECHAT_BUNDLE_ID } from '@wechat-agent/app';
import type { Action, PageFacts, Timestamp } from '@wechat-agent/ports';
import { newFriendsPage, pageFacts, requestRow } from '../src/fixtures.ts';
import { snapshotOf, startFakeStack, timeline, viewOf, waitFor, type FakeStack } from '../src/fake-runtime-stack.ts';
import { approve, createAccept, createRead, NAME, TERMINAL, waitForTask } from '../src/scenario.ts';

/** 微信 opened on the chats list; the only control the read-only flow may click is 通讯录. */
const chatsPage = (): PageFacts => pageFacts({ page: 'chats', buttons: [{ text: '通讯录', rect: { x: 40, y: 200, width: 80, height: 80 }, confidence: 0.95 }], chats: [] });

const ROWS = [requestRow('测试联系人甲', 'pending'), requestRow('测试联系人乙', 'added', { rect: { x: 600, y: 440, width: 1200, height: 120 } })];

/** Every act the Fake Runtime saw, with the action it carried. */
function acts(stack: FakeStack): { requestId: string; action: Action; runId?: string }[] {
  return stack.fake.requests.filter((r) => r.method === 'act').map((r) => ({ requestId: r.requestId, action: r.params.action as Action, runId: r.context.runId }));
}

/** The rehearsal's own ban: a click is navigation only; nothing types, presses keys, or scrolls; no attempt is a dangerous step. */
async function assertReadOnly(stack: FakeStack, taskIds: string[]): Promise<void> {
  for (const { action } of acts(stack)) assert.equal(action.kind, 'click', `only clicks: ${JSON.stringify(action)}`);
  for (const taskId of taskIds) {
    const attempts = await stack.ledger.listAttempts(taskId);
    for (const attempt of attempts) assert.match(attempt.stepId, /^(navigate:|open_detail$)/, `attempt ${attempt.stepId} is not navigation`);
    assert.ok(!attempts.some((a) => a.stepId === 'accept' || a.stepId === 'send' || a.stepId.startsWith('type')), 'no dangerous attempt');
  }
}

// ---------------------------------------------------------------- A01–A04 只读基线

test('rehearsal A01–A04: connect (handshake, contract, capabilities, principal) → bind the WeChat window by bundleId → ReadRequests → list_read with coverage; one navigation click, nothing else', async (t) => {
  // A screenshot above 512 KiB makes artifact.read go through more than one chunk on the real client.
  const stack = await startFakeStack(t, { fake: { screenshot: { byteSize: 600_000 } }, facts: [chatsPage(), newFriendsPage(ROWS, 'current_viewport')] });
  const { fake, app, ledger } = stack;
  await app.start();

  // A01: what the handshake and the capability list said, as the app recorded them.
  const before = await snapshotOf(stack);
  assert.equal(before.connection.product, 'AgentDesktop');
  assert.equal(before.connection.apiVersion, 'agentdesktop.runtime/1');
  // A4: the app is a paired client (the Fake Runtime enforces the grant), never the owner.
  assert.deepEqual(before.connection.principal, { clientId: stack.clientId, role: 'paired' });
  assert.equal(before.connection.state, 'ready');
  assert.equal(before.connection.pairing.state, 'paired');
  assert.deepEqual(before.connection.missingCapabilities, []);
  assert.deepEqual(before.features.read_list, { enabled: true });
  assert.notEqual((before.features.accept_request as { reason?: string }).reason, 'pairing_missing');
  const handshake = fake.requests.find((r) => r.method === 'runtime.handshake')!;
  const shown = handshake.params.credential as { clientId: string; token: string };
  assert.equal(shown.clientId, stack.clientId);
  assert.deepEqual({ ...handshake.params, credential: undefined }, { apiVersions: ['agentdesktop.runtime/1'], client: { name: 'wechat-agent-rehearsal', version: '0.1.0' }, credential: undefined });
  assert.ok(fake.requests.filter((r) => r.method !== 'runtime.handshake').every((r) => !JSON.stringify(r.params).includes(shown.token)), 'the credential goes into the handshake only');
  assert.equal(fake.callCount('runtime.capabilities'), 1);
  // Setup steps: discover/contract/pairing done, window bound, account done, baseline configured off.
  const steps = Object.fromEntries(before.connection.steps.map((s) => [s.key, s.state]));
  assert.deepEqual(steps, { discover: 'done', contract: 'done', pairing: 'done', window: 'done', account: 'done', baseline: 'done' });

  // A02-ish: window.list was filtered by the WeChat bundleId on the app side and the bound window is that one.
  const bind = fake.requests.find((r) => r.method === 'window.bind')!;
  const wechat = fake.windows.find((w) => w.bundleId === WECHAT_BUNDLE_ID)!;
  assert.deepEqual(bind.params, { desktopId: 'desk_1', pid: wechat.process.pid, windowId: wechat.windowId });
  assert.equal(fake.callCount('act'), 0, 'connecting and binding send no input');
  // The event subscription is its own connection with its own handshake (opened asynchronously after the control connection is ready).
  await waitFor(async () => fake.callCount('events.subscribe'), (n) => n === 1, 'events.subscribe');
  assert.equal(fake.requests.filter((r) => r.method === 'runtime.handshake').length, 2);
  assert.equal(fake.connectionCount, 2);

  // A04: one ReadRequests task.
  stack.mark();
  const created = await createRead(app.service, 'op_stage4_read');
  const done = await waitForTask(app.service, created.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed', timeline(done));
  assert.equal(done.stateReason, undefined);

  // The handler's wire trace: a Delegated Run bracketed the work, params of run.start empty, one click, released afterwards.
  const trace = stack.methods(stack.since());
  assert.deepEqual(trace.filter((m) => !['observe', 'artifact.show', 'artifact.read'].includes(m)), ['session.open', 'run.start', 'act', 'run.finish', 'session.close'], trace.join(' > '));
  assert.equal(stack.since().filter((r) => r.method === 'observe').length, 2, 'chats → click 通讯录 → new_friends');
  assert.ok(stack.since().filter((r) => r.method === 'artifact.read').length >= 4, 'two screenshots, each read in ≥2 chunks of ≤512 KiB');
  const runStart = stack.since().find((r) => r.method === 'run.start')!;
  assert.deepEqual(runStart.params, {}, 'no lifetime/ownership/origin (ADR-05)');
  const run = fake.runs.get(runStart.context.sessionId ? [...fake.runs.values()].find((x) => x.sessionId === runStart.context.sessionId)!.runId : '')!;
  assert.equal(run.lifetime, 'connection_scoped');
  assert.equal(run.ownership, 'external_client');
  assert.equal(run.phase, 'ended');
  assert.equal(run.outcome, 'success');
  assert.equal(run.closingReason, 'finished');
  assert.deepEqual(run.events.map((e) => e.type), ['run.started', 'action.accepted', 'action.dispatched', 'action.completed', 'run.quiescent', 'run.ended'], 'run.events: the evidence the plan asks for');

  // The one click is the navigation to 通讯录, at the centre of the recognised control, in image pixels.
  const [click] = acts(stack);
  assert.equal(acts(stack).length, 1);
  assert.deepEqual(click.action, { kind: 'click', target: { imagePoint: { x: 80, y: 240 } } });
  assert.equal(click.runId, run.runId);
  const attempts = await ledger.listAttempts(created.taskId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].stepId, 'navigate:contacts:0');
  assert.equal(attempts[0].state, 'verified', 'settled by the observation after it');
  assert.equal(attempts[0].requestId, click.requestId, 'the requestId in the ledger is the envelope requestId on the wire');
  assert.ok(await ledger.getReceipt(attempts[0].attemptId), 'the platform receipt is stored verbatim');
  await assertReadOnly(stack, [created.taskId]);

  // list_read: rows, statuses, coverage; zero or partial is never "all handled".
  const facts = await ledger.listFacts(created.taskId);
  const listRead = facts.find((f) => f.factKind === 'list_read')!;
  assert.ok(listRead, facts.map((f) => f.factKind).join(','));
  assert.equal(listRead.data?.coverage, 'current_viewport');
  assert.equal(listRead.data?.complete, false);
  assert.equal(listRead.data?.rowCount, 2);
  assert.deepEqual((listRead.data?.rows as { name: string; status: string }[]).map((r) => `${r.name}:${r.status}`), ['测试联系人甲:pending', '测试联系人乙:added']);
  assert.ok(facts.some((f) => f.factKind === 'platform_receipt' && f.outcome === 'observed'));

  // Evidence: every observation became an Evidence row whose sha256 is the artifact's, and the bytes the real client read match it.
  assert.equal(listRead.evidenceIds.length, 1);
  const evidence = await ledger.getEvidence(listRead.evidenceIds[0]);
  assert.ok(evidence?.artifactId);
  const artifact = fake.artifacts.get(evidence!.artifactId!)!;
  assert.equal(evidence!.sha256, artifact.sha256);
  assert.equal(createHash('sha256').update(artifact.bytes).digest('hex'), evidence!.sha256);
  assert.equal(evidence!.coverage, 'current_viewport');
  assert.equal(artifact.runId, run.runId, 'the screenshot artifact belongs to the Run');
  // The recognizer saw the bytes the client fetched (size and sha256 of the artifact).
  const read = stack.recognizer.reads.at(-1)!;
  assert.equal(read.artifactId, evidence!.artifactId);
  assert.equal(read.sha256, artifact.sha256);
  assert.equal((read as { bytes?: Uint8Array }).bytes?.byteLength, 600_000);

  // Snapshot after: nothing waiting, gate open, connection still ready; patrol coverage reflects the read.
  // (patrol.coverage in the snapshot only follows patrol/baseline reads, not a UI-created task; the fact above is the record.)
  const after = await snapshotOf(stack);
  assert.equal(after.counts.waitingApproval, 0);
  assert.equal(after.inputGate, 'open');
  assert.equal(after.connection.state, 'ready');
});

test('rehearsal A04 step 3: a list longer than one screen is reported partial (confirmed with coverage_partial), never end_confirmed', async (t) => {
  const stack = await startFakeStack(t, { facts: [newFriendsPage(ROWS, 'partial')] });
  await stack.app.start();
  const created = await createRead(stack.app.service, 'op_stage4_partial');
  const done = await waitForTask(stack.app.service, created.taskId, TERMINAL);
  assert.equal(done.state, 'confirmed', timeline(done));
  assert.equal(done.stateReason, 'coverage_partial');
  const listRead = (await stack.ledger.listFacts(created.taskId)).find((f) => f.factKind === 'list_read')!;
  assert.equal(listRead.data?.coverage, 'partial');
  assert.equal(listRead.data?.complete, false);
  assert.equal(stack.fake.callCount('act'), 0, 'already on 新的朋友: no click at all');
  await assertReadOnly(stack, [created.taskId]);
});

test('rehearsal A04 step 4: a page with zero rows is current_viewport (not "all handled"); end_confirmed only when the recognizer says so', async (t) => {
  const stack = await startFakeStack(t, { facts: [newFriendsPage([], 'current_viewport'), newFriendsPage([], 'end_confirmed')] });
  await stack.app.start();
  const empty = await createRead(stack.app.service, 'op_stage4_zero');
  const doneEmpty = await waitForTask(stack.app.service, empty.taskId, TERMINAL);
  assert.equal(doneEmpty.state, 'confirmed', timeline(doneEmpty));
  const first = (await stack.ledger.listFacts(empty.taskId)).find((f) => f.factKind === 'list_read')!;
  assert.deepEqual({ coverage: first.data?.coverage, complete: first.data?.complete, rowCount: first.data?.rowCount }, { coverage: 'current_viewport', complete: false, rowCount: 0 });
  assert.match(String(doneEmpty.timeline.at(-1)?.label), /confirmed/);

  const whole = await createRead(stack.app.service, 'op_stage4_end');
  await waitForTask(stack.app.service, whole.taskId, TERMINAL);
  const second = (await stack.ledger.listFacts(whole.taskId)).find((f) => f.factKind === 'list_read')!;
  assert.deepEqual({ coverage: second.data?.coverage, complete: second.data?.complete }, { coverage: 'end_confirmed', complete: true });
  assert.equal(stack.fake.callCount('act'), 0);
});

test('rehearsal: an unreadable capture (no layout profile applies) stops the read as blocked(layout_unreadable) with no click', async (t) => {
  const stack = await startFakeStack(t, { facts: [pageFacts({ page: 'unknown', coverage: 'unreadable', warnings: ['scale mismatch'] })] });
  await stack.app.start();
  const created = await createRead(stack.app.service, 'op_stage4_unreadable');
  const done = await waitForTask(stack.app.service, created.taskId, ['blocked', ...TERMINAL]);
  assert.equal(done.state, 'blocked', timeline(done));
  assert.equal(done.stateReason, 'layout_unreadable');
  assert.equal(stack.fake.callCount('act'), 0);
  assert.equal((await stack.ledger.listFacts(created.taskId)).some((f) => f.factKind === 'list_read'), false, 'no list_read fact from an unreadable capture');
  const run = [...stack.fake.runs.values()][0]!;
  assert.equal(run.phase, 'ended');
  assert.equal(run.closingReason, 'finished');
});

// ---------------------------------------------------------------- 异常：断连

test('rehearsal stop condition: the control connection drops during observe → the task is blocked(disconnected), the gate closes, the platform ends the Run; reconnect is explicit and resumes nothing', async (t) => {
  const stack = await startFakeStack(t, { facts: [newFriendsPage(ROWS)] });
  const { fake, driver, app, scheduler } = stack;
  await app.start();
  fake.injectDisconnectBeforeReply('observe');
  stack.mark();
  const created = await createRead(app.service, 'op_stage4_drop');
  const blocked = await waitForTask(app.service, created.taskId, ['blocked', ...TERMINAL]);
  assert.equal(blocked.state, 'blocked', timeline(blocked));
  assert.equal(blocked.stateReason, 'disconnected');

  // Driver: disconnected, no reconnect by itself; the in-flight observe got connection_lost with notSent=false.
  await waitFor(async () => driver.state, (s) => s === 'disconnected', 'driver state');
  const snapshot = await waitFor(() => snapshotOf(stack), (s) => s.connection.state === 'disconnected', 'app connection state');
  assert.equal(snapshot.inputGate, 'closed', 'the write gate closed on the drop');
  assert.equal(snapshot.connection.steps.find((s) => s.key === 'discover')?.state, 'failed');
  assert.equal(snapshot.features.read_list.enabled, false);
  assert.equal((snapshot.features.read_list as { reason?: string }).reason, 'platform_offline');
  assert.equal(fake.connectionsAccepted, 2, 'control + events; no silent reconnect');
  assert.equal(scheduler.size >= 1, true, 'the app scheduled a backoff reconnect; nothing fires until the scheduler does');

  // Platform: the Delegated Run ended with the connection (connection_scoped), nothing was cancelled by the client.
  const run = [...fake.runs.values()][0]!;
  assert.equal(run.phase, 'ended');
  assert.equal(run.closingReason, 'connection_closed');
  assert.equal(run.outcome, 'cancelled');
  assert.equal(run.quiescence, 'confirmed');
  assert.equal(fake.callCount('run.cancel'), 0);
  assert.equal(fake.callCount('run.finish'), 0, 'the client could not finish a Run it lost');
  assert.equal(fake.callCount('act'), 0);

  // Reconnect (as the person pressing "retry" would): a new handshake, re-bind, re-subscribe; the old Run is only never touched again.
  stack.mark();
  const check = await app.service.call('connection.check', {});
  assert.equal(check.state, 'ready');
  await waitFor(async () => fake.connectionsAccepted, (n) => n === 4, 'control + events re-opened');
  const after = stack.methods(stack.since());
  assert.deepEqual(after.filter((m) => !['runtime.handshake', 'runtime.capabilities', 'desktop.list', 'window.list', 'window.bind', 'events.subscribe'].includes(m)), [], after.join(' > '));
  assert.equal((await viewOf(stack, created.taskId)).state, 'blocked', 'the task stays blocked; nothing is replayed');
  assert.equal(fake.callCount('run.attach'), 0);
  assert.equal(fake.callCount('run.start'), 1);
  const resumed = await snapshotOf(stack);
  assert.equal(resumed.connection.state, 'ready');
  assert.equal(resumed.inputGate, 'closed', 'the gate stays closed until an explicit app.resume');
  await assertReadOnly(stack, [created.taskId]);
});

test('rehearsal stop condition: the Runtime goes away between recognize and the next step (all connections dropped) → blocked(disconnected), no act after the drop', async (t) => {
  const stack = await startFakeStack(t, { facts: [chatsPage(), newFriendsPage(ROWS)] });
  const { fake, app } = stack;
  await app.start();
  const hold = stack.recognizer.hold(1);
  const created = await createRead(app.service, 'op_stage4_drop_all');
  await hold.reached;
  fake.dropConnections();
  await waitFor(async () => stack.driver.state, (s) => s === 'disconnected', 'driver state');
  hold.release();
  const blocked = await waitForTask(app.service, created.taskId, ['blocked', ...TERMINAL]);
  assert.equal(blocked.state, 'blocked', timeline(blocked));
  assert.equal(blocked.stateReason, 'disconnected');
  assert.equal(fake.callCount('act'), 0, 'the navigation click after the recognize never went out');
  assert.equal((await snapshotOf(stack)).inputGate, 'closed');
  const run = [...fake.runs.values()][0]!;
  assert.equal(run.closingReason, 'connection_closed');
  await assertReadOnly(stack, [created.taskId]);
});

// ---------------------------------------------------------------- 异常：超时

test('rehearsal stop condition: observe gets no reply within the deadline → blocked(disconnected) and the gate closes; the explicit reconnect must succeed on a fresh connection', async (t) => {
  const stack = await startFakeStack(t, { facts: [newFriendsPage(ROWS)], requestTimeoutMs: 200 });
  const { fake, driver, app } = stack;
  await app.start();
  fake.injectTimeout('observe');
  const created = await createRead(app.service, 'op_stage4_timeout');
  const blocked = await waitForTask(app.service, created.taskId, ['blocked', ...TERMINAL]);
  assert.equal(blocked.state, 'blocked', timeline(blocked));
  assert.equal(blocked.stateReason, 'disconnected', 'a deadline is treated as loss of the connection: stop, do not guess');
  const dropped = await waitFor(() => snapshotOf(stack), (s) => s.connection.state === 'disconnected', 'app connection state');
  assert.equal(dropped.inputGate, 'closed');
  assert.equal(fake.callCount('act'), 0);
  // The driver alone keeps the socket after a deadline (a late reply is ignored); the app, having counted the
  // deadline as a lost connection, closes it so the platform sees the same thing: the Run ends with the connection.
  // (Before the connector fix of docs/acceptance/driver-disconnect-review.md the socket stayed open and the
  // reconnect failed with invalid_argument: connect() called while connected.)
  await waitFor(async () => driver.state, (s) => s === 'closed', 'the stale control connection is closed');
  const staleRun = [...fake.runs.values()][0]!;
  await waitFor(async () => staleRun.phase, (p) => p === 'ended', 'the Run on the stale connection ended on the platform');
  assert.equal(staleRun.closingReason, 'connection_closed');
  assert.equal(fake.callCount('run.cancel'), 0);
  assert.equal(fake.callCount('run.finish'), 0);

  // The person presses retry: a fresh connection, a new handshake; the parked task is not replayed.
  stack.mark();
  const check = await app.service.call('connection.check', {});
  assert.equal(check.state, 'ready', `reconnect after a timeout must succeed: ${(await snapshotOf(stack)).connection.steps.map((s) => `${s.key}=${s.state}${s.detail ? `(${s.detail})` : ''}`).join(' ')}`);
  assert.equal(driver.state, 'connected');
  assert.ok(stack.since().some((r) => r.method === 'runtime.handshake'), 'a new handshake, not the stale socket');
  assert.equal(fake.callCount('run.start'), 1, 'nothing resumed, nothing restarted');
  assert.equal((await viewOf(stack, created.taskId)).state, 'blocked');
  await assertReadOnly(stack, [created.taskId]);
});

// ---------------------------------------------------------------- 异常：窗口变化

test('rehearsal stop condition: the bound window changes (windowId/generation) between the approval and the re-observe → stopped as approval_invalid (waiting_user), no dangerous click', async (t) => {
  // The only flow that anchors on the window is a write flow; the rehearsal runs it up to the pre-write check and proves the check stops it.
  // A paired principal is required for the feature to be enabled; the stack starts the app paired on the A4 Fake Runtime.
  const detail = pageFacts({ page: 'request_detail', detail: { name: NAME, wechatId: 'wxid_fixture_a', buttons: [{ text: '接受', rect: { x: 1500, y: 900, width: 200, height: 80 }, confidence: 0.95 }], confidence: 0.95 } });
  const stack = await startFakeStack(t, { facts: [newFriendsPage([requestRow(NAME, 'pending')]), detail, detail] });
  const { fake, app, ledger } = stack;
  await app.start();
  const created = await createAccept(app.service, { operationId: 'op_stage4_window' });
  const waiting = await waitForTask(app.service, created.taskId, ['waiting_approval']);
  const firstObserve = fake.requests.filter((r) => r.method === 'observe').length;
  assert.equal(firstObserve, 2, 'list and detail');
  assert.equal(fake.callCount('act'), 1, 'only the navigation click that opened the detail');

  // 微信 was re-launched / the binding moved: another window, another generation.
  const desktop = fake.desktops.get('desk_1')!;
  const startedAt: Timestamp = new Date().toISOString();
  fake.windows.push({ windowId: 12, process: { pid: 778, startedAt }, appName: 'WeChat', bundleId: WECHAT_BUNDLE_ID, title: 'WeChat', frame: { x: 0, y: 25, width: 1280, height: 875 }, onScreen: true });
  desktop.generation += 1;
  desktop.binding = { generation: desktop.generation, process: { pid: 778, startedAt }, windowId: 12, appName: 'WeChat', boundAt: startedAt };

  await approve(app.service, created.taskId, stack.slice.now);
  // Lane D halts blocked(approval_invalid); from `executing` the legal landing for a blocked outcome is waiting_user (a person decides). Either way: stopped.
  const done = await waitForTask(app.service, created.taskId, ['blocked', 'waiting_user', ...TERMINAL]);
  assert.equal(done.state, 'waiting_user', timeline(done));
  assert.equal(done.stateReason, 'approval_invalid');
  // The re-observe did happen and saw the new target; the dangerous click did not.
  const observes = fake.requests.filter((r) => r.method === 'observe');
  assert.equal(observes.length, 3);
  const fresh = [...fake.snapshots.values()].at(-1)!;
  assert.ok(fresh);
  assert.equal(desktop.binding.windowId, 12);
  assert.equal(fake.callCount('act'), 1, 'no accept click');
  const attempts = await ledger.listAttempts(created.taskId);
  assert.deepEqual(attempts.map((a) => `${a.stepId}:${a.state}`), ['open_detail:verified']);
  assert.equal(waiting.approval, undefined);
  const stored = (await ledger.listFacts(created.taskId)).map((f) => f.factKind);
  assert.ok(!stored.includes('friend_added'));
  // The run was released (failed, not cancelled: nothing was in flight) and the platform saw no cancel.
  assert.equal(fake.callCount('run.cancel'), 0);
  assert.equal([...fake.runs.values()].every((r) => r.phase === 'ended'), true);
  await assertReadOnly(stack, [created.taskId]);
});
