// Test harness over the shared fakes: a connected FakeDriver with one screenshot
// artifact, a FakeRecognizer scripted per observation, an InMemoryLedger, and a
// HandlerContext whose approval flow records a BusinessApproval in the ledger.

import { WriteGateClosedError } from '@wechat-agent/ports';
import type {
  AccountBinding, ActionAttempt, ApprovalDecision, ApprovalRequest, BusinessApproval, HandlerContext, Observation, PageFacts, PageKind, PixelRect,
  Policy, TargetRef, TaskIntake, WeChatTask,
} from '@wechat-agent/ports';
import { FakeDriver, FakeRecognizer, InMemoryLedger, type FakeDriverOptions } from '@wechat-agent/ports/fakes';
import { createHandlers, type HandlersOptions } from '../src/index.ts';

export const T0 = '2026-10-08T10:00:00+08:00';
export const ART = 'art_1';
export const SHA = 'ab'.repeat(32);

export function r(x: number, y: number, width = 100, height = 40): PixelRect {
  return { x, y, width, height };
}

export function mid(rect: PixelRect): { x: number; y: number } {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

export function observation(over: Partial<Observation> = {}): Observation {
  return {
    snapshotId: 'snap_0', desktopId: 'desk_fake', capturedAt: T0, screen: {},
    target: { generation: 1, process: { pid: 777, startedAt: null }, windowId: 11, windowFrame: { x: 0, y: 25, width: 1280, height: 875 }, title: '微信' },
    image: { artifactId: ART, mediaType: 'image/png', width: 2560, height: 1750, byteSize: 4, sha256: SHA, transform: { originX: 0, originY: 25, scale: 2 } },
    elements: [], ...over,
  };
}

export function facts(partial: Partial<PageFacts> & { page: PageKind }): PageFacts {
  return { coverage: 'current_viewport', profileId: 'p1', buttons: [], texts: [], warnings: [], confidence: 0.9, evidenceRef: { artifactId: ART, sha256: SHA }, ...partial };
}

export function button(text: string, rect: PixelRect) {
  return { text, rect, confidence: 0.95 };
}

export function text(t: string, rect: PixelRect = r(0, 0)) {
  return { text: t, rect, confidence: 0.95 };
}

export const ACCOUNT: AccountBinding = { accountId: 'acc_1', visibleLabel: '测试号', evidenceIds: [], confirmedAt: T0, revision: 1, status: 'confirmed' };

export const LI: TargetRef = { targetId: 'tgt_li', accountId: 'acc_1', kind: 'single', displayName: '李三', visibleIdentifier: 'li_san', identityEvidenceIds: ['ev_x'], confidence: 0.9, revision: 1 };

export interface HarnessOptions {
  facts: PageFacts[];
  task: Pick<TaskIntake, 'type' | 'payload'> & Partial<TaskIntake>;
  observations?: Observation[];
  driver?: Omit<FakeDriverOptions, 'observations' | 'artifacts'>;
  applicable?: boolean;
  policy?: Partial<Policy>;
  account?: Partial<AccountBinding>;
  writeGateOpen?: boolean;
  /** Runs when approval is requested; return a decision to override the default "approved". */
  decide?: (request: ApprovalRequest, harness: Harness) => Promise<ApprovalDecision | undefined> | ApprovalDecision | undefined;
  /** Approval expiry override, e.g. one in the past. */
  expiresAt?: string;
  handlers?: HandlersOptions;
}

export interface Harness {
  driver: FakeDriver;
  recognizer: FakeRecognizer;
  ledger: InMemoryLedger;
  ctx: HandlerContext;
  task: WeChatTask;
  approvals: ApprovalRequest[];
  granted: BusinessApproval[];
  abort: AbortController;
  writeGate: { open: boolean };
  log: string[];
  run(): Promise<import('@wechat-agent/ports').DomainResult>;
}

let clock = 0;

export async function harness(options: HarnessOptions): Promise<Harness> {
  const driver = new FakeDriver({ ...options.driver, observations: options.observations ?? [observation()], artifacts: { [ART]: new Uint8Array([1, 2, 3, 4]) } });
  await driver.connect();
  const session = await driver.openSession('desk_fake');
  const run = await driver.startRun(session.sessionId);
  const recognizer = new FakeRecognizer(options.facts, undefined, options.applicable ?? true);
  const ledger = new InMemoryLedger();
  const base = await ledger.getPolicy();
  const policy: Policy = { ...base, ...options.policy };
  const account: AccountBinding = { ...ACCOUNT, ...options.account };
  const { task } = await ledger.intake({
    operationId: 'op_1', fingerprint: 'fp_1', accountRevision: 1, targetId: 'tgt_1', targetRevision: 1, payloadHash: 'ph_1', ...options.task,
  }, T0);
  const abort = new AbortController();
  const writeGate = { open: options.writeGateOpen ?? true };
  const log: string[] = [];
  let ids = 0;
  /** Timestamps keep the +08:00 offset so that lexical comparisons in the fakes stay meaningful. */
  const now = () => new Date(Date.parse(T0) + 1000 * ++clock + 8 * 3_600_000).toISOString().replace('Z', '+08:00');
  const approvals: ApprovalRequest[] = [];
  const granted: BusinessApproval[] = [];
  const h: Harness = {
    driver, recognizer, ledger, task, approvals, granted, abort, writeGate, log,
    ctx: {
      driver, recognizer, ledger, policy, account, signal: abort.signal,
      writeGate: { isOpen: () => writeGate.open, ensureOpen() { if (!writeGate.open) throw new WriteGateClosedError('paused'); } },
      session: { desktopId: 'desk_fake', sessionId: session.sessionId, runId: run.runId },
      async requestApproval(request) {
        approvals.push(request);
        const override = await options.decide?.(request, h);
        if (override) return override;
        const approval = await ledger.recordApproval({
          taskId: request.taskId, accountRevision: request.accountRevision, targetRevision: request.targetRevision, draftRevision: request.draftRevision,
          contentHash: request.contentHash, allowedAction: request.allowedAction, expiresAt: options.expiresAt ?? '2026-10-08T11:00:00+08:00', createdAt: now(),
        });
        granted.push(approval);
        return { kind: 'approved', approval };
      },
      newId: () => `rq_${++ids}`,
      now,
      log: (line) => log.push(line),
    },
    async run() {
      const handler = createHandlers(options.handlers).get(task.type);
      if (!handler) throw new Error(`no handler for ${task.type}`);
      return handler.run(task as never, h.ctx);
    },
  };
  return h;
}

/** The act calls the driver saw, in order. */
export function acts(driver: FakeDriver): { requestId: string; action: Record<string, unknown>; snapshotId: string }[] {
  return driver.calls.filter((c) => c.method === 'act').map((c) => {
    const [, params, requestId] = c.args as [unknown, { snapshotId: string; action: Record<string, unknown> }, string];
    return { requestId, action: params.action, snapshotId: params.snapshotId };
  });
}

export function clickPoints(driver: FakeDriver): { x: number; y: number }[] {
  return acts(driver).filter((a) => a.action.kind === 'click').map((a) => (a.action.target as { imagePoint: { x: number; y: number } }).imagePoint);
}

export function attemptsFor(ledger: InMemoryLedger, stepId: string): ActionAttempt[] {
  return [...ledger.attempts.values()].filter((a) => a.stepId === stepId);
}
