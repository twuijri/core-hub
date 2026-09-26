/**
 * Linked hubs (ADR 0026): one Core Hub linked to another, safely and for little.
 *
 * What a link allows, and nothing more:
 *   - each side lists the agents the other shares (names and descriptions);
 *   - a person on one side asks one shared agent on the other one question and gets the
 *     answer. The asked hub answers as its **peer guest**: from the shared agent's model,
 *     without tools, files, memory or conversation (`runner.ask`, the tool-free one-shot).
 *
 * Nothing else crosses: no files, memory, tasks, providers or keys. The peer guest is not a
 * user and has no token; it exists only inside the two signed routes below.
 *
 * Linking needs both owners: the inviting hub's admin makes a single-use invite (10 minutes,
 * only its hash kept), the other hub's admin redeems it (`requestPeer` → `peerJoin`), and the
 * inviting admin approves. Each side keeps the other's Ed25519 public key; every later call is
 * signed (`peer-crypto.ts`) and checked for time, nonce and recipient. Deleting a peer drops its
 * key at once. Everything is written to the peer's audit log (`peer_events`) on both sides.
 */
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PRODUCT } from '@corehub/contracts';
import { newUlid } from '../../db/ids.js';
import type { ModuleDb } from '../../lib/db.js';
import { HubError, conflict, notFound, stateInvalid, validationFailed } from '../../lib/errors.js';
import { defineRoute, type RouteDeps } from '../../lib/route.js';
import type { Language } from '../../i18n/index.js';
import type { Sealer } from './push.js';
import {
  JOIN_RECIPIENT,
  PEER_HEADERS,
  SIGNATURE_WINDOW_MS,
  bodyText,
  canonical,
  compactFingerprint,
  fingerprint,
  generateKeys,
  isPublicKey,
  sha256Hex,
  signedHeaders,
  verifyText,
} from './peer-crypto.js';
import {
  peerEvents,
  peerIdentity,
  peerInvites,
  peerNonces,
  peerShares,
  peers,
  type PeerEventKind,
} from './schema.js';

export const INVITE_TTL_MS = 10 * 60_000;
export const MAX_OPEN_INVITES = 5;
export const MAX_PEERS = 50;
/** Signed calls one peer may make in a minute, whatever they are. */
export const PEER_CALLS_PER_MINUTE = 60;
/** Invite redemptions one address may try in a minute. */
export const JOINS_PER_MINUTE = 10;
export const DEFAULT_ASKS_PER_HOUR = 30;
/** The peer guest's question: how long it may take and how long its answer may be. */
export const ASK_TIMEOUT_MS = 120_000;
export const ASK_MAX_TOKENS = 2_000;
const MAX_ANSWER_CHARS = 64_000;
const CALL_TIMEOUT_MS = 15_000;
/** The asking side waits a little longer than the answering side's own limit. */
const ASK_CALL_TIMEOUT_MS = ASK_TIMEOUT_MS + 15_000;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** What the composition root lends this file: the agents, and asking one of them. */
export interface PeerAgentsPort {
  /** Every agent of every profile, for the share list. */
  list(
    app: FastifyInstance,
    language: Language,
  ): Array<{ workspaceId: string; profile: string; agentId: string; name: string }>;
  /** One question, no tools; `null` when the agent gave no answer. */
  ask(
    app: FastifyInstance,
    input: {
      workspaceId: string;
      agentId: string;
      prompt: string;
      timeoutMs: number;
      maxTokens: number;
    },
  ): Promise<string | null>;
}

export interface PeerContext {
  db(app: FastifyInstance): ModuleDb;
  sealer(app: FastifyInstance): Sealer;
  agents: PeerAgentsPort;
  now(): number;
  fetch(): typeof fetch;
  base: string;
}

type PeerRow = typeof peers.$inferSelect;

// ------------------------------------------------------------------ small helpers

function inviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let out = '';
  for (const byte of bytes) out += CROCKFORD[byte % 32];
  return out;
}

/** The origin this request reached the hub on, as its client saw it. */
function ownOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

function httpsOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function serializePeer(row: PeerRow) {
  return {
    id: row.id,
    name: row.name,
    hub_name: row.hubName,
    url: row.url,
    direction: row.direction,
    status: row.status,
    enabled: row.enabled,
    fingerprint: row.fingerprint,
    version: row.version ?? null,
    asks_per_hour: row.asksPerHour,
    last_seen_at: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    approved_at: row.approvedAt ? row.approvedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

/** Sliding-window counters, per hub (in memory: a restart forgives, it never lets more in). */
export class PeerLimiter {
  private readonly hits = new Map<string, number[]>();
  take(key: string, limit: number, windowMs: number, now: number): boolean {
    const since = now - windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
const limiters = new WeakMap<object, PeerLimiter>();
function limiterOf(app: FastifyInstance): PeerLimiter {
  const key = app.hub.io as object;
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new PeerLimiter();
    limiters.set(key, limiter);
  }
  return limiter;
}

const refused = (status: 'unauthorized' | 'forbidden', reason: string) =>
  new HubError(status, { details: { reason } });

// ------------------------------------------------------------------ identity and log

export interface Identity {
  hubId: string;
  publicKey: string;
  privateKey: string;
}

export function identityOf(db: ModuleDb, sealer: Sealer): Identity {
  const row = db.select().from(peerIdentity).get();
  if (row) {
    return {
      hubId: row.id,
      publicKey: row.publicKey,
      privateKey: sealer.open({ ciphertext: row.ciphertext, nonce: row.nonce, keyId: row.keyId }),
    };
  }
  const keys = generateKeys();
  const sealed = sealer.seal(keys.privateKey);
  const hubId = newUlid();
  db.insert(peerIdentity)
    .values({ id: hubId, publicKey: keys.publicKey, ...sealed })
    .onConflictDoNothing()
    .run();
  // Two first calls at once: the row that won is the identity.
  return identityOf(db, sealer);
}

function logEvent(
  db: ModuleDb,
  input: {
    peerId: string;
    kind: PeerEventKind;
    ok: boolean;
    detail?: string | null;
    actorId?: string | null;
    now: number;
  },
): void {
  db.insert(peerEvents)
    .values({
      id: newUlid(input.now),
      peerId: input.peerId,
      kind: input.kind,
      ok: input.ok,
      detail: input.detail ? input.detail.slice(0, 200) : null,
      actorId: input.actorId ?? null,
      createdAt: new Date(input.now),
    })
    .run();
}

// ------------------------------------------------------------------ verifying a signed call

/**
 * Checks a signed hub-to-hub call and returns the calling peer. In order: the headers, the
 * clock, the key (an unknown hub is refused without a log line: there is no peer to log it
 * against), the signature, then the nonce — last, so a forged call cannot fill the store.
 */
export function verifySigned(
  ctx: PeerContext,
  app: FastifyInstance,
  request: FastifyRequest,
  body: unknown,
): PeerRow {
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === 'string' ? value : null;
  };
  const hubId = header(PEER_HEADERS.hub);
  const timestamp = header(PEER_HEADERS.timestamp);
  const nonce = header(PEER_HEADERS.nonce);
  const signature = header(PEER_HEADERS.signature);
  if (!hubId || !timestamp || !nonce || !signature || !/^\d{1,16}$/.test(timestamp)) {
    throw refused('unauthorized', 'peer_signature_missing');
  }
  if (nonce.length > 64) throw refused('unauthorized', 'peer_signature_missing');
  const db = ctx.db(app);
  const now = ctx.now();
  const peer = db.select().from(peers).where(eq(peers.hubId, hubId)).get();
  if (!peer) throw refused('unauthorized', 'peer_unknown');
  const refuse = (reason: string): never => {
    logEvent(db, { peerId: peer.id, kind: 'refused', ok: false, detail: reason, now });
    throw refused('unauthorized', reason);
  };
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS) refuse('peer_clock_skew');
  const me = identityOf(db, ctx.sealer(app));
  const text = canonical({
    method: request.method,
    path: request.url,
    timestamp,
    nonce,
    body: bodyText(body),
    recipient: me.hubId,
  });
  if (!verifyText(peer.publicKey, text, signature)) refuse('peer_signature_invalid');
  db.delete(peerNonces)
    .where(lt(peerNonces.expiresAt, new Date(now)))
    .run();
  const taken = db
    .insert(peerNonces)
    .values({
      id: newUlid(now),
      peerHubId: hubId,
      nonce,
      expiresAt: new Date(Number(timestamp) + SIGNATURE_WINDOW_MS),
    })
    .onConflictDoNothing()
    .run();
  if (taken.changes === 0) refuse('peer_replay');
  if (!limiterOf(app).take(`calls:${peer.id}`, PEER_CALLS_PER_MINUTE, 60_000, now)) {
    logEvent(db, { peerId: peer.id, kind: 'refused', ok: false, detail: 'rate_limited', now });
    throw new HubError('rate_limited', { details: { reason: 'peer_calls' } });
  }
  db.update(peers)
    .set({ lastSeenAt: new Date(now) })
    .where(eq(peers.id, peer.id))
    .run();
  return peer;
}

/**
 * A call that may use the link: the peer is enabled, and linked — or `waiting` on this side,
 * which a signed call from it ends (it could only call because its owner approved).
 */
function requireUsable(ctx: PeerContext, app: FastifyInstance, peer: PeerRow): PeerRow {
  const db = ctx.db(app);
  const now = ctx.now();
  if (!peer.enabled) {
    logEvent(db, { peerId: peer.id, kind: 'refused', ok: false, detail: 'peer_disabled', now });
    throw refused('forbidden', 'peer_disabled');
  }
  if (peer.status === 'pending') {
    logEvent(db, { peerId: peer.id, kind: 'refused', ok: false, detail: 'peer_pending', now });
    throw refused('forbidden', 'peer_pending');
  }
  if (peer.status === 'waiting') {
    const linked = db
      .update(peers)
      .set({ status: 'linked', approvedAt: new Date(now) })
      .where(eq(peers.id, peer.id))
      .returning()
      .get();
    logEvent(db, { peerId: peer.id, kind: 'approved_by_peer', ok: true, now });
    return linked ?? peer;
  }
  return peer;
}

// ------------------------------------------------------------------ calling a peer

interface PeerAnswerRaw {
  status: number;
  body: unknown;
}

class PeerUnreachable extends Error {}

async function callPeer(
  ctx: PeerContext,
  app: FastifyInstance,
  target: { url: string; hubId: string | null },
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<PeerAnswerRaw> {
  const me = identityOf(ctx.db(app), ctx.sealer(app));
  const fullPath = `${ctx.base}${path}`;
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers = signedHeaders({
    hubId: me.hubId,
    privateKey: me.privateKey,
    method,
    path: fullPath,
    body: text,
    recipient: target.hubId ?? JOIN_RECIPIENT,
    now: ctx.now(),
  });
  let response: Response;
  try {
    response = await ctx.fetch()(`${target.url}${fullPath}`, {
      method,
      headers: {
        ...headers,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: text }),
      // A peer's address is the one its owner gave: never followed somewhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    app.log.info({ err: error, url: target.url }, 'devices: a linked hub did not answer');
    throw new PeerUnreachable('peer_unreachable');
  }
  const raw = await response.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

const peerCode = (answer: PeerAnswerRaw): string | null => {
  const body = answer.body as { code?: unknown; details?: { reason?: unknown } } | null;
  const reason = body?.details?.reason;
  return typeof reason === 'string' ? reason : typeof body?.code === 'string' ? body.code : null;
};

/** Tells the peer something, best effort: a peer that does not hear it learns on its next call. */
function notify(
  ctx: PeerContext,
  app: FastifyInstance,
  peer: PeerRow,
  kind: 'approved' | 'unlinked',
) {
  return callPeer(
    ctx,
    app,
    { url: peer.url, hubId: peer.hubId },
    'POST',
    '/peer-link/notice',
    { kind },
    5_000,
  ).then(
    (answer) => answer.status === 204,
    () => false,
  );
}

// ------------------------------------------------------------------ routes

export function registerPeerRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  ctx: PeerContext,
  actorOf: (request: FastifyRequest) => { id: string; username: string },
): void {
  const db = () => ctx.db(app);
  const findPeer = (id: string) => {
    const row = db().select().from(peers).where(eq(peers.id, id)).get();
    if (!row) throw notFound({ resource: 'peer', id });
    return row;
  };

  defineRoute(app, deps, {
    operationId: 'devices.listPeers',
    handler: () => ({
      items: db().select().from(peers).orderBy(desc(peers.createdAt)).all().map(serializePeer),
    }),
  });

  defineRoute(app, deps, {
    operationId: 'devices.createPeerInvite',
    status: 201,
    handler: (request) => {
      const origin = ownOrigin(request);
      if (!httpsOrigin(origin)) throw validationFailed({ reason: 'own_url_not_https' });
      const now = ctx.now();
      const open = db()
        .select({ id: peerInvites.id })
        .from(peerInvites)
        .where(and(isNull(peerInvites.usedAt), gt(peerInvites.expiresAt, new Date(now))))
        .all();
      if (open.length >= MAX_OPEN_INVITES) {
        throw stateInvalid({ reason: 'invite_limit', limit: MAX_OPEN_INVITES });
      }
      const me = identityOf(db(), ctx.sealer(app));
      const code = inviteCode();
      const expiresAt = new Date(now + INVITE_TTL_MS);
      db()
        .insert(peerInvites)
        .values({
          id: newUlid(now),
          ownerId: actorOf(request).id,
          codeHash: sha256Hex(code),
          expiresAt,
        })
        .run();
      const print = fingerprint(me.publicKey);
      request.log.info({ expiresAt }, 'devices: a linked-hub invite was made');
      return {
        url: `${origin}/peer-invite/${code}?fp=${compactFingerprint(print)}`,
        expires_at: expiresAt.toISOString(),
        fingerprint: print,
      };
    },
  });

  defineRoute(app, deps, {
    operationId: 'devices.requestPeer',
    status: 201,
    handler: async (request, { body }) => {
      const input = body as { url: string; name?: string };
      const own = httpsOrigin(ownOrigin(request));
      if (!own) throw validationFailed({ reason: 'own_url_not_https' });
      let invite: URL;
      try {
        invite = new URL(input.url);
      } catch {
        throw validationFailed({ field: 'url', reason: 'invite_url_invalid' });
      }
      const origin = httpsOrigin(input.url);
      if (!origin) throw validationFailed({ field: 'url', reason: 'https_required' });
      const code = /^\/peer-invite\/([0-9A-Z]{26})\/?$/.exec(invite.pathname)?.[1];
      const expected = invite.searchParams.get('fp')?.toUpperCase() ?? '';
      if (!code || !/^[0-9A-F]{32}$/.test(expected)) {
        throw validationFailed({ field: 'url', reason: 'invite_url_invalid' });
      }
      if (db().select({ id: peers.id }).from(peers).all().length >= MAX_PEERS) {
        throw stateInvalid({ reason: 'peer_limit', limit: MAX_PEERS });
      }
      const me = identityOf(db(), ctx.sealer(app));
      let answer: PeerAnswerRaw;
      try {
        answer = await callPeer(ctx, app, { url: origin, hubId: null }, 'POST', '/peer-link/join', {
          code,
          hub_id: me.hubId,
          name: PRODUCT.name,
          url: own,
          public_key: me.publicKey,
          version: app.hub.version ?? null,
        });
      } catch {
        throw stateInvalid({ reason: 'peer_unreachable' });
      }
      if (answer.status !== 200) {
        throw stateInvalid({
          reason: answer.status === 404 ? 'invite_refused' : 'peer_refused',
          peer_code: peerCode(answer),
        });
      }
      const joined = answer.body as {
        hub_id?: unknown;
        name?: unknown;
        public_key?: unknown;
        version?: unknown;
      } | null;
      const publicKey = typeof joined?.public_key === 'string' ? joined.public_key : '';
      const hubId = typeof joined?.hub_id === 'string' ? joined.hub_id : '';
      if (!isPublicKey(publicKey) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(hubId)) {
        throw stateInvalid({ reason: 'peer_refused', peer_code: 'bad_answer' });
      }
      const print = fingerprint(publicKey);
      if (compactFingerprint(print) !== expected) {
        request.log.warn({ origin }, 'devices: a linked hub answered with another key');
        throw stateInvalid({ reason: 'fingerprint_mismatch' });
      }
      if (hubId === me.hubId) throw stateInvalid({ reason: 'peer_is_self' });
      if (db().select().from(peers).where(eq(peers.hubId, hubId)).get()) {
        throw conflict({ reason: 'peer_exists' });
      }
      const hubName = (typeof joined?.name === 'string' ? joined.name : '').slice(0, 80) || origin;
      const now = ctx.now();
      const row = db()
        .insert(peers)
        .values({
          id: newUlid(now),
          ownerId: actorOf(request).id,
          hubId,
          name: input.name?.trim() || hubName,
          hubName,
          url: origin,
          direction: 'outbound',
          status: 'waiting',
          publicKey,
          fingerprint: print,
          version: typeof joined?.version === 'string' ? joined.version.slice(0, 40) : null,
          asksPerHour: DEFAULT_ASKS_PER_HOUR,
          lastSeenAt: new Date(now),
        })
        .returning()
        .get();
      logEvent(db(), {
        peerId: row.id,
        kind: 'requested',
        ok: true,
        actorId: actorOf(request).id,
        now,
      });
      return serializePeer(row);
    },
  });

  defineRoute(app, deps, {
    operationId: 'devices.updatePeer',
    handler: async (request, { params, body }) => {
      const peer = findPeer(params.peer_id as string);
      const input = body as {
        name?: string;
        enabled?: boolean;
        approve?: boolean;
        asks_per_hour?: number;
      };
      const now = ctx.now();
      const actor = actorOf(request).id;
      const changes: Partial<typeof peers.$inferInsert> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw validationFailed({ field: 'name', reason: 'empty' });
        changes.name = name;
      }
      if (input.enabled !== undefined) changes.enabled = input.enabled;
      if (input.asks_per_hour !== undefined) changes.asksPerHour = input.asks_per_hour;
      if (input.approve) {
        if (peer.direction !== 'inbound' || peer.status !== 'pending') {
          throw stateInvalid({ reason: 'peer_not_pending' });
        }
        changes.status = 'linked';
        changes.approvedAt = new Date(now);
      }
      const row = db()
        .update(peers)
        .set({ ...changes, updatedAt: new Date(now) })
        .where(eq(peers.id, peer.id))
        .returning()
        .get()!;
      const fields = Object.keys(input).filter((key) => key !== 'approve');
      if (fields.length > 0) {
        logEvent(db(), {
          peerId: peer.id,
          kind: 'updated',
          ok: true,
          detail: fields.join(','),
          actorId: actor,
          now,
        });
      }
      if (input.approve) {
        const told = await notify(ctx, app, row, 'approved');
        logEvent(db(), {
          peerId: peer.id,
          kind: 'approved',
          ok: true,
          detail: told ? null : 'peer_not_told',
          actorId: actor,
          now,
        });
      }
      return serializePeer(row);
    },
  });

  defineRoute(app, deps, {
    operationId: 'devices.deletePeer',
    status: 204,
    handler: (request, { params }) => {
      const peer = findPeer(params.peer_id as string);
      const now = ctx.now();
      // Revoked here first: the key is gone before the other side is even told.
      db().delete(peers).where(eq(peers.id, peer.id)).run();
      db().delete(peerNonces).where(eq(peerNonces.peerHubId, peer.hubId)).run();
      logEvent(db(), {
        peerId: peer.id,
        kind: 'unlinked',
        ok: true,
        actorId: actorOf(request).id,
        now,
      });
      void notify(ctx, app, peer, 'unlinked');
      return null;
    },
  });

  defineRoute(app, deps, {
    operationId: 'devices.listPeerEvents',
    handler: (_request, { params }) => {
      const id = params.peer_id as string;
      const rows = db()
        .select()
        .from(peerEvents)
        .where(eq(peerEvents.peerId, id))
        .orderBy(desc(peerEvents.createdAt), desc(peerEvents.id))
        .limit(200)
        .all();
      if (rows.length === 0) findPeer(id);
      return {
        items: rows.map((row) => ({
          id: row.id,
          peer_id: row.peerId,
          kind: row.kind,
          ok: row.ok,
          detail: row.detail ?? null,
          actor_id: row.actorId ?? null,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  });

  // ---------------------------------------------------------------- shares

  const shareList = (language: Language) => {
    const rows = db().select().from(peerShares).all();
    const byKey = new Map(rows.map((row) => [`${row.workspace}:${row.agentId}`, row]));
    return ctx.agents.list(app, language).map((agent) => {
      const row = byKey.get(`${agent.workspaceId}:${agent.agentId}`);
      return {
        workspaceId: agent.workspaceId,
        profile: agent.profile,
        agent_id: agent.agentId,
        name: agent.name,
        shared: row?.shared ?? false,
        description: row?.description ?? null,
        shareId: row?.id ?? null,
      };
    });
  };
  const publicShare = (share: ReturnType<typeof shareList>[number]) => ({
    profile: share.profile,
    agent_id: share.agent_id,
    name: share.name,
    shared: share.shared,
    description: share.description,
  });

  defineRoute(app, deps, {
    operationId: 'devices.listPeerShares',
    handler: (request) => ({ items: shareList(request.language).map(publicShare) }),
  });

  defineRoute(app, deps, {
    operationId: 'devices.setPeerShare',
    handler: (request, { body }) => {
      const input = body as {
        profile: string;
        agent_id: string;
        shared: boolean;
        description?: string | null;
      };
      const target = shareList(request.language).find(
        (share) => share.profile === input.profile && share.agent_id === input.agent_id,
      );
      if (!target) throw notFound({ resource: 'agent', id: input.agent_id });
      const description =
        input.description === undefined ? target.description : input.description?.trim() || null;
      const now = new Date(ctx.now());
      if (target.shareId) {
        db()
          .update(peerShares)
          .set({ shared: input.shared, description, updatedAt: now })
          .where(eq(peerShares.id, target.shareId))
          .run();
      } else {
        db()
          .insert(peerShares)
          .values({
            id: newUlid(now.getTime()),
            ownerId: actorOf(request).id,
            workspace: target.workspaceId,
            agentId: target.agent_id,
            shared: input.shared,
            description,
          })
          .run();
      }
      request.log.info(
        { profile: target.profile, agentId: target.agent_id, shared: input.shared },
        'devices: an agent share changed',
      );
      return publicShare({ ...target, shared: input.shared, description });
    },
  });

  // ---------------------------------------------------------------- this hub asking a peer

  const usableForCalls = (peer: PeerRow) => {
    if (!peer.enabled) throw stateInvalid({ reason: 'peer_disabled' });
    if (peer.status === 'pending') throw stateInvalid({ reason: 'peer_not_linked' });
  };
  /** A peer that answered a signed call has approved: a `waiting` row becomes linked. */
  const answered = (peer: PeerRow) => {
    if (peer.status !== 'waiting') return;
    const now = ctx.now();
    db()
      .update(peers)
      .set({ status: 'linked', approvedAt: new Date(now) })
      .where(eq(peers.id, peer.id))
      .run();
    logEvent(db(), { peerId: peer.id, kind: 'approved_by_peer', ok: true, now });
  };

  defineRoute(app, deps, {
    operationId: 'devices.listPeerAgents',
    handler: async (request, { params }) => {
      const peer = findPeer(params.peer_id as string);
      usableForCalls(peer);
      const now = ctx.now();
      let answer: PeerAnswerRaw;
      try {
        answer = await callPeer(ctx, app, peer, 'GET', '/peer-link/agents', undefined);
      } catch {
        logEvent(db(), {
          peerId: peer.id,
          kind: 'list_out',
          ok: false,
          detail: 'peer_unreachable',
          actorId: actorOf(request).id,
          now,
        });
        throw stateInvalid({ reason: 'peer_unreachable' });
      }
      const ok = answer.status === 200;
      logEvent(db(), {
        peerId: peer.id,
        kind: 'list_out',
        ok,
        detail: ok ? null : peerCode(answer),
        actorId: actorOf(request).id,
        now,
      });
      if (!ok) {
        if (answer.status === 429) throw new HubError('rate_limited');
        throw stateInvalid({ reason: 'peer_refused', peer_code: peerCode(answer) });
      }
      answered(peer);
      const items = ((answer.body as { items?: unknown } | null)?.items ?? []) as unknown[];
      return {
        items: items
          .filter(
            (item): item is { id: string; name: string; description?: unknown } =>
              !!item &&
              typeof (item as { id?: unknown }).id === 'string' &&
              typeof (item as { name?: unknown }).name === 'string',
          )
          .slice(0, 200)
          .map((item) => ({
            id: item.id,
            name: item.name.slice(0, 120),
            description:
              typeof item.description === 'string' ? item.description.slice(0, 280) : null,
          })),
      };
    },
  });

  defineRoute(app, deps, {
    operationId: 'devices.askPeerAgent',
    handler: async (request, { params, body }) => {
      const peer = findPeer(params.peer_id as string);
      usableForCalls(peer);
      const actor = actorOf(request);
      const now = ctx.now();
      const input = body as { prompt: string };
      let answer: PeerAnswerRaw;
      try {
        answer = await callPeer(
          ctx,
          app,
          peer,
          'POST',
          '/peer-link/ask',
          { agent: params.share_id as string, prompt: input.prompt, asked_by: actor.username },
          ASK_CALL_TIMEOUT_MS,
        );
      } catch {
        logEvent(db(), {
          peerId: peer.id,
          kind: 'ask_out',
          ok: false,
          detail: 'peer_unreachable',
          actorId: actor.id,
          now,
        });
        throw stateInvalid({ reason: 'peer_unreachable' });
      }
      const text = (answer.body as { answer?: unknown } | null)?.answer;
      const ok = answer.status === 200 && typeof text === 'string';
      logEvent(db(), {
        peerId: peer.id,
        kind: 'ask_out',
        ok,
        detail: ok ? null : peerCode(answer),
        actorId: actor.id,
        now,
      });
      if (!ok) {
        if (answer.status === 429) throw new HubError('rate_limited');
        throw stateInvalid({ reason: 'peer_refused', peer_code: peerCode(answer) });
      }
      answered(peer);
      return { answer: text.slice(0, MAX_ANSWER_CHARS) };
    },
  });

  // ---------------------------------------------------------------- hub to hub

  defineRoute(app, deps, {
    operationId: 'devices.peerJoin',
    handler: (request, { body }) => {
      const now = ctx.now();
      if (!limiterOf(app).take(`join:${request.ip}`, JOINS_PER_MINUTE, 60_000, now)) {
        throw new HubError('rate_limited', { details: { reason: 'peer_joins' } });
      }
      const input = body as {
        code: string;
        hub_id: string;
        name: string;
        url: string;
        public_key: string;
        version: string | null;
      };
      if (!isPublicKey(input.public_key)) {
        throw validationFailed({ field: 'public_key', reason: 'not_ed25519' });
      }
      const url = httpsOrigin(input.url);
      if (!url) throw validationFailed({ field: 'url', reason: 'https_required' });
      // The call is signed with the key it registers: whoever sends it holds that key.
      const timestamp = request.headers[PEER_HEADERS.timestamp];
      const nonce = request.headers[PEER_HEADERS.nonce];
      const signature = request.headers[PEER_HEADERS.signature];
      const sender = request.headers[PEER_HEADERS.hub];
      if (
        typeof timestamp !== 'string' ||
        typeof nonce !== 'string' ||
        typeof signature !== 'string' ||
        sender !== input.hub_id ||
        !/^\d{1,16}$/.test(timestamp)
      ) {
        throw refused('unauthorized', 'peer_signature_missing');
      }
      if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS) {
        throw refused('unauthorized', 'peer_clock_skew');
      }
      const text = canonical({
        method: request.method,
        path: request.url,
        timestamp,
        nonce,
        body: bodyText(body),
        recipient: JOIN_RECIPIENT,
      });
      if (!verifyText(input.public_key, text, signature)) {
        throw refused('unauthorized', 'peer_signature_invalid');
      }
      const me = identityOf(db(), ctx.sealer(app));
      if (input.hub_id === me.hubId) throw conflict({ reason: 'peer_is_self' });
      // Single use and 10 minutes, in one statement: two redemptions at once cannot both win.
      const invite = db()
        .update(peerInvites)
        .set({ usedAt: new Date(now) })
        .where(
          and(
            eq(peerInvites.codeHash, sha256Hex(input.code)),
            isNull(peerInvites.usedAt),
            gt(peerInvites.expiresAt, new Date(now)),
          ),
        )
        .returning()
        .get();
      if (!invite) {
        request.log.info('devices: an invite that is unknown, used or expired was presented');
        throw notFound({ resource: 'peer_invite' });
      }
      if (db().select().from(peers).where(eq(peers.hubId, input.hub_id)).get()) {
        throw conflict({ reason: 'peer_exists' });
      }
      if (db().select({ id: peers.id }).from(peers).all().length >= MAX_PEERS) {
        throw stateInvalid({ reason: 'peer_limit', limit: MAX_PEERS });
      }
      const row = db()
        .insert(peers)
        .values({
          id: newUlid(now),
          ownerId: invite.ownerId,
          hubId: input.hub_id,
          name: input.name.trim().slice(0, 80) || url,
          hubName: input.name.trim().slice(0, 80) || url,
          url,
          direction: 'inbound',
          status: 'pending',
          publicKey: input.public_key,
          fingerprint: fingerprint(input.public_key),
          version: input.version?.slice(0, 40) ?? null,
          asksPerHour: DEFAULT_ASKS_PER_HOUR,
          lastSeenAt: new Date(now),
        })
        .returning()
        .get();
      logEvent(db(), { peerId: row.id, kind: 'joined', ok: true, now });
      return {
        hub_id: me.hubId,
        name: PRODUCT.name,
        public_key: me.publicKey,
        version: app.hub.version ?? null,
      };
    },
  });

  defineRoute(app, deps, {
    operationId: 'devices.peerNotice',
    status: 204,
    handler: (request, { body }) => {
      const peer = verifySigned(ctx, app, request, body);
      const now = ctx.now();
      const kind = (body as { kind: 'approved' | 'unlinked' }).kind;
      if (kind === 'approved') {
        if (peer.direction === 'outbound' && peer.status === 'waiting') {
          db()
            .update(peers)
            .set({ status: 'linked', approvedAt: new Date(now) })
            .where(eq(peers.id, peer.id))
            .run();
          logEvent(db(), { peerId: peer.id, kind: 'approved_by_peer', ok: true, now });
        }
      } else {
        db().delete(peers).where(eq(peers.id, peer.id)).run();
        db().delete(peerNonces).where(eq(peerNonces.peerHubId, peer.hubId)).run();
        logEvent(db(), { peerId: peer.id, kind: 'unlinked_by_peer', ok: true, now });
      }
      return null;
    },
  });

  defineRoute(app, deps, {
    operationId: 'devices.peerAgents',
    handler: (request) => {
      const peer = requireUsable(ctx, app, verifySigned(ctx, app, request, undefined));
      const items = shareList('en')
        .filter((share) => share.shared && share.shareId)
        .map((share) => ({ id: share.shareId!, name: share.name, description: share.description }));
      logEvent(db(), {
        peerId: peer.id,
        kind: 'list_in',
        ok: true,
        detail: String(items.length),
        now: ctx.now(),
      });
      return { items };
    },
  });

  defineRoute(app, deps, {
    operationId: 'devices.peerAsk',
    handler: async (request, { body }) => {
      const peer = requireUsable(ctx, app, verifySigned(ctx, app, request, body));
      const input = body as { agent: string; prompt: string; asked_by?: string | null };
      const now = ctx.now();
      const who = input.asked_by ? ` · ${input.asked_by.slice(0, 80)}` : '';
      // An agent that is not shared and one that does not exist get the same answer.
      const share = shareList('en').find((item) => item.shareId === input.agent && item.shared);
      if (!share) {
        logEvent(db(), {
          peerId: peer.id,
          kind: 'refused',
          ok: false,
          detail: `agent_not_shared${who}`,
          now,
        });
        throw refused('forbidden', 'agent_not_shared');
      }
      if (!limiterOf(app).take(`asks:${peer.id}`, peer.asksPerHour, 3_600_000, now)) {
        logEvent(db(), {
          peerId: peer.id,
          kind: 'refused',
          ok: false,
          detail: `rate_limited${who}`,
          now,
        });
        throw new HubError('rate_limited', { details: { reason: 'peer_asks' } });
      }
      const answer = await ctx.agents
        .ask(app, {
          workspaceId: share.workspaceId,
          agentId: share.agent_id,
          prompt: input.prompt,
          timeoutMs: ASK_TIMEOUT_MS,
          maxTokens: ASK_MAX_TOKENS,
        })
        .catch(() => null);
      const text = answer?.trim();
      logEvent(db(), {
        peerId: peer.id,
        kind: 'ask_in',
        ok: !!text,
        detail: `${share.name}${who}`,
        now: ctx.now(),
      });
      if (!text) throw new HubError('agent_unavailable', { details: { reason: 'no_answer' } });
      return { answer: text.slice(0, MAX_ANSWER_CHARS) };
    },
  });
}
