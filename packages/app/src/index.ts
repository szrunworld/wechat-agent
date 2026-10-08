// Lane E: the application core. See docs/lanes/lane-e.md.
import { WeChatAgentApplication, type Application, type ApplicationDeps, type ApplicationInternals } from './application.ts';

export type { Application, ApplicationDeps, ApplicationInternals };
export type { AppConfig } from './config.ts';
export { DEFAULT_CONFIG, resolveConfig } from './config.ts';
export { RuntimeConnector, SetupSteps, CORE_METHODS, WECHAT_BUNDLE_ID, isConnectionError } from './connector.ts';
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

export function createApplication(deps: ApplicationDeps): Application {
  return new WeChatAgentApplication(deps);
}
