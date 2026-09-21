// The one place a credential is turned into bytes and back (ADR 0010, docs/domain/models.md).
// Nothing here needs a real provider key: the plaintexts are made up on the spot.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DataKeyRing, MASKED, SecretCryptoError, hintOf, isMask, maskSecret } from './crypto.js';

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-keys-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('models: the data key ring', () => {
  it('mints a key file on first open and reuses it on the next', () => {
    const dir = dataDir();
    const first = DataKeyRing.open(dir);
    const file = path.join(dir, 'keys', 'data.key');
    const ring = JSON.parse(readFileSync(file, 'utf8')) as {
      active: string;
      keys: Record<string, string>;
    };
    expect(ring.active).toBe('k1');
    expect(Buffer.from(ring.keys.k1!, 'base64')).toHaveLength(32);

    const sealed = first.seal('sk-test-abcd');
    const second = DataKeyRing.open(dir);
    expect(second.open(sealed)).toBe('sk-test-abcd');
  });

  it('writes the key file readable only by its owner', () => {
    const dir = dataDir();
    DataKeyRing.open(dir);
    const mode = statSync(path.join(dir, 'keys', 'data.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('refuses to open a key file that is not a ring, instead of overwriting it', () => {
    const dir = dataDir();
    const file = path.join(dir, 'keys', 'data.key');
    DataKeyRing.open(dir);
    // Somebody put something else there.
    writeFileSync(file, 'not json at all');
    expect(() => DataKeyRing.open(dir)).toThrow(SecretCryptoError);
  });
});

describe('models: sealing and opening', () => {
  it('round-trips a secret and records the key version and the hint', () => {
    const ring = DataKeyRing.inMemory();
    const sealed = ring.seal('sk-ant-api03-SECRETVALUE9f2a');
    expect(sealed.keyId).toBe('k1');
    expect(sealed.hint).toBe('9f2a');
    expect(ring.open(sealed)).toBe('sk-ant-api03-SECRETVALUE9f2a');
  });

  it('never stores the plaintext, not even encoded', () => {
    const ring = DataKeyRing.inMemory();
    const secret = 'sk-plaintext-must-not-appear';
    const sealed = ring.seal(secret);
    const blob = `${sealed.ciphertext}${sealed.nonce}${sealed.keyId}`;
    expect(blob).not.toContain(secret);
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('utf8')).not.toContain('plaintext');
  });

  it('uses a fresh nonce per seal, so the same secret never yields the same row', () => {
    const ring = DataKeyRing.inMemory();
    const a = ring.seal('same-secret');
    const b = ring.seal('same-secret');
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(ring.open(a)).toBe(ring.open(b));
  });

  it('fails to open a tampered ciphertext rather than returning wrong bytes', () => {
    const ring = DataKeyRing.inMemory();
    const sealed = ring.seal('sk-authentic');
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    expect(() => ring.open({ ...sealed, ciphertext: bytes.toString('base64') })).toThrow(
      /could not be decrypted/,
    );
  });

  it('fails to open a row sealed under a version the ring no longer holds', () => {
    const ring = DataKeyRing.inMemory();
    const sealed = ring.seal('sk-old');
    expect(() => ring.open({ ...sealed, keyId: 'k99' })).toThrow(/no data key version "k99"/);
  });

  it('keeps a secret shorter than the hint from leaking more than it has', () => {
    const ring = DataKeyRing.inMemory();
    expect(ring.seal('ab').hint).toBe('ab');
    expect(hintOf('sk-1234567890')).toBe('7890');
  });
});

describe('models: rotation', () => {
  it('adds a version, makes it active and can still open the old rows', () => {
    const ring = DataKeyRing.inMemory();
    const before = ring.seal('sk-sealed-under-k1');
    const next = ring.rotate();

    expect(next).toBe('k2');
    expect(ring.activeKeyId).toBe('k2');
    expect(ring.keyIds().sort()).toEqual(['k1', 'k2']);
    // The old row is still readable: rotation is additive, not a cut-over.
    expect(ring.open(before)).toBe('sk-sealed-under-k1');
    expect(ring.seal('new').keyId).toBe('k2');
  });

  it('re-seals a row under the active version without changing what it says', () => {
    const ring = DataKeyRing.inMemory();
    const before = ring.seal('sk-value');
    ring.rotate();
    const after = ring.reseal(before);
    expect(after.keyId).toBe('k2');
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(ring.open(after)).toBe('sk-value');
  });

  it('drops an old version only after nothing needs it, and never the active one', () => {
    const ring = DataKeyRing.inMemory();
    const before = ring.seal('sk-value');
    ring.rotate();
    const after = ring.reseal(before);

    expect(() => ring.forget('k2')).toThrow(/active/);
    ring.forget('k1');
    expect(ring.keyIds()).toEqual(['k2']);
    expect(ring.open(after)).toBe('sk-value');
    expect(() => ring.open(before)).toThrow(/no data key version "k1"/);
  });

  it('survives a restart after rotation', () => {
    const dir = dataDir();
    const ring = DataKeyRing.open(dir);
    ring.rotate();
    const sealed = ring.seal('sk-after-rotation');
    expect(DataKeyRing.open(dir).open(sealed)).toBe('sk-after-rotation');
  });
});

describe('models: masking', () => {
  it('is the contract literal, and only ever says whether something is stored', () => {
    expect(MASKED).toBe('[stored]');
    expect(maskSecret(true)).toBe('[stored]');
    expect(maskSecret(false)).toBeNull();
    expect(isMask('[stored]')).toBe(true);
    expect(isMask('sk-real-value')).toBe(false);
    expect(isMask(null)).toBe(false);
  });
});
