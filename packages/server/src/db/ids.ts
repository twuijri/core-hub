/**
 * ULID identifiers for every row in Majlis.
 *
 * 26 characters, Crockford base32, lexicographically sortable by creation
 * time (48-bit millisecond timestamp + 80 random bits). Generated in the
 * application, never by the database, so the same id is valid on SQLite and
 * PostgreSQL and can be created before the row is inserted (jobs return their
 * id immediately, invariant 4).
 *
 * No third-party dependency: the encoding is small enough to own.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ULID_LENGTH = 26;
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function newUlid(now: number = Date.now()): string {
  let time = now;
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = ENCODING.charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let randomPart = '';
  for (let i = 0; i < 16; i += 1) {
    // 256 is divisible by 32, so masking keeps the distribution uniform.
    randomPart += ENCODING.charAt((bytes[i] ?? 0) & 31);
  }
  return timePart + randomPart;
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}
