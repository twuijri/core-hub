/**
 * The use cases behind the eight attachment operations, plus the two a run needs.
 *
 * `knowledge` owns the bytes (docs/domain/knowledge.md §attachment), so everything that
 * decides *whether* a file may be stored lives here and nowhere else:
 *
 * - the size limits (`limits.ts`), answered with the contract's `payload_too_large`
 *   envelope and its documented `details.max_bytes`;
 * - the name, sanitised before it is written down (`media.sanitiseFilename`);
 * - the media type, sniffed from the bytes (`media.sniffMime`) — the client's claim is
 *   recorded in the log when it was wrong, and otherwise ignored;
 * - de-duplication by `(workspace, sha256, size)`, so ten messages carrying the same
 *   screenshot hold one file.
 *
 * Nothing here reads a whole file into memory: uploads are streams into `BlobStore`,
 * downloads are streams out of it.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Readable } from 'node:stream';
import { HubError, notFound } from '../../lib/errors.js';
import { BlobStore, parseRange, type ByteRange } from './blobs.js';
import { MAX_PRODUCED_FILE_BYTES, MAX_RESUMABLE_BYTES, MAX_UPLOAD_BYTES } from './limits.js';
import { contentDispositionOf, sanitiseFilename, sniffMime, storedKindOf } from './media.js';
import {
  ATTACHMENT_PURPOSES,
  toAttachment,
  toUpload,
  type AttachmentPurpose,
} from './serialize.js';
import { AttachmentStore, type AttachmentRow } from './store.js';
import { UploadRegistry, type UploadRegistryOptions } from './uploads.js';
import type { AttachmentMeta } from './schema.js';

export interface AttachmentScope {
  workspace: string;
  profile: string;
  userId: string;
}

export interface UploadInput {
  filename: unknown;
  declaredMime: unknown;
  purpose: unknown;
  body: Readable;
  sourceKind?: AttachmentRow['sourceKind'];
  sourceId?: string | null;
  expiresAt?: Date | null;
  /** Extra metadata a caller already knows (a produced file's relative path). */
  meta?: AttachmentMeta;
}

/** What `BlobStore` answers once the bytes are in place. */
export interface StoredBlobLike {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  head: Buffer;
}

export interface DownloadHandle {
  row: AttachmentRow;
  stream: Readable;
  /** 200 or 206. */
  status: 200 | 206;
  headers: Record<string, string>;
}

export interface KnowledgeServiceOptions {
  db: ConstructorParameters<typeof AttachmentStore>[0];
  dataDir: string;
  log: FastifyBaseLogger;
  uploads?: UploadRegistryOptions;
}

function purposeFrom(value: unknown): AttachmentPurpose {
  const text = typeof value === 'string' ? value.trim() : '';
  return (ATTACHMENT_PURPOSES as readonly string[]).includes(text)
    ? (text as AttachmentPurpose)
    : 'message';
}

const tooLarge = (maxBytes: number): HubError =>
  new HubError('payload_too_large', { details: { max_bytes: maxBytes } });

/** `@fastify/multipart`'s own "part too big", whatever release it comes from. */
function isFileTooLarge(error: unknown): boolean {
  const candidate = error as { code?: unknown; statusCode?: unknown } | null;
  return candidate?.code === 'FST_REQ_FILE_TOO_LARGE' || candidate?.statusCode === 413;
}

export class KnowledgeService {
  readonly blobs: BlobStore;
  readonly rows: AttachmentStore;
  readonly uploads: UploadRegistry;
  private readonly log: FastifyBaseLogger;

  constructor(options: KnowledgeServiceOptions) {
    this.blobs = new BlobStore(options.dataDir);
    this.rows = new AttachmentStore(options.db);
    this.uploads = new UploadRegistry(options.uploads ?? {});
    this.log = options.log;
  }

  // ------------------------------------------------------- one-shot upload

  /**
   * Read the body into the store, under the one-shot limit.
   *
   * It is a step of its own because a multipart form field that follows the file part
   * (`purpose`, as every browser's `FormData` sends it) is only parsed once the file
   * stream has been drained: the route must read the bytes first and the fields after.
   */
  async storeStream(scope: AttachmentScope, body: Readable): Promise<StoredBlobLike> {
    try {
      return await this.blobs.write(scope.workspace, body, {
        maxBytes: MAX_UPLOAD_BYTES,
        onTooLarge: () => tooLarge(MAX_UPLOAD_BYTES),
      });
    } catch (error) {
      // The multipart reader enforces the same ceiling one byte later; either way the
      // client gets the contract's envelope rather than a framework error.
      if (isFileTooLarge(error)) throw tooLarge(MAX_UPLOAD_BYTES);
      throw error;
    }
  }

  /** `sessions.uploadAttachment`: one multipart request, streamed to disk. */
  async upload(scope: AttachmentScope, input: UploadInput): Promise<AttachmentRow> {
    const blob = await this.storeStream(scope, input.body);
    return this.registerBlob(scope, {
      filename: sanitiseFilename(input.filename),
      declaredMime: input.declaredMime,
      purpose: input.purpose,
      blob,
      sourceKind: input.sourceKind ?? 'upload',
      sourceId: input.sourceId ?? null,
      expiresAt: input.expiresAt ?? null,
      meta: input.meta ?? {},
    });
  }

  // ------------------------------------------------------ resumable upload

  /** `sessions.startUpload`. The declared size is checked before a byte is accepted. */
  startUpload(scope: AttachmentScope, input: Record<string, unknown>): Record<string, unknown> {
    const sizeBytes = Number(input.size_bytes);
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_RESUMABLE_BYTES) {
      throw tooLarge(MAX_RESUMABLE_BYTES);
    }
    for (const dropped of this.uploads.sweep()) this.blobs.discardTemp(dropped.temp);
    const upload = this.uploads.start({
      workspace: scope.workspace,
      ownerId: scope.userId,
      filename: sanitiseFilename(input.name),
      declaredMime: typeof input.mime === 'string' ? input.mime : 'application/octet-stream',
      sizeBytes,
      purpose: purposeFrom(input.purpose),
      temp: this.blobs.openTemp(scope.workspace),
    });
    return toUpload(upload, this.uploads.chunkBytes);
  }

  /** `sessions.uploadChunk`: append at `offset`, answer the new `next_offset`. */
  async uploadChunk(
    scope: AttachmentScope,
    uploadId: string,
    offset: number,
    body: Readable,
  ): Promise<Record<string, unknown>> {
    const upload = this.uploads.find(scope.workspace, uploadId);
    if (!upload) throw notFound({ resource: 'upload', id: uploadId });
    if (offset !== upload.nextOffset) {
      // Resuming from anywhere but where the server stopped would corrupt the file.
      throw new HubError('conflict', {
        details: { expected_offset: upload.nextOffset, offset },
      });
    }
    const written = await this.blobs.append(upload.temp, body, offset, upload.sizeBytes);
    return toUpload(this.uploads.advance(upload, written), this.uploads.chunkBytes);
  }

  /** `sessions.abortUpload`: forget it and delete the partial file. */
  abortUpload(scope: AttachmentScope, uploadId: string): void {
    const upload = this.uploads.find(scope.workspace, uploadId);
    if (!upload) throw notFound({ resource: 'upload', id: uploadId });
    this.uploads.forget(upload.id);
    this.blobs.discardTemp(upload.temp);
  }

  /** `sessions.completeUpload`: the bytes must be all there before a row is written. */
  async completeUpload(scope: AttachmentScope, uploadId: string): Promise<AttachmentRow> {
    const upload = this.uploads.find(scope.workspace, uploadId);
    if (!upload) throw notFound({ resource: 'upload', id: uploadId });
    const onDisk = this.blobs.size(upload.temp);
    if (onDisk !== upload.sizeBytes) {
      throw new HubError('conflict', {
        details: { received_bytes: onDisk, size_bytes: upload.sizeBytes },
      });
    }
    this.uploads.forget(upload.id);
    const blob = await this.blobs.commitFile(scope.workspace, upload.temp);
    return this.registerBlob(scope, {
      filename: upload.filename,
      declaredMime: upload.declaredMime,
      purpose: upload.purpose,
      blob,
      sourceKind: 'upload',
      sourceId: null,
      expiresAt: null,
      meta: {},
    });
  }

  // -------------------------------------------------------------- read side

  /** `sessions.getAttachment`. */
  require(scope: AttachmentScope, id: string): AttachmentRow {
    const row = this.rows.get(scope.workspace, id);
    if (!row) throw notFound({ resource: 'attachment', id });
    return row;
  }

  /** The live rows for a set of ids — used to render a message's blocks. */
  resolve(workspace: string, ids: readonly string[]): Map<string, AttachmentRow> {
    return this.rows.many(workspace, ids);
  }

  /** `sessions.downloadAttachment`, including one `Range`. */
  download(scope: AttachmentScope, id: string, rangeHeader: unknown): DownloadHandle {
    const row = this.require(scope, id);
    if (!this.blobs.exists(row.storageKey)) {
      // The row says the file is live but the bytes are gone: say so honestly.
      throw notFound({ resource: 'attachment', id, reason: 'bytes_missing' });
    }
    const range: ByteRange | null = parseRange(rangeHeader, row.sizeBytes);
    const headers: Record<string, string> = {
      'content-type': row.mime,
      'content-disposition': contentDispositionOf(row.filename),
      'accept-ranges': 'bytes',
      // Content addressed: the bytes behind an id never change.
      etag: `"${row.sha256}"`,
      'cache-control': 'private, max-age=31536000, immutable',
      // Downloads are user files; nothing here is ever a page.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    };
    if (!range) {
      headers['content-length'] = String(row.sizeBytes);
      return { row, stream: this.blobs.read(row.storageKey), status: 200, headers };
    }
    headers['content-range'] = `bytes ${range.start}-${range.end}/${row.sizeBytes}`;
    headers['content-length'] = String(range.end - range.start + 1);
    return { row, stream: this.blobs.read(row.storageKey, range), status: 206, headers };
  }

  /**
   * `sessions.deleteAttachment` — "an attachment that no message references yet".
   * Whether it is referenced is the `sessions` module's knowledge, so the caller passes
   * the answer in; `knowledge` refuses with the contract's `409` when it is true.
   */
  remove(scope: AttachmentScope, id: string, referenced: boolean): void {
    const row = this.require(scope, id);
    if (referenced) {
      throw new HubError('conflict', {
        messageKey: 'knowledge.attachment_in_use',
        details: { attachment_id: id, reason: 'referenced_by_message' },
      });
    }
    this.rows.markDeleted(scope.workspace, row.id);
    // Content addressing means another row may share these bytes.
    if (this.rows.referencesTo(scope.workspace, row.storageKey) === 0) {
      this.blobs.remove(row.storageKey);
    }
  }

  // ------------------------------------------------------- what a run needs

  /**
   * Copy an attachment's bytes into `directory` under its stored name, and answer the
   * absolute path. Used to put a person's files where the agent can read them.
   */
  materialise(row: AttachmentRow, directory: string): string {
    const target = path.join(directory, row.filename);
    return this.blobs.copyTo(row.storageKey, target);
  }

  /** Take a file an agent wrote and store it as an attachment of that message. */
  async capture(
    scope: AttachmentScope,
    file: { path: string; relativePath: string; sizeBytes: number },
    sourceId: string,
  ): Promise<AttachmentRow> {
    if (file.sizeBytes > MAX_PRODUCED_FILE_BYTES) throw tooLarge(MAX_PRODUCED_FILE_BYTES);
    const blob = await this.blobs.ingest(scope.workspace, file.path, {
      maxBytes: MAX_PRODUCED_FILE_BYTES,
      onTooLarge: () => tooLarge(MAX_PRODUCED_FILE_BYTES),
    });
    return this.registerBlob(scope, {
      filename: sanitiseFilename(path.basename(file.relativePath)),
      declaredMime: null,
      purpose: 'message',
      blob,
      sourceKind: 'agent_output',
      sourceId,
      expiresAt: null,
      meta: { producedPath: file.relativePath },
    });
  }

  // --------------------------------------------------------- housekeeping

  /** Temporary attachments past `expires_at`: bytes gone, row marked. */
  purgeExpired(now: Date = new Date()): number {
    const rows = this.rows.expired(now);
    for (const row of rows) {
      this.rows.markDeleted(row.workspace, row.id, now);
      if (this.rows.referencesTo(row.workspace, row.storageKey) === 0) {
        this.blobs.remove(row.storageKey);
      }
    }
    return rows.length;
  }

  /** Shutdown: an open upload's temp file has no future. */
  closeUploads(): void {
    for (const upload of this.uploads.drain()) rmSync(upload.temp, { force: true });
  }

  // ------------------------------------------------- registering the bytes

  /** Sniff, de-duplicate and write the row. Public so the routes can do it in two steps. */
  registerBlob(
    scope: AttachmentScope,
    input: {
      filename: string;
      declaredMime: unknown;
      purpose: unknown;
      blob: StoredBlobLike;
      sourceKind: AttachmentRow['sourceKind'];
      sourceId: string | null;
      expiresAt: Date | null;
      meta: AttachmentMeta;
    },
  ): AttachmentRow {
    const declared = typeof input.declaredMime === 'string' ? input.declaredMime : null;
    const sniffed = sniffMime(input.blob.head, input.filename, declared);
    if (sniffed.overrode) {
      this.log.info(
        { declared, stored: sniffed.mime, source: sniffed.source },
        'attachments: the declared media type did not match the bytes',
      );
    }
    const purpose = purposeFrom(input.purpose);
    const existing = this.rows.findBySha(scope.workspace, input.blob.sha256, input.blob.sizeBytes);
    if (
      existing &&
      existing.filename === input.filename &&
      existing.mime === sniffed.mime &&
      existing.sourceKind === input.sourceKind &&
      (existing.meta?.purpose ?? 'message') === purpose &&
      existing.expiresAt === null &&
      input.expiresAt === null
    ) {
      // The very same file, uploaded again: one row, one copy of the bytes.
      return existing;
    }
    return this.rows.create({
      workspace: scope.workspace,
      ownerId: scope.userId,
      filename: input.filename,
      mime: sniffed.mime,
      sizeBytes: input.blob.sizeBytes,
      sha256: input.blob.sha256,
      storageKey: input.blob.storageKey,
      kind: storedKindOf(sniffed.mime, input.filename),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      meta: { ...input.meta, purpose },
      expiresAt: input.expiresAt,
    });
  }
}

export { toAttachment };
