import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeDriver, FakeRecognizer, InMemoryLedger } from '@wechat-agent/ports/fakes';
import { createApplication } from '../src/index.ts';
test('lane E stub', () => {
  assert.throws(() => createApplication({ driver: new FakeDriver(), ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: { get: () => undefined, all: () => [] } }));
});
