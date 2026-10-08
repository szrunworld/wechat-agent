// One contract-valid request example per implemented method of the snapshot.
import { RUNTIME_API_VERSION } from '@wechat-agent/ports';
import type { RuntimeRequest } from '@wechat-agent/ports';

export const CLIENT = { name: 'WeChat Agent', version: '0.1.0-test' };

export const PARAMS_EXAMPLES: Record<string, Record<string, unknown>> = {
  'runtime.handshake': { apiVersions: [RUNTIME_API_VERSION], client: CLIENT },
  'runtime.status': {},
  'runtime.capabilities': {},
  'desktop.list': {},
  'desktop.show': { desktopId: 'desk_1' },
  'app.list': { includeBackground: false },
  'window.list': { pid: 777 },
  'desktop.create': { name: 'wechat', width: 1280, height: 900 },
  'desktop.destroy': { desktopId: 'desk_2' },
  'app.launch': { desktopId: 'desk_1', bundleId: 'com.example.app' },
  'window.bind': { desktopId: 'desk_1', pid: 777, windowId: 11 },
  'window.unbind': { desktopId: 'desk_1' },
  'session.open': { desktopId: 'desk_1' },
  'session.show': { sessionId: 'ses_1' },
  'session.close': { sessionId: 'ses_1' },
  observe: { screenshot: true, elements: true },
  'request.show': { requestId: 'rq_1' },
  act: { snapshotId: 'snap_1', action: { kind: 'click', target: { imagePoint: { x: 10, y: 20 } } } },
  wait: { condition: { kind: 'elementPresent', role: 'AXButton', labelContains: 'Accept' }, timeoutMs: 1000 },
  'run.start': {},
  'run.attach': { runId: 'run_1', token: 'a'.repeat(64) },
  'run.finish': { runId: 'run_1', exitCode: 0 },
  'run.show': { runId: 'run_1' },
  'run.events': { runId: 'run_1', after: 0, limit: 100 },
  'run.wait': { runId: 'run_1', timeoutMs: 100 },
  'run.cancel': { runId: 'run_1' },
  'run.list': { active: true, limit: 50 },
  'runtime.stopAll': { scope: 'all_platform_runs' },
  'runtime.enableInput': {},
  'artifact.show': { artifactId: 'art_1' },
  'artifact.read': { artifactId: 'art_1', offset: 0, length: 524288 },
  'events.subscribe': { runId: 'run_1', after: 0 },
  'events.unsubscribe': {},
};

const CONTEXT_EXAMPLES: Record<string, RuntimeRequest['context']> = {
  observe: { sessionId: 'ses_1', runId: 'run_1' },
  act: { sessionId: 'ses_1', runId: 'run_1' },
  wait: { sessionId: 'ses_1' },
  'run.start': { sessionId: 'ses_1' },
  'window.list': { desktopId: 'desk_1' },
};

export function exampleRequest(method: string, requestId = 'rq_example'): RuntimeRequest {
  const params = PARAMS_EXAMPLES[method];
  if (!params) throw new Error(`no example for ${method}`);
  const context = CONTEXT_EXAMPLES[method];
  return { apiVersion: RUNTIME_API_VERSION, requestId, method, ...(context ? { context } : {}), params };
}
