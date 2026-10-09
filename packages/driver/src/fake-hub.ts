// A4 caller identity as the Runtime enforces it on runtime.sock
// (agentdesktop #137, docs/security/a4-identity.md), for the Fake Runtime:
// identity only from the handshake credential; unpaired connections may only
// pair; a paired client gets runtime.status plus what its grant covers;
// revoking or narrowing cuts the client's connections. The person's answer in
// the trusted window (Touch ID) is the test's call: approve / deny.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Credential, GrantCapability, GrantRequest, HubGrant, Id, Principal, RequestContext, RuntimeError, Timestamp } from '@wechat-agent/ports';

export interface FakeA4Options {
  /** What the Runtime reads from the peer's code signature; an Electron app is shared_interpreter. */
  codeIdentityLevel?: NonNullable<Principal['codeIdentityLevel']>;
  /** How long a pairing request waits for the person (default 120 s, the trusted window's limit). */
  pairingTtlMs?: number;
  /** After a refusal the same program may not ask again for this long (default 60 s). */
  cooldownMs?: number;
}

/** A refusal in the Runtime's words: code, phase, notSent, details.reason. */
export class HubRefusal extends Error {
  constructor(readonly code: string, message: string, readonly extra: Partial<RuntimeError> = {}) {
    super(message);
  }
}

export interface HubConnection {
  id: Id;
  clientId: string;
  role: 'paired' | 'unpaired';
  /** Set when the owner withdrew this client's access while the connection was open. */
  cutReason?: string;
}

interface ClientRecord { clientId: string; agentName: string; tokenHash: Buffer; state: 'active' | 'revoked'; grant: HubGrant | null }

export interface FakePairing {
  pairingId: Id;
  shortCode: string;
  connectionId: Id;
  agentName: string;
  publisher?: string;
  requested: GrantRequest;
  state: 'requested' | 'approved' | 'denied' | 'expired';
  expiresAt: Timestamp;
  clientId?: string;
  /** The credential, until the asking connection collects it (once). */
  token?: string;
}

const OPEN_METHODS = new Set(['runtime.handshake', 'runtime.capabilities', 'hub.pairing.start', 'hub.pairing.status']);
const PAIRED_BASELINE = new Set(['runtime.status']);
const CAPABILITY_OF: Record<string, GrantCapability> = {};
for (const m of ['desktop.list', 'desktop.show', 'app.list', 'window.list', 'observe', 'wait', 'artifact.show', 'artifact.read', 'session.show', 'request.show']) CAPABILITY_OF[m] = 'observe';
for (const m of ['act', 'session.open', 'session.close']) CAPABILITY_OF[m] = 'act';
for (const m of ['desktop.create', 'desktop.destroy', 'app.launch', 'window.bind', 'window.unbind']) CAPABILITY_OF[m] = 'desktop.manage';
for (const m of ['run.start', 'run.attach', 'run.finish', 'run.show', 'run.events', 'run.wait', 'run.cancel', 'run.list', 'events.subscribe', 'events.unsubscribe', 'runtime.stopAll']) CAPABILITY_OF[m] = 'run';
CAPABILITY_OF['unit.run'] = 'unit.run';
const GRANT_REASON: Record<string, string> = {
  'app.launch': 'launch_requires_grant', 'app.list': 'window_discovery_requires_grant', 'window.list': 'window_discovery_requires_grant',
};

const hash = (token: string): Buffer => createHash('sha256').update(token).digest();
const iso = (ms: number): Timestamp => new Date(ms).toISOString();

export class FakeHub {
  readonly clients = new Map<string, ClientRecord>();
  readonly pairings = new Map<Id, FakePairing>();
  /** Every decision, as the Runtime audits it (method, decision, reason). */
  readonly audit: { at: Timestamp; connectionId: Id; clientId: string; method: string; decision: string; reason: string }[] = [];
  private cooldownUntil = 0;
  private counter = 0;

  constructor(
    readonly options: FakeA4Options,
    private readonly hooks: {
      /** Cut every open connection of a client: shut its socket, end its Runs. */
      cut(clientId: string, reason: string): void;
      /** The Desktop's creator, or undefined when there is no such Desktop. */
      desktopCreator(desktopId: Id): string | undefined;
      /** Bundle id of the app a pid belongs to. */
      bundleOfPid(pid: number): string | null | undefined;
    },
  ) {}

  get codeIdentityLevel(): NonNullable<Principal['codeIdentityLevel']> {
    return this.options.codeIdentityLevel ?? 'shared_interpreter';
  }

  private note(c: HubConnection, method: string, decision: string, reason: string): void {
    this.audit.push({ at: iso(Date.now()), connectionId: c.id, clientId: c.clientId, method, decision, reason });
  }

  /** runtime.handshake: who this connection is. No credential: unpaired. */
  authenticate(credential: Credential | undefined, c: HubConnection): void {
    if (!credential) return;
    const refuse = (code: string, message: string, reason: string): never => {
      this.note(c, 'runtime.handshake', 'denied', `${reason} (claimed ${credential.clientId.slice(0, 80)})`);
      throw new HubRefusal(code, message, { phase: 'handshake', notSent: true, details: { reason } });
    };
    if (credential.clientId.startsWith('local:')) refuse('permission_denied', 'no socket client is the owner of AgentDesktop; pair this app (hub.pairing.start)', 'owner_not_on_socket');
    const client = this.clients.get(credential.clientId);
    const presented = hash(credential.token);
    if (!client || !timingSafeEqual(client.tokenHash, presented)) refuse('permission_denied', `the credential does not prove ${credential.clientId}`, 'bad_credential');
    if (client!.state === 'revoked') refuse('client_revoked', `${credential.clientId} was removed from AgentDesktop; pair again`, 'client_revoked');
    c.clientId = client!.clientId;
    c.role = 'paired';
  }

  /** Why this request may not run, if it may not. Desktops and apps the request names are checked too. */
  authorize(method: string, context: RequestContext, params: Record<string, unknown>, c: HubConnection): void {
    if (OPEN_METHODS.has(method)) return;
    const deny = (e: HubRefusal, reason: string): never => {
      this.note(c, method, 'denied', reason);
      throw e;
    };
    if (c.role !== 'paired') {
      deny(new HubRefusal('pairing_required', `pair this app with AgentDesktop first (hub.pairing.start); ${method} needs a paired client`, { phase: 'request', notSent: true }), 'unpaired');
    }
    if (c.cutReason) deny(cutError(c), 'connection_cut');
    const e = this.accessError(c, method);
    if (e) deny(e, String(e.extra.details?.reason ?? e.code));
    const desktops = new Set([context.desktopId, params.desktopId].filter((d): d is string => typeof d === 'string'));
    if (desktops.size > 1) deny(new HubRefusal('invalid_argument', 'the request names more than one Desktop', { phase: 'request', notSent: true, details: { reason: 'target_mismatch' } }), 'target_mismatch');
    for (const d of desktops) if (!this.desktopAllowed(c, d)) deny(new HubRefusal('not_found', `no desktop ${d}`), 'desktop_out_of_grant');
    if (method === 'app.launch' || method === 'window.bind') {
      const bundle = method === 'app.launch' ? (params.bundleId as string | undefined) : this.hooks.bundleOfPid(params.pid as number);
      if (method === 'app.launch' && params.path !== undefined) deny(new HubRefusal('grant_missing', 'starting an app by path needs a grant this client cannot hold', { phase: 'request', notSent: true, details: { reason: 'launch_requires_grant' } }), 'app_out_of_grant');
      if (!this.appAllowed(c, bundle ?? null)) {
        const launch = method === 'app.launch';
        deny(new HubRefusal('grant_missing', launch ? 'starting this app needs a launch grant for it, which this client does not have' : 'binding this window needs a grant for its app, which this client does not have',
          { phase: 'request', notSent: true, details: { reason: launch ? 'launch_requires_grant' : 'bind_requires_grant' } }), 'app_out_of_grant');
      }
    }
  }

  /** Checked again right before a reply or an action goes out (revocation while waiting). */
  accessLost(method: string, c: HubConnection): HubRefusal | undefined {
    if (c.role !== 'paired' || OPEN_METHODS.has(method)) return undefined;
    return c.cutReason ? cutError(c) : this.accessError(c, method);
  }

  private accessError(c: HubConnection, method: string): HubRefusal | undefined {
    const client = this.clients.get(c.clientId);
    if (!client || client.state !== 'active') return new HubRefusal('client_revoked', `${c.clientId} was removed from AgentDesktop; pair again to continue`, { phase: 'request', notSent: true, details: { reason: 'client_revoked' } });
    const g = client.grant;
    if (!g || g.state !== 'active') return new HubRefusal('grant_missing', `${c.clientId} holds no active grant`, { phase: 'request', notSent: true, details: { reason: 'no_grant' } });
    if (Date.parse(g.expiresAt) <= Date.now()) return new HubRefusal('grant_expired', `the grant of ${c.clientId} expired at ${g.expiresAt}; ask the owner to renew it`, { phase: 'request', notSent: true, details: { reason: 'grant_expired' } });
    if (PAIRED_BASELINE.has(method)) return undefined;
    const capability = CAPABILITY_OF[method];
    if (!capability) return new HubRefusal('permission_denied', `${method} is reserved to the owner of this AgentDesktop`, { phase: 'request', notSent: true, details: { reason: GRANT_REASON[method] ?? 'owner_only' } });
    if (!g.capabilities.includes(capability)) {
      return new HubRefusal('grant_missing', `${method} needs the ${capability} capability, which ${c.clientId} was not granted`, { phase: 'request', notSent: true, details: { reason: GRANT_REASON[method] ?? 'capability', capability } });
    }
    return undefined;
  }

  desktopAllowed(c: HubConnection, desktopId: Id): boolean {
    if (c.role !== 'paired') return false;
    const g = this.clients.get(c.clientId)?.grant;
    if (!g || g.state !== 'active') return false;
    if (g.desktops.includes(desktopId)) return true;
    return g.desktops.includes('created') && this.hooks.desktopCreator(desktopId) === c.clientId;
  }

  appAllowed(c: HubConnection, bundleId: string | null): boolean {
    if (c.role !== 'paired' || !bundleId) return false;
    return this.clients.get(c.clientId)?.grant?.apps.includes(bundleId) ?? false;
  }

  // ---- pairing ----------------------------------------------------------

  startPairing(params: { agentName: string; publisher?: string; requested: GrantRequest }, c: HubConnection): FakePairing {
    this.expireLapsed();
    if (Date.now() < this.cooldownUntil) {
      this.note(c, 'hub.pairing.start', 'denied', 'pairing_cooldown');
      throw new HubRefusal('permission_denied', 'the user just refused this program; try again in a minute', { phase: 'request', notSent: true, details: { reason: 'pairing_cooldown' } });
    }
    // One open request per program; the fake has one program (this test process).
    if ([...this.pairings.values()].some((p) => p.state === 'requested')) {
      this.note(c, 'hub.pairing.start', 'denied', 'pairing_busy');
      throw new HubRefusal('permission_denied', 'a pairing request from this program is already waiting; answer it first', { phase: 'request', notSent: true, details: { reason: 'pairing_busy' } });
    }
    this.counter += 1;
    const pairing: FakePairing = {
      pairingId: `pair_${this.counter}`, shortCode: String(100000 + Math.floor(Math.random() * 900000)), connectionId: c.id,
      agentName: params.agentName, publisher: params.publisher, requested: params.requested, state: 'requested',
      expiresAt: iso(Date.now() + (this.options.pairingTtlMs ?? 120_000)),
    };
    this.pairings.set(pairing.pairingId, pairing);
    this.note(c, 'hub.pairing.start', 'requested', pairing.pairingId);
    return pairing;
  }

  pairingStatus(pairingId: Id, c: HubConnection): Record<string, unknown> {
    this.expireLapsed();
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.connectionId !== c.id) throw new HubRefusal('not_found', `no pairing ${pairingId}`);
    const out: Record<string, unknown> = { pairingId: pairing.pairingId, state: pairing.state, expiresAt: pairing.expiresAt };
    if (pairing.clientId) out.clientId = pairing.clientId;
    if (pairing.state === 'approved' && pairing.clientId && pairing.token) {
      out.credential = { clientId: pairing.clientId, token: pairing.token };
      delete pairing.token; // once
      const grant = this.clients.get(pairing.clientId)?.grant;
      if (grant) out.grant = { ...grant };
    }
    return out;
  }

  /** The asking connection closed: its open request lapses (A4). */
  connectionClosed(connectionId: Id): void {
    for (const p of this.pairings.values()) if (p.connectionId === connectionId && p.state === 'requested') p.state = 'expired';
  }

  private expireLapsed(): void {
    for (const p of this.pairings.values()) if (p.state === 'requested' && Date.parse(p.expiresAt) <= Date.now()) p.state = 'expired';
  }

  private pending(pairingId?: Id): FakePairing {
    const pairing = pairingId ? this.pairings.get(pairingId) : [...this.pairings.values()].reverse().find((p) => p.state === 'requested');
    if (!pairing || pairing.state !== 'requested') throw new Error(`no pairing request is waiting${pairingId ? ` (${pairingId})` : ''}`);
    return pairing;
  }

  /** The person approves in the trusted window (Touch ID passed): exactly what was asked, duration from now. */
  approve(pairingId?: Id): { clientId: string; grant: HubGrant } {
    const pairing = this.pending(pairingId);
    this.counter += 1;
    const clientId = `app:${randomBytes(8).toString('hex')}`;
    const token = `adt1_${randomBytes(32).toString('base64url')}`;
    const r = pairing.requested;
    const grant: HubGrant = {
      clientId, capabilities: [...r.capabilities], desktops: [...(r.desktops ?? [])], apps: [...(r.apps ?? [])],
      expiresAt: iso(Date.now() + (r.durationSeconds ?? 3600) * 1000), revision: 1, state: 'active',
    };
    this.clients.set(clientId, { clientId, agentName: pairing.agentName, tokenHash: hash(token), state: 'active', grant });
    pairing.state = 'approved';
    pairing.clientId = clientId;
    pairing.token = token;
    return { clientId, grant };
  }

  /**
   * A client the person paired earlier (test setup: the trusted window and Touch ID happened before the
   * test). Returns the credential the app would have stored.
   */
  preapprove(requested: GrantRequest, agentName = 'WeChat Agent'): { credential: Credential; grant: HubGrant } {
    const pairing: FakePairing = {
      pairingId: `pair_pre_${++this.counter}`, shortCode: '000000', connectionId: 'conn_setup', agentName, requested, state: 'requested',
      expiresAt: iso(Date.now() + 60_000),
    };
    this.pairings.set(pairing.pairingId, pairing);
    const { clientId, grant } = this.approve(pairing.pairingId);
    const token = pairing.token!;
    delete pairing.token;
    return { credential: { clientId, token }, grant };
  }

  /** The person denies, cancels or lets it time out: the same program waits a minute before asking again. */
  deny(pairingId?: Id, reason: 'user_denied' | 'user_cancelled' | 'confirmation_timeout' | 'no_trusted_ui' = 'user_denied'): void {
    const pairing = this.pending(pairingId);
    pairing.state = 'denied';
    if (reason !== 'no_trusted_ui') this.cooldownUntil = Date.now() + (this.options.cooldownMs ?? 60_000);
  }

  /** hub.clients.revoke by the owner: the credential stops working for good, open connections are cut. */
  revokeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`unknown client ${clientId}`);
    client.state = 'revoked';
    this.hooks.cut(clientId, 'client_revoked');
  }

  /** hub.grants.revoke by the owner: the credential still proves the client, but it may do nothing. */
  revokeGrant(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client?.grant) throw new Error(`no grant for ${clientId}`);
    client.grant = { ...client.grant, state: 'revoked', revision: client.grant.revision + 1 };
    this.hooks.cut(clientId, 'grant_revoked');
  }

  /** hub.grants.set by the owner. Narrowing cuts the client's connections; widening does not. */
  setGrant(clientId: string, change: Partial<Pick<HubGrant, 'capabilities' | 'desktops' | 'apps' | 'expiresAt'>>): HubGrant {
    const client = this.clients.get(clientId);
    if (!client?.grant) throw new Error(`no grant for ${clientId}`);
    const before = client.grant;
    const after: HubGrant = { ...before, ...change, state: 'active', revision: before.revision + 1 };
    client.grant = after;
    const lost = (a: string[], b: string[]) => a.some((x) => !b.includes(x));
    if (lost(before.capabilities, after.capabilities) || lost(before.desktops, after.desktops) || lost(before.apps, after.apps)) this.hooks.cut(clientId, 'grant_narrowed');
    return after;
  }

  /** The grant's time ran out (no owner action, nothing is cut; the next check refuses). */
  expireGrant(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client?.grant) throw new Error(`no grant for ${clientId}`);
    client.grant = { ...client.grant, expiresAt: iso(Date.now() - 1000) };
  }

  clearCooldown(): void {
    this.cooldownUntil = 0;
  }
}

function cutError(c: HubConnection): HubRefusal {
  const reason = c.cutReason ?? 'connection_cut';
  return new HubRefusal(reason === 'client_revoked' ? 'client_revoked' : 'grant_missing', `the owner withdrew the access of ${c.clientId} on this connection (${reason}); reconnect`,
    { phase: 'request', notSent: true, details: { reason } });
}
