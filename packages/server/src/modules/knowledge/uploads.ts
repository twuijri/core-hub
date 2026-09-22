/**
 * Open resumable uploads (`sessions.startUpload` … `sessions.completeUpload`).
 *
 * An open upload is a temp file plus five fields, and it is deliberately **not** a
 * table: it is worth nothing after a restart (the bytes are half a file nobody asked
 * for), the contract already says it expires after five minutes of inactivity, and a
 * row that outlives its temp file would be a lie. A restart therefore answers `404` for
 * an id it no longer knows, which is one of the statuses the contract documents.
 *
 * Every method is scoped by workspace: an upload id from another workspace does not
 * exist here either.
 */
import { newUlid } from '../../db/ids.js';
import { CHUNK_BYTES, UPLOAD_IDLE_MS } from './limits.js';

export interface OpenUpload {
  id: string;
  workspace: string;
  ownerId: string;
  /** Already sanitised by the service. */
  filename: string;
  /** What the client declared; only reported back, never trusted for storage. */
  declaredMime: string;
  sizeBytes: number;
  purpose: string;
  /** Absolute path of the temp file the chunks are appended to. */
  temp: string;
  nextOffset: number;
  expiresAt: number;
}

export interface UploadRegistryOptions {
  now?: () => number;
  idleMs?: number;
}

export class UploadRegistry {
  private readonly open = new Map<string, OpenUpload>();
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(options: UploadRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? UPLOAD_IDLE_MS;
  }

  /** The contract's `Upload.chunk_bytes`. */
  readonly chunkBytes = CHUNK_BYTES;

  start(input: Omit<OpenUpload, 'id' | 'nextOffset' | 'expiresAt'>): OpenUpload {
    this.sweep();
    const upload: OpenUpload = {
      ...input,
      id: newUlid(),
      nextOffset: 0,
      expiresAt: this.now() + this.idleMs,
    };
    this.open.set(upload.id, upload);
    return upload;
  }

  /** The open upload, or `undefined` when unknown, expired or another workspace's. */
  find(workspace: string, id: string): OpenUpload | undefined {
    this.sweep();
    const upload = this.open.get(id);
    if (!upload || upload.workspace !== workspace) return undefined;
    return upload;
  }

  /** Record progress and push the idle deadline out. */
  advance(upload: OpenUpload, nextOffset: number): OpenUpload {
    upload.nextOffset = nextOffset;
    upload.expiresAt = this.now() + this.idleMs;
    return upload;
  }

  forget(id: string): OpenUpload | undefined {
    const upload = this.open.get(id);
    this.open.delete(id);
    return upload;
  }

  /** Expired uploads, removed from the registry; the caller deletes their temp files. */
  sweep(): OpenUpload[] {
    const now = this.now();
    const dropped: OpenUpload[] = [];
    for (const [id, upload] of this.open) {
      if (upload.expiresAt <= now) {
        this.open.delete(id);
        dropped.push(upload);
      }
    }
    return dropped;
  }

  /** Everything still open (shutdown: their temp files are removed). */
  drain(): OpenUpload[] {
    const all = [...this.open.values()];
    this.open.clear();
    return all;
  }
}
