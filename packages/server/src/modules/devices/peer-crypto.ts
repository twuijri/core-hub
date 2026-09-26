/**
 * The cryptography of linked hubs (ADR 0026), pure and small: Ed25519 keys, the fingerprint a
 * person compares by eye, and the signature every hub-to-hub call carries.
 *
 * A signed call carries four headers:
 *
 *   X-Peer-Hub        the caller's hub id
 *   X-Peer-Timestamp  milliseconds since the epoch
 *   X-Peer-Nonce      16 random bytes, base64url, never used twice by the same hub
 *   X-Peer-Signature  Ed25519 over the canonical string, base64url
 *
 * The canonical string binds the call to one method, one path, one moment, one nonce, one body
 * and one recipient, so a captured call cannot be replayed later (the timestamp window and the
 * nonce store), sent to another path, with another body, or to another hub:
 *
 *   corehub-peer-v1 \n METHOD \n /api/v1/path?query \n timestamp \n nonce \n sha256(body) \n recipient hub id
 *
 * The body is hashed as `JSON.stringify` of the parsed JSON (the sender signs exactly the text it
 * sends, made by `JSON.stringify`), and the empty string when there is none. The recipient of a
 * join is `-`: the joining hub does not know the other's id yet, and the invite code in the body
 * (single use, 10 minutes) is what binds the call.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';

export const SIGNATURE_VERSION = 'corehub-peer-v1';
/** How far a call's timestamp may be from this hub's clock, either way. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;
export const JOIN_RECIPIENT = '-';

export const PEER_HEADERS = {
  hub: 'x-peer-hub',
  timestamp: 'x-peer-timestamp',
  nonce: 'x-peer-nonce',
  signature: 'x-peer-signature',
} as const;

export interface KeyPair {
  /** SPKI DER, base64url. */
  publicKey: string;
  /** PKCS#8 DER, base64url. Sealed before it is stored. */
  privateKey: string;
}

export function generateKeys(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

/** Whether `text` is an Ed25519 public key in the form this hub sends. */
export function isPublicKey(text: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(text, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** SHA-256 of the key's bytes, first 16 bytes, upper-case hex in groups of four. */
export function fingerprint(publicKey: string): string {
  const hex = createHash('sha256')
    .update(Buffer.from(publicKey, 'base64url'))
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

/** The fingerprint as it rides in an invite link (`?fp=`): the same hex without dashes. */
export const compactFingerprint = (print: string): string => print.replace(/-/g, '');

export const bodyHash = (body: string): string => createHash('sha256').update(body).digest('hex');

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function canonical(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
  recipient: string;
}): string {
  return [
    SIGNATURE_VERSION,
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    bodyHash(input.body),
    input.recipient,
  ].join('\n');
}

export function signText(privateKey: string, text: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  return edSign(null, Buffer.from(text), key).toString('base64url');
}

export function verifyText(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return edVerify(null, Buffer.from(text), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** The four headers of one signed call. */
export function signedHeaders(input: {
  hubId: string;
  privateKey: string;
  method: string;
  path: string;
  body: string;
  recipient: string;
  now: number;
  nonce?: string;
}): Record<string, string> {
  const timestamp = String(input.now);
  const nonce = input.nonce ?? newNonce();
  const signature = signText(
    input.privateKey,
    canonical({
      method: input.method,
      path: input.path,
      timestamp,
      nonce,
      body: input.body,
      recipient: input.recipient,
    }),
  );
  return {
    [PEER_HEADERS.hub]: input.hubId,
    [PEER_HEADERS.timestamp]: timestamp,
    [PEER_HEADERS.nonce]: nonce,
    [PEER_HEADERS.signature]: signature,
  };
}

/** The canonical body text of a request as the receiving hub parsed it. */
export function bodyText(body: unknown): string {
  return body === undefined || body === null ? '' : JSON.stringify(body);
}
