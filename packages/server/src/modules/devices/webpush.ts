/**
 * Web Push, written from the two RFCs rather than a library: RFC 8291 (the message is
 * encrypted to the browser's own key, `aes128gcm`) and RFC 8292 (VAPID — the hub signs
 * who it is, so a push service accepts the message and a subscription made with the hub's
 * key cannot be used by anyone else).
 *
 * **The keys are the hub's own.** They are made on first use and kept in
 * `${DATA_DIR}/keys/vapid.json` (mode 0600, next to the data key), so Web Push works on a
 * fresh hub with no third-party account at all. Replacing the file would orphan every
 * browser that subscribed, which is why nothing here rotates it.
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url — the browser's `applicationServerKey`. */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
}

const b64url = (buffer: Buffer): string => buffer.toString('base64url');
const fromB64url = (value: string): Buffer => Buffer.from(value, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

/** Reads `${dataDir}/keys/vapid.json`, making it on first use. */
export function loadOrCreateVapidKeys(dataDir: string): VapidKeys {
  const dir = path.join(dataDir, 'keys');
  const file = path.join(dir, 'vapid.json');
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>;
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
    throw new Error(`${file} is not a VAPID key file ({ publicKey, privateKey }); not replacing it`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keys = generateVapidKeys();
  writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return keys;
}

/** The P-256 private key as a KeyObject, from the raw scalar and its public point. */
export function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const point = fromB64url(keys.publicKey);
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

export function vapidPublicKeyObject(publicKey: string): KeyObject {
  const point = fromB64url(publicKey);
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** An ES256 JWT (RFC 7515/7518): the signature is the raw r‖s pair, not DER. */
export function signEs256Jwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(
    Buffer.from(JSON.stringify(claims)),
  )}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

/**
 * RFC 8292 §2–3: `Authorization: vapid t=<jwt>, k=<public key>`. The audience is the push
 * service's origin; twelve hours is well inside the 24 the RFC allows.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: number,
): string {
  const audience = new URL(endpoint).origin;
  const jwt = signEs256Jwt(
    { typ: 'JWT', alg: 'ES256' },
    { aud: audience, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject },
    vapidPrivateKeyObject(keys),
  );
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Parses the JSON a browser's `PushSubscription.toJSON()` gives; null when it is not one. */
export function parseSubscription(token: string): WebPushSubscription | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return null;
  }
  const candidate = parsed as Partial<WebPushSubscription> | null;
  if (!candidate || typeof candidate.endpoint !== 'string') return null;
  const p256dh = candidate.keys?.p256dh;
  const auth = candidate.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  let url: URL;
  try {
    url = new URL(candidate.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const point = fromB64url(p256dh);
  if (point.length !== 65 || point[0] !== 0x04) return null;
  if (fromB64url(auth).length < 16) return null;
  return { endpoint: candidate.endpoint, keys: { p256dh, auth } };
}

const RECORD_SIZE = 4096;

/**
 * RFC 8291 §3–4 with the `aes128gcm` coding of RFC 8188: one record, the padding delimiter
 * `0x02`, and the header carrying the salt, the record size and the hub's one-time public
 * key. `salt` and `ephemeral` are parameters only so a test can pin them.
 */
export function encryptPayload(
  subscription: WebPushSubscription,
  plaintext: Buffer,
  pinned: { salt?: Buffer; ephemeralPrivateKey?: Buffer } = {},
): Buffer {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const ecdh = createECDH('prime256v1');
  if (pinned.ephemeralPrivateKey) ecdh.setPrivateKey(pinned.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);
  const salt = pinned.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  if (plaintext.length + 1 + 16 > RECORD_SIZE) {
    throw new Error('push payload is too large for one record');
  }
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}
