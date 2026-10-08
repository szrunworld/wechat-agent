import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleSnapshots } from '@wechat-agent/ports/fakes';
import { decideClose, shellStatus, trayToggle, STATUS_LABEL } from '../src/index.ts';

test('tray status follows the snapshot', () => {
  assert.equal(shellStatus(sampleSnapshots.ready_idle), 'running');
  assert.equal(shellStatus(sampleSnapshots.stopping), 'stopping');
  assert.equal(shellStatus(sampleSnapshots.platform_offline), 'offline');
  assert.equal(shellStatus(sampleSnapshots.incompatible), 'offline');
  assert.equal(shellStatus(sampleSnapshots.unpaired), 'offline');
  assert.equal(shellStatus(sampleSnapshots.quiescence_unconfirmed), 'quiescence_unconfirmed');
  assert.equal(shellStatus({ ...sampleSnapshots.ready_idle, inputGate: 'closed' }), 'paused');
  for (const key of Object.keys(STATUS_LABEL)) assert.ok(STATUS_LABEL[key as keyof typeof STATUS_LABEL].length > 0);
});

test('pause/resume is offered only in running/paused', () => {
  assert.equal(trayToggle('running'), 'pause');
  assert.equal(trayToggle('paused'), 'resume');
  assert.equal(trayToggle('stopping'), null);
  assert.equal(trayToggle('offline'), null);
  assert.equal(trayToggle('quiescence_unconfirmed'), null);
});

test('closing the window hides it; the hint shows once; quitting lets it close', () => {
  assert.deepEqual(decideClose({ quitting: false, hintShown: false }), { action: 'hide', showHint: true });
  assert.deepEqual(decideClose({ quitting: false, hintShown: true }), { action: 'hide', showHint: false });
  assert.deepEqual(decideClose({ quitting: true, hintShown: false }), { action: 'allow', showHint: false });
});
