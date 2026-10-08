import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RESEND, button, mount } from './helpers.tsx';

describe('W03 好友审批', () => {
  it('approve is enabled in waiting_approval and calls task.approve with the task revision', async () => {
    const { fake } = await mount('waiting_approval', 'W03');
    const approve = button('批准接受');
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'task.approve')).toBe(true));
    const call = fake.calls.find((c) => c.method === 'task.approve')!.params as { taskId: string; approvalRevision: number; approvedContentHash: string; expiresAt: string };
    expect(call.taskId).toBe('task_1');
    expect(call.approvalRevision).toBe(3);
    expect(call.approvedContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(call.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
  it('approve is disabled with a stated reason when identity confidence is low', async () => {
    await mount('ambiguous_identity', 'W03');
    const approve = button('批准接受');
    expect(approve.disabled).toBe(true);
    const reasons = document.getElementById(approve.getAttribute('aria-describedby')!)!.textContent!;
    expect(reasons).toMatch(/置信度 41%/);
    expect(screen.getByText(/身份歧义，不能批准/)).toBeTruthy();
  });
  it('approve is disabled when the feature is off (stopping → input_gate_closed)', async () => {
    await mount('stopping', 'W03');
    expect(button('批准接受').disabled).toBe(true);
    expect(screen.getByText(/接受好友申请当前不可用/)).toBeTruthy();
  });
  it('expired approval is explained and a fresh approval is offered', async () => {
    await mount('approval_expired', 'W03');
    expect(screen.getByText(/上次的批准已过期/)).toBeTruthy();
    expect(button('批准接受').disabled).toBe(false);
  });
  it('skip calls task.skip with expectedRevision', async () => {
    const { fake } = await mount('waiting_approval', 'W03');
    fireEvent.click(button('先跳过'));
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'task.skip')?.params).toEqual({ taskId: 'task_1', expectedRevision: 3 }));
  });
});

describe('W04 加好友与回复编辑', () => {
  it('approving the final text is blocked while the editor differs from the saved draft', async () => {
    await mount('waiting_approval', 'W04');
    const approve = button(/批准最终正文/);
    expect(approve.disabled).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: /草稿正文/ }), { target: { value: '改过的正文' } });
    expect(button(/批准最终正文/).disabled).toBe(true);
    expect(button('保存草稿').disabled).toBe(false);
  });
  it('approving the final text hashes exactly the saved draft', async () => {
    const { fake } = await mount('waiting_approval', 'W04');
    fireEvent.click(button(/批准最终正文/));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'task.approve')).toBe(true));
    const p = fake.calls.find((c) => c.method === 'task.approve')!.params as { taskId: string; approvedContentHash: string };
    expect(p.taskId).toBe('task_2');
    expect(p.approvedContentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('add friend is disabled with the CR02 reason while the capability is missing', async () => {
    await mount('ready_idle', 'W04');
    const create = button(/创建加好友任务/);
    expect(create.disabled).toBe(true);
    expect(document.getElementById(create.getAttribute('aria-describedby')!)!.textContent).toMatch(/CR02/);
  });
});

describe('W02 工作台', () => {
  it('pause sends app.pause with the snapshot revision', async () => {
    const { fake } = await mount('ready_idle', 'W02');
    fireEvent.click(button(/暂停/));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'app.pause')).toBe(true));
    const p = fake.calls.find((c) => c.method === 'app.pause')!.params as { operationId: string; expectedRevision: number };
    expect(p.expectedRevision).toBe(1);
    expect(p.operationId).toMatch(/^pause:/);
  });
  it('stopping shows resume disabled and explains', async () => {
    await mount('stopping', 'W02');
    expect(button(/恢复/).disabled).toBe(true);
    expect(screen.getAllByText(/正在停止/).length).toBeGreaterThan(0);
  });
  it('handback is disabled with the CR03 reason and points at the manual guide', async () => {
    await mount('ready_idle', 'W02');
    expect(button(/我要接管微信窗口/).disabled).toBe(true);
    expect(screen.getAllByText(/CR03/).length).toBeGreaterThan(0);
    expect(button(/查看手动接管指引/)).toBeTruthy();
  });
});

describe('W05 任务详情与未知核实', () => {
  it('unknown result offers reconcile and manual conclusion only', async () => {
    const { fake, container } = await mount('unknown_result', 'W05');
    const texts = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(texts.filter((t) => RESEND.test(t))).toEqual([]);
    expect(button(/仅核实/).disabled).toBe(false);
    const conclude = button(/我已人工检查/);
    expect(conclude.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: /亲自检查/ }), { target: { value: '对方已在通讯录' } });
    expect(button(/我已人工检查/).disabled).toBe(false);
    fireEvent.click(button(/仅核实/));
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'task.reconcile')?.params).toEqual({ taskId: 'task_7', expectedRevision: 3 }));
    fireEvent.click(button(/我已人工检查/));
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'task.concludeManually')?.params).toEqual({ taskId: 'task_7', expectedRevision: 3, conclusion: '对方已在通讯录', evidenceIds: [] }));
  });
  it('shows the three result layers separately', async () => {
    await mount('unknown_result', 'W05');
    expect(screen.getByText('平台投递')).toBeTruthy();
    expect(screen.getByText('平台静止')).toBeTruthy();
    expect(screen.getByText('业务核实')).toBeTruthy();
  });
  it('a failed IPC call is reported, not swallowed', async () => {
    await mount('unknown_result', 'W05');
    fireEvent.click(button(/仅核实/)); // the Fake service does not implement task.reconcile
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/仅核实失败/));
  });
});

describe('W01 连接与账号确认', () => {
  it('locates the failed step and disables confirm when offline', async () => {
    await mount('platform_offline', 'W01');
    expect(screen.getByText(/停在"发现 AgentDesktop"/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '这就是我的账号' })).toBeNull();
  });
  it('confirms the account with its evidence and revision', async () => {
    const { fake } = await mount('account_unconfirmed', 'W01');
    fireEvent.click(button('这就是我的账号'));
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'account.confirm')?.params).toEqual({ bindingEvidenceId: 'ev_1', expectedRevision: 0 }));
  });
});

describe('W06 设置与诊断', () => {
  it('shows the manual handback guide when the capability is missing', async () => {
    await mount('ready_idle', 'W06');
    expect(screen.getByText(/手动接管步骤/)).toBeTruthy();
    expect(screen.getByText(/平台归还能力不可用/)).toBeTruthy();
  });
  it('exports diagnostics without evidence by default', async () => {
    const { fake } = await mount('ready_idle', 'W06');
    fireEvent.click(button('导出脱敏诊断'));
    await waitFor(() => expect(fake.calls.find((c) => c.method === 'diagnostics.export')?.params).toEqual({ includeEvidence: false, selectedEvidenceIds: [] }));
  });
});
