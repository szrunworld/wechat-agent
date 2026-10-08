// The frozen seams between lanes. A lane imports only from this package
// (and `@wechat-agent/ports/fakes` in its tests), never from another lane.
// Changing anything here is the coordinator's job: write
// `INTERFACE REQUEST: ...` in your PR description instead.
export * from './domain.ts';
export * from './driver.ts';
export * from './ledger.ts';
export * from './recognizer.ts';
export * from './handler.ts';
export * from './ipc.ts';
