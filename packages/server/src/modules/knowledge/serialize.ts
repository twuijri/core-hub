/**
 * `attachments` rows -> the contract's `Attachment`, and the one download URL shape.
 *
 * The URL is a path, never an origin and never a token: the contract says "the bearer
 * token goes in the header, never in the URL", so a client fetches it with the same
 * headers it uses everywhere else. It is built here and in `sessions/mappers.ts` from
 * this same function, so there is one spelling of it in the server.
 */
import { wireKindOf } from './media.js';
import type { AttachmentRow } from './store.js';
import type { AttachmentMeta } from './schema.js';

export const ATTACHMENT_PURPOSES = [
  'message',
  'avatar',
  'task',
  'import',
  'background',
  'skill',
  'release',
] as const;
export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number];

/** The contract's `Attachment.url`. */
export function attachmentUrl(attachmentId: string): string {
  return `/api/v1/attachments/${attachmentId}/content`;
}

export function purposeOf(meta: AttachmentMeta): AttachmentPurpose {
  const value = meta.purpose;
  return (ATTACHMENT_PURPOSES as readonly string[]).includes(value ?? '')
    ? (value as AttachmentPurpose)
    : 'message';
}

const iso = (value: Date | number): string =>
  new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function toAttachment(row: AttachmentRow, profile: string): Record<string, unknown> {
  const meta = row.meta ?? {};
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    name: row.filename,
    mime: row.mime,
    size_bytes: row.sizeBytes,
    // The table has six kinds (`diff` and `log` say how to render a tool's output);
    // the wire has four, so both fold into `file`.
    kind: wireKindOf(row.mime),
    url: attachmentUrl(row.id),
    purpose: purposeOf(meta),
    width: meta.width ?? null,
    height: meta.height ?? null,
    duration_ms: meta.durationMs ?? null,
    sha256: row.sha256,
  };
}

/** The contract's `Upload`, from an open upload. */
export function toUpload(
  upload: {
    id: string;
    filename: string;
    declaredMime: string;
    sizeBytes: number;
    nextOffset: number;
    expiresAt: number;
  },
  chunkBytes: number,
): Record<string, unknown> {
  return {
    id: upload.id,
    name: upload.filename,
    mime: upload.declaredMime,
    size_bytes: upload.sizeBytes,
    chunk_bytes: chunkBytes,
    next_offset: upload.nextOffset,
    expires_at: iso(upload.expiresAt),
  };
}
