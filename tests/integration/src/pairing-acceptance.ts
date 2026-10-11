// A4 pairing acceptance against a running AgentDesktop TEST COPY (never the
// product endpoint). Driven by scripts/pairing-acceptance.sh; one mode per run:
//
//   probe        no person needed: the unpaired wire (handshake principal, contract, pairing_required)
//   pair         the real app core asks to pair; the person approves (or denies) in the trusted window
//   check        the real app core connects with the stored credential and reports its state
//   revoke-self  the stored client gives up its own access (A4 R1: the person confirms with Touch ID)
//
//   WECHAT_AGENT_ENDPOINT=/tmp/adt-wxpair/side.runtime.sock WECHAT_AGENT_CREDENTIAL=/tmp/adt-wxpair/credential.json \
//     node_modules/.bin/tsx tests/integration/src/pairing-acceptance.ts <mode> [--expect paired|denied|revoked] --out <file.json>
//
// Nothing here reads WeChat, binds a window, observes the screen or sends input:
// no task is created, patrol and the baseline read are off, and the only calls
// are the handshake, capabilities, runtime.status, desktop.list and hub.pairing.*.
// The token is never printed or written to the record.
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication, FileCredentialStore, MemorySink, resolveConfig } from '@wechat-agent/app';
import { createDriver, RpcConnection, resolveEndpoint, resultProblems } from '@wechat-agent/driver';
import { DriverError, RUNTIME_API_VERSION, type AppSnapshot, type HandlerRegistry } from '@wechat-agent/ports';
import { expectedPairingResult } from './pairing-expectations.ts';
import { FakeRecognizer, InMemoryLedger } from '@wechat-agent/ports/fakes';

const CLIENT = { name: 'wechat-agent', version: '0.1.0' };
const PRODUCT_ENDPOINT = resolveEndpoint(undefined);

type Check = { id: string; title: string; result: 'passed' | 'failed' | 'info'; detail?: unknown };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function noHandlers(): HandlerRegistry {
  return { get: () => undefined, all: () => [] };
}

function code(error: unknown): { code: string; reason?: unknown; phase?: string; notSent?: boolean } | string {
  return error instanceof DriverError ? { code: error.error.code, reason: error.error.details?.reason, phase: error.error.phase, notSent: error.error.notSent } : String(error);
}

/** The snapshot without anything secret (it never holds the token; this keeps the record small). */
function connectionOf(snapshot: AppSnapshot) {
  const { state, principal, pairing, steps, missingCapabilities } = snapshot.connection;
  return { state, principal, pairing, steps, missingCapabilities, inputGate: snapshot.inputGate, features: snapshot.features };
}

async function probe(endpoint: string, checks: Check[]): Promise<void> {
  const driver = createDriver({ endpoint, client: CLIENT, requestTimeoutMs: 10_000 });
  const hello = await driver.connect();
  const p = hello.principal;
  checks.push({ id: 'P1', title: 'handshake without a credential: principal unpaired', result: p?.role === 'unpaired' && /^unpaired:conn_[0-9a-f]{16}$/.test(p.clientId) ? 'passed' : 'failed', detail: p });
  const handshakeProblems = resultProblems('runtime.handshake', hello.raw);
  checks.push({ id: 'P2', title: 'handshake result validates against the contract snapshot', result: handshakeProblems.length ? 'failed' : 'passed', detail: handshakeProblems });
  const caps = await driver.capabilities();
  const methods = caps.interface.methods.map((m) => m.method);
  const needed = ['hub.pairing.start', 'hub.pairing.status', 'desktop.list', 'window.list', 'window.bind', 'session.open', 'observe', 'act', 'run.start', 'events.subscribe'];
  const missing = needed.filter((m) => !methods.includes(m));
  checks.push({ id: 'P3', title: 'capabilities (open to unpaired) list the methods the app needs', result: missing.length ? 'failed' : 'passed', detail: { missing } });
  for (const [id, title, call] of [
    ['P4', 'desktop.list unpaired → pairing_required, not sent', () => driver.listDesktops()],
    ['P5', 'runtime.status unpaired → pairing_required', () => driver.status()],
    ['P6', 'window.list unpaired → pairing_required', () => driver.listWindows()],
  ] as const) {
    try {
      await call();
      checks.push({ id, title, result: 'failed', detail: 'answered' });
    } catch (error) {
      const c = code(error);
      checks.push({ id, title, result: typeof c === 'object' && c.code === 'pairing_required' && c.notSent === true ? 'passed' : 'failed', detail: c });
    }
  }
  try {
    await driver.pairingStatus('pair_doesnotexist');
    checks.push({ id: 'P7', title: 'hub.pairing.status of someone else / nothing → not_found', result: 'failed', detail: 'answered' });
  } catch (error) {
    const c = code(error);
    checks.push({ id: 'P7', title: 'hub.pairing.status of someone else / nothing → not_found', result: typeof c === 'object' && c.code === 'not_found' ? 'passed' : 'failed', detail: c });
  }
  await driver.close();
  const bad = createDriver({ endpoint, client: CLIENT });
  try {
    await bad.connect({ credential: { clientId: 'app:doesnotexist', token: 'adt1_not-a-real-token-at-all' } });
    checks.push({ id: 'P8', title: 'a credential that proves nothing → permission_denied bad_credential', result: 'failed', detail: 'accepted' });
  } catch (error) {
    const c = code(error);
    checks.push({ id: 'P8', title: 'a credential that proves nothing → permission_denied bad_credential', result: typeof c === 'object' && c.code === 'permission_denied' && c.reason === 'bad_credential' ? 'passed' : 'failed', detail: c });
  }
  await bad.close();
  // The app core, unpaired: it asks nothing but pairing and every feature is off.
  const app = createApplication({
    driver: createDriver({ endpoint, client: CLIENT }), ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: noHandlers(), outboxSink: new MemorySink(),
    credentials: new FileCredentialStore(path.join(os.tmpdir(), `wechat-agent-probe-${process.pid}`, 'none.json')),
    config: { dataDir: path.join(os.tmpdir(), `wechat-agent-probe-${process.pid}`), lockPath: null, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  const snap = await app.service.call('app.getSnapshot', {});
  await app.stop();
  const allOff = Object.values(snap.features).every((f) => !f.enabled && f.reason === 'pairing_missing');
  checks.push({ id: 'P9', title: 'app core unpaired: state unpaired, every feature pairing_missing', result: snap.connection.state === 'unpaired' && allOff ? 'passed' : 'failed', detail: connectionOf(snap) });
}

async function runApp(endpoint: string, credentialFile: string, mode: 'pair' | 'check', expected: 'paired' | 'denied' | 'revoked', checks: Check[]): Promise<void> {
  const dataDir = path.join(path.dirname(credentialFile), 'app-data');
  const store = new FileCredentialStore(credentialFile);
  const app = createApplication({
    driver: createDriver({ endpoint, client: CLIENT, requestTimeoutMs: 10_000 }), ledger: new InMemoryLedger(), recognizer: new FakeRecognizer(), handlers: noHandlers(),
    outboxSink: new MemorySink(), credentials: store,
    config: { dataDir, lockPath: null, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  const snapshot = () => app.service.call('app.getSnapshot', {});
  if (mode === 'check') {
    const snap = await snapshot();
    console.log(`state: ${snap.connection.state}  pairing: ${snap.connection.pairing.state}${snap.connection.pairing.refusal ? `  (${snap.connection.pairing.refusal.message})` : ''}`);
    checks.push({ id: 'C1', title: `reconnected: expected ${expected}`, result: expectedPairingResult(snap.connection.state, snap.connection.pairing.state, expected), detail: connectionOf(snap) });
    if (expected === 'revoked') {
      const again = await app.service.call('connection.check', {});
      checks.push({ id: 'C2', title: 'revoked: credential cleared and retry remains revoked', result: !(await store.load()) && again.state === 'revoked' ? 'passed' : 'failed' });
    }
    await app.stop();
    return;
  }
  const requested = resolveConfig().pairing.requested;
  console.log('Asking AgentDesktop (test copy) to pair "WeChat Agent" with:');
  console.log(`  capabilities ${requested.capabilities.join(', ')}; desktops ${requested.desktops?.join(', ')}; apps ${requested.apps?.join(', ')}; ${requested.durationSeconds} s`);
  let view;
  try {
    view = await app.service.call('pairing.start', {});
  } catch (error) {
    const snap = await snapshot();
    checks.push({ id: 'A1', title: 'pairing.start', result: 'failed', detail: { error: String(error), connection: connectionOf(snap) } });
    await app.stop();
    return;
  }
  console.log(`\n  配对码 ${view.shortCode}：请在 AgentDesktop 的确认窗口核对它，再按你要验收的回合操作（批准后用 Touch ID / 拒绝）。\n`);
  checks.push({ id: 'A1', title: 'pairing.start → waiting with a short code', result: view.state === 'waiting' && /^\d{6}$/.test(view.shortCode ?? '') ? 'passed' : 'failed', detail: { state: view.state, shortCode: view.shortCode, expiresAt: view.expiresAt } });
  const deadline = Date.now() + 200_000;
  let snap = await snapshot();
  while (Date.now() < deadline && (snap.connection.state === 'pairing' || snap.connection.state === 'connecting')) {
    await new Promise((r) => setTimeout(r, 1_000));
    snap = await snapshot();
  }
  console.log(`result: ${snap.connection.state} / ${snap.connection.pairing.state}`);
  checks.push({ id: 'A2', title: `the person answered: expected ${expected}`, result: expectedPairingResult(snap.connection.state, snap.connection.pairing.state, expected), detail: connectionOf(snap) });
  if (snap.connection.pairing.state === 'paired') {
    const stored = await store.load();
    checks.push({ id: 'A3', title: 'credential stored (0600 file), principal paired', result: stored?.clientId === snap.connection.principal?.clientId && snap.connection.principal?.role === 'paired' ? 'passed' : 'failed', detail: { clientId: stored?.clientId, codeIdentityLevel: snap.connection.pairing.codeIdentityLevel, grant: snap.connection.pairing.grant } });
    const window = snap.connection.steps.find((s) => s.key === 'window');
    checks.push({ id: 'A4', title: 'paired ≠ every window: the "created" grant shows no Desktop, nothing is bound', result: window?.state === 'failed' ? 'passed' : 'failed', detail: window });
  }
  if (snap.connection.pairing.state === 'denied') {
    let blocked = false;
    try { await app.service.call('pairing.start', {}); } catch { blocked = true; }
    checks.push({ id: 'A6', title: 'denied: no credential was stored', result: await store.load() === null ? 'passed' : 'failed' });
    checks.push({ id: 'A5', title: 'denied → the app does not ask again within the minute', result: blocked ? 'passed' : 'failed', detail: { retryAfter: snap.connection.pairing.retryAfter } });
  }
  await app.stop();
}

/** The stored client gives up its own access (hub.clients.revoke on itself); the person confirms with Touch ID. */
async function revokeSelf(endpoint: string, credentialFile: string, checks: Check[]): Promise<void> {
  const stored = await new FileCredentialStore(credentialFile).load();
  if (!stored) throw new Error(`no credential at ${credentialFile}: run "pair" first`);
  const conn = await RpcConnection.connect(endpoint, 5_000);
  const call = (method: string, params: Record<string, unknown>, timeoutMs = 10_000) =>
    conn.request({ apiVersion: RUNTIME_API_VERSION, requestId: `rq_acc_${method.replace(/\./g, '_')}_${Date.now().toString(36)}`, method, params }, timeoutMs);
  const hello = await call('runtime.handshake', { apiVersions: [RUNTIME_API_VERSION], client: CLIENT, credential: { clientId: stored.clientId, token: stored.token } });
  if (!hello.ok) throw new Error(`handshake refused: ${hello.error.code}`);
  console.log(`\n  ${stored.clientId} 申请撤销自己的授权：请在 AgentDesktop 的确认窗口批准并用 Touch ID 确认。\n`);
  const revoked = await call('hub.clients.revoke', { clientId: stored.clientId }, 150_000);
  checks.push({ id: 'R1', title: 'self-revocation answered', result: revoked.ok && (revoked.data as { state?: string }).state === 'revoked' ? 'passed' : 'failed', detail: revoked.ok ? { state: (revoked.data as { state?: string }).state } : revoked.error });
  conn.destroy();
}

async function main(): Promise<number> {
  const [mode] = process.argv.slice(2);
  const args = process.argv.slice(3);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
  if (!['probe', 'pair', 'check', 'revoke-self'].includes(mode ?? '')) {
    console.error('usage: pairing-acceptance.ts probe|pair|check|revoke-self [--expect paired|denied|revoked] [--out file.json]');
    return 2;
  }
  const endpoint = resolveEndpoint(env('WECHAT_AGENT_ENDPOINT'));
  if (endpoint === PRODUCT_ENDPOINT || endpoint.endsWith('/agent-desktop.sock')) {
    console.error(`refusing the product endpoint ${endpoint}: acceptance runs only against a test copy`);
    return 2;
  }
  const expected = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : undefined;
  if ((mode === 'pair' && !['paired', 'denied'].includes(expected ?? '')) || (mode === 'check' && !['paired', 'revoked'].includes(expected ?? ''))) {
    console.error('pair/check require --expect paired|denied|revoked (matching the round)');
    return 2;
  }
  const checks: Check[] = [];
  if (mode === 'probe') await probe(endpoint, checks);
  else if (mode === 'revoke-self') await revokeSelf(endpoint, env('WECHAT_AGENT_CREDENTIAL'), checks);
  else await runApp(endpoint, env('WECHAT_AGENT_CREDENTIAL'), mode as 'pair' | 'check', expected as 'paired' | 'denied' | 'revoked', checks);
  for (const c of checks) console.log(`${c.result.toUpperCase().padEnd(6)} ${c.id} ${c.title}`);
  const record = { probe: `wechat-agent pairing-acceptance ${mode}`, at: new Date().toISOString(), endpoint, checks };
  if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  return checks.some((c) => c.result === 'failed') ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error instanceof Error ? error.message : error); process.exit(2); });
