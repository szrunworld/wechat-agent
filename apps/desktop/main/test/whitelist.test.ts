import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IPC_METHODS, IpcFailure } from '@wechat-agent/ports';
import { buildBridge, isIpcMethod, preloadWhitelist, CALL_CHANNEL, SNAPSHOT_CHANNEL, type RendererTransport } from '../src/index.ts';

test('whitelist is exactly IPC_METHODS from ports', () => {
  assert.deepEqual([...preloadWhitelist], [...IPC_METHODS]);
  for (const m of IPC_METHODS) assert.ok(isIpcMethod(m), m);
  for (const bad of ['fs.read', 'app.getSnapshot ', 'APP.GETSNAPSHOT', '', 42, null, undefined, {}, ['app.getSnapshot']]) assert.equal(isIpcMethod(bad), false, String(bad));
});

function fakeTransport() {
  const invoked: unknown[][] = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const transport: RendererTransport = {
    async invoke(channel, ...args) { invoked.push([channel, ...args]); return { ok: true, result: { echoed: args } }; },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener); listeners.set(channel, set);
      return () => set.delete(listener);
    },
  };
  return { transport, invoked, listeners };
}

test('preload bridge exposes only call and subscribe', () => {
  const bridge = buildBridge(fakeTransport().transport);
  assert.deepEqual(Object.keys(bridge).sort(), ['call', 'subscribe']);
  assert.ok(Object.isFrozen(bridge));
  assert.equal(typeof bridge.call, 'function');
  assert.equal(typeof bridge.subscribe, 'function');
});

test('bridge refuses a non-whitelisted method before touching the transport', async () => {
  const { transport, invoked } = fakeTransport();
  const bridge = buildBridge(transport);
  await assert.rejects(bridge.call('fs.read' as never, {} as never), (e: unknown) => e instanceof IpcFailure && e.error.code === 'blocked');
  await assert.rejects(bridge.call('' as never, {} as never), IpcFailure);
  assert.equal(invoked.length, 0);
});

test('bridge forwards a whitelisted call on the call channel and unwraps the envelope', async () => {
  const { transport, invoked } = fakeTransport();
  const bridge = buildBridge(transport);
  const result = await bridge.call('task.show', { taskId: 't1' });
  assert.deepEqual(invoked, [[CALL_CHANNEL, 'task.show', { taskId: 't1' }]]);
  assert.deepEqual(result, { echoed: ['task.show', { taskId: 't1' }] });
});

test('bridge rethrows a structured error from the envelope as IpcFailure', async () => {
  const transport: RendererTransport = {
    async invoke() { return { ok: false, error: { code: 'revision_conflict', message: 'stale', details: { expected: 2 } } }; },
    on() { return () => {}; },
  };
  const bridge = buildBridge(transport);
  await assert.rejects(bridge.call('app.getSnapshot', {}), (e: unknown) => e instanceof IpcFailure && e.error.code === 'revision_conflict' && e.error.details?.expected === 2);
});

test('bridge treats a malformed reply as internal, not as a result', async () => {
  const transport: RendererTransport = { async invoke() { return 'nope'; }, on() { return () => {}; } };
  await assert.rejects(buildBridge(transport).call('app.getSnapshot', {}), (e: unknown) => e instanceof IpcFailure && e.error.code === 'internal');
});

test('subscribe listens on the snapshot channel and the returned function unsubscribes', () => {
  const { transport, listeners } = fakeTransport();
  const bridge = buildBridge(transport);
  const seen: unknown[] = [];
  const off = bridge.subscribe((s) => seen.push(s));
  const set = listeners.get(SNAPSHOT_CHANNEL)!;
  assert.equal(set.size, 1);
  for (const l of set) l({ revision: 7 });
  assert.deepEqual(seen, [{ revision: 7 }]);
  off();
  assert.equal(set.size, 0);
});
