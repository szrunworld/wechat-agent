// Getting WeChat to 通讯录 → 新的朋友 with observe → act → observe, never a
// blind click sequence. Shared by ReadRequests and AcceptRequest.

import type { PageFacts } from '@wechat-agent/ports';
import { ERROR_TEXT, type Flow, type Scene } from './steps.ts';
import { anyText, center, findButton, findText } from './text.ts';

const MAX_HOPS = 3;

export function isDialog(facts: PageFacts): boolean {
  return facts.page === 'dialog';
}

/** Stops the flow on any dialog that is not ours to dismiss. */
export function stopOnDialog(flow: Flow, scene: Scene): void {
  if (!isDialog(scene.facts)) return;
  const texts = scene.facts.texts.map((t) => t.text).join(' ');
  if (anyText(scene.facts, /频繁/)) flow.halt(flow.dangerDispatched ? 'needs_reconciliation' : 'failed', 'rate_limited', `WeChat says: ${texts}`);
  flow.halt(flow.dangerDispatched ? 'needs_reconciliation' : 'failed', 'unexpected_dialog', `unexpected dialog: ${texts}`);
}

/** Observes until the 新的朋友 list is on screen, clicking 通讯录 / 新的朋友 as needed. Read-only apart from navigation clicks. */
export async function openNewFriends(flow: Flow, first?: Scene): Promise<Scene> {
  let scene = first ?? await flow.observe();
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    stopOnDialog(flow, scene);
    if (scene.facts.page === 'new_friends') return scene;
    if (scene.facts.page === 'contacts') {
      const header = findButton(scene.facts, ['新的朋友']) ?? findText(scene.facts, /^新的朋友$/);
      if (!header) flow.halt('blocked', 'layout_unreadable', 'contacts page shows no 新的朋友 entry');
      await flow.act(`navigate:new_friends:${hop}`, { kind: 'click', target: { imagePoint: center(header.rect) } }, scene);
    } else {
      const contacts = findButton(scene.facts, ['通讯录']);
      if (!contacts) flow.halt('blocked', 'layout_unreadable', `page ${scene.facts.page} shows no 通讯录 control`);
      await flow.act(`navigate:contacts:${hop}`, { kind: 'click', target: { imagePoint: center(contacts.rect) } }, scene);
    }
    await flow.settle();
    scene = await flow.observe();
  }
  stopOnDialog(flow, scene);
  flow.halt('failed', undefined, `could not reach 新的朋友 in ${MAX_HOPS} steps; last page ${scene.facts.page}`);
}

export function errorTextOf(facts: PageFacts): string | undefined {
  const hit = facts.texts.find((t) => ERROR_TEXT.test(t.text));
  return hit?.text;
}
