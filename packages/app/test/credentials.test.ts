// The credential stores: a 0600 file in a 0700 directory, refused when other
// users could read it; memory for tests. Neither touches the keychain.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileCredentialStore, MemoryCredentialStore } from '../src/credentials.ts';

const CRED = { clientId: 'app:0123456789abcdef', token: 'adt1_test-token-not-a-secret', pairedAt: '2026-10-09T00:00:00Z' };

test('file store: round trip, 0600 file in a 0700 directory, clear removes it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-cred-'));
  const store = new FileCredentialStore(path.join(dir, 'pairing', 'credential.json'));
  assert.equal(await store.load(), null);
  await store.save(CRED);
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(store.file))).mode & 0o777, 0o700);
  assert.deepEqual(await store.load(), CRED);
  await store.clear();
  assert.equal(await store.load(), null);
});

test('file store: a file other users can read is not used; a malformed one is not used', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-cred-'));
  const file = path.join(dir, 'credential.json');
  await writeFile(file, JSON.stringify(CRED), { mode: 0o600 });
  await chmod(file, 0o644);
  const store = new FileCredentialStore(file);
  await assert.rejects(store.load(), /other users/);
  await chmod(file, 0o600);
  await writeFile(file, JSON.stringify({ clientId: 'local:501', token: 'x' }));
  await assert.rejects(store.load(), /malformed/);
  await assert.rejects(store.save({ ...CRED, clientId: 'local:501' }), /malformed/);
  assert.match(await readFile(file, 'utf8'), /local:501/, 'a refused save leaves the file alone');
});

test('memory store: copies in and out', async () => {
  const store = new MemoryCredentialStore();
  await store.save(CRED);
  const loaded = await store.load();
  loaded!.token = 'changed';
  assert.equal((await store.load())?.token, CRED.token);
  await store.clear();
  assert.equal(await store.load(), null);
});
