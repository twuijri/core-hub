// Argon2id password hashing. Parameters follow the OWASP minimum for Argon2id
// (19 MiB, 2 iterations, 1 lane); a hash is verified with the parameters stored in it, so
// raising them later only affects new hashes.
import argon2 from 'argon2';

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 8;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** False for a wrong password and for a malformed hash; never throws. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function isArgon2idHash(hash: string): boolean {
  return hash.startsWith('$argon2id$');
}
