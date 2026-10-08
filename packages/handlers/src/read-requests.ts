// ReadRequests: 通讯录 → 新的朋友, read-only. Produces a list_read fact with
// the coverage and every row's key/status/confidence. Zero rows never means
// "all handled": only end_confirmed says the list ended.

import type { DomainResult, Handler, HandlerContext, WeChatTask } from '@wechat-agent/ports';
import { openNewFriends } from './navigate.ts';
import { Flow, type FlowOptions } from './steps.ts';

export function createReadRequestsHandler(options: FlowOptions): Handler<'read_requests'> {
  return {
    type: 'read_requests',
    requires: { methods: ['observe', 'act', 'artifact.read'], actions: ['read', 'navigate'] },
    run(task: WeChatTask & { type: 'read_requests' }, ctx: HandlerContext): Promise<DomainResult> {
      return Flow.run(ctx, task, options, async (flow) => readRequests(flow));
    },
  };
}

export async function readRequests(flow: Flow): Promise<DomainResult> {
  const scene = await openNewFriends(flow);
  const rows = scene.facts.requests ?? [];
  const coverage = scene.facts.coverage;
  const complete = coverage === 'end_confirmed';
  await flow.fact('list_read', 'observed', {
    page: scene.facts.page, coverage, complete, rowCount: rows.length,
    rows: rows.map((r) => ({ rowKey: r.rowKey, name: r.name, status: r.status, confidence: r.confidence, hasAction: Boolean(r.actionRect) })),
    warnings: scene.facts.warnings,
  }, { evidenceIds: [scene.evidenceId], confidence: scene.facts.confidence });
  if (coverage === 'partial') return flow.result('confirmed', 'coverage_partial', `read ${rows.length} row(s); the list continues beyond the viewport`);
  if (rows.length === 0 && !complete) return flow.result('confirmed', undefined, 'no rows in the current viewport; the end of the list was not confirmed');
  return flow.result('confirmed', undefined, `read ${rows.length} row(s)${complete ? ', end confirmed' : ''}`);
}
