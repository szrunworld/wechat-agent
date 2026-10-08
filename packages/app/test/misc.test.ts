// Single instance lock, diagnostics redaction, state paths, feature gate.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FakeDriver, FakeRecognizer, InMemoryLedger } from '@wechat-agent/ports/fakes';
import { AppLockedError, computeFeatures, createApplication, maskLabel, maskText, pathTo } from '../src/index.ts';
import { makeHarness, registry, sendStub, waitState } from './harness.ts';

test('single instance: a second application on the same lock file refuses to start; a stale lock is taken over', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wechat-agent-lock-'));
  const make = () => createApplication({ driver: new FakeDriver({ principalRole: 'paired' }), ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: registry(), config: { dataDir: dir, patrolEnabled: false, baselineOnConnect: false, reconnect: { baseMs: 0, maxMs: 0 } } });
  const first = make();
  await first.start();
  const second = make();
  await assert.rejects(second.start(), (e: unknown) => e instanceof AppLockedError && e.ownerPid === process.pid);
  await first.stop();
  await second.start();
  await second.stop();
  // A dead owner does not block.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'instance.lock'), '999999999');
  const third = make();
  await third.start();
  await third.stop();
});

test('diagnostics.export masks names and numbers and carries no draft text', async () => {
  const h = await makeHarness({ handlers: [sendStub()] });
  await h.confirmAccount();
  const policy = await h.ledger.getPolicy();
  await h.ledger.setPolicy({ ...policy, allowlist: ['chat_a'] }, policy.revision);
  const account = (await h.ledger.getAccount())!;
  const view = await h.call('task.create', { operationId: 'op', type: 'send_message', expectedAccountRevision: account.revision, payload: { kind: 'send_message', conversationTargetId: 'chat_a', content: '我的手机号 13812345678，明天见', contentHash: 'h', contextRevision: 1 } });
  await waitState(h, view.taskId, 'waiting_approval');
  const result = await h.call('diagnostics.export', { includeEvidence: true, selectedEvidenceIds: account.evidenceIds });
  const body = await readFile(result.path, 'utf8');
  assert.equal(Buffer.byteLength(body), result.byteSize);
  assert.ok(result.path.startsWith(h.dataDir));
  assert.ok(!body.includes('13812345678'), 'phone number masked');
  assert.ok(!body.includes('明天见'), 'no message text');
  assert.ok(!body.includes('"text"'), 'drafts are reduced to lengths');
  const bundle = JSON.parse(body) as { tasks: { draft?: { length: number } }[]; evidence: { sha256: string }[]; account: { visibleLabel: string }; ledger: { writable: boolean } };
  assert.equal(bundle.tasks[0]!.draft?.length, [...'我的手机号 13812345678，明天见'].length);
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.ledger.writable, true);
  assert.equal(maskLabel('陈一'), '陈＊');
  assert.equal(maskText('电话 13912345678 。'), '电话 1********** 。');
  await h.app.stop();
});

test('pathTo walks only through working states', () => {
  assert.deepEqual(pathTo('executing', 'confirmed'), ['verifying', 'confirmed']);
  assert.deepEqual(pathTo('preparing', 'confirmed'), ['ready', 'executing', 'verifying', 'confirmed']);
  assert.deepEqual(pathTo('stopping', 'cancelled'), ['cancelled']);
  assert.deepEqual(pathTo('queued', 'blocked'), ['blocked']);
  assert.equal(pathTo('executing', 'blocked'), undefined, 'a running task cannot jump to blocked');
  assert.equal(pathTo('confirmed', 'queued'), undefined);
  assert.deepEqual(pathTo('executing', 'waiting_approval', ['preparing', 'ready', 'executing', 'verifying', 'waiting_user']), ['waiting_user', 'preparing', 'waiting_approval']);
});

test('feature gate reasons are ordered: offline, incompatible, pairing, account, policy, gate', () => {
  const handlers = registry(sendStub());
  const policy = { revision: 1, allowlist: [], allowedActions: ['read', 'navigate', 'send_message'] as const, activeHours: [], timezone: 'Asia/Shanghai', maxDaily: {}, minIntervalSeconds: 0, modelUpload: false, patrolIntervalSeconds: 60, approvalPerAction: true as const };
  const base = { connection: 'ready' as const, paired: true, methods: ['observe', 'act'], accountConfirmed: true, gateOpen: true, policy: { ...policy, allowedActions: [...policy.allowedActions] }, handlers, handbackVerified: false };
  assert.equal((computeFeatures({ ...base, connection: 'connecting' }).send_message as { reason: string }).reason, 'platform_offline');
  assert.equal((computeFeatures({ ...base, connection: 'incompatible' }).read_list as { reason: string }).reason, 'capability_missing');
  assert.equal((computeFeatures({ ...base, paired: false }).send_message as { reason: string }).reason, 'pairing_missing');
  assert.equal((computeFeatures({ ...base, accountConfirmed: false }).send_message as { reason: string }).reason, 'account_unconfirmed');
  assert.equal((computeFeatures({ ...base, policy: { ...base.policy, allowedActions: ['read'] } }).send_message as { reason: string }).reason, 'policy_disabled');
  assert.equal((computeFeatures({ ...base, gateOpen: false }).send_message as { reason: string }).reason, 'input_gate_closed');
  assert.deepEqual(computeFeatures(base).send_message, { enabled: true });
  assert.equal((computeFeatures(base).handback as { reason: string }).reason, 'capability_missing');
  assert.equal((computeFeatures(base).read_list as { reason: string }).reason, 'capability_missing', 'no read handler registered');
});

test('window.requestHandback is manual until CR03; snapshot subscribers get pushes', async () => {
  const h = await makeHarness({ handlers: [] });
  const handback = await h.call('window.requestHandback', { operationId: 'hb' });
  assert.equal(handback.mode, 'manual');
  assert.ok(handback.instructions?.includes('CR03'));
  const revisions: number[] = [];
  const off = h.app.service.subscribe((s) => revisions.push(s.revision));
  await h.confirmAccount();
  await new Promise((r) => setTimeout(r, 5));
  off();
  assert.ok(revisions.length >= 2, `pushes: ${revisions.join(',')}`);
  await h.app.stop();
});
