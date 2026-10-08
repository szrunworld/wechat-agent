// diagnostics.export: a JSON bundle with names and phone numbers masked, no
// message text, no screenshots, no credentials. Evidence goes in as ids and
// hashes only, and only when asked for.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppSnapshot, Id, Ledger, TaskView } from '@wechat-agent/ports';

export function maskLabel(label: string): string {
  if (!label) return '';
  const chars = [...label];
  return chars.length <= 1 ? '＊' : `${chars[0]}${'＊'.repeat(Math.min(chars.length - 1, 3))}`;
}

export function maskText(text: string): string {
  return text.replace(/1[3-9]\d{9}/g, '1**********').replace(/\+?\d[\d -]{7,}\d/g, (m) => `${m.slice(0, 2)}${'*'.repeat(Math.max(0, m.length - 2))}`);
}

function redactTask(task: TaskView): Record<string, unknown> {
  return {
    taskId: task.taskId, type: task.type, state: task.state, stateReason: task.stateReason, revision: task.revision,
    target: task.target ? { kind: task.target.kind, displayName: maskLabel(task.target.displayName), visibleIdentifier: task.target.visibleIdentifier ? maskLabel(task.target.visibleIdentifier) : undefined, confidence: task.target.confidence, evidenceCount: task.target.evidenceIds.length } : undefined,
    draft: task.draft ? { length: [...task.draft.text].length, revision: task.draft.revision, source: task.draft.source } : undefined,
    approval: task.approval ? { consumed: task.approval.consumed, expiresAt: task.approval.expiresAt } : undefined,
    platform: task.platform,
    facts: task.facts.map((f) => ({ factKind: f.factKind, outcome: f.outcome, confidence: f.confidence, observedAt: f.observedAt, reason: f.reason ? maskText(f.reason) : undefined })),
    timeline: task.timeline.map((t) => ({ at: t.at, label: maskText(t.label) })),
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}

export async function exportDiagnostics(input: {
  snapshot: AppSnapshot; ledger: Ledger; dataDir: string; includeEvidence: boolean; selectedEvidenceIds: Id[]; now: string; appVersion: string; log: string[];
}): Promise<{ path: string; byteSize: number }> {
  const { snapshot } = input;
  const evidence: Record<string, unknown>[] = [];
  if (input.includeEvidence) {
    for (const id of input.selectedEvidenceIds) {
      const item = await input.ledger.getEvidence(id);
      if (item) evidence.push({ evidenceId: item.evidenceId, sha256: item.sha256, captureTime: item.captureTime, coverage: item.coverage, hasArtifact: item.artifactId !== undefined });
    }
  }
  const bundle = {
    exportedAt: input.now,
    appVersion: input.appVersion,
    redaction: 'names and identifiers masked; no message text, screenshots or credentials',
    connection: { ...snapshot.connection, principal: snapshot.connection.principal ? { role: snapshot.connection.principal.role } : undefined },
    account: snapshot.account ? { status: snapshot.account.status, revision: snapshot.account.revision, visibleLabel: maskLabel(snapshot.account.visibleLabel) } : null,
    inputGate: snapshot.inputGate,
    patrol: snapshot.patrol,
    counts: snapshot.counts,
    features: snapshot.features,
    policy: snapshot.policy,
    tasks: snapshot.tasks.map(redactTask),
    ledger: await input.ledger.diagnostics(),
    evidence,
    log: input.log.map(maskText),
  };
  const dir = path.join(input.dataDir, 'diagnostics');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `wechat-agent-${input.now.replace(/[:+]/g, '-')}.json`);
  const body = JSON.stringify(bundle, null, 2);
  await writeFile(file, body, { mode: 0o600 });
  return { path: file, byteSize: Buffer.byteLength(body) };
}
