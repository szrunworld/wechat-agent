// Stage 4: the real app core (lane E) against a running AgentDesktop, read-only.
//
//   WECHAT_AGENT_ENDPOINT=/tmp/adt-wx/side.runtime.sock \
//     node_modules/.bin/tsx tests/integration/src/stage4-app-connect.ts --out app-connect.json
//
// Patrol and the baseline read are off, the ledger lives in a temp directory,
// and no task is created, so the app only connects, checks the contract and
// capabilities, and computes its setup steps and feature gates. It never calls
// desktop.create; window.bind happens only if a WeChat window is listed, which
// the operator must not allow without an authorized test account.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, MemorySink } from '@wechat-agent/app';
import { createDriver } from '@wechat-agent/driver';
import { createHandlers } from '@wechat-agent/handlers';
import { openLedger } from '@wechat-agent/ledger';
import { createRecognizer } from '@wechat-agent/recognition';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
  const dir = mkdtempSync(join(tmpdir(), 'wechat-agent-stage4-'));
  const driver = createDriver({ endpoint: process.env.WECHAT_AGENT_ENDPOINT, client: { name: 'wechat-agent', version: '0.1.0' } });
  const ledger = await openLedger(join(dir, 'ledger.sqlite'));
  const app = createApplication({
    driver, ledger, recognizer: createRecognizer(), handlers: createHandlers(), outboxSink: new MemorySink(),
    config: { dataDir: dir, patrolEnabled: false, baselineOnConnect: false },
  });
  await app.start();
  // Let the connector finish discover → contract → pairing → window.
  for (let i = 0; i < 40; i++) {
    const s = await app.service.call('app.getSnapshot', {});
    if (s.connection.steps.every((step) => step.state !== 'pending' || step.key === 'baseline')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const snapshot = await app.service.call('app.getSnapshot', {});
  const check = await app.service.call('connection.check', {});
  await app.stop();
  const actsSent = 0; // no task was created; the dispatcher never ran
  const record = {
    probe: 'wechat-agent stage4-app-connect', at: new Date().toISOString(), dataDir: dir,
    connection: snapshot.connection, inputGate: snapshot.inputGate, account: snapshot.account, features: snapshot.features,
    connectionCheck: check, tasks: snapshot.tasks.length, actsSent,
  };
  if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`connection: ${snapshot.connection.state}  inputGate: ${snapshot.inputGate}`);
  for (const step of snapshot.connection.steps) console.log(`  ${step.key.padEnd(9)} ${step.state.padEnd(8)} ${step.detail ?? ''}`);
  for (const [key, f] of Object.entries(snapshot.features)) console.log(`  feature ${key.padEnd(15)} ${f.enabled ? 'enabled' : `disabled (${f.reason})`}`);
  return 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(2); });
