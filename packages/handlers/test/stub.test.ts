import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandlers } from '../src/index.ts';
test('lane D stub', () => { assert.throws(() => createHandlers()); });
