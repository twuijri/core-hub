/**
 * Everything cryptographic the relay does, on WebCrypto only (the Workers runtime has no
 * `node:crypto`): base64url, SHA-256, HMAC, a constant-time compare, PEM keys, and the two
 * JWTs — ES256 for APNs' provider token and RS256 for Google's OAuth assertion.
 */

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url (or plain base64); throws on anything else. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_\-+/]*={0,2}$/.test(text)) throw new Error('not base64url');
  const normal = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export function randomToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), utf8(message)));
}

export async function hmacBase64url(secret: string, message: string): Promise<string> {
  return base64url(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), utf8(message)));
}

/** Checks a hex HMAC-SHA256 with WebCrypto's own (constant-time) verify. */
export async function hmacVerifyHex(
  secret: string,
  message: string,
  signature: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), bytes, utf8(message));
}

/** Compares two strings without leaking where they differ (both are hashed first). */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', utf8(a)),
    crypto.subtle.digest('SHA-256', utf8(b)),
  ]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

/** The DER bytes of a PEM block (`-----BEGIN PRIVATE KEY-----`, PKCS#8). */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('the PEM block is empty');
  return fromBase64url(body);
}

export async function importEs256Key(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

export async function importRs256Key(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

const segment = (value: unknown) => base64url(utf8(JSON.stringify(value)));

/**
 * A compact JWS. WebCrypto's ECDSA signature is already the raw `r || s` that JWS wants
 * (RFC 7518 §3.4), so ES256 needs no DER conversion.
 */
export async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
): Promise<string> {
  const input = `${segment(header)}.${segment(claims)}`;
  const algorithm =
    key.algorithm.name === 'ECDSA'
      ? { name: 'ECDSA', hash: 'SHA-256' }
      : { name: 'RSASSA-PKCS1-v1_5' };
  const signature = await crypto.subtle.sign(algorithm, key, utf8(input));
  return `${input}.${base64url(signature)}`;
}
