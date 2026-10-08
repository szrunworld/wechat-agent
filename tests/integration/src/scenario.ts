// Scenario helpers shared by the slice, fault and ADR tests. Everything goes
// through ApplicationService.call so the helpers do not care which
// application or handlers are wired in.
import type { ApplicationService, BusinessApproval, TaskState, TaskView, Timestamp } from '@wechat-agent/ports';
import { TERMINAL_TASK_STATES } from '@wechat-agent/ports';
import type { Slice } from './wiring.ts';

export const TERMINAL = TERMINAL_TASK_STATES;
export const NAME = '测试联系人甲';
export const KEY = `${NAME}|${NAME}`;

export const plusSeconds = (now: Timestamp, seconds: number): Timestamp => new Date(Date.parse(now) + seconds * 1000).toISOString();

export async function waitForTask(service: ApplicationService, taskId: string, states: readonly TaskState[], timeoutMs = 3000): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await service.call('task.show', { taskId });
    if (states.includes(view.state)) return view;
    if (Date.now() > deadline) throw new Error(`task ${taskId} is ${view.state}, waited for ${states.join('|')}; timeline: ${view.timeline.map((t) => t.label).join(' > ')}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function createAccept(service: ApplicationService, over: { operationId?: string; requestKey?: string; targetId?: string; expectedAccountRevision?: number } = {}): Promise<TaskView> {
  return service.call('task.create', {
    operationId: over.operationId ?? 'op_accept_1', type: 'accept_request', targetId: over.targetId ?? 'tgt_a',
    payload: { kind: 'accept_request', requestKey: over.requestKey ?? KEY }, expectedAccountRevision: over.expectedAccountRevision ?? 1,
  });
}

export async function createRead(service: ApplicationService, operationId = 'op_read_1'): Promise<TaskView> {
  return service.call('task.create', { operationId, type: 'read_requests', payload: { kind: 'read_requests' }, expectedAccountRevision: 1 });
}

/** The hash the UI must send back: `pendingContentHash` while waiting_approval (ports/src/ipc.ts); never one of its own. */
export function shownContentHash(view: TaskView): string {
  return view.pendingContentHash ?? view.approval?.contentHash ?? '';
}

/** Approve what task.show currently presents (revision + content hash), as the UI would. */
export async function approve(service: ApplicationService, taskId: string, now: () => Timestamp, over: { expiresAt?: Timestamp } = {}): Promise<BusinessApproval> {
  const shown = await service.call('task.show', { taskId });
  return service.call('task.approve', { taskId, approvalRevision: shown.revision, approvedContentHash: shownContentHash(shown), expiresAt: over.expiresAt ?? plusSeconds(now(), 600) });
}

/** create → wait for approval → approve → wait for a terminal state. */
export async function acceptToEnd(slice: Slice, over: { operationId?: string; expiresAt?: Timestamp } = {}): Promise<TaskView> {
  const { service } = slice.app;
  const created = await createAccept(service, { operationId: over.operationId });
  await waitForTask(service, created.taskId, ['waiting_approval']);
  await approve(service, created.taskId, slice.now, over.expiresAt ? { expiresAt: over.expiresAt } : {});
  return waitForTask(service, created.taskId, [...TERMINAL, 'waiting_user', 'blocked']);
}

export const indexOfCall = (slice: Slice, method: string, nth = 1): number => {
  let seen = 0;
  for (let i = 0; i < slice.driver.calls.length; i += 1) if (slice.driver.calls[i].method === method && (seen += 1) === nth) return i;
  return -1;
};
