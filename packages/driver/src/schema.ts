// The contract snapshot (contracts/agentdesktop-runtime-v1) and a small JSON
// Schema validator that covers the keywords runtime.schema.json uses. The
// validator is deliberately a subset: no remote refs, no $dynamicRef, no
// unevaluated*, no content*. Anything it does not understand is ignored, so a
// new keyword in a future snapshot degrades to "not checked", never to a
// false rejection.
import { readFileSync } from 'node:fs';

const CONTRACT_DIR = new URL('../../../contracts/agentdesktop-runtime-v1/', import.meta.url);

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, CONTRACT_DIR), 'utf8')) as T;
}

export interface MethodSpec {
  method: string;
  stage: string;
  mutation: boolean;
  params: string;
  result: string;
  status: string;
  note?: string;
}

export interface MethodsContract {
  apiVersion: string;
  status: string;
  transport: { maxFrameBytes: number; countIncludesNewline: boolean; firstMethod: string; [k: string]: unknown };
  methods: MethodSpec[];
  catalog: { method: string; status: string; [k: string]: unknown }[];
}

export interface ErrorSpec {
  code: string;
  exitCode: number;
  phase: 'local' | 'connect' | 'transport' | 'handshake' | 'request' | 'handler';
  reserved?: boolean;
  description: string;
}

export interface ErrorsContract { apiVersion: string; status: string; codes: ErrorSpec[] }

export type JsonSchema = boolean | { [keyword: string]: unknown };

export const runtimeSchema: { $defs: Record<string, JsonSchema>; [k: string]: unknown } = loadJson('runtime.schema.json');
export const methodsContract: MethodsContract = loadJson('methods.json');
export const errorsContract: ErrorsContract = loadJson('errors.json');

/**
 * The runtime/1 GUI surface this client may call, by name: the snapshot's
 * implemented methods minus the platform's own service families. `ai.*`
 * (model configuration, params in service.schema.json) belongs to the
 * AgentDesktop UI, and `gui.runs.*` is transitional until unit.run; the
 * WeChat Agent calls neither, so they are refused locally. Of `hub.*` it
 * asks only to pair (hub.pairing.start/status): approving, granting,
 * revoking and listing clients are the owner's, and this app never asks
 * for owner calls (A4: no owner identity, no back door).
 */
const NOT_FOR_THIS_CLIENT = /^(ai|gui\.runs)\.|^hub\.(?!pairing\.(start|status)$)|^runtime\.enableInput$/;
export const METHODS: ReadonlyMap<string, MethodSpec> = new Map(
  methodsContract.methods.filter((m) => !NOT_FOR_THIS_CLIENT.test(m.method)).map((m) => [m.method, m]),
);
/** Every implemented method the snapshot lists, including the ones this client never calls. */
export const ALL_IMPLEMENTED_METHODS: ReadonlyMap<string, MethodSpec> = new Map(methodsContract.methods.map((m) => [m.method, m]));
/** Error codes of the snapshot, by code. */
export const ERROR_CODES: ReadonlyMap<string, ErrorSpec> = new Map(errorsContract.codes.map((e) => [e.code, e]));

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

const patternCache = new Map<string, RegExp>();
function regex(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    patternCache.set(pattern, re);
  }
  return re;
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

export class SchemaValidator {
  constructor(private readonly root: { $defs?: Record<string, JsonSchema>; [k: string]: unknown }) {}

  /** `#/$defs/Name`, `#/path/...` or a bare def name. */
  resolve(ref: string): JsonSchema {
    if (!ref.startsWith('#')) {
      const def = this.root.$defs?.[ref];
      if (def === undefined) throw new Error(`unknown schema definition: ${ref}`);
      return def;
    }
    const parts = ref.slice(1).split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let node: unknown = this.root;
    for (const part of parts) {
      if (!isPlainObject(node) || !(part in node)) throw new Error(`unresolvable $ref: ${ref}`);
      node = node[part];
    }
    return node as JsonSchema;
  }

  /** Returns a list of problems; empty means valid. */
  errors(schema: JsonSchema | string, value: unknown): string[] {
    const out: string[] = [];
    this.check(typeof schema === 'string' ? this.resolve(schema) : schema, value, '$', out);
    return out;
  }

  valid(schema: JsonSchema | string, value: unknown): boolean {
    return this.errors(schema, value).length === 0;
  }

  private check(schema: JsonSchema, value: unknown, path: string, out: string[]): void {
    if (schema === true) return;
    if (schema === false) { out.push(`${path}: no value is allowed here`); return; }
    const s = schema;

    if (typeof s.$ref === 'string') this.check(this.resolve(s.$ref), value, path, out);

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => matchesType(t, value))) out.push(`${path}: expected ${types.join('|')}`);
    }
    if ('const' in s && !deepEqual(s.const, value)) out.push(`${path}: must equal ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) out.push(`${path}: not one of ${JSON.stringify(s.enum)}`);

    if (typeof value === 'string') {
      if (typeof s.minLength === 'number' && codePoints(value) < s.minLength) out.push(`${path}: shorter than ${s.minLength}`);
      if (typeof s.maxLength === 'number' && codePoints(value) > s.maxLength) out.push(`${path}: longer than ${s.maxLength}`);
      if (typeof s.pattern === 'string' && !regex(s.pattern).test(value)) out.push(`${path}: does not match ${s.pattern}`);
      if (s.format === 'date-time' && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) out.push(`${path}: not a date-time`);
    }

    if (typeof value === 'number') {
      if (typeof s.minimum === 'number' && value < s.minimum) out.push(`${path}: below minimum ${s.minimum}`);
      if (typeof s.maximum === 'number' && value > s.maximum) out.push(`${path}: above maximum ${s.maximum}`);
      if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) out.push(`${path}: must be > ${s.exclusiveMinimum}`);
      if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) out.push(`${path}: must be < ${s.exclusiveMaximum}`);
    }

    if (isPlainObject(value)) {
      const props = isPlainObject(s.properties) ? s.properties : {};
      if (Array.isArray(s.required)) {
        for (const key of s.required as string[]) if (!(key in value)) out.push(`${path}: missing ${key}`);
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in value) this.check(sub as JsonSchema, value[key], `${path}.${key}`, out);
      }
      if (s.additionalProperties !== undefined) {
        for (const key of Object.keys(value)) {
          if (key in props) continue;
          if (s.additionalProperties === false) out.push(`${path}: unexpected property ${key}`);
          else if (s.additionalProperties !== true) this.check(s.additionalProperties as JsonSchema, value[key], `${path}.${key}`, out);
        }
      }
      const count = Object.keys(value).length;
      if (typeof s.maxProperties === 'number' && count > s.maxProperties) out.push(`${path}: more than ${s.maxProperties} properties`);
      if (typeof s.minProperties === 'number' && count < s.minProperties) out.push(`${path}: fewer than ${s.minProperties} properties`);
      if (isPlainObject(s.dependentRequired)) {
        for (const [key, deps] of Object.entries(s.dependentRequired)) {
          if (key in value) for (const dep of deps as string[]) if (!(dep in value)) out.push(`${path}: ${key} requires ${dep}`);
        }
      }
    }

    if (Array.isArray(value)) {
      if (s.items !== undefined) value.forEach((item, i) => this.check(s.items as JsonSchema, item, `${path}[${i}]`, out));
      if (typeof s.minItems === 'number' && value.length < s.minItems) out.push(`${path}: fewer than ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && value.length > s.maxItems) out.push(`${path}: more than ${s.maxItems} items`);
      if (s.uniqueItems === true) {
        for (let i = 0; i < value.length; i += 1) {
          for (let j = i + 1; j < value.length; j += 1) {
            if (deepEqual(value[i], value[j])) { out.push(`${path}: items ${i} and ${j} are equal`); i = value.length; break; }
          }
        }
      }
    }

    if (Array.isArray(s.allOf)) for (const sub of s.allOf) this.check(sub as JsonSchema, value, path, out);
    if (Array.isArray(s.anyOf)) {
      const branches = (s.anyOf as JsonSchema[]).map((sub) => this.errors(sub, value));
      if (!branches.some((b) => b.length === 0)) out.push(`${path}: matches none of anyOf (${branches.map((b) => b.join('; ')).join(' | ')})`);
    }
    if (Array.isArray(s.oneOf)) {
      const passing = (s.oneOf as JsonSchema[]).filter((sub) => this.errors(sub, value).length === 0).length;
      if (passing !== 1) out.push(`${path}: matches ${passing} of oneOf, need exactly 1`);
    }
    if (s.not !== undefined && this.errors(s.not as JsonSchema, value).length === 0) out.push(`${path}: matches the forbidden schema`);
    if (s.if !== undefined) {
      if (this.errors(s.if as JsonSchema, value).length === 0) {
        if (s.then !== undefined) this.check(s.then as JsonSchema, value, path, out);
      } else if (s.else !== undefined) {
        this.check(s.else as JsonSchema, value, path, out);
      }
    }
  }
}

/** Validator bound to the frozen runtime.schema.json. */
export const validator = new SchemaValidator(runtimeSchema);

export function paramsSchemaName(method: string): string {
  const spec = METHODS.get(method);
  if (!spec) throw new Error(`method not in the contract snapshot: ${method}`);
  return spec.params;
}

export function resultSchemaName(method: string): string {
  const spec = METHODS.get(method);
  if (!spec) throw new Error(`method not in the contract snapshot: ${method}`);
  return spec.result;
}

/** Problems with a full request envelope plus its method-specific params. */
export function requestProblems(request: unknown): string[] {
  const problems = validator.errors('Request', request);
  if (problems.length) return problems;
  const { method, params } = request as { method: string; params: unknown };
  const spec = METHODS.get(method);
  if (!spec) {
    return [ALL_IMPLEMENTED_METHODS.has(method)
      ? `$.method: ${method} is a platform service method this client does not call`
      : `$.method: ${method} is not an implemented method of the snapshot`];
  }
  return validator.errors(spec.params, params).map((p) => p.replace(/^\$/, '$.params'));
}

/** Problems with a method's result object. */
export function resultProblems(method: string, data: unknown): string[] {
  return validator.errors(resultSchemaName(method), data);
}

/** Deterministic key order, so two parties compute the same digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Removes keys whose value is undefined (what JSON.stringify would drop anyway), one level deep. */
export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}
