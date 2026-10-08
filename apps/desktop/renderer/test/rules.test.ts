import { sampleSnapshots } from '@wechat-agent/ports/fakes';
import { describe, expect, it } from 'vitest';
import { canApproveAccept, canApproveContent, canConcludeManually, canPause, canReconcile, canResume, canConfirmAccount } from '../src/rules.ts';

describe('approval rules', () => {
  it('approves an accept_request only when identity is confident and the feature is enabled', () => {
    const s = sampleSnapshots.waiting_approval;
    expect(canApproveAccept(s, s.activeTask).ok).toBe(true);
    const ambiguous = sampleSnapshots.ambiguous_identity;
    const d = canApproveAccept(ambiguous, ambiguous.activeTask);
    expect(d.ok).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/置信度|身份歧义/);
    const off = { ...s, features: { ...s.features, accept_request: { enabled: false as const, reason: 'policy_disabled' as const } } };
    expect(canApproveAccept(off, s.activeTask).ok).toBe(false);
  });
  it('stopping and quiescence_unconfirmed block every outbound approval', () => {
    for (const key of ['stopping', 'quiescence_unconfirmed'] as const) {
      const s = sampleSnapshots[key];
      expect(canApproveAccept(s, { ...s.activeTask!, state: 'waiting_approval' }).ok).toBe(false);
    }
  });
  it('content approval needs a saved, non-empty draft and an unambiguous target', () => {
    const s = sampleSnapshots.waiting_approval;
    const msg = s.tasks.find((t) => t.type === 'send_message')!;
    expect(canApproveContent(s, msg, false).ok).toBe(true);
    expect(canApproveContent(s, msg, true).reasons).toContain('草稿有未保存的修改，先保存再批准');
    expect(canApproveContent(s, { ...msg, target: { ...msg.target!, confidence: 0.4 } }, false).ok).toBe(false);
    expect(canApproveContent(s, { ...msg, draft: { text: ' ', revision: 1, source: 'manual' } }, false).ok).toBe(false);
  });
});

describe('workbench rules', () => {
  it('pause only when open; resume only when closed and ready', () => {
    expect(canPause(sampleSnapshots.ready_idle).ok).toBe(true);
    expect(canPause(sampleSnapshots.stopping).ok).toBe(false);
    expect(canResume(sampleSnapshots.stopping).ok).toBe(false);
    expect(canResume(sampleSnapshots.quiescence_unconfirmed).ok).toBe(false);
    expect(canResume(sampleSnapshots.platform_offline).ok).toBe(false);
    expect(canResume({ ...sampleSnapshots.ready_idle, inputGate: 'closed' }).ok).toBe(true);
  });
  it('account confirm only for an unconfirmed account on a ready platform', () => {
    expect(canConfirmAccount(sampleSnapshots.account_unconfirmed).ok).toBe(true);
    expect(canConfirmAccount(sampleSnapshots.ready_idle).ok).toBe(false);
    expect(canConfirmAccount(sampleSnapshots.unpaired).ok).toBe(false);
  });
});

describe('reconciliation rules', () => {
  it('unknown results can only be reconciled or concluded by hand', () => {
    const s = sampleSnapshots.unknown_result;
    expect(canReconcile(s, s.activeTask).ok).toBe(true);
    expect(canConcludeManually(s.activeTask, '').ok).toBe(false);
    expect(canConcludeManually(s.activeTask, '对方已在通讯录').ok).toBe(true);
    expect(canReconcile(sampleSnapshots.ready_idle, sampleSnapshots.waiting_approval.activeTask).ok).toBe(false);
  });
});
