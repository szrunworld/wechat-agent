import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IpcFailure } from '@wechat-agent/ports';
import { FakeApplicationService } from '@wechat-agent/ports/fakes';
import { createCallGateway, toIpcError } from '../src/index.ts';

test('gateway rejects a non-whitelisted method without calling the service', async () => {
  const service = new FakeApplicationService();
  const gateway = createCallGateway(service);
  for (const bad of ['fs.read', 'child_process.exec', '', undefined, 1]) {
    const envelope = await gateway(bad, {});
    assert.equal(envelope.ok, false);
    if (!envelope.ok) assert.equal(envelope.error.code, 'blocked');
  }
  assert.equal(service.calls.length, 0);
});

test('gateway rejects non-object params', async () => {
  const service = new FakeApplicationService();
  const gateway = createCallGateway(service);
  for (const bad of [null, 'x', 3, ['a']]) {
    const envelope = await gateway('app.getSnapshot', bad);
    assert.equal(envelope.ok, false);
  }
  assert.equal(service.calls.length, 0);
});

test('gateway wraps a result and a structured failure', async () => {
  const service = new FakeApplicationService('platform_offline');
  const gateway = createCallGateway(service);
  const ok = await gateway('app.getSnapshot', {});
  assert.ok(ok.ok && (ok.result as { connection: { state: string } }).connection.state === 'disconnected');
  const missing = await gateway('task.show', { taskId: 'nope' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'not_found');
  const unimplemented = await gateway('diagnostics.export', { includeEvidence: false, selectedEvidenceIds: [] });
  assert.equal(unimplemented.ok, false);
  if (!unimplemented.ok) assert.equal(unimplemented.error.code, 'unavailable');
  assert.deepEqual(service.calls.map((c) => c.method), ['app.getSnapshot', 'task.show', 'diagnostics.export']);
});

test('toIpcError keeps IpcFailure codes and maps anything else to internal', () => {
  assert.deepEqual(toIpcError(new IpcFailure({ code: 'blocked', message: 'b' })), { code: 'blocked', message: 'b' });
  assert.deepEqual(toIpcError(new Error('boom')), { code: 'internal', message: 'boom' });
  assert.deepEqual(toIpcError('str'), { code: 'internal', message: 'str' });
});
