/**
 * The server data key and the envelope every secret is stored in (ADR 0010,
 * docs/domain/models.md §secret).
 *
 * One key file, `${DATA_DIR}/keys/data.key` (mode 0600, directory 0700), holds every data
 * key version the hub has ever used:
 *
 *     { "active": "k1", "keys": { "k1": "<base64 32 bytes>" } }
 *
 * A secret row records the `key_id` that sealed it, so rotation is additive: mint `k2`,
 * make it active, and re-seal rows in the background — nothing has to be decryptable by
 * one key at one moment. A version is only removed once no row references it.
 *
 * The cipher is AES-256-GCM with a fresh 12-byte nonce per seal; the 16-byte tag is
 * appended to the ciphertext, so a tampered row fails to open rather than opening wrong.
 *
 * Nothing here logs, prints or returns a plaintext. `maskSecret()` is the only shape a
 * secret ever takes on the way out: the contract's literal `[stored]`.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** What a client sees instead of a stored secret — the contract's `Provider.api_key`. */
export const MASKED = '[stored]';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  /** Base64 of ciphertext ‖ tag. */
  ciphertext: string;
  /** Base64 of the 12-byte nonce. */
  nonce: string;
  keyId: string;
  /** Last 4 characters of the plaintext, for "sk-…ab12". Never more. */
  hint: string;
}

export interface DataKeyFile {
  active: string;
  keys: Record<string, string>;
}

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCryptoError';
  }
}

/**
 * The key ring. Built once per hub from the data directory, or in memory for a test
 * (`DataKeyRing.inMemory()`), so no test ever needs a file or a real key.
 */
export class DataKeyRing {
  private constructor(
    private readonly file: string | null,
    private ring: DataKeyFile,
  ) {}

  /** Reads `${dataDir}/keys/data.key`, minting the first version on first boot. */
  static open(dataDir: string): DataKeyRing {
    const dir = path.join(dataDir, 'keys');
    const file = path.join(dir, 'data.key');
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const ring = newRing();
      writeFileSync(file, `${JSON.stringify(ring, null, 2)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      return new DataKeyRing(file, ring);
    }
    const ring = parseRing(readFileSync(file, 'utf8'), file);
    return new DataKeyRing(file, ring);
  }

  /** A ring that lives only in this process. Used by the tests and by `--dry-run` tools. */
  static inMemory(): DataKeyRing {
    return new DataKeyRing(null, newRing());
  }

  get activeKeyId(): string {
    return this.ring.active;
  }

  /** Every version the ring can still open, newest first is not guaranteed. */
  keyIds(): string[] {
    return Object.keys(this.ring.keys);
  }

  /** Mints a new version, makes it active, and returns its id. Rotation step one. */
  rotate(): string {
    const id = nextKeyId(this.ring);
    this.ring = {
      active: id,
      keys: { ...this.ring.keys, [id]: randomBytes(KEY_BYTES).toString('base64') },
    };
    this.persist();
    return id;
  }

  /**
   * Drops a version. Rotation step three, after every row that used it was re-sealed.
   * Refuses to drop the active version: that would make new secrets unreadable.
   */
  forget(keyId: string): void {
    if (keyId === this.ring.active) {
      throw new SecretCryptoError(`data key "${keyId}" is active and cannot be dropped`);
    }
    if (!(keyId in this.ring.keys)) return;
    const keys = { ...this.ring.keys };
    delete keys[keyId];
    this.ring = { active: this.ring.active, keys };
    this.persist();
  }

  seal(plaintext: string): SealedSecret {
    const keyId = this.ring.active;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.keyFor(keyId), nonce);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([body, tag]).toString('base64'),
      nonce: nonce.toString('base64'),
      keyId,
      hint: hintOf(plaintext),
    };
  }

  open(sealed: Pick<SealedSecret, 'ciphertext' | 'nonce' | 'keyId'>): string {
    const key = this.keyFor(sealed.keyId);
    const packed = Buffer.from(sealed.ciphertext, 'base64');
    if (packed.length < TAG_BYTES) {
      throw new SecretCryptoError('stored secret is too short to be a GCM envelope');
    }
    const body = packed.subarray(0, packed.length - TAG_BYTES);
    const tag = packed.subarray(packed.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.nonce, 'base64'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      // Never echo the ciphertext or the key id's material into the message.
      throw new SecretCryptoError('stored secret could not be decrypted (wrong key or tampered)');
    }
  }

  /** Rotation step two: same plaintext, sealed under the active version. */
  reseal(sealed: Pick<SealedSecret, 'ciphertext' | 'nonce' | 'keyId'>): SealedSecret {
    return this.seal(this.open(sealed));
  }

  private keyFor(keyId: string): Buffer {
    const encoded = this.ring.keys[keyId];
    if (!encoded) {
      throw new SecretCryptoError(
        `no data key version "${keyId}" in the key ring — the secret cannot be read`,
      );
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new SecretCryptoError(`data key "${keyId}" is not ${KEY_BYTES} bytes`);
    }
    return key;
  }

  private persist(): void {
    if (!this.file) return;
    writeFileSync(this.file, `${JSON.stringify(this.ring, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

function newRing(): DataKeyFile {
  return { active: 'k1', keys: { k1: randomBytes(KEY_BYTES).toString('base64') } };
}

function nextKeyId(ring: DataKeyFile): string {
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `k${n}`;
    if (!(candidate in ring.keys)) return candidate;
  }
  // Practically unreachable; a UUID keeps rotation working rather than throwing.
  return `k-${randomUUID()}`;
}

function parseRing(raw: string, file: string): DataKeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretCryptoError(`${file} is not valid JSON; refusing to overwrite it`);
  }
  const ring = parsed as Partial<DataKeyFile>;
  if (!ring || typeof ring.active !== 'string' || !ring.keys || typeof ring.keys !== 'object') {
    throw new SecretCryptoError(`${file} is not a data key ring ({ active, keys })`);
  }
  if (!(ring.active in ring.keys)) {
    throw new SecretCryptoError(`${file} names an active key version it does not contain`);
  }
  return { active: ring.active, keys: { ...ring.keys } };
}

/** Last four characters, or fewer for a very short secret. Never the whole value. */
export function hintOf(plaintext: string): string {
  return plaintext.slice(-4);
}

/** The only shape a stored secret takes on the way out. */
export function maskSecret(present: boolean): string | null {
  return present ? MASKED : null;
}

/** `true` when a client sent back the mask instead of a new value: leave the row alone. */
export function isMask(value: unknown): boolean {
  return typeof value === 'string' && value === MASKED;
}

/** Constant-time comparison, for the rare case a caller must compare two secrets. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
