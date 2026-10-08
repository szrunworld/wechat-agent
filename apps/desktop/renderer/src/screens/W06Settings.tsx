import { useState } from 'react';
import type { FeatureKey, IpcMethods } from '@wechat-agent/ports';
import { ActionButton } from '../components/ActionButton.tsx';
import { KeyValue } from '../components/KeyValue.tsx';
import { Notice } from '../components/Notice.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { FEATURE_LABEL, featureText } from '../copy.ts';
import { allTasks } from '../tasks.ts';
import type { ScreenProps } from './index.ts';

const FEATURE_KEYS: FeatureKey[] = ['read_list', 'accept_request', 'add_friend', 'reply_draft', 'send_message', 'handback'];

/** W06 · 设置与诊断：权限、策略、保留期、导出脱敏诊断、归还能力缺失的手动指引。 */
export function W06Settings({ snapshot, call, run, busy }: ScreenProps) {
  const { features, policy, connection } = snapshot;
  const [includeEvidence, setIncludeEvidence] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [exported, setExported] = useState<IpcMethods['diagnostics.export']['result'] | null>(null);
  const evidenceIds = Array.from(new Set([...(snapshot.account?.evidenceIds ?? []), ...allTasks(snapshot).flatMap((t) => t.target?.evidenceIds ?? [])]));

  return (
    <section aria-labelledby="w06-title">
      <h1 id="w06-title">W06 · 设置与诊断</h1>

      <h2>权限与能力</h2>
      <table className="table">
        <thead><tr><th scope="col">功能</th><th scope="col">状态</th></tr></thead>
        <tbody>
          {FEATURE_KEYS.map((k) => (
            <tr key={k}>
              <th scope="row">{FEATURE_LABEL[k]}</th>
              <td><StatusBadge tone={features[k].enabled ? 'ok' : 'warn'}>{featureText(features[k])}</StatusBadge></td>
            </tr>
          ))}
        </tbody>
      </table>
      {connection.missingCapabilities.length > 0 ? <p className="muted">平台缺少的能力：{connection.missingCapabilities.join('、')}</p> : null}

      <h2>策略</h2>
      <KeyValue rows={[
        { k: '允许回复的单聊', v: `${policy.allowlistCount} 个（白名单，在应用核心维护）` },
        { k: '每个动作单独审批', v: policy.approvalPerAction ? '是（不可关闭）' : '否' },
        { k: '截图上传给模型', v: policy.modelUpload ? '允许' : '不允许（草稿只基于本机识别文字）' },
        { k: '巡检间隔', v: `${policy.patrolIntervalSeconds} 秒` },
        { k: '证据保留期', v: '由应用核心按策略设定，每条证据带保留截止时间；当前快照未暴露天数' },
      ]} />
      <p className="muted small">策略在本应用里只读；修改要通过应用核心的配置，这样界面不会绕过策略门。</p>

      <h2>诊断导出</h2>
      <div className="card">
        <p>导出的是脱敏诊断包：连接状态、任务状态机记录、平台回执；默认不含截图。</p>
        <label className="check"><input type="checkbox" checked={includeEvidence} onChange={(e) => setIncludeEvidence(e.target.checked)} /> 包含选中的证据截图（原图，未脱敏，请谨慎）</label>
        {includeEvidence ? (
          <fieldset className="field"><legend>选择证据</legend>
            {evidenceIds.length === 0 ? <span className="muted">没有可选证据</span> : evidenceIds.map((id) => (
              <label key={id} className="check"><input type="checkbox" checked={selected.includes(id)} onChange={(e) => setSelected((p) => e.target.checked ? [...p, id] : p.filter((x) => x !== id))} /> {id}</label>
            ))}
          </fieldset>
        ) : null}
        <div className="actions">
          <ActionButton kind="secondary" busy={busy} decision={{ ok: true, reasons: [] }} onClick={() => run('导出诊断', async () => setExported(await call('diagnostics.export', { includeEvidence, selectedEvidenceIds: includeEvidence ? selected : [] })))}>导出脱敏诊断</ActionButton>
        </div>
        {exported ? <Notice tone="ok" title="已导出"><code>{exported.path}</code>（{Math.round(exported.byteSize / 1024)} KB）</Notice> : null}
      </div>

      <h2>归还微信窗口</h2>
      {features.handback.enabled ? (
        <Notice tone="ok" title="平台支持归还">在工作台点"我要接管微信窗口"，平台会把窗口交还给你。</Notice>
      ) : (
        <Notice tone="warn" title={`平台归还能力不可用：${featureText(features.handback)}`}>
          <p>本应用不会用前台化或模拟点击把窗口抢回来。手动接管步骤：</p>
          <ol>
            <li>在工作台点"暂停（关闭写入门）"，等状态变为"写入门已关闭"或"正在停止"结束。</li>
            <li>在 AgentDesktop 里解除对微信窗口的绑定（按它的界面操作）。</li>
            <li>像平时一样从 Dock 打开微信，你的操作不会被本应用干扰。</li>
            <li>用完后回到工作台点"恢复"；恢复不会重放之前的动作。</li>
          </ol>
        </Notice>
      )}
    </section>
  );
}
