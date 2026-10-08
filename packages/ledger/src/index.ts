// Lane B. See docs/lanes/lane-b.md. The contract tests to pass live in
// packages/ports/test/ledger-contract.ts.
import type { Ledger } from '@wechat-agent/ports';
export async function openLedger(_path: string): Promise<Ledger> {
  throw new Error('lane B: not implemented yet');
}
