// A fresh directory per ledger so permission and crash tests never share a file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-ledger-'));
  return join(dir, 'ledger', 'ledger.sqlite');
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
