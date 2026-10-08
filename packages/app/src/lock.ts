// Single instance: one lock file holding the owner pid. A stale lock (dead
// pid) is taken over; a live one refuses the second instance.
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class AppLockedError extends Error {
  constructor(readonly lockPath: string, readonly ownerPid: number) {
    super(`another WeChat Agent instance (pid ${ownerPid}) holds ${lockPath}`);
    this.name = 'AppLockedError';
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SingleInstanceLock {
  /** Lock paths this process already holds: a second application object in the same process is still a second instance. */
  private static readonly heldInProcess = new Set<string>();
  private held = false;

  constructor(readonly lockPath: string, private readonly pid: number = process.pid) {}

  async acquire(): Promise<void> {
    await mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    if (SingleInstanceLock.heldInProcess.has(this.lockPath)) throw new AppLockedError(this.lockPath, this.pid);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(this.lockPath, String(this.pid), { flag: 'wx', mode: 0o600 });
        this.held = true;
        SingleInstanceLock.heldInProcess.add(this.lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number((await readFile(this.lockPath, 'utf8').catch(() => '')).trim());
        if (owner === this.pid || !pidAlive(owner)) {
          await unlink(this.lockPath).catch(() => undefined);
          continue;
        }
        throw new AppLockedError(this.lockPath, owner);
      }
    }
    throw new AppLockedError(this.lockPath, -1);
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    SingleInstanceLock.heldInProcess.delete(this.lockPath);
    const owner = (await readFile(this.lockPath, 'utf8').catch(() => '')).trim();
    if (owner === String(this.pid)) await unlink(this.lockPath).catch(() => undefined);
  }
}
