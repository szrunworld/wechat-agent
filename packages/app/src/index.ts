// Lane E. See docs/lanes/lane-e.md.
import type { AgentDesktopDriver, ApplicationService, HandlerRegistry, Ledger, Recognizer } from '@wechat-agent/ports';
export interface ApplicationDeps { driver: AgentDesktopDriver; ledger: Ledger; recognizer: Recognizer; handlers: HandlerRegistry; now?: () => string }
export interface Application { service: ApplicationService; start(): Promise<void>; stop(): Promise<void> }
export function createApplication(_deps: ApplicationDeps): Application {
  throw new Error('lane E: not implemented yet');
}
