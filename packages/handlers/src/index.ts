// Lane D: one handler per task type over the three ports. See docs/lanes/lane-d.md.
import type { Handler, HandlerRegistry, TaskType } from '@wechat-agent/ports';
import { createAcceptRequestHandler } from './accept-request.ts';
import { createAddFriendHandler } from './add-friend.ts';
import type { DraftProviders } from './draft-provider.ts';
import { createReadRequestsHandler } from './read-requests.ts';
import { createReplyDraftHandler, type ConversationOptions } from './reply-draft.ts';
import { createSendMessageHandler } from './send-message.ts';
import { DEFAULT_FLOW_OPTIONS, type FlowOptions } from './steps.ts';

export interface HandlersOptions extends Partial<FlowOptions>, ConversationOptions {
  drafts?: DraftProviders;
}

export function createHandlers(options: HandlersOptions = {}): HandlerRegistry {
  const flow: FlowOptions = { ...DEFAULT_FLOW_OPTIONS, settle: options.settle ?? DEFAULT_FLOW_OPTIONS.settle, evidenceRetentionDays: options.evidenceRetentionDays ?? DEFAULT_FLOW_OPTIONS.evidenceRetentionDays };
  const conversation: ConversationOptions = { resolveTarget: options.resolveTarget };
  const handlers: Handler[] = [
    createReadRequestsHandler(flow),
    createAcceptRequestHandler(flow),
    createAddFriendHandler(flow),
    createReplyDraftHandler(flow, options.drafts ?? {}, conversation),
    createSendMessageHandler(flow, conversation),
  ];
  const byType = new Map<TaskType, Handler>(handlers.map((h) => [h.type, h]));
  return {
    get<T extends TaskType>(type: T): Handler<T> | undefined {
      return byType.get(type) as Handler<T> | undefined;
    },
    all(): Handler[] {
      return [...handlers];
    },
  };
}

export type { DraftProvider, DraftProviders, DraftInput, Draft } from './draft-provider.ts';
export { fixedDraftProvider, manualDraft, FIXED_DRAFT_TEXT } from './draft-provider.ts';
export type { ConversationOptions, TargetResolver } from './reply-draft.ts';
export type { FlowOptions } from './steps.ts';
export { contextRevisionOf, normText, sameContent } from './text.ts';
