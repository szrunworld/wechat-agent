// Every screen renders in every sample state without throwing, and no screen
// ever offers a "send again" control.
import { screen } from '@testing-library/react';
import { sampleSnapshots, type SnapshotKey } from '@wechat-agent/ports/fakes';
import { describe, expect, it } from 'vitest';
import { SCREENS } from '../src/screens/index.ts';
import { RESEND, mount } from './helpers.tsx';

const states = Object.keys(sampleSnapshots) as SnapshotKey[];

describe('six screens × thirteen states', () => {
  expect(states).toHaveLength(13);
  for (const s of SCREENS) {
    for (const state of states) {
      it(`${s.key} renders in ${state}`, async () => {
        const { container } = await mount(state, s.key);
        expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(s.key);
        const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
        expect(buttons.filter((t) => RESEND.test(t))).toEqual([]);
        // The identity text is never clipped by CSS truncation.
        for (const el of container.querySelectorAll('.identity')) expect(el.className).not.toMatch(/truncate|ellipsis/);
      });
    }
  }
});

describe('state copy is distinct', () => {
  it('stopping, quiescence_unconfirmed, unknown, platform_offline, ambiguous, approval_expired, coverage_partial each have their own wording', async () => {
    const texts = new Map<SnapshotKey, string>();
    const probes: [SnapshotKey, import('../src/screens/index.ts').ScreenKey, RegExp][] = [
      ['stopping', 'W02', /正在停止/],
      ['quiescence_unconfirmed', 'W02', /静止未确认/],
      ['unknown_result', 'W05', /结果未知/],
      ['platform_offline', 'W01', /平台离线/],
      ['ambiguous_identity', 'W03', /身份歧义/],
      ['approval_expired', 'W03', /过期/],
      ['coverage_partial', 'W02', /覆盖部分/],
    ];
    for (const [state, screenKey, re] of probes) {
      const { container, unmount } = await mount(state, screenKey);
      const text = container.textContent ?? '';
      expect(text, `${state} on ${screenKey}`).toMatch(re);
      texts.set(state, text);
      unmount();
    }
    expect(new Set(texts.values()).size).toBe(probes.length);
  });
});
