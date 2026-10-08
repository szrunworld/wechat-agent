// Lane A: the AgentDesktop runtime/1 driver and a fault-injecting Fake Runtime.
// See docs/lanes/lane-a.md and packages/driver/README.md.
export { createDriver, resolveEndpoint } from './client.ts';
export { FakeRuntime, type FakeRuntimeOptions, type FakeFault, type LoggedRequest } from './fake-runtime.ts';
export { encodeFrame, LineDecoder } from './framing.ts';
export { RpcConnection } from './connection.ts';
export {
  SchemaValidator, validator, runtimeSchema, methodsContract, errorsContract, METHODS, ALL_IMPLEMENTED_METHODS, ERROR_CODES,
  requestProblems, resultProblems, paramsSchemaName, resultSchemaName, canonicalJson,
  type JsonSchema, type MethodSpec, type ErrorSpec,
} from './schema.ts';
