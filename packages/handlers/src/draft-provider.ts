// Where a reply draft's text comes from. The handler never types a draft into
// WeChat; it only writes the text to the ledger for a person to review.

import type { Bubble, Id, Policy } from '@wechat-agent/ports';

export interface DraftInput {
  taskId: Id;
  conversationTargetId: Id;
  targetLabel?: string;
  /** Visible bubbles, oldest first. */
  messages: Bubble[];
  evidenceIds: Id[];
  policy: Policy;
}

export interface Draft {
  text: string;
  /** Which model produced it, when one did. */
  model?: string;
}

export interface DraftProvider {
  draft(input: DraftInput): Promise<Draft | undefined>;
}

export interface DraftProviders {
  /** `source: 'manual'`: the person's own text, verbatim. Absent → the task waits for the person. */
  manual?: DraftProvider;
  /** `source: 'model'`: a generated suggestion. The default returns a fixed text and never uploads anything. */
  model?: DraftProvider;
}

export const FIXED_DRAFT_TEXT = '收到，稍后回复您。';

/** A provider that answers the same fixed text; no network, no model. */
export const fixedDraftProvider: DraftProvider = {
  async draft() {
    return { text: FIXED_DRAFT_TEXT, model: 'fixed' };
  },
};

/** A manual provider over a text the person already wrote. */
export function manualDraft(text: string): DraftProvider {
  return { async draft() { return { text }; } };
}
