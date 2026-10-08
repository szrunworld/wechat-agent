// ReplyDraft: for an allow-listed single chat that is open, read the visible
// messages and write a draft fact. It never types into WeChat.

import type { DomainResult, Handler, HandlerContext, TargetRef, WeChatTask } from '@wechat-agent/ports';
import { fixedDraftProvider, type DraftProviders } from './draft-provider.ts';
import { stopOnDialog } from './navigate.ts';
import { Flow, type FlowOptions, type Scene } from './steps.ts';
import { contextRevisionOf, normText, sameLabel, sha256 } from './text.ts';

export type TargetResolver = (targetId: string) => Promise<TargetRef | undefined>;

export interface ConversationOptions {
  /** How the app hands a handler the TargetRef behind a payload's conversationTargetId. */
  resolveTarget?: TargetResolver;
}

export function createReplyDraftHandler(options: FlowOptions, providers: DraftProviders, conversation: ConversationOptions): Handler<'reply_draft'> {
  return {
    type: 'reply_draft',
    requires: { methods: ['observe', 'artifact.read'], actions: ['read'] },
    run(task: WeChatTask & { type: 'reply_draft' }, ctx: HandlerContext): Promise<DomainResult> {
      return Flow.run(ctx, task, options, async (flow) => replyDraft(flow, task, providers, conversation));
    },
  };
}

/** The open chat must be the allow-listed target; a chat that does not show its name is not written to. */
export async function requireOpenChat(flow: Flow, targetId: string, conversation: ConversationOptions, scene: Scene): Promise<TargetRef> {
  if (!flow.ctx.policy.allowlist.includes(targetId)) flow.halt('blocked', 'policy_disabled', `conversation ${targetId} is not on the allow-list`);
  if (!conversation.resolveTarget) flow.halt('blocked', 'identity_unproven', 'no target resolver; the conversation identity cannot be checked');
  const target = await conversation.resolveTarget(targetId);
  if (!target) flow.halt('blocked', 'identity_unproven', `unknown target ${targetId}`);
  if (target.kind !== 'single') flow.halt('blocked', 'policy_disabled', `only single chats are handled, not ${target.kind}`);
  stopOnDialog(flow, scene);
  if (scene.facts.page !== 'chat') flow.halt('ambiguous', 'target_ambiguous', `no chat is open (page ${scene.facts.page})`);
  const shown = scene.facts.texts.some((t) => sameLabel(t.text, target.displayName));
  if (!shown) flow.halt('ambiguous', 'target_ambiguous', `the open chat does not show ${target.displayName}`);
  return target;
}

async function replyDraft(flow: Flow, task: WeChatTask & { type: 'reply_draft' }, providers: DraftProviders, conversation: ConversationOptions): Promise<DomainResult> {
  const payload = task.payload;
  if (payload.kind !== 'reply_draft') flow.halt('failed', undefined, 'payload is not a reply_draft');
  const scene = await flow.observe();
  const target = await requireOpenChat(flow, payload.conversationTargetId, conversation, scene);
  const bubbles = scene.facts.bubbles ?? [];
  const contextRevision = contextRevisionOf(bubbles);

  let provider = providers[payload.source];
  if (payload.source === 'model') {
    if (!flow.ctx.policy.modelUpload && provider && provider !== fixedDraftProvider) flow.halt('blocked', 'policy_disabled', 'model drafts are off in the policy');
    provider ??= fixedDraftProvider;
  }
  const draft = provider ? await provider.draft({ taskId: task.taskId, conversationTargetId: target.targetId, targetLabel: target.displayName, messages: bubbles, evidenceIds: [scene.evidenceId], policy: flow.ctx.policy }) : undefined;
  if (!draft || !normText(draft.text)) return flow.result('waiting_user', undefined, `no ${payload.source} draft text yet; the person writes it`);
  const text = normText(draft.text);
  // INTERFACE REQUEST: a FactKind for drafts; manual_conclusion is the nearest "for a person to act on".
  await flow.fact('manual_conclusion', 'observed', {
    kind: 'reply_draft', source: payload.source, model: draft.model, conversationTargetId: target.targetId, targetLabel: target.displayName,
    text, contentHash: sha256(text), contextRevision, visibleMessages: bubbles.length,
  }, { evidenceIds: [scene.evidenceId], confidence: scene.facts.confidence });
  return flow.result('confirmed', undefined, `draft written for ${target.displayName}; nothing typed into WeChat`);
}
