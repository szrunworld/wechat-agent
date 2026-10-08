import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preloadWhitelist } from '../src/index.ts';
test('lane G stub', () => { assert.ok(preloadWhitelist.includes('app.getSnapshot')); });
