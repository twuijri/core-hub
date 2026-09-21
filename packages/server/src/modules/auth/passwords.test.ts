import { describe, expect, it } from 'vitest';
import { hashPassword, isArgon2idHash, verifyPassword } from './passwords.js';

describe('auth: passwords', () => {
  it('hashes with argon2id and verifies the same password only', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(isArgon2idHash(hash)).toBe(true);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stable')).toBe(false);
  });

  it('salts: two hashes of one password differ, both verify', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same')).toBe(true);
    expect(await verifyPassword(b, 'same')).toBe(true);
  });

  it('treats a malformed hash as a failed verification, never an exception', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword('', 'x')).toBe(false);
  });
});
