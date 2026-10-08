import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openLedger } from '../src/index.ts';
test('lane B stub', async () => { await assert.rejects(openLedger('/tmp/x.sqlite')); });
