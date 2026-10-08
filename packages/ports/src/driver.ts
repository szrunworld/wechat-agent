// The only seam to the platform: AgentDesktop runtime/1 over runtime.sock.
// Wire types follow contracts/agentdesktop-runtime-v1/runtime.schema.json.
// Lane A implements this; lanes D, E and H consume it.

import type { Id, Timestamp } from './domain.ts';

export const RUNTIME_API_VERSION = 'agentdesktop.runtime/1';
/**
 * The host's single runtime/1 endpoint (agentdesktop main fa2222f, A2): runtime.sock.
 * ai.sock is gone and control.sock is not an execution entry. The driver expands `~`;
 * it never probes other sockets.
 */
export const DEFAULT_RUNTIME_ENDPOINT = '~/Library/Application Support/AgentDesktop/runtime.sock';
export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_ARTIFACT_CHUNK_BYTES = 524_288;
export const EXPECTED_PRODUCT = 'AgentDesktop';

export type RuntimeErrorCode =
  | 'invalid_argument' | 'schema_invalid' | 'frame_too_large' | 'not_found' | 'invalid_target'
  | 'runtime_offline' | 'permission_denied' | 'ownership_escalation_denied' | 'approval_required'
  | 'control_busy' | 'stale_observation' | 'idempotency_conflict' | 'conflict' | 'run_not_active'
  | 'input_disabled' | 'stop_pending' | 'handshake_required' | 'version_mismatch' | 'instance_mismatch'
  | 'capability_missing' | 'model_unavailable' | 'execution_failed' | 'internal_error' | 'limit_exceeded'
  | 'events_cursor_expired' | 'wait_timeout' | 'deadline_exceeded' | 'pairing_required' | 'client_revoked'
  | 'grant_missing' | 'grant_expired' | 'permit_expired' | 'target_moved' | 'audit_unavailable'
  | 'unsupported_backend' | 'capability_mismatch' | 'connection_lost' | 'request_acceptance_unknown'
  | 'action_delivery_unknown' | 'cancel_acceptance_unknown';

export type ErrorPhase = 'local' | 'connect' | 'transport' | 'handshake' | 'request' | 'handler';

export interface RuntimeError {
  code: RuntimeErrorCode | string;
  message: string;
  phase: ErrorPhase;
  retryable: boolean;
  /** true only when it is certain the request never reached the Runtime. */
  notSent?: boolean;
  details?: Record<string, unknown>;
}

export class DriverError extends Error {
  constructor(readonly error: RuntimeError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'DriverError';
  }
}

export interface RequestContext { sessionId?: Id; runId?: Id; desktopId?: Id }

export interface RuntimeRequest<P = Record<string, unknown>> {
  apiVersion: typeof RUNTIME_API_VERSION;
  requestId: Id;
  method: string;
  context?: RequestContext;
  deadline?: Timestamp;
  params: P;
}

export type RuntimeResponse<D = Record<string, unknown>> =
  | { apiVersion: typeof RUNTIME_API_VERSION; requestId: Id; ok: true; data: D }
  | { apiVersion: typeof RUNTIME_API_VERSION; requestId: Id | null; ok: false; error: RuntimeError };

export interface Principal { clientId: string; role: 'owner' | 'paired'; connectionId: Id }

export interface RuntimeIdentity {
  product: string;
  productVersion: string;
  apiVersion: string;
  apiVersions: string[];
  instanceId: Id;
  pid: number;
  startedAt: Timestamp;
  endpoint: string;
  platform: Record<string, unknown>;
  build: { source: string; builtAt?: string };
}

export interface HandshakeResult { identity: RuntimeIdentity; principal?: Principal; raw: Record<string, unknown> }

export interface CapabilityMethod { method: string; mutation: boolean; stage: 'P0' | 'P1' | 'P2' }
export interface Capabilities {
  apiVersion: string;
  interface: { methods: CapabilityMethod[] };
  backend: {
    platform: Record<string, unknown>;
    permissions: { screenRecording: string; accessibility: string };
    features: string[];
  };
  /** GUI unit capabilities (unit.run); not used by this app in P0. */
  gui?: Record<string, unknown>;
}

export interface ProcessIdentity { pid: number; startedAt: Timestamp | null }
export interface Rect { x: number; y: number; width: number; height: number }
export interface ObservedTarget { generation: number; process: ProcessIdentity; windowId: number; windowFrame: Rect; title: string }
/** global point = origin + pixel / scale */
export interface ImageTransform { originX: number; originY: number; scale: number }
export interface ImageArtifact { artifactId: Id; mediaType: 'image/png'; width: number; height: number; byteSize: number; sha256: string; transform: ImageTransform }
export interface Element { id: Id; role: string; label: string | null; value: string | null; actions: string[]; frame: Rect | null }

export interface Observation {
  snapshotId: Id;
  desktopId: Id;
  sessionId?: Id;
  capturedAt: Timestamp;
  screen: Record<string, unknown>;
  target: ObservedTarget | null;
  image: ImageArtifact | null;
  elements: Element[];
  /** What this observation could see: the element read may be partial or unavailable while the screenshot is complete. */
  coverage?: { screenshot: 'complete' | 'not_requested'; ax: 'complete' | 'partial' | 'unavailable' | 'not_requested'; axReason?: 'deadline' | 'limits' | 'busy' | 'error' };
}

export type ActionTarget = { elementRef: Id } | { imagePoint: { x: number; y: number } };

export type Action =
  | { kind: 'click'; target: ActionTarget; button?: 'left' | 'right'; count?: 1 | 2; modifiers?: Modifier[] }
  | { kind: 'type'; text: string; target?: ActionTarget }
  | { kind: 'key'; key: string; modifiers?: Modifier[]; target?: ActionTarget }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; target?: ActionTarget };
export type Modifier = 'cmd' | 'shift' | 'option' | 'ctrl';

export interface ActionReceipt {
  receiptId: Id;
  requestId: Id;
  runId: Id;
  desktopId: Id;
  sessionId: Id;
  snapshotId: Id;
  delivery: 'dispatched' | 'not_dispatched' | 'unknown';
  execution: 'completed' | 'failed' | 'unknown';
  verification: 'not_requested';
  businessResult?: 'not_evaluated';
  route: string | null;
  target: { generation: number; process: ProcessIdentity; windowId: number; elementRef: Id | null; point: { x: number; y: number } | null };
  timing: { acceptedAt: Timestamp; dispatchedAt: Timestamp; completedAt: Timestamp };
  /** Why the action was not delivered, failed or has an unknown outcome; absent when delivered. */
  reason?: { code: string; message: string };
}

export type RunPhase = 'queued' | 'running' | 'waiting_approval' | 'waiting_input' | 'stopping' | 'ended';
export type RunOutcome = 'success' | 'failed' | 'cancelled' | 'unknown' | null;
export type Quiescence = 'not_confirmed' | 'pending' | 'confirmed';

export interface Run {
  runId: Id;
  kind: 'act' | 'exec' | 'unit';
  origin: 'agent_hub' | 'gui_explorer' | 'workflow_replay' | 'user';
  ownership: 'external_client' | 'platform';
  lifetime: 'connection_scoped' | 'platform_durable';
  clientId: string | null;
  connectionId: string | null;
  sessionId: Id;
  desktopId: Id;
  phase: RunPhase;
  outcome: RunOutcome;
  quiescence: Quiescence;
  closingReason: string | null;
  revision: number;
  createdAt: Timestamp;
  endedAt?: Timestamp;
  receipts: Id[];
  unknownActions: number;
  /** Set on unit runs only. */
  unit?: Record<string, unknown>;
}

export interface RunEvent { runId: Id; sequence: number; at: Timestamp; type: string; data: Record<string, unknown> }
export interface EventFrame { apiVersion: string; event: RunEvent; cursor?: number }

export interface CancelReceipt {
  cancelRequest: { accepted: true; scope: { kind: 'run'; id: Id } };
  execution: { phase: string; quiescence: string; outcome: string | null; revision: number };
  alreadyTerminal?: boolean;
}

export interface RequestRecord { requestId: Id; method: string; state: 'accepted' | 'completed' | 'failed' | 'unknown'; acceptedAt: Timestamp; finishedAt?: Timestamp; outcome?: Record<string, unknown> }
export interface Artifact { artifactId: Id; mediaType: string; byteSize: number; sha256: string; createdAt: Timestamp; runId?: Id }
export interface Session { sessionId: Id; desktopId: Id; state: 'open' | 'closed'; createdAt: Timestamp; closedAt?: Timestamp }
export interface Desktop { desktopId: Id; name: string; state: 'ready' | 'busy' | 'destroying'; createdAt: Timestamp; screen?: Record<string, unknown>; binding?: Record<string, unknown> | null; openSessions?: number }
export interface Window { windowId: number; process: ProcessIdentity; appName: string; bundleId: string | null; title: string | null; frame: Rect; onScreen: boolean }
export interface WaitCondition { kind: 'elementPresent' | 'elementAbsent'; role?: string; label?: string; labelContains?: string }
export interface WaitResult { satisfied: true; snapshotId: Id; matches: Element[] }

export interface DriverConfig {
  /** Defaults to DEFAULT_RUNTIME_ENDPOINT. There is no fallback list. */
  endpoint?: string;
  client: { name: string; version: string };
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

/** A subscription connection: one async iterator of frames, independent of the control connection. */
export interface EventStream extends AsyncIterable<EventFrame> {
  /** Resume point for a new subscription after a drop. */
  readonly cursor: number;
  close(): Promise<void>;
}

export type DriverState = 'disconnected' | 'connecting' | 'connected' | 'incompatible' | 'closed';

/**
 * Everything the app may ask of the platform. One control connection per
 * driver; `subscribe` opens its own. Methods throw DriverError with the
 * platform's error (phase/notSent preserved), never a bare string.
 */
export interface AgentDesktopDriver {
  readonly state: DriverState;
  /** Opens the control connection and performs runtime.handshake; refuses a product/apiVersion mismatch. */
  connect(): Promise<HandshakeResult>;
  close(): Promise<void>;
  capabilities(): Promise<Capabilities>;
  status(): Promise<Record<string, unknown>>;
  listDesktops(): Promise<Desktop[]>;
  listWindows(params?: { desktopId?: Id; pid?: number }): Promise<Window[]>;
  bindWindow(params: { desktopId: Id; pid: number; windowId?: number }): Promise<Desktop>;
  unbindWindow(params: { desktopId: Id }): Promise<Desktop>;
  openSession(desktopId: Id): Promise<Session>;
  closeSession(sessionId: Id): Promise<Session>;
  /** A Delegated run: the driver never sends lifetime/ownership/origin (ADR-05). */
  startRun(sessionId: Id): Promise<Run>;
  /** run.finish takes an exitCode on the wire: success → 0, failed → 1, cancelled → 130. */
  finishRun(runId: Id, outcome: 'success' | 'failed' | 'cancelled'): Promise<Run>;
  showRun(runId: Id): Promise<Run>;
  waitRun(runId: Id, timeoutMs: number): Promise<Run>;
  cancelRun(runId: Id): Promise<CancelReceipt>;
  listRuns(): Promise<Run[]>;
  observe(context: { sessionId: Id; runId?: Id }, params?: { screenshot?: boolean; elements?: boolean; query?: string }): Promise<Observation>;
  /** `requestId` is chosen and persisted by the caller before this call; it is the idempotency key. */
  act(context: { sessionId: Id; runId: Id }, params: { snapshotId: Id; action: Action }, requestId: Id): Promise<ActionReceipt>;
  wait(context: { sessionId: Id; runId?: Id }, params: { condition: WaitCondition; timeoutMs: number }): Promise<WaitResult>;
  showRequest(requestId: Id): Promise<RequestRecord>;
  showArtifact(artifactId: Id): Promise<Artifact>;
  /** Reads in chunks of at most MAX_ARTIFACT_CHUNK_BYTES and verifies byteSize and sha256. */
  readArtifact(artifactId: Id): Promise<Uint8Array>;
  subscribe(params?: { runId?: Id; after?: number }): Promise<EventStream>;
}
