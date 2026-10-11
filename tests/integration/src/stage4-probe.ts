// Stage 4 connection probe (docs/acceptance/stage4-readonly-plan.md S1, plus the
// exception checks that need no GUI): talks to a running AgentDesktop over
// runtime/1 with lane A's real client and writes one JSON evidence record.
//
//   WECHAT_AGENT_ENDPOINT=/tmp/adt-wx/side.runtime.sock \
//     node_modules/.bin/tsx tests/integration/src/stage4-probe.ts --out evidence.json
//
// Read-only by construction. It calls runtime.handshake / capabilities / status,
// desktop.list, app.list, window.list, run.list, events.subscribe/unsubscribe and
// request.show. It deliberately provokes three refusals that change nothing:
// run.start without a session, a request that outlives its deadline, and a call
// after the control connection is gone. It never calls desktop.create,
// window.bind, session.open, observe or act, so it creates no display and
// touches no window. A step it cannot run is recorded as blocked, never passed.
import { writeFileSync } from 'node:fs';
import { createDriver, resolveEndpoint } from '@wechat-agent/driver';
import { CORE_METHODS, WECHAT_BUNDLE_ID } from '@wechat-agent/app';
import { DriverError, EXPECTED_PRODUCT, RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type { AgentDesktopDriver } from '@wechat-agent/ports';

type Result = 'passed' | 'failed' | 'blocked';
interface Step { id: string; title: string; result: Result; detail: Record<string, unknown> }

const CLIENT = { name: 'wechat-agent-stage4-probe', version: '0.1.0' };

function errorOf(error: unknown): Record<string, unknown> {
  if (error instanceof DriverError) {
    const { code, phase, notSent, retryable, message } = error.error;
    return { code, phase, notSent, retryable, message };
  }
  return { message: String(error) };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
  const endpoint = process.env.WECHAT_AGENT_ENDPOINT;
  const steps: Step[] = [];
  const add = (id: string, title: string, result: Result, detail: Record<string, unknown>) => steps.push({ id, title, result, detail });
  const driver: AgentDesktopDriver = createDriver({ endpoint, client: CLIENT, requestTimeoutMs: 10_000 });

  // S1-1 handshake: product, protocol, principal.
  let principalRole: string | undefined;
  try {
    const hs = await driver.connect();
    principalRole = hs.principal?.role;
    const ok = hs.identity.product === EXPECTED_PRODUCT && hs.identity.apiVersions.includes(RUNTIME_API_VERSION);
    add('S1-1', 'runtime.handshake: product, apiVersion, principal', ok ? 'passed' : 'failed', {
      product: hs.identity.product, productVersion: hs.identity.productVersion, apiVersion: hs.identity.apiVersion,
      instanceId: hs.identity.instanceId, endpoint: hs.identity.endpoint, build: hs.identity.build, principal: hs.principal ?? null,
    });
  } catch (error) {
    add('S1-1', 'runtime.handshake', 'failed', { error: errorOf(error), endpoint: resolveEndpoint(endpoint) });
    return finish(steps, out);
  }

  // S1-2 authentication: CR01 is pairing. An owner principal is the controlled development exception, not CR01.
  add('S1-2', 'principal is a paired app (CR01)', principalRole === 'paired' ? 'passed' : 'blocked', {
    role: principalRole ?? null,
    note: principalRole === 'paired' ? 'paired principal' : 'not paired: since agentdesktop #137 (A4) an unpaired connection may only pair; see docs/acceptance/a4-pairing.md',
  });

  // S1-3 capabilities: every method the app needs is implemented.
  try {
    const caps = await driver.capabilities();
    const methods = caps.interface.methods.map((m) => m.method);
    const missing = CORE_METHODS.filter((m) => !methods.includes(m));
    add('S1-3', 'runtime.capabilities covers the app core methods', missing.length ? 'failed' : 'passed', {
      apiVersion: caps.apiVersion, methodCount: methods.length, missing, permissions: caps.backend.permissions, features: caps.backend.features,
    });
  } catch (error) {
    add('S1-3', 'runtime.capabilities', 'failed', { error: errorOf(error) });
  }

  // S1-4 status and read-only listings.
  try {
    const status = await driver.status();
    const desktops = await driver.listDesktops();
    const windows = await driver.listWindows();
    const wechat = windows.filter((w) => w.bundleId === WECHAT_BUNDLE_ID);
    const runs = await driver.listRuns();
    add('S1-4', 'runtime.status, desktop.list, window.list, run.list', 'passed', {
      status, desktops: desktops.map((d) => ({ desktopId: d.desktopId, name: d.name, state: d.state })),
      windowCount: windows.length, wechatWindows: wechat.map((w) => ({ windowId: w.windowId, pid: w.process.pid, title: w.title, onScreen: w.onScreen })),
      runCount: runs.length,
    });
    // S2/S3 need a Desktop to open a session and start a Run. Desktops come only from
    // desktop.create, which makes a virtual display; Stage 4 forbids that.
    add('S1-5', 'session.open → run.start (Run creation)', 'blocked', {
      reason: desktops.length === 0
        ? 'no Desktop exists and desktop.create (a virtual display) is forbidden in Stage 4'
        : 'a Desktop exists but binding WeChat needs an authorized test account (not provided)',
      desktopCount: desktops.length,
    });
    add('S2', 'WeChat window identified by bundleId', wechat.length ? 'passed' : 'blocked', {
      bundleId: WECHAT_BUNDLE_ID, found: wechat.length, note: wechat.length ? 'listed only; not bound' : 'WeChat is not running (no authorized test account)',
    });
  } catch (error) {
    add('S1-4', 'status and listings', 'failed', { error: errorOf(error) });
  }

  // S1-6 the event subscription is its own connection; closing it leaves control alone (ADR-02).
  try {
    const stream = await driver.subscribe({});
    await stream.close();
    const after = await driver.status();
    add('S1-6', 'events.subscribe on its own connection; closing it keeps the control connection', driver.state === 'connected' ? 'passed' : 'failed', {
      cursor: stream.cursor, driverState: driver.state, statusAfter: Boolean(after),
    });
  } catch (error) {
    add('S1-6', 'events.subscribe', 'failed', { error: errorOf(error) });
  }

  // X-1 a Run cannot start without a session; the refusal is typed and nothing is created.
  try {
    await driver.startRun('ses_does_not_exist');
    add('X-1', 'run.start without a valid session is refused', 'failed', { note: 'the Runtime accepted it' });
  } catch (error) {
    const e = errorOf(error);
    const runsAfter = (await driver.listRuns()).length;
    add('X-1', 'run.start without a valid session is refused', e.code ? 'passed' : 'failed', { error: e, runsAfter });
  }

  // X-2 request.show for an id this client never sent: not_found, which the app never reads as "not sent".
  try {
    await driver.showRequest('rq_wechat_agent_probe_never_sent');
    add('X-2', 'request.show of an unknown requestId', 'failed', { note: 'found a record' });
  } catch (error) {
    const e = errorOf(error);
    add('X-2', 'request.show of an unknown requestId → not_found', e.code === 'not_found' ? 'passed' : 'failed', { error: e });
  }

  // X-3 timeout: a deadline shorter than any answer. The driver reports deadline_exceeded and keeps the connection.
  {
    const quick = createDriver({ endpoint, client: CLIENT, requestTimeoutMs: 1 });
    try {
      await quick.connect();
      add('X-3', 'request deadline', 'blocked', { note: 'the handshake answered within 1 ms; no timeout to observe' });
    } catch (error) {
      const e = errorOf(error);
      add('X-3', 'request deadline → deadline_exceeded, notSent not claimed', e.code === 'deadline_exceeded' && e.notSent !== true ? 'passed' : 'failed', { error: e, state: quick.state });
    }
    await quick.close().catch(() => undefined);
  }

  // X-4 disconnect: after the control connection is closed every call fails typed, and the driver does not reconnect by itself.
  await driver.close();
  try {
    await driver.status();
    add('X-4', 'calls after the control connection is gone', 'failed', { note: 'a call succeeded on a closed driver' });
  } catch (error) {
    add('X-4', 'calls after the control connection is gone fail typed; no silent reconnect', 'passed', { error: errorOf(error), state: driver.state });
  }

  return finish(steps, out);
}

function finish(steps: Step[], out: string | undefined): number {
  const record = {
    probe: 'wechat-agent stage4-probe', at: new Date().toISOString(), endpoint: resolveEndpoint(process.env.WECHAT_AGENT_ENDPOINT),
    note: 'connection-level evidence only; no Desktop, window binding, observe or act. Not a substitute for A01–A04 on an authorized account.',
    steps,
    summary: Object.fromEntries((['passed', 'failed', 'blocked'] as Result[]).map((r) => [r, steps.filter((s) => s.result === r).map((s) => s.id)])),
  };
  const text = JSON.stringify(record, null, 2);
  if (out) writeFileSync(out, `${text}\n`);
  for (const s of steps) console.log(`${s.result.padEnd(7)} ${s.id.padEnd(5)} ${s.title}`);
  return steps.some((s) => s.result === 'failed') ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(2); });
