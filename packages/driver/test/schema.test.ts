import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNTIME_API_VERSION } from '@wechat-agent/ports';
import { METHODS, canonicalJson, methodsContract, requestProblems, validator } from '../src/index.ts';
import { PARAMS_EXAMPLES, exampleRequest } from './examples.ts';

test('every implemented method of the snapshot has a request example that passes local schema validation', () => {
  const methods = [...METHODS.keys()];
  assert.ok(methods.length >= 30, `snapshot lists ${methods.length} methods`);
  const validated: string[] = [];
  for (const method of methods) {
    assert.ok(method in PARAMS_EXAMPLES, `missing example for ${method}`);
    const problems = requestProblems(exampleRequest(method));
    assert.deepEqual(problems, [], `${method}: ${problems.join('; ')}`);
    validated.push(method);
  }
  assert.deepEqual(validated.sort(), methods.sort());
  console.log(`schema examples validated for ${validated.length} methods: ${validated.join(', ')}`);
  assert.equal(methodsContract.transport.maxFrameBytes, 1_048_576);
});

test('envelope: apiVersion const, requestId pattern, method pattern, no extra keys', () => {
  assert.ok(requestProblems({ apiVersion: 'agentdesktop.runtime/2', requestId: 'rq_1', method: 'observe', params: {} }).some((p) => p.includes('apiVersion')));
  assert.ok(requestProblems({ apiVersion: RUNTIME_API_VERSION, requestId: '-bad', method: 'observe', params: {} }).some((p) => p.includes('requestId')));
  assert.ok(requestProblems({ apiVersion: RUNTIME_API_VERSION, requestId: 'rq_1', method: 'Observe', params: {} }).some((p) => p.includes('method')));
  assert.ok(requestProblems({ apiVersion: RUNTIME_API_VERSION, requestId: 'rq_1', method: 'observe', params: {}, extra: 1 }).some((p) => p.includes('extra')));
  assert.ok(requestProblems({ apiVersion: RUNTIME_API_VERSION, requestId: 'rq_1', method: 'hub.pairing.start', params: {} }).some((p) => p.includes('not an implemented method')));
  // Platform service families (model configuration, the transitional gui.runs) are implemented but not this client's.
  assert.ok(requestProblems({ apiVersion: RUNTIME_API_VERSION, requestId: 'rq_1', method: 'ai.profiles.list', params: {} }).some((p) => p.includes('does not call')));
  assert.ok(requestProblems({ apiVersion: RUNTIME_API_VERSION, requestId: 'rq_1', method: 'gui.runs.start', params: {} }).some((p) => p.includes('does not call')));
});

test('params: additionalProperties, pattern, oneOf, not, if/then, dependentRequired, uniqueItems, enum null', () => {
  // additionalProperties false
  assert.ok(validator.errors('observe_params', { screenshot: true, desktopId: 'x' }).some((p) => p.includes('desktopId')));
  // pattern on Id
  assert.ok(validator.errors('session_ref_params', { sessionId: 'has space' }).length > 0);
  // oneOf: app.launch needs bundleId xor path
  assert.ok(validator.valid('app_launch_params', { desktopId: 'd', path: '/Applications/X.app' }));
  assert.ok(!validator.valid('app_launch_params', { desktopId: 'd', path: '/x', bundleId: 'b' }));
  assert.ok(!validator.valid('app_launch_params', { desktopId: 'd' }));
  // not: window.list refuses pid together with bundleId
  assert.ok(validator.valid('window_list_params', { bundleId: 'com.x' }));
  assert.ok(!validator.valid('window_list_params', { pid: 1, bundleId: 'com.x' }));
  // if/then: click needs target, type needs text, key needs key, scroll needs direction
  assert.ok(!validator.valid('Action', { kind: 'click' }));
  assert.ok(validator.valid('Action', { kind: 'click', target: { elementRef: 'el_1' } }));
  assert.ok(!validator.valid('Action', { kind: 'type' }));
  assert.ok(validator.valid('Action', { kind: 'type', text: 'hi' }));
  assert.ok(!validator.valid('Action', { kind: 'key' }));
  assert.ok(!validator.valid('Action', { kind: 'scroll' }));
  assert.ok(validator.valid('Action', { kind: 'scroll', direction: 'down', amount: 3 }));
  assert.ok(!validator.valid('Action', { kind: 'hover', target: { elementRef: 'el_1' } }));
  // ActionTarget oneOf: not both
  assert.ok(!validator.valid('ActionTarget', { elementRef: 'e', imagePoint: { x: 1, y: 1 } }));
  // dependentRequired
  assert.ok(!validator.valid('desktop_create_params', { width: 1280 }));
  assert.ok(validator.valid('desktop_create_params', { width: 1280, height: 900 }));
  // uniqueItems
  assert.ok(!validator.valid('runtime_handshake_params', { apiVersions: ['a', 'a'], client: { name: 'n', version: 'v' } }));
  // enum containing null
  assert.ok(validator.valid({ enum: ['success', null] }, null));
  // integer vs number, ranges
  assert.ok(!validator.valid('wait_params', { condition: { kind: 'elementPresent' }, timeoutMs: 99 }));
  assert.ok(!validator.valid('wait_params', { condition: { kind: 'elementPresent' }, timeoutMs: 1000.5 }));
  // anyOf with null
  assert.ok(validator.valid('ProcessIdentity', { pid: 1, startedAt: null }));
  assert.ok(!validator.valid('ProcessIdentity', { pid: 1, startedAt: 'yesterday' }));
  // format date-time
  assert.ok(validator.valid('Timestamp', '2026-10-08T14:03:00+08:00'));
  assert.ok(validator.valid('Timestamp', '2026-10-08T06:03:00.123Z'));
  assert.ok(!validator.valid('Timestamp', '2026-10-08'));
});

test('result schemas: Run invariants (ended => confirmed, external_client => connection_scoped)', () => {
  const run = {
    runId: 'run_1', kind: 'act', origin: 'agent_hub', ownership: 'external_client', lifetime: 'connection_scoped', clientId: 'local:501', connectionId: 'conn_1',
    sessionId: 'ses_1', desktopId: 'desk_1', phase: 'running', outcome: null, quiescence: 'not_confirmed', closingReason: null, revision: 1,
    createdAt: '2026-10-08T06:03:00Z', receipts: [], unknownActions: 0,
  };
  assert.ok(validator.valid('Run', run));
  assert.ok(!validator.valid('Run', { ...run, phase: 'ended', outcome: 'success' }), 'ended needs quiescence confirmed');
  assert.ok(validator.valid('Run', { ...run, phase: 'ended', outcome: 'success', quiescence: 'confirmed' }));
  assert.ok(!validator.valid('Run', { ...run, lifetime: 'platform_durable' }), 'external_client cannot be durable');
});

test('canonicalJson orders keys and drops undefined, so client and server digest the same bytes', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }], e: null }), '{"a":[{"d":2}],"b":1,"e":null}');
});
