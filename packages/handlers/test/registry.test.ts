import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandlers } from '../src/index.ts';
import { acts, facts, harness } from './helpers.ts';

test('the registry has one handler per task type, each declaring what it requires', () => {
  const registry = createHandlers();
  assert.deepEqual(registry.all().map((h) => h.type), ['read_requests', 'accept_request', 'add_friend', 'reply_draft', 'send_message']);
  for (const handler of registry.all()) {
    assert.ok(handler.requires.methods.includes('observe'), handler.type);
    assert.ok(handler.requires.actions.length > 0, handler.type);
    assert.equal(registry.get(handler.type), handler);
  }
  assert.deepEqual(registry.get('accept_request')?.requires.actions, ['accept_request', 'navigate', 'read']);
  assert.deepEqual(registry.get('reply_draft')?.requires.methods, ['observe', 'artifact.read']);
  assert.ok(registry.get('send_message')?.requires.actions.includes('send_message'));
  assert.ok(registry.get('add_friend')?.requires.actions.includes('send_friend_request'));
});

test('a disconnected driver blocks with disconnected before any act', async () => {
  const h = await harness({ task: { type: 'read_requests', payload: { kind: 'read_requests' } }, facts: [facts({ page: 'new_friends' })] });
  h.driver.dropConnection();
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'disconnected');
  assert.equal(acts(h.driver).length, 0);
});

test('a missing screenshot blocks with layout_unreadable', async () => {
  const { observation } = await import('./helpers.ts');
  const h = await harness({ task: { type: 'read_requests', payload: { kind: 'read_requests' } }, facts: [facts({ page: 'new_friends' })], observations: [observation({ image: null })] });
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'layout_unreadable');
});
