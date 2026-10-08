// Stage 4 read-only environment check (docs/acceptance/stage4-readonly-plan.md §2).
// Run through scripts/stage4-env-check.sh. It only reads: the contract snapshot
// on disk, whether runtime.sock exists, runtime.handshake / runtime.capabilities /
// runtime.status over lane A's real client, and `ps` for the WeChat process.
// It never calls window.bind, session.open, run.start, observe or act, and it
// never starts, moves or clicks anything. Exit 0 = ready, 1 = not ready, 2 = bad usage.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createDriver, resolveEndpoint } from '@wechat-agent/driver';
import { createHandlers } from '@wechat-agent/handlers';
import { CORE_METHODS, WECHAT_BUNDLE_ID } from '@wechat-agent/app';
import { DEFAULT_RUNTIME_ENDPOINT, DriverError, EXPECTED_PRODUCT, RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type { Capabilities, HandshakeResult } from '@wechat-agent/ports';

const CLIENT = { name: 'wechat-agent-env-check', version: '0.1.0' };

export interface EnvCheckReport {
  checkedAt: string;
  contract: { dir: string; files: { name: string; expected: string; actual: string; ok: boolean }[]; ok: boolean };
  endpoint: { configured: string; resolved: string; exists: boolean; isSocket: boolean };
  runtime?: {
    product: string; productVersion: string; apiVersion: string; apiVersions: string[]; instanceId: string; pid: number; startedAt: string; endpoint: string;
    principal: { clientId: string; role: string } | null;
    methods: string[]; required: string[]; missing: string[];
    permissions: Record<string, string>; features: string[];
    status: Record<string, unknown>;
  };
  runtimeError?: { code: string; phase: string; message: string };
  wechat: { running: boolean; pids: number[]; bundleId: string };
  ready: boolean;
  reasons: string[];
  warnings: string[];
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** contracts/agentdesktop-runtime-v1/SHA256SUMS against the files next to it (A01 step 1). */
function checkContract(repoRoot: string): EnvCheckReport['contract'] {
  const dir = path.join(repoRoot, 'contracts', 'agentdesktop-runtime-v1');
  const files: EnvCheckReport['contract']['files'] = [];
  for (const line of readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    let actual = '';
    try { actual = sha256File(path.join(dir, m[2])); } catch { actual = '(missing)'; }
    files.push({ name: m[2], expected: m[1], actual, ok: actual === m[1] });
  }
  return { dir, files, ok: files.length > 0 && files.every((f) => f.ok) };
}

function checkEndpoint(configured: string | undefined): EnvCheckReport['endpoint'] {
  const resolved = resolveEndpoint(configured);
  try {
    const st = statSync(resolved);
    return { configured: configured ?? DEFAULT_RUNTIME_ENDPOINT, resolved, exists: true, isSocket: st.isSocket() };
  } catch {
    return { configured: configured ?? DEFAULT_RUNTIME_ENDPOINT, resolved, exists: false, isSocket: false };
  }
}

/** The methods the app and every registered handler need. */
function requiredMethods(): string[] {
  const set = new Set<string>(CORE_METHODS);
  for (const handler of createHandlers().all()) for (const m of handler.requires.methods) set.add(m);
  return [...set].sort();
}

async function probeRuntime(endpoint: string): Promise<{ runtime?: EnvCheckReport['runtime']; error?: EnvCheckReport['runtimeError'] }> {
  const driver = createDriver({ endpoint, client: CLIENT, connectTimeoutMs: 3_000, requestTimeoutMs: 5_000 });
  let handshake: HandshakeResult;
  let capabilities: Capabilities;
  let status: Record<string, unknown>;
  try {
    handshake = await driver.connect();
    capabilities = await driver.capabilities();
    status = await driver.status();
  } catch (e) {
    await driver.close().catch(() => undefined);
    if (e instanceof DriverError) return { error: { code: e.error.code, phase: e.error.phase, message: e.error.message } };
    return { error: { code: 'internal_error', phase: 'local', message: e instanceof Error ? e.message : String(e) } };
  }
  await driver.close().catch(() => undefined);
  const methods = capabilities.interface.methods.map((m) => m.method).sort();
  const required = requiredMethods();
  const { identity, principal } = handshake;
  return {
    runtime: {
      product: identity.product, productVersion: identity.productVersion, apiVersion: identity.apiVersion, apiVersions: identity.apiVersions,
      instanceId: identity.instanceId, pid: identity.pid, startedAt: identity.startedAt, endpoint: identity.endpoint,
      principal: principal ? { clientId: principal.clientId, role: principal.role } : null,
      methods, required, missing: required.filter((m) => !methods.includes(m)),
      permissions: { ...capabilities.backend.permissions }, features: [...capabilities.backend.features],
      status,
    },
  };
}

/** `ps` only: the main WeChat process (not its helpers). Nothing is sent to it. */
function checkWeChat(): EnvCheckReport['wechat'] {
  const pids: number[] = [];
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      if (/\/WeChat\.app\/Contents\/MacOS\/WeChat$/.test(m[2]) || /\/Weixin\.app\/Contents\/MacOS\/Weixin$/.test(m[2])) pids.push(Number(m[1]));
    }
  } catch {
    // ps unavailable: reported as not running; the reason list says why.
  }
  return { running: pids.length > 0, pids, bundleId: WECHAT_BUNDLE_ID };
}

export async function runEnvCheck(options: { endpoint?: string; repoRoot: string }): Promise<EnvCheckReport> {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const contract = checkContract(options.repoRoot);
  if (!contract.ok) reasons.push('契约快照与 SHA256SUMS 不一致（contracts/agentdesktop-runtime-v1）');
  const endpoint = checkEndpoint(options.endpoint);
  const report: EnvCheckReport = { checkedAt: new Date().toISOString(), contract, endpoint, wechat: checkWeChat(), ready: false, reasons, warnings };
  if (!endpoint.exists) {
    reasons.push(`runtime.sock 不存在：${endpoint.resolved}（AgentDesktop 未运行）`);
  } else if (!endpoint.isSocket) {
    reasons.push(`${endpoint.resolved} 存在但不是 Unix socket`);
  } else {
    const probe = await probeRuntime(endpoint.resolved);
    if (probe.error) {
      report.runtimeError = probe.error;
      reasons.push(`握手失败：${probe.error.code}（${probe.error.phase}）${probe.error.message}`);
    } else if (probe.runtime) {
      const rt = probe.runtime;
      report.runtime = rt;
      if (rt.product !== EXPECTED_PRODUCT) reasons.push(`product 是 ${rt.product}，需要 ${EXPECTED_PRODUCT}`);
      if (!rt.apiVersions.includes(RUNTIME_API_VERSION)) reasons.push(`apiVersions ${rt.apiVersions.join(',')} 不含 ${RUNTIME_API_VERSION}`);
      if (rt.missing.length) reasons.push(`平台缺少方法：${rt.missing.join(', ')}`);
      for (const [perm, state] of Object.entries(rt.permissions)) if (state !== 'granted') reasons.push(`平台权限 ${perm} = ${state}（观察需要 granted）`);
      if (!rt.principal) warnings.push('握手未返回 principal（冻结的 RuntimeIdentity 还没有 principal 字段）：只读步骤可做，外发保持 blocked');
      else if (rt.principal.role !== 'paired') warnings.push(`principal.role=${rt.principal.role}（${rt.principal.clientId}）：受控开发模式，不是 CR01 的配对身份；只读步骤可做，外发保持 blocked`);
      const admission = rt.status.inputAdmission;
      if (admission !== undefined && admission !== 'enabled') warnings.push(`runtime.status.inputAdmission=${String(admission)}：导航点击会被 input_disabled 拒绝（只读 observe 不受影响）`);
    }
  }
  if (!report.wechat.running) reasons.push('微信（WeChat.app 主进程）没有在运行');
  report.ready = reasons.length === 0;
  return report;
}

function printReport(report: EnvCheckReport): void {
  const line = (s: string) => process.stdout.write(`${s}\n`);
  line(`stage4 env check @ ${report.checkedAt}`);
  line(`契约快照 ${report.contract.ok ? 'ok' : 'MISMATCH'}: ${report.contract.files.map((f) => `${f.name}=${f.ok ? f.expected.slice(0, 12) : `${f.actual.slice(0, 12)}≠${f.expected.slice(0, 12)}`}`).join(' ')}`);
  line(`runtime.sock: ${report.endpoint.resolved} → ${report.endpoint.exists ? (report.endpoint.isSocket ? 'exists (socket)' : 'exists (NOT a socket)') : 'missing'}`);
  if (report.runtime) {
    const rt = report.runtime;
    line(`runtime: product=${rt.product} ${rt.productVersion} apiVersion=${rt.apiVersion} apiVersions=[${rt.apiVersions.join(',')}] instance=${rt.instanceId} pid=${rt.pid} startedAt=${rt.startedAt}`);
    line(`principal: ${rt.principal ? `${rt.principal.clientId} role=${rt.principal.role}` : '(none)'}`);
    line(`methods (${rt.methods.length}): ${rt.methods.join(' ')}`);
    line(`required (${rt.required.length}): ${rt.required.join(' ')}`);
    line(`missing: ${rt.missing.length ? rt.missing.join(' ') : '(none)'}`);
    line(`permissions: ${Object.entries(rt.permissions).map(([k, v]) => `${k}=${v}`).join(' ')}; features: ${rt.features.join(' ') || '(none)'}`);
    line(`status: ${JSON.stringify(rt.status)}`);
  } else if (report.runtimeError) {
    line(`runtime: ${report.runtimeError.code} (${report.runtimeError.phase}): ${report.runtimeError.message}`);
  } else {
    line('runtime: not probed');
  }
  line(`wechat: ${report.wechat.running ? `running pid=${report.wechat.pids.join(',')}` : 'not running'} (bundleId ${report.wechat.bundleId}; from ps only)`);
  for (const w of report.warnings) line(`warning: ${w}`);
  for (const r of report.reasons) line(`reason: ${r}`);
  line(report.ready ? 'READY: 阶段 4 只读步骤可以开始（仍需 Kevin 提供授权测试账号与联系人）' : 'NOT READY');
}

function repoRootFrom(here: string): string {
  return path.resolve(here, '../../..');
}

async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const bad = argv.filter((a) => a !== '--json');
  if (bad.length) {
    process.stderr.write(`usage: scripts/stage4-env-check.sh [--json]   (WECHAT_AGENT_ENDPOINT overrides the socket path)\n`);
    return 2;
  }
  const report = await runEnvCheck({ endpoint: process.env.WECHAT_AGENT_ENDPOINT, repoRoot: repoRootFrom(import.meta.dirname) });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  return report.ready ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    process.stderr.write(`env check failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  });
}
