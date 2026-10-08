import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acts, button, clickPoints, facts, harness, mid, r, text } from './helpers.ts';

const row = (name: string, status: 'pending' | 'added', y: number) => ({ name, note: `我是${name}`, status, rect: r(40, y, 300, 60), confidence: 0.9, rowKey: `${name}|我是${name}` });
const task = { type: 'read_requests' as const, payload: { kind: 'read_requests' as const } };

test('ReadRequests walks 通讯录 → 新的朋友 with observe between clicks and writes a list_read fact', async () => {
  const contacts = button('通讯录', r(20, 120, 60, 60));
  const header = button('新的朋友', r(40, 100, 200, 40));
  const h = await harness({
    task,
    facts: [
      facts({ page: 'chats', buttons: [contacts] }),
      facts({ page: 'contacts', buttons: [header] }),
      facts({ page: 'new_friends', coverage: 'end_confirmed', requests: [row('陈一', 'pending', 200), row('周四', 'added', 260)] }),
    ],
  });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed');
  assert.deepEqual(clickPoints(h.driver), [mid(contacts.rect), mid(header.rect)]);
  assert.equal(h.driver.countCalls('observe'), 3);
  const fact = result.facts.find((f) => f.factKind === 'list_read');
  assert.ok(fact);
  const data = fact.data as { complete: boolean; rows: { rowKey: string; status: string; confidence: number }[] };
  assert.equal(data.complete, true);
  assert.deepEqual(data.rows.map((x) => [x.rowKey, x.status, x.confidence]), [['陈一|我是陈一', 'pending', 0.9], ['周四|我是周四', 'added', 0.9]]);
  assert.equal(result.evidenceIds.length, 3);
  for (const id of result.evidenceIds) assert.ok(await h.ledger.getEvidence(id));
});

test('zero rows in the viewport is not "all handled" unless the end is confirmed', async () => {
  const h = await harness({ task, facts: [facts({ page: 'new_friends', requests: [] })] });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed');
  assert.match(result.reason ?? '', /not confirmed/);
  assert.equal((result.facts[0].data as { complete: boolean }).complete, false);
  assert.equal(acts(h.driver).length, 0);
});

test('partial coverage is reported as coverage_partial', async () => {
  const h = await harness({ task, facts: [facts({ page: 'new_friends', coverage: 'partial', requests: [row('陈一', 'pending', 200)] })] });
  const result = await h.run();
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.reasonCode, 'coverage_partial');
});

test('a dialog stops navigation without clicking anything', async () => {
  const h = await harness({ task, facts: [facts({ page: 'dialog', texts: [text('操作失败')], buttons: [button('确定', r(500, 500))] })] });
  const result = await h.run();
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reasonCode, 'unexpected_dialog');
  assert.equal(acts(h.driver).length, 0);
});

test('an inapplicable layout or an unreadable capture blocks with layout_unreadable', async () => {
  const a = await harness({ task, facts: [facts({ page: 'new_friends' })], applicable: false });
  const ra = await a.run();
  assert.equal(ra.outcome, 'blocked');
  assert.equal(ra.reasonCode, 'layout_unreadable');
  assert.equal(a.recognizer.reads.length, 0);
  const b = await harness({ task, facts: [facts({ page: 'unknown', coverage: 'unreadable', warnings: ['ocr failed'] })] });
  const rb = await b.run();
  assert.equal(rb.outcome, 'blocked');
  assert.equal(rb.reasonCode, 'layout_unreadable');
  assert.equal(rb.evidenceIds.length, 1, 'the unreadable capture is still kept as evidence');
  assert.equal(acts(b.driver).length, 0);
});

test('no 通讯录 control on an unknown page blocks instead of guessing a click', async () => {
  const h = await harness({ task, facts: [facts({ page: 'unknown' })] });
  const result = await h.run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reasonCode, 'layout_unreadable');
  assert.equal(acts(h.driver).length, 0);
});
