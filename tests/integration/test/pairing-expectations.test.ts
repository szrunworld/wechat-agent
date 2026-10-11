import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedPairingResult } from '../src/pairing-expectations.ts';

test('acceptance rejects the opposite answer, timeout and incomplete reconnect', () => {
  assert.equal(expectedPairingResult('unpaired', 'denied', 'paired'), 'failed');
  assert.equal(expectedPairingResult('ready', 'paired', 'denied'), 'failed');
  assert.equal(expectedPairingResult('pairing', 'waiting', 'paired'), 'failed');
  assert.equal(expectedPairingResult('unpaired', 'expired', 'denied'), 'failed');
  assert.equal(expectedPairingResult('connecting', 'paired', 'paired'), 'failed');
  assert.equal(expectedPairingResult('ready', 'paired', 'revoked'), 'failed');
  assert.equal(expectedPairingResult('ready', 'paired', 'paired'), 'passed');
  assert.equal(expectedPairingResult('unpaired', 'denied', 'denied'), 'passed');
  assert.equal(expectedPairingResult('revoked', 'revoked', 'revoked'), 'passed');
});
