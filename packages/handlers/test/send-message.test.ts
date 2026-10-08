import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bubble, PageFacts } from '@wechat-agent/ports';
import { contextRevisionOf } from '../src/index.ts';
import { acts, attemptsFor, facts, harness, LI, r, text } from './helpers.ts';

const bubble = (side: 'self' | 'other', t: string, y: number): Bubble => ({ side, text: t, rect: r(400, y, 300, 40), anchorKey: `${y}:${t}`, confidence: 0.9 });
const BASE = [bubble('other', '在吗', 100), bubble('self', '在的', 160), bubble('other', '明天有空吗', 220)];
const CONTENT = '好的 👋\n明天见';
const chat = (box = '', bubbles: Bubble[] = BASE, over: Partial<PageFacts> = {}) => facts({
  page: 'chat', texts: [text('李三', r(400, 10, 100, 30))], bubbles, inputBox: { rect: r(400, 800, 800, 80), text: box, empty: box === '', confidence: 0.9 }, ...over,
});
const task = (content = CONTENT) => ({
  type: 'send_message' as const,
  payload: { kind: 'send_message' as const, conversationTargetId: 'tgt_li', content, contentHash: 'hash_1', contextRevision: contextRevisionOf(BASE) },
});
const policy = { allowlist: ['tgt_li'] };
const resolveTarget = async (id: string) => (id === 'tgt_li' ? LI : undefined);
const handlers = { resolveTarget };

test('send: approval → re-observe → empty box → type (newline via shift+return) → read back → return → new self bubble', async () => {
  const h = await harness({ task: task(), facts: [chat(), chat(), chat(CONTENT), chat('', [...BASE, bubble('self', CONTENT, 300)])], policy, handlers });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed', result.reason);
  const sent = acts(h.driver);
  assert.deepEqual(sent.map((a) => [a.action.kind, a.action.text ?? a.action.key, a.action.modifiers ?? null]), [
    ['type', '好的 👋', null], ['key', 'return', ['shift']], ['type', '明天见', null], ['key', 'return', null],
  ]);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].summary.contentPreview, CONTENT);
  assert.equal(h.approvals[0].summary.targetLabel, '李三');
  assert.ok(h.granted[0].consumedAt);
  assert.equal(attemptsFor(h.ledger, 'send')[0].state, 'verified');
  assert.ok(result.facts.some((f) => f.factKind === 'message_sent' && f.outcome === 'confirmed'));
});

test('T23: a draft already in the input box → waiting_user user_draft_present, nothing typed', async () => {
  const h = await harness({ task: task(), facts: [chat(), chat('我先写一半')], policy, handlers });
  const result = await h.run();
  assert.equal(result.outcome, 'waiting_user');
  assert.equal(result.reasonCode, 'user_draft_present');
  assert.equal(acts(h.driver).length, 0);
  assert.equal(h.granted[0].consumedAt, undefined);
});

test('T24: the read-back drops the emoji → content_mismatch, no return key, the text is left for the person', async () => {
  const h = await harness({ task: task(), facts: [chat(), chat(), chat('好的 \n明天见')], policy, handlers });
  const result = await h.run();
  assert.equal(result.outcome, 'waiting_user');
  assert.equal(result.reasonCode, 'content_mismatch');
  const sent = acts(h.driver);
  assert.equal(sent.length, 3);
  assert.ok(!sent.some((a) => a.action.kind === 'key' && a.action.key === 'return' && !a.action.modifiers), 'no bare return');
  assert.equal(attemptsFor(h.ledger, 'send').length, 0);
  assert.ok(result.facts.some((f) => f.factKind === 'input_mismatch'));
  assert.equal(h.granted[0].consumedAt, undefined);
});

test('T24: a newline read back as a space is also a mismatch', async () => {
  const h = await harness({ task: task(), facts: [chat(), chat(), chat('好的 👋 明天见')], policy, handlers });
  const result = await h.run();
  assert.equal(result.reasonCode, 'content_mismatch');
  assert.equal(attemptsFor(h.ledger, 'send').length, 0);
});

test('T27: the box is empty but no new bubble appears → sent_unconfirmed, attempt unknown', async () => {
  const h = await harness({ task: task(), facts: [chat(), chat(), chat(CONTENT), chat('')], policy, handlers });
  const result = await h.run();
  assert.equal(result.outcome, 'sent_unconfirmed');
  assert.equal(result.reasonCode, 'verification_missing');
  assert.equal(attemptsFor(h.ledger, 'send')[0].state, 'unknown');
  assert.equal(acts(h.driver).length, 4);
  assert.ok(!result.facts.some((f) => f.factKind === 'message_sent'));
});

test('an old bubble with the same text does not count as the sent one', async () => {
  const old = [...BASE, bubble('self', CONTENT, 260)];
  const h = await harness({ task: { ...task(), payload: { ...task().payload, contextRevision: contextRevisionOf(old) } }, facts: [chat('', old), chat('', old), chat(CONTENT, old), chat('', old)], policy, handlers });
  const result = await h.run();
  assert.equal(result.outcome, 'sent_unconfirmed');
});

test('T28: a new inbound bubble since the draft → approval_invalid, re-approval, nothing typed', async () => {
  const h = await harness({ task: task(), facts: [chat(), chat('', [...BASE, bubble('other', '你在吗？', 280)])], policy, handlers });
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'approval_invalid');
  assert.match(result.reason ?? '', /approve again/);
  assert.equal(acts(h.driver).length, 0);
  assert.equal(h.granted[0].consumedAt, undefined);
});

test('T28: a new inbound bubble while typing → our own text is cleared (same window, same account, same text) and re-approval is asked', async () => {
  const arrived = [...BASE, bubble('other', '你在吗？', 280)];
  const h = await harness({ task: task(), facts: [chat(), chat(), chat(CONTENT, arrived), chat('', arrived)], policy, handlers });
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'approval_invalid');
  assert.match(result.reason ?? '', /cleared/);
  const sent = acts(h.driver);
  assert.deepEqual(sent.slice(3).map((a) => [a.action.key, a.action.modifiers ?? null]), [['a', ['cmd']], ['delete', null]]);
  assert.equal(attemptsFor(h.ledger, 'send').length, 0);
});

test('a dropped connection on the return key → attempt unknown → needs_reconciliation, same requestId never re-sent', async () => {
  const h = await harness({
    task: task(), facts: [chat(), chat(), chat(CONTENT), chat('', [...BASE, bubble('self', CONTENT, 300)])], policy, handlers,
    driver: { faults: [{ method: 'act', onCall: 4, error: { code: 'connection_lost', phase: 'transport', retryable: false, notSent: false }, disconnect: true }] },
  });
  const result = await h.run();
  assert.equal(result.outcome, 'needs_reconciliation');
  const sent = acts(h.driver);
  assert.equal(sent.length, 4);
  const send = attemptsFor(h.ledger, 'send');
  assert.equal(send.length, 1);
  assert.equal(send[0].state, 'unknown');
  assert.equal(send[0].requestId, sent[3].requestId);
});

test('an unknown delivery receipt is reconciliation, not success', async () => {
  const h = await harness({ task: task(), facts: [chat(), chat(), chat(CONTENT)], policy, handlers, driver: { receipt: { delivery: 'unknown', execution: 'unknown' } } });
  const result = await h.run();
  assert.equal(result.outcome, 'needs_reconciliation');
  assert.equal(result.reasonCode, 'platform_unknown');
});

test('the context revision ignores our own bubbles and scroll-stable texts but sees a new inbound one', () => {
  const base = contextRevisionOf(BASE);
  assert.equal(contextRevisionOf([...BASE, bubble('self', '好的', 300)]), base);
  assert.equal(contextRevisionOf(BASE.map((b) => ({ ...b, rect: r(400, b.rect.y + 50), anchorKey: `${b.rect.y + 50}:${b.text}` }))), base);
  assert.notEqual(contextRevisionOf([...BASE, bubble('other', '？', 300)]), base);
});

test('a conversation off the allow-list or another open chat is never typed into', async () => {
  const off = await harness({ task: task(), facts: [chat()], handlers });
  assert.equal((await off.run()).reasonCode, 'policy_disabled');
  const other = await harness({ task: task(), facts: [chat('', BASE, { texts: [text('王二')] })], policy, handlers });
  assert.equal((await other.run()).reasonCode, 'target_ambiguous');
  for (const h of [off, other]) { assert.equal(acts(h.driver).length, 0); assert.equal(h.approvals.length, 0); }
});
