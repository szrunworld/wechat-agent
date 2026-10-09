// Lane E: the application core. See docs/lanes/lane-e.md.
import { WeChatAgentApplication, type Application, type ApplicationDeps, type ApplicationInternals } from './application.ts';

export type { Application, ApplicationDeps, ApplicationInternals };
export type { AppConfig } from './config.ts';
export { DEFAULT_CONFIG, resolveConfig } from './config.ts';
export {
  RuntimeConnector, SetupSteps, CORE_METHODS, WECHAT_BUNDLE_ID, PAIRING_COOLDOWN_MS, isConnectionError, isAccessLost, isPlatformLost, describeRefusal,
  type PairingConfig,
} from './connector.ts';
export { MemoryCredentialStore, FileCredentialStore } from './credentials.ts';
export { Dispatcher, type FinishedEvent } from './dispatcher.ts';
export { computeFeatures, featureKeyFor, reasonCodeForFeature, OUTBOUND_ACTIONS, type FeatureMap } from './features.ts';
export { InputGate, type PauseReason } from './gate.ts';
export { PolicyGate, type Verdict } from './policy.ts';
export { Patrol, requestsFromFacts } from './patrol.ts';
export { recoverOpenAttempts, type RecoveryReport } from './recovery.ts';
export { exportDiagnostics, maskLabel, maskText } from './diagnostics.ts';
export { SingleInstanceLock, AppLockedError } from './lock.ts';
export { ManualScheduler, realScheduler, canonicalJson, hashContent, sha256, type Scheduler } from './support.ts';
export { pathTo, projectTask, isTerminal, OPEN_TASK_STATES, type TaskRuntime } from './tasks.ts';
export { toIpcFailure } from './application.ts';
export {
  OutboxWriter, OutboxDeliverer, MemorySink, FileSink, outboxExtension, taskFinalDraft, factDraft, payloadHashOf, KEY_FACT_KINDS, DEFAULT_OUTBOX_BACKOFF,
  type OutboxSink, type SinkResult, type OutboxDraft, type OutboxLedgerExtension, type OutboxBackoff, type DeliveryReport, type TaskFinalPayload, type FactPayload, type MemorySinkScript,
} from './outbox.ts';

export function createApplication(deps: ApplicationDeps): Application {
  return new WeChatAgentApplication(deps);
}
