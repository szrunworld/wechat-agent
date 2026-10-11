// Where the app keeps the credential AgentDesktop handed it at pairing (A4).
// The token proves this app to the Runtime; it goes into runtime.handshake
// and nowhere else: never into logs, snapshots, diagnostics or the outbox.
//
// - MemoryCredentialStore: tests, and library use without a data directory
//   (the app pairs again on every start).
// - FileCredentialStore: a 0600 file in a 0700 directory. Same-user
//   protection only, as AgentDesktop's docs say of SDK files; used by tests and
//   the acceptance scripts. The signed app keeps it in the keychain instead,
//   which comes with the shell wiring and S4 (Developer ID), not in this
//   module. Tests never touch the login keychain.
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CredentialStore, StoredCredential } from '@wechat-agent/ports';

const CLIENT_ID = /^app:[A-Za-z0-9._-]{1,64}$/;

function valid(value: unknown): value is StoredCredential {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.clientId === 'string' && CLIENT_ID.test(v.clientId) && typeof v.token === 'string' && v.token.length >= 8 && v.token.length <= 200
    && typeof v.pairedAt === 'string';
}

export class MemoryCredentialStore implements CredentialStore {
  readonly kind = 'memory' as const;
  private value: StoredCredential | null;

  constructor(initial: StoredCredential | null = null) {
    this.value = initial ? { ...initial } : null;
  }

  async load(): Promise<StoredCredential | null> {
    return this.value ? { ...this.value } : null;
  }

  async save(credential: StoredCredential): Promise<void> {
    if (!valid(credential)) throw new Error('refusing to store a malformed credential');
    this.value = { ...credential };
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly kind = 'file' as const;

  constructor(readonly file: string) {}

  /** A file other users could read or write is not trusted: it is reported, not used. */
  async load(): Promise<StoredCredential | null> {
    let info;
    try {
      info = await stat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if ((info.mode & 0o077) !== 0) throw new Error(`credential file ${this.file} is accessible to other users (mode ${(info.mode & 0o777).toString(8)}); not using it`);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`credential file ${this.file} belongs to another user; not using it`);
    const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
    if (!valid(parsed)) throw new Error(`credential file ${this.file} is malformed; not using it`);
    return parsed;
  }

  async save(credential: StoredCredential): Promise<void> {
    if (!valid(credential)) throw new Error('refusing to store a malformed credential');
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(credential), { mode: 0o600, flag: 'w' });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
