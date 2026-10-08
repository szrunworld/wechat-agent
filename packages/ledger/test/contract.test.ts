// The shared Ledger contract (packages/ports/test/ledger-contract.ts) against SQLite.
import { runLedgerContract } from '../../ports/test/ledger-contract.ts';
import { openLedger } from '../src/index.ts';
import { tmpLedgerPath } from './helpers/tmp.ts';

runLedgerContract(() => openLedger(tmpLedgerPath()));
