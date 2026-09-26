/**
 * A fake Core Hub push relay (packages/push-relay), for the server tests: a `fetch` that
 * speaks the relay's API, checks every call's HMAC signature, timestamp and nonce the way the
 * relay does, and keeps what it received so a test can read what a phone would have shown.
 */
import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { relaySigningInput } from '../relay.js';

/** The relay's device-proof prefix (packages/push-relay/src/relay.ts `PROOF_PREFIX`). */
export const RELAY_PROOF_PREFIX = 'corehub-push-bind-v1';

/**
 * Checks a device proof the way the relay does: `key` the raw P-256 point (65 bytes), the
 * signature raw `r || s` (64 bytes), both base64url, over prefix, platform, token and time.
 * Returns the key's hash, or null when it does not verify.
 */
export function verifyRelayProof(
  proof: { key?: unknown; signature?: unknown; signed_at?: unknown },
  platform: string,
  token: string,
): string | null {
  if (typeof proof.key !== 'string' || typeof proof.signature !== 'string') return null;
  const raw = Buffer.from(proof.key, 'base64url');
  const signature = Buffer.from(proof.signature, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4 || signature.length !== 64) return null;
  try {
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const message = [RELAY_PROOF_PREFIX, platform, token, String(proof.signed_at)].join('\n');
    const ok = verify(
      'sha256',
      Buffer.from(message),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
    return ok ? createHash('sha256').update(raw).digest('hex') : null;
  } catch {
    return null;
  }
}

export interface FakeRelayMessage {
  platform: 'apns' | 'fcm';
  token: string;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  urgent: boolean;
  collapse_id: string | null;
  thread_id: string | null;
}

export interface FakeRelay {
  url: string;
  fetch: typeof fetch;
  /** Hub id → its secret. */
  hubs: Map<string, string>;
  /** `platform:token` → hub id. */
  bindings: Map<string, string>;
  /** `platform:token` → the device key the first proof recorded, and that proof's time. */
  deviceKeys: Map<string, { keyHash: string; signedAt: number }>;
  /** Every bind's proof as it arrived (null when the bind had none). */
  proofs: Array<Record<string, unknown> | null>;
  pushed: FakeRelayMessage[];
  /** Every call's path, in order, with whether its signature held. */
  calls: Array<{ method: string; path: string; signed: boolean }>;
  /** Tokens the "service" calls dead: the relay answers `gone` and forgets the binding. */
  gone: Set<string>;
  /** When set, every signed call answers this. */
  mode: 'ok' | 'down' | 'blocked' | 'rate_limited';
  /** Forget every hub (a relay whose database was reset). */
  forgetHubs(): void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeRelay(url = 'https://relay.test'): FakeRelay {
  const hubs = new Map<string, string>();
  const bindings = new Map<string, string>();
  const deviceKeys: FakeRelay['deviceKeys'] = new Map();
  const proofs: FakeRelay['proofs'] = [];
  const nonces = new Set<string>();
  const pushed: FakeRelayMessage[] = [];
  const calls: FakeRelay['calls'] = [];
  const gone = new Set<string>();
  const relay: FakeRelay = {
    url,
    hubs,
    bindings,
    deviceKeys,
    proofs,
    pushed,
    calls,
    gone,
    mode: 'ok',
    forgetHubs() {
      hubs.clear();
    },
    fetch: async (input, init) => {
      const target = new URL(String(input));
      if (`${target.origin}` !== url) throw new Error(`fetch failed: ${target.origin}`);
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = target.pathname;
      const text = typeof init?.body === 'string' ? init.body : '';
      if (relay.mode === 'down') throw new Error('connect ECONNREFUSED');
      if (method === 'POST' && path === '/v1/hubs') {
        calls.push({ method, path, signed: false });
        const id = `hub_${randomBytes(15).toString('base64url')}`;
        const secret = randomBytes(32).toString('base64url');
        hubs.set(id, secret);
        return json(201, { hub_id: id, secret });
      }
      const headers = new Headers(init?.headers);
      const id = headers.get('x-corehub-hub') ?? '';
      const timestamp = headers.get('x-corehub-timestamp') ?? '';
      const nonce = headers.get('x-corehub-nonce') ?? '';
      const signature = headers.get('x-corehub-signature') ?? '';
      const secret = hubs.get(id);
      if (!secret) {
        calls.push({ method, path, signed: false });
        return json(401, { error: 'unknown_hub', message: 'this hub is not registered' });
      }
      const expected = createHmac('sha256', secret)
        .update(relaySigningInput(method, path, timestamp, nonce, text))
        .digest('hex');
      const fresh = !nonces.has(`${id}:${nonce}`) && nonce.length >= 16;
      nonces.add(`${id}:${nonce}`);
      const signed = expected === signature && fresh && /^\d+$/.test(timestamp);
      calls.push({ method, path, signed });
      if (!signed) return json(401, { error: 'unauthorized', message: 'bad signature' });
      if (relay.mode === 'blocked') {
        return json(403, { error: 'blocked', message: 'this hub is blocked on the relay' });
      }
      if (relay.mode === 'rate_limited') {
        return json(429, { error: 'rate_limited', message: 'over the per-minute limit' });
      }
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      const key = (platform: unknown, token: unknown) => `${String(platform)}:${String(token)}`;
      if (method === 'POST' && path === '/v1/tokens') {
        const k = key(body.platform, body.token);
        const raw = (body.proof ?? null) as Record<string, unknown> | null;
        proofs.push(raw);
        let proof: { keyHash: string; signedAt: number } | null = null;
        if (raw) {
          const keyHash = verifyRelayProof(raw, String(body.platform), String(body.token));
          if (!keyHash) {
            return json(400, {
              error: 'invalid_proof',
              message: 'the device proof does not verify',
            });
          }
          proof = { keyHash, signedAt: Number(raw.signed_at) };
        }
        const holder = bindings.get(k);
        const known = deviceKeys.get(k);
        if (holder && holder !== id) {
          // Another hub holds it: only a newer proof from the key it recorded moves it.
          const proven =
            !!proof &&
            !!known &&
            known.keyHash === proof.keyHash &&
            proof.signedAt > known.signedAt;
          if (!proven) {
            return json(409, { error: 'bound_elsewhere', message: 'bound to another hub' });
          }
          bindings.set(k, id);
          deviceKeys.set(k, proof!);
          return json(200, { status: 'rebound', reason: 'proof' });
        }
        bindings.set(k, id);
        if (proof && (!known || proof.signedAt > known.signedAt)) deviceKeys.set(k, proof);
        return json(200, { status: 'bound' });
      }
      if (method === 'POST' && path === '/v1/tokens/sync') {
        const wanted = new Map(
          (body.tokens as Array<{ platform: string; hash: string }>).map((t) => [t.hash, t]),
        );
        const hashOf = (k: string) => createHash('sha256').update(k).digest('hex');
        let removed = 0;
        const held = new Set<string>();
        for (const [k, holder] of [...bindings]) {
          if (holder !== id) continue;
          if (wanted.has(hashOf(k))) held.add(hashOf(k));
          else {
            bindings.delete(k);
            deviceKeys.delete(k);
            removed += 1;
          }
        }
        const missing = [...wanted.values()].filter((t) => !held.has(t.hash));
        return json(200, { kept: held.size, removed, missing });
      }
      if (method === 'POST' && path === '/v1/push') {
        const results = (body.messages as FakeRelayMessage[]).map((message) => {
          const k = key(message.platform, message.token);
          if (bindings.get(k) !== id) {
            return { status: 'not_bound', ref: null, error: 'not bound to this hub' };
          }
          if (gone.has(message.token)) {
            bindings.delete(k);
            deviceKeys.delete(k);
            return { status: 'gone', ref: null, error: 'APNs: Unregistered (410)' };
          }
          pushed.push(message);
          return { status: 'sent', ref: `relay-${pushed.length}`, error: null };
        });
        return json(200, { results });
      }
      return json(404, { error: 'not_found' });
    },
  };
  return relay;
}
