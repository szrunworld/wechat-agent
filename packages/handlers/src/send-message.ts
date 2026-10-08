// SendMessage: approval → re-observe → empty input box → same conversation
// context → type → read back exactly → one return key → a new self bubble
// with the text confirms. Anything less is sent_unconfirmed or waiting_user.

import type { ApprovalRequest, Bubble, DomainResult, Handler, HandlerContext, WeChatTask } from '@wechat-agent/ports';
import { stopOnDialog } from './navigate.ts';
import { requireOpenChat, type ConversationOptions } from './reply-draft.ts';
import { Flow, type ActOutcome, type ApprovalExpectation, type FlowOptions, type Scene } from './steps.ts';
import { contextRevisionOf, normText, sameContent } from './text.ts';

const VERIFY_ROUNDS = 3;

export function createSendMessageHandler(options: FlowOptions, conversation: ConversationOptions): Handler<'send_message'> {
  return {
    type: 'send_message',
    requires: { methods: ['observe', 'act', 'artifact.read'], actions: ['send_message', 'read'] },
    run(task: WeChatTask & { type: 'send_message' }, ctx: HandlerContext): Promise<DomainResult> {
      return Flow.run(ctx, task, options, async (flow) => sendMessage(flow, task, conversation));
    },
  };
}

async function sendMessage(flow: Flow, task: WeChatTask & { type: 'send_message' }, conversation: ConversationOptions): Promise<DomainResult> {
  const payload = task.payload;
  if (payload.kind !== 'send_message') flow.halt('failed', undefined, 'payload is not a send_message');
  const content = normText(payload.content);
  if (!content) flow.halt('failed', 'content_mismatch', 'empty message');

  // 1. identity, then approval over the exact content
  const first = await flow.observe();
  const target = await requireOpenChat(flow, payload.conversationTargetId, conversation, first);
  const expectation: ApprovalExpectation = { action: 'send_message', contentHash: payload.contentHash, targetRevision: task.targetRevision ?? target.revision };
  const request: ApprovalRequest = {
    taskId: task.taskId, allowedAction: 'send_message', accountRevision: flow.ctx.account.revision, targetRevision: expectation.targetRevision,
    draftRevision: task.revision, contentHash: payload.contentHash,
    summary: { targetLabel: target.displayName, visibleIdentifier: target.visibleIdentifier, contentPreview: content, evidenceIds: [first.evidenceId], identityConfidence: target.confidence },
  };
  flow.checkSignal();
  const decision = await flow.ctx.requestApproval(request);
  if (decision.kind === 'rejected') return flow.result('no_op', undefined, 'the person rejected the message');
  if (decision.kind === 'skipped') return flow.result('no_op', undefined, 'the person skipped the message');
  if (decision.kind === 'cancelled') return flow.result('no_op', 'cancelled', 'approval cancelled');
  const approval = decision.approval;

  // 2. re-observe and verify before anything is typed
  const scene = await flow.observe();
  await requireOpenChat(flow, payload.conversationTargetId, conversation, scene);
  flow.requireSameWindow(scene);
  flow.requireApprovalValid(approval, expectation);
  const box = scene.facts.inputBox;
  if (!box) flow.halt('blocked', 'layout_unreadable', 'the input box could not be located');
  if (!box.empty || normText(box.text)) flow.halt('waiting_user', 'user_draft_present', 'the input box already holds text; not touching it');
  const nowRevision = contextRevisionOf(scene.facts.bubbles);
  if (nowRevision !== payload.contextRevision) {
    flow.halt('blocked', 'approval_invalid', `the conversation changed since the draft (context ${payload.contextRevision} → ${nowRevision}); approve again over the new messages`);
  }
  const before = new Set((scene.facts.bubbles ?? []).map((b) => b.anchorKey));

  // 3. type, then read back exactly (Chinese, emoji and newlines included)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await flow.act(`newline:${i}`, { kind: 'key', key: 'return', modifiers: ['shift'] }, scene);
    if (lines[i]) await flow.act(`type:${i}`, { kind: 'type', text: lines[i] }, scene);
  }
  await flow.settle();
  const typed = await flow.observe();
  stopOnDialog(flow, typed);
  const readBack = typed.facts.inputBox;
  if (!readBack || !sameContent(content, readBack.text)) {
    await flow.fact('input_mismatch', 'observed', { expected: content, readBack: readBack?.text ?? null }, { evidenceIds: [typed.evidenceId], confidence: readBack?.confidence ?? 0 });
    return flow.result('waiting_user', 'content_mismatch', `the input box reads "${readBack?.text ?? ''}", not the approved text; nothing sent`);
  }
  flow.requireSameWindow(typed);
  if (contextRevisionOf(typed.facts.bubbles) !== payload.contextRevision) {
    return cleanupOwnInput(flow, typed, content, flow.result('blocked', 'approval_invalid', 'a new message arrived while typing; approve again'));
  }

  // 4. the one dangerous act
  await flow.consumeApproval(approval, expectation);
  const send = await flow.act('send', { kind: 'key', key: 'return' }, typed, true);

  // 5. business verification: a new self bubble with the text
  return verifySent(flow, send, content, before, target.displayName);
}

async function verifySent(flow: Flow, send: ActOutcome, content: string, before: Set<string>, label: string): Promise<DomainResult> {
  for (let round = 0; round < VERIFY_ROUNDS; round++) {
    await flow.settle();
    const after = await flow.observe();
    const fresh = (after.facts.bubbles ?? []).filter((b) => b.side === 'self' && !before.has(b.anchorKey));
    const match = fresh.find((b: Bubble) => sameContent(content, b.text));
    if (match) {
      await flow.settleAttempt(send, 'verified', 'bubble appeared');
      await flow.fact('message_sent', 'confirmed', { targetLabel: label, text: content, anchorKey: match.anchorKey }, { evidenceIds: [after.evidenceId], confidence: match.confidence });
      return flow.result('confirmed', undefined, `message to ${label} appeared as a new bubble`);
    }
    const box = after.facts.inputBox;
    if (box && !box.empty && sameContent(content, box.text)) {
      // The text is still in the box: the return key may not have been taken, or the send is in flight.
      continue;
    }
  }
  await flow.settleAttempt(send, 'unknown', 'no new self bubble with the text');
  return flow.result('sent_unconfirmed', 'verification_missing', `the input box is empty but no new bubble with the text appeared for ${label}`);
}

/** Rule 7: only text this task just typed, in the same window and account, is cleared; otherwise the scene is left for the person. */
async function cleanupOwnInput(flow: Flow, scene: Scene, typed: string, result: DomainResult): Promise<DomainResult> {
  const box = scene.facts.inputBox;
  if (!box || !sameContent(typed, box.text) || !flow.sameWindow(scene) || flow.ctx.account.status !== 'confirmed' || flow.ctx.account.revision !== flow.task.accountRevision) {
    return { ...flow.result('waiting_user', result.reasonCode, `${result.reason ?? ''}; the input box is left as is`.trim()) };
  }
  await flow.act('cleanup:select', { kind: 'key', key: 'a', modifiers: ['cmd'] }, scene);
  await flow.act('cleanup:delete', { kind: 'key', key: 'delete' }, scene);
  await flow.settle();
  const after = await flow.observe();
  if (!after.facts.inputBox?.empty) return flow.result('waiting_user', result.reasonCode, `${result.reason ?? ''}; the input box still holds text`.trim());
  return { ...result, facts: [...flow.facts], evidenceIds: [...flow.evidenceIds], reason: `${result.reason ?? ''}; our text was cleared`.trim() };
}
