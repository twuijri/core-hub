// Timestamps on the wire are the contract's `Timestamp`: ISO-8601 UTC ending in `Z`,
// seconds precision (the examples in openapi.yaml carry no milliseconds). The database
// stores epoch milliseconds (db/columns.ts `timestampMs`).

export function iso(value: Date): string;
export function iso(value: Date | null | undefined): string | null;
export function iso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
