// Minimal in-memory fakes of the ports, for lane tests. They are the
// reference for behaviour the real implementations must match; lanes may
// extend them in their own test directories, not here.
export { FakeDriver, type FakeDriverOptions, type FaultSpec } from './driver.ts';
export { InMemoryLedger } from './ledger.ts';
export { FakeRecognizer } from './recognizer.ts';
export { sampleSnapshots, emptyFeatures, type SnapshotKey } from './snapshots.ts';
export { FakeApplicationService } from './service.ts';
