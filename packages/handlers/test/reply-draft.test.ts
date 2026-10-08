import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXED_DRAFT_TEXT, manualDraft } from '../src/index.ts';
import { acts, facts, harness, LI, r, text } from './helpers.ts';

const bubble = (side: 'self' | 'other', t: string, y: number) => ({ side, text: t, rect: r(400, y, 300, 40), anchorKey: `${y}:${t}`, confidence: 0.9 });
const chat = facts({ page: 'chat', texts: [text('李三', r(400, 10, 100, 30))], bubbles: [bubble('other', '在吗', 100), bubble('self', '在的', 160), bubble('other', '明天有空吗', 220)], inputBox: { rect: r(400, 800, 800, 80), text: '', empty: true, confidence: 0.9 } });
const task = (source: 'manual' | 'model') => ({ type: 'reply_draft' as const, payload: { kind: 'reply_draft' as const, conversationTargetId: 'tgt_li', source } });
const policy = { allowlist: ['tgt_li'] };
const resolveTarget = async (id: string) => (id === 'tgt_li' ? LI : undefined);

test('a manual draft is written to the ledger verbatim and nothing is typed into WeChat', async () => {
  const h = await harness({ task: task('manual'), facts: [chat], policy, handlers: { resolveTarget, drafts: { manual: manualDraft('好的，明天下午三点见。') } } });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed', result.reason);
  assert.equal(acts(h.driver).length, 0);
  const fact = result.facts[0];
  assert.equal(fact.factKind, 'manual_conclusion');
  const data = fact.data as { kind: string; text: string; source: string; visibleMessages: number; contextRevision: number };
  assert.equal(data.kind, 'reply_draft');
  assert.equal(data.text, '好的，明天下午三点见。');
  assert.equal(data.source, 'manual');
  assert.equal(data.visibleMessages, 3);
  assert.equal(typeof data.contextRevision, 'number');
});

test('without a manual text the task waits for the person', async () => {
  const h = await harness({ task: task('manual'), facts: [chat], policy, handlers: { resolveTarget } });
  const result = await h.run();
  assert.equal(result.outcome, 'waiting_user');
  assert.equal(acts(h.driver).length, 0);
});

test('the default model provider answers a fixed text and needs no upload', async () => {
  const h = await harness({ task: task('model'), facts: [chat], policy: { ...policy, modelUpload: false }, handlers: { resolveTarget } });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed');
  assert.equal((result.facts[0].data as { text: string }).text, FIXED_DRAFT_TEXT);
  assert.equal(acts(h.driver).length, 0);
});

test('a real model provider is blocked while modelUpload is off', async () => {
  const h = await harness({ task: task('model'), facts: [chat], policy: { ...policy, modelUpload: false }, handlers: { resolveTarget, drafts: { model: { async draft() { return { text: 'x', model: 'remote' }; } } } } });
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'policy_disabled');
});

test('a conversation off the allow-list, an unresolved target or another open chat is never drafted', async () => {
  const off = await harness({ task: task('manual'), facts: [chat], handlers: { resolveTarget, drafts: { manual: manualDraft('x') } } });
  assert.equal((await off.run()).reasonCode, 'policy_disabled');
  const unresolved = await harness({ task: task('manual'), facts: [chat], policy, handlers: { drafts: { manual: manualDraft('x') } } });
  assert.equal((await unresolved.run()).reasonCode, 'identity_unproven');
  const other = await harness({ task: task('manual'), facts: [facts({ ...chat, texts: [text('王二')] })], policy, handlers: { resolveTarget, drafts: { manual: manualDraft('x') } } });
  const ro = await other.run();
  assert.equal(ro.outcome, 'ambiguous');
  assert.equal(ro.reasonCode, 'target_ambiguous');
  for (const h of [off, unresolved, other]) assert.equal(h.ledger.facts.length, 0);
});
