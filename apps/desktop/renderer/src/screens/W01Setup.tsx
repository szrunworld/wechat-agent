import { useState } from 'react';
import type { IpcMethods } from '@wechat-agent/ports';
import { ActionButton } from '../components/ActionButton.tsx';
import { IdentityText } from '../components/IdentityText.tsx';
import { KeyValue } from '../components/KeyValue.tsx';
import { Notice } from '../components/Notice.tsx';
import { StatusBadge, type Tone } from '../components/StatusBadge.tsx';
import { ACCOUNT_STATUS, CONNECTION_DETAIL, CONNECTION_STATE, SETUP_STEP, STEP_STATE, formatTime } from '../copy.ts';
import { canConfirmAccount } from '../rules.ts';
import type { ScreenProps } from './index.ts';

const STEP_TONE: Record<'pending' | 'done' | 'failed' | 'blocked', Tone> = { pending: 'neutral', done: 'ok', failed: 'danger', blocked: 'warn' };

/** W01 · 连接与账号确认：逐步状态与失败定位；确认"这就是我的账号"。 */
export function W01Setup({ snapshot, call, run, busy }: ScreenProps) {
  const { connection, account } = snapshot;
  const [check, setCheck] = useState<IpcMethods['connection.check']['result'] | null>(null);
  const failed = connection.steps.find((s) => s.state === 'failed');
  const blocked = connection.steps.find((s) => s.state === 'blocked');
  const connTone: Tone = connection.state === 'ready' ? 'ok' : connection.state === 'connecting' ? 'info' : 'danger';

  return (
    <section aria-labelledby="w01-title">
      <h1 id="w01-title">W01 · 连接与账号确认</h1>

      <Notice tone={connTone} title={`平台：${CONNECTION_STATE[connection.state]}`}>{CONNECTION_DETAIL[connection.state]}</Notice>
      {connection.missingCapabilities.length > 0 ? (
        <Notice tone="warn" title="平台缺少本应用需要的能力">
          缺少：{connection.missingCapabilities.join('、')}。对应功能会在"设置与诊断"里标为不可用并说明原因。
        </Notice>
      ) : null}

      <h2>接入步骤</h2>
      <ol className="steps">
        {connection.steps.map((step) => (
          <li key={step.key} className={`step step-${step.state}`} aria-current={step.state === 'failed' || step.state === 'blocked' ? 'step' : undefined}>
            <StatusBadge tone={STEP_TONE[step.state]}>{STEP_STATE[step.state].glyph} {STEP_STATE[step.state].text}</StatusBadge>
            <span className="step-name">{SETUP_STEP[step.key]}</span>
            {step.detail ? <span className="step-detail">{step.detail}</span> : null}
          </li>
        ))}
      </ol>
      {failed ? (
        <Notice tone="danger" title={`停在"${SETUP_STEP[failed.key]}"`}>{failed.detail ?? '该步骤失败。'} 后面的步骤不会继续。</Notice>
      ) : blocked ? (
        <Notice tone="warn" title={`下一步：${SETUP_STEP[blocked.key]}`}>
          {blocked.key === 'pairing' ? '需要在 AgentDesktop 里完成配对后再继续；本应用不会申请 owner 权限绕过它。' : blocked.key === 'account' ? '请在下面核对账号后确认。' : '等待该步骤完成。'}
        </Notice>
      ) : null}

      <h2>连接信息</h2>
      <KeyValue rows={[
        { k: '端点', v: <code>{connection.endpoint}</code> },
        { k: '产品', v: connection.product ?? '—' },
        { k: '协议版本', v: connection.apiVersion ?? '—' },
        { k: '身份', v: connection.principal ? `${connection.principal.clientId}（${connection.principal.role}）` : '—' },
      ]} />
      <div className="actions">
        <ActionButton kind="secondary" busy={busy} decision={{ ok: true, reasons: [] }} onClick={() => run('重新检查连接', async () => setCheck(await call('connection.check', {})))}>重新检查连接</ActionButton>
        {check ? <span className="muted">检查结果：{CONNECTION_STATE[check.state]}，版本 {check.apiVersion ?? '—'}，方法 {check.methods.length} 个，缺失能力 {check.missingCapabilities.length ? check.missingCapabilities.join('、') : '无'}</span> : null}
      </div>

      <h2>账号确认</h2>
      {account ? (
        <div className="card">
          <KeyValue rows={[
            { k: '微信里显示的账号', v: <IdentityText>{account.visibleLabel}</IdentityText> },
            { k: '状态', v: <StatusBadge tone={account.status === 'confirmed' ? 'ok' : account.status === 'changed' ? 'danger' : 'warn'}>{ACCOUNT_STATUS[account.status]}</StatusBadge> },
            { k: '证据', v: account.evidenceIds.join('、') || '—' },
            { k: '确认时间', v: account.status === 'confirmed' ? formatTime(account.confirmedAt) : '—' },
            { k: '账号版本', v: String(account.revision) },
          ]} />
          {account.status === 'changed' ? <Notice tone="danger" title="账号已变更">微信里登录的账号和之前确认的不一样。之前的全部审批已失效，待办任务不会继续；请重新确认账号。</Notice> : null}
          {account.status === 'unconfirmed' ? <Notice tone="warn" title="请确认这就是你的账号">在外发任何动作之前，本应用需要你确认微信当前登录的就是上面这个账号。确认只对这个账号版本有效；换号后要重新确认。</Notice> : null}
          <div className="actions">
            <ActionButton busy={busy} decision={canConfirmAccount(snapshot)} onClick={() => run('确认账号', () => call('account.confirm', { bindingEvidenceId: account.evidenceIds[0], expectedRevision: account.revision }))}>
              这就是我的账号
            </ActionButton>
          </div>
        </div>
      ) : (
        <Notice tone="neutral" title="还没有读到账号">账号要在绑定微信窗口并读取只读基线之后才会出现。</Notice>
      )}
    </section>
  );
}
