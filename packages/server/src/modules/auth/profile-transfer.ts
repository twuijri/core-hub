/**
 * Moving a profile in and out of the hub as Hermes's own archive (ADR 0014 stage 2).
 *
 * `auth` owns the operations (`auth.exportProfile`, `auth.importProfile`) and the workspace
 * rows; it knows nothing of Hermes, of where attachment bytes live or of how a provider key
 * is sealed. Those arrive through one port that `modules/index.ts` fills:
 *
 * - `runtime` — Hermes's dashboard API (ADR 0015), which writes and reads the archive. It
 *   exists only where the hub supervises Hermes; `null` anywhere else, and both operations
 *   then answer `409 state_invalid` (`hermes_not_supervised`) before any job is made.
 * - `files` — `knowledge`, which keeps the finished export as an attachment only its
 *   requester can read, and hands back the path of an uploaded archive.
 * - `secrets` — every credential value the hub holds (`models`' provider keys, Hermes's API
 *   key), so the export can be checked for them byte by byte (`profile-archive.ts`).
 *
 * Both jobs work in a folder of their own under `<DATA_DIR>/tmp/profile-transfer/<job>/`,
 * which Hermes (the same user, the same container) can write to and which is removed when
 * the job ends, whatever the outcome.
 */
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { t, type Language } from '../../i18n/index.js';
import type { ModuleDb } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import type { JobHandle } from '../audit/index.js';
import { ArchiveError, isCredentialFile, rewriteArchive } from './profile-archive.js';
import { runtimeProfileName } from './profile-mirror.js';
import { createProfile, slugTaken } from './profiles.js';
import { workspaces } from './schema.js';
import type { WorkspaceRow } from './serialize.js';
import { findWorkspace } from './workspace.js';

/** How long a finished export stays downloadable (contract decision §34). */
export const EXPORT_KEEP_MS = 24 * 60 * 60_000;
/** An export larger than this is refused rather than stored (the hub's disk is not a backup). */
export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
/** An archive that unpacks to more than this is refused before Hermes sees it. */
export const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;

/** Hermes said no; `message` is Hermes's own sentence. */
export class ProfileArchiveRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileArchiveRefusal';
  }
}

/** Hermes could not be asked at all (its server would not start, or died). */
export class ProfileArchiveUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileArchiveUnavailable';
  }
}

export interface ProfileArchiveRuntime {
  /** Writes `profile`'s archive to `target` (a `.tar.gz` path); answers the path written. */
  export(profile: string, target: string): Promise<string>;
  /** Makes profile `name` from the archive at `archive`. */
  import(archive: string, name: string): Promise<void>;
}

export interface TransferScope {
  workspace: string;
  userId: string;
}

export interface ProfileArchiveFiles {
  /** Stores a finished export as an attachment only `scope.userId` can read. */
  keep(
    scope: TransferScope,
    file: string,
    name: string,
    expiresAt: Date,
  ): Promise<{ id: string; sizeBytes: number }>;
  /** The bytes of an attachment the caller can see, or null. */
  open(scope: TransferScope, attachmentId: string): { path: string; name: string } | null;
  /** Deletes an uploaded archive once it has served. */
  discard(scope: TransferScope, attachmentId: string): void;
  /** Deletes what has expired (old exports). */
  sweep(): void;
}

export interface ProfileTransferPorts {
  runtime: ProfileArchiveRuntime | null;
  files: ProfileArchiveFiles;
  /** Every credential value the hub holds; none of them may leave in an export. */
  secrets(): readonly string[];
}

let factory: ((app: FastifyInstance) => ProfileTransferPorts | null) | null = null;

/** Wired once, from `modules/index.ts`. Returns the previous factory (tests restore it). */
export function registerProfileTransfer(
  next: ((app: FastifyInstance) => ProfileTransferPorts | null) | null,
): ((app: FastifyInstance) => ProfileTransferPorts | null) | null {
  const previous = factory;
  factory = next;
  return previous;
}

/** The ports for this app, or none (a hub composed without the other modules). */
export function profileTransferFor(app: FastifyInstance): ProfileTransferPorts | null {
  if (!factory) return null;
  try {
    return factory(app);
  } catch {
    return null;
  }
}

/** The ports, with a runtime; the named refusal when this hub cannot ask Hermes. */
export function requireTransfer(
  app: FastifyInstance,
): ProfileTransferPorts & { runtime: ProfileArchiveRuntime } {
  const ports = profileTransferFor(app);
  if (!ports?.runtime) {
    throw new HubError('state_invalid', {
      messageKey: 'auth.profile_transfer_unmanaged',
      details: { reason: 'hermes_not_supervised' },
    });
  }
  return ports as ProfileTransferPorts & { runtime: ProfileArchiveRuntime };
}

export interface TransferContext {
  db: ModuleDb;
  dataDir: string;
  ports: ProfileTransferPorts & { runtime: ProfileArchiveRuntime };
  scope: TransferScope;
  language: Language;
  now?: () => Date;
}

function stagingOf(dataDir: string, jobId: string): string {
  return path.join(dataDir, 'tmp', 'profile-transfer', jobId);
}

/** `20260924-101500`, in UTC: the stamp Hermes's own export names carry. */
function stampOf(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
}

/** A failure in the requester's language, with Hermes's sentence appended when it spoke. */
function failure(
  code: 'conflict' | 'bad_request' | 'service_unavailable' | 'payload_too_large' | 'internal',
  key: string,
  language: Language,
  detail?: string,
): HubError {
  const sentence = t(key, language);
  return new HubError(code, { message: detail ? `${sentence} ${detail}` : sentence });
}

function fromRuntime(error: unknown, language: Language, key: string): never {
  if (error instanceof ProfileArchiveRefusal) {
    throw failure('conflict', key, language, error.message);
  }
  if (error instanceof ProfileArchiveUnavailable) {
    throw failure(
      'service_unavailable',
      'auth.profile_transfer_unreachable',
      language,
      error.message,
    );
  }
  throw error;
}

function fromArchive(error: unknown, language: Language): never {
  if (error instanceof ArchiveError) {
    throw failure(
      error.reason === 'too_large' ? 'payload_too_large' : 'bad_request',
      `auth.profile_archive_${error.reason}`,
      language,
    );
  }
  throw error;
}

/**
 * The export job: Hermes writes its archive, the hub rewrites it without credential files
 * and with every stored key overwritten, and keeps the result for its requester.
 */
export async function runExport(
  context: TransferContext,
  handle: JobHandle,
  profile: WorkspaceRow,
): Promise<Record<string, unknown>> {
  const { ports, language, scope } = context;
  const now = context.now ?? (() => new Date());
  const staging = stagingOf(context.dataDir, handle.id);
  const name = runtimeProfileName(profile);
  try {
    ports.files.sweep();
    await mkdir(staging, { recursive: true, mode: 0o700 });
    handle.progress(10, t('auth.profile_export_hermes', language));
    let raw: string;
    try {
      raw = await ports.runtime.export(name, path.join(staging, `${name}.tar.gz`));
    } catch (error) {
      fromRuntime(error, language, 'auth.profile_export_refused');
    }
    if (handle.cancelRequested()) return {};

    handle.progress(60, t('auth.profile_export_checking', language));
    const at = now();
    const fileName = `${profile.slug}-${stampOf(at)}.tar.gz`;
    const checked = path.join(staging, fileName);
    let report;
    try {
      report = await rewriteArchive(raw, checked, {
        drop: isCredentialFile,
        secrets: ports.secrets(),
      });
    } catch (error) {
      fromArchive(error, language);
    }
    if (report.roots.length !== 1 || report.roots[0] !== name) {
      // Hermes's archive always holds one folder named after the profile; anything else is
      // not what was asked for, and is not handed out.
      throw failure('internal', 'auth.profile_export_unexpected', language);
    }
    const { size } = await stat(checked);
    if (size > MAX_EXPORT_BYTES) {
      throw failure('payload_too_large', 'auth.profile_export_too_large', language);
    }
    if (handle.cancelRequested()) return {};

    handle.progress(90, t('auth.profile_export_storing', language));
    const expiresAt = new Date(at.getTime() + EXPORT_KEEP_MS);
    const kept = await ports.files.keep(scope, checked, fileName, expiresAt);
    handle.progress(100, t('auth.profile_export_done', language));
    return {
      attachment_id: kept.id,
      profile: profile.slug,
      name: fileName,
      size_bytes: kept.sizeBytes,
      expires_at: expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      removed: report.removed,
      masked: report.masked,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface ImportRequest {
  attachmentId: string;
  slug: string;
  name: string;
}

/**
 * The import job: the upload is checked to be a profile archive, Hermes makes the profile
 * from it, and the hub adds the workspace. The upload is deleted when the job ends.
 */
export async function runImport(
  context: TransferContext,
  handle: JobHandle,
  input: ImportRequest,
): Promise<Record<string, unknown>> {
  const { db, ports, language, scope } = context;
  const staging = stagingOf(context.dataDir, handle.id);
  try {
    const upload = ports.files.open(scope, input.attachmentId);
    if (!upload) {
      throw new HubError('not_found', {
        message: t('auth.profile_archive_missing', language),
        details: { resource: 'attachment', id: input.attachmentId },
      });
    }
    await mkdir(staging, { recursive: true, mode: 0o700 });
    handle.progress(10, t('auth.profile_import_checking', language));
    const archive = path.join(staging, `${input.slug}.tar.gz`);
    let report;
    try {
      report = await rewriteArchive(upload.path, null, { maxUnpackedBytes: MAX_UNPACKED_BYTES });
    } catch (error) {
      fromArchive(error, language);
    }
    if (report.roots.length !== 1) {
      throw failure('bad_request', 'auth.profile_archive_roots', language);
    }
    if (report.unsafe.length > 0 || report.unsupported.length > 0) {
      throw failure(
        'bad_request',
        'auth.profile_archive_entries',
        language,
        [...report.unsafe, ...report.unsupported].slice(0, 3).join(', '),
      );
    }
    await copyFile(upload.path, archive);
    if (handle.cancelRequested()) return {};
    // Checked when the job was asked for, and again now: another import may have won.
    if (slugTaken(db, input.slug)) {
      throw failure('conflict', 'auth.slug_taken', language);
    }

    handle.progress(40, t('auth.profile_import_hermes', language));
    try {
      await ports.runtime.import(archive, input.slug);
    } catch (error) {
      fromRuntime(error, language, 'auth.profile_import_refused');
    }

    handle.progress(90, t('auth.profile_import_adding', language));
    // The profile exists in Hermes now; a listing that ran in between may already have
    // adopted it under its bare name (ADR 0014 §3). Then it is named here instead.
    const adopted = findWorkspace(db, input.slug);
    const row = adopted
      ? db
          .update(workspaces)
          .set({ name: input.name, updatedAt: new Date() })
          .where(eq(workspaces.id, adopted.id))
          .returning()
          .get()
      : createProfile(db, scope.userId, { slug: input.slug, name: input.name, cloneFrom: null });
    handle.progress(100, t('auth.profile_import_done', language));
    return { profile_id: row.id, slug: row.slug, name: row.name };
  } finally {
    ports.files.discard(scope, input.attachmentId);
    await rm(staging, { recursive: true, force: true });
  }
}
