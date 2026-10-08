import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDriver } from '../src/index.ts';
test('lane A stub', () => { assert.throws(() => createDriver({ client: { name: 'WeChat Agent', version: '0.0.0' } })); });
