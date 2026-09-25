/**
 * Module `knowledge`: journal, notes/memory browser, and — implemented here — the file
 * registry every other module refers to by id (docs/domain/knowledge.md §attachment,
 * DECISIONS §15).
 *
 * Implemented: the eight attachment operations the contract declares on the `sessions`
 * tag. They are mounted by this module and not by `sessions` because the bytes, the
 * limits and the media-type policy belong here; `sessions` only ever holds ids.
 *
 *   sessions.uploadAttachment    POST   /attachments                       multipart, ≤ 25 MB
 *   sessions.getAttachment       GET    /attachments/{id}
 *   sessions.deleteAttachment    DELETE /attachments/{id}                  409 when a message uses it
 *   sessions.downloadAttachment  GET    /attachments/{id}/content          streams, honours `Range`
 *   sessions.startUpload         POST   /attachment-uploads                ≤ 50 MB, 256 KiB chunks
 *   sessions.uploadChunk         PUT    /attachment-uploads/{id}?offset=
 *   sessions.abortUpload         DELETE /attachment-uploads/{id}
 *   sessions.completeUpload      POST   /attachment-uploads/{id}/complete
 *
 * Also implemented (Phase 4): `knowledge.listItems` — the journal, the notes and the
 * files of one workspace merged into a single page, newest first (`items.ts`). Nothing
 * writes journal entries or notes yet, so today the page is the files; the shape and the
 * paging are the real ones, and the other two kinds appear the moment something writes
 * them, with no change here.
 *
 * Also implemented: the profile's working files (`knowledge.*WorkspaceFile*`, contract
 * decision §65) — a file manager over `${DATA_DIR}/workspaces/<profile>` for owners and
 * admins, in `workspace-files.ts` (the path rules) and `workspace-files-routes.ts`.
 *
 * What the rest of the hub gets is `attachmentsPortFor(app)`: resolve ids, put a
 * person's files where an agent can read them, and take back what the agent wrote.
 */
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import multipart from '@fastify/multipart';
import { loadOpenApiDocument } from '@corehub/contracts';
import { createContractIndex } from '../../lib/contract.js';
import { clampLimit, decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { defineModule } from '../../lib/module.js';
import { defineRoute } from '../../lib/route.js';
import { requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { MAX_UPLOAD_BYTES } from './limits.js';
import { sanitiseFilename } from './media.js';
import { KnowledgeItems, type ItemKind } from './items.js';
import { KnowledgeService, type AttachmentScope } from './service.js';
import { attachmentUrl, toAttachment } from './serialize.js';
import type { AttachmentRow } from './store.js';
import { registerWorkspaceFileRoutes } from './workspace-files-routes.js';

export { KnowledgeItems } from './items.js';
export type { ItemKind, ItemQuery, KnowledgeItem } from './items.js';
export { KnowledgeService } from './service.js';
export type { AttachmentScope, DownloadHandle } from './service.js';
export { attachmentUrl, toAttachment } from './serialize.js';
export type { AttachmentPurpose } from './serialize.js';
export { BlobStore, parseRange } from './blobs.js';
export {
  contentDispositionOf,
  sanitiseFilename,
  sniffMime,
  sniffSignature,
  storedKindOf,
  wireKindOf,
} from './media.js';
export * from './limits.js';
export { AttachmentStore } from './store.js';
export type { AttachmentRow } from './store.js';
export { UploadRegistry } from './uploads.js';

/**
 * What `knowledge` lends to a module that needs files but does not own them.
 * `sessions` declares the same shape as a port of its own (ARCHITECTURE §Modules);
 * the wiring line in `src/modules/index.ts` is where the two must agree.
 */
export interface AttachmentsPort {
  /** Metadata for a set of ids, keyed by id; ids that do not exist are simply absent. */
  resolve(
    workspace: string,
    ids: readonly string[],
  ): Map<
    string,
    { id: string; name: string; mime: string; sizeBytes: number; kind: string; url: string }
  >;
  /** Copy those attachments into `directory`; answers what actually landed. */
  materialise(
    workspace: string,
    ids: readonly string[],
    directory: string,
  ): Array<{ id: string; name: string; path: string; mime: string; sizeBytes: number }>;
  /** Store a file an agent produced and answer the attachment it became. */
  capture(
    scope: { workspace: string; userId: string },
    file: { path: string; relativePath: string; sizeBytes: number },
    sourceId: string,
  ): Promise<{ id: string; name: string; mime: string; sizeBytes: number; kind: string }>;
}

const services = new WeakMap<SocketServer, KnowledgeService>();

export function knowledgeServiceFor(app: FastifyInstance): KnowledgeService {
  const { hub } = app;
  const existing = services.get(hub.io);
  if (existing) return existing;
  const created = new KnowledgeService({
    db: requireSqlite(hub.database),
    dataDir: hub.config.dataDir,
    log: app.log,
  });
  services.set(hub.io, created);
  return created;
}

/** The `AttachmentsPort` implementation, for `src/modules/index.ts` to hand to `sessions`. */
export function attachmentsPort(app: FastifyInstance): AttachmentsPort {
  const service = () => knowledgeServiceFor(app);
  const summary = (row: AttachmentRow) => ({
    id: row.id,
    name: row.filename,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    url: attachmentUrl(row.id),
  });
  return {
    resolve(workspace, ids) {
      const found = service().resolve(workspace, ids);
      const out = new Map<string, ReturnType<typeof summary>>();
      for (const [id, row] of found) if (!row.deletedAt) out.set(id, summary(row));
      return out;
    },
    materialise(workspace, ids, directory) {
      const knowledge = service();
      const rows = knowledge.resolve(workspace, ids);
      const landed = [];
      for (const id of ids) {
        const row = rows.get(id);
        if (!row || row.deletedAt || !knowledge.blobs.exists(row.storageKey)) continue;
        landed.push({
          id: row.id,
          name: row.filename,
          path: knowledge.materialise(row, directory),
          mime: row.mime,
          sizeBytes: row.sizeBytes,
        });
      }
      return landed;
    },
    async capture(scope, file, sourceId) {
      const row = await service().capture(
        { workspace: scope.workspace, profile: '', userId: scope.userId },
        file,
        sourceId,
      );
      return summary(row);
    },
  };
}

/**
 * What `auth`'s profile export and import need from the file registry (ADR 0014 stage 2),
 * for `src/modules/index.ts` to hand over: keep an export for its requester only, find an
 * uploaded archive the caller may see, remove it once used, and sweep what expired.
 */
export function profileArchiveFiles(app: FastifyInstance, maxExportBytes: number) {
  const service = () => knowledgeServiceFor(app);
  const scopeOf = (scope: { workspace: string; userId: string }): AttachmentScope => ({
    workspace: scope.workspace,
    profile: '',
    userId: scope.userId,
  });
  return {
    async keep(
      scope: { workspace: string; userId: string },
      file: string,
      name: string,
      expiresAt: Date,
    ): Promise<{ id: string; sizeBytes: number }> {
      const row = await service().keepExport(scopeOf(scope), file, name, expiresAt, maxExportBytes);
      return { id: row.id, sizeBytes: row.sizeBytes };
    },
    open(
      scope: { workspace: string; userId: string },
      attachmentId: string,
    ): { path: string; name: string } | null {
      const knowledge = service();
      let row: AttachmentRow;
      try {
        row = knowledge.require(scopeOf(scope), attachmentId);
      } catch {
        return null;
      }
      if (!knowledge.blobs.exists(row.storageKey)) return null;
      return { path: knowledge.blobs.pathOf(row.storageKey), name: row.filename };
    },
    discard(scope: { workspace: string; userId: string }, attachmentId: string): void {
      service().discardUpload(scopeOf(scope), attachmentId);
    },
    sweep(): void {
      service().purgeExpired();
    },
  };
}

/** How often expired files (profile exports) are swept away. */
export const SWEEP_INTERVAL_MS = 60 * 60_000;

const scopeOf = (request: FastifyRequest): AttachmentScope => {
  const workspace = request.workspace;
  const principal = request.principal;
  if (!workspace || !principal) throw new HubError('internal', { message: 'route has no scope' });
  return { workspace: workspace.id, profile: workspace.slug, userId: principal.user.id };
};

/**
 * Whether a message already points at this attachment. `sessions` owns messages, so the
 * answer is injected; without it the hub would have to guess, and the contract's `409`
 * exists precisely so it does not.
 */
export interface AttachmentReferences {
  isReferenced(workspace: string, attachmentId: string): boolean;
}

let referencesImpl: ((app: FastifyInstance) => AttachmentReferences) | null = null;

/** Called once from `src/modules/index.ts`; `sessions` provides the implementation. */
export function registerAttachmentReferences(
  factory: (app: FastifyInstance) => AttachmentReferences,
): void {
  referencesImpl = factory;
}

export const knowledgeModule = defineModule({
  name: 'knowledge',
  async registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    // One multipart reader for the hub, with the contract's own ceiling on it: the part
    // stream is refused by the plugin before the service ever sees it.
    await app.register(multipart, {
      // One byte above the hub's own ceiling, so the service refuses first and the
      // client gets `payload_too_large` with `details.max_bytes` rather than a
      // framework error; the plugin's limit stays as the backstop.
      limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1, fields: 8, parts: 12 },
      throwFileSizeLimit: true,
    });
    // `PUT /attachment-uploads/{id}` carries raw bytes; Fastify must not buffer them.
    app.addContentTypeParser(
      'application/octet-stream',
      (_request, payload, done) => void done(null, payload),
    );

    const knowledge = () => knowledgeServiceFor(app);
    // Temporary files (a profile export after its 24 hours) go on their own, at boot and
    // every hour after; the timer never keeps a closing hub alive.
    const sweep = () => {
      try {
        const purged = knowledge().purgeExpired();
        if (purged > 0) app.log.info({ purged }, 'knowledge: expired files removed');
      } catch (error) {
        app.log.warn({ err: error }, 'knowledge: sweeping expired files failed');
      }
    };
    const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweeper.unref?.();
    app.addHook('onReady', async () => sweep());
    app.addHook('onClose', async () => {
      clearInterval(sweeper);
      knowledge().closeUploads();
    });

    // ------------------------------------------------------- what is stored

    defineRoute(app, deps, {
      operationId: 'knowledge.listItems',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const items = new KnowledgeItems(requireSqlite(request.server.hub.database));
        const limit = clampLimit(query.limit as number | undefined);
        const page = items.list({
          workspace: scope.workspace,
          profile: scope.profile,
          kind: query.kind as ItemKind | undefined,
          q: query.q as string | undefined,
          cursor: decodeCursor(query.cursor as string | undefined),
          limit,
        });
        return {
          items: page.items,
          next_cursor: page.lastId ? encodeCursor(page.lastId) : null,
        };
      },
    });

    // ------------------------------------------------------------ one shot

    defineRoute(app, deps, {
      operationId: 'sessions.uploadAttachment',
      status: 201,
      handler: async (request) => {
        const scope = scopeOf(request);
        const service = knowledge();
        const part = await readFilePart(request);
        // Bytes first: `purpose` is a form field that follows the file in every
        // browser's `FormData`, so it only exists once the file stream is drained.
        const blob = await service.storeStream(scope, part.file);
        const row = service.registerBlob(scope, {
          filename: sanitiseFilename(part.filename),
          declaredMime: part.mimetype,
          purpose: part.purpose(),
          blob,
          sourceKind: 'upload',
          sourceId: null,
          expiresAt: null,
          meta: {},
        });
        return toAttachment(row, scope.profile);
      },
    });

    // ------------------------------------------------------------ metadata

    defineRoute(app, deps, {
      operationId: 'sessions.getAttachment',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        return toAttachment(
          knowledge().require(scope, String(params.attachment_id)),
          scope.profile,
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'sessions.deleteAttachment',
      status: 204,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const id = String(params.attachment_id);
        const references = referencesImpl?.(app);
        knowledge().remove(scope, id, references?.isReferenced(scope.workspace, id) ?? false);
        return null;
      },
    });

    // ------------------------------------------------------------ the bytes

    defineRoute(app, deps, {
      operationId: 'sessions.downloadAttachment',
      handler: (request, { params }, reply: FastifyReply) => {
        const scope = scopeOf(request);
        const handle = knowledge().download(
          scope,
          String(params.attachment_id),
          request.headers.range,
        );
        return reply.status(handle.status).headers(handle.headers).send(handle.stream);
      },
    });

    // ----------------------------------------------------------- resumable

    defineRoute(app, deps, {
      operationId: 'sessions.startUpload',
      status: 201,
      handler: (request, { body }) => {
        const scope = scopeOf(request);
        return knowledge().startUpload(scope, body as Record<string, unknown>);
      },
    });

    defineRoute(app, deps, {
      operationId: 'sessions.uploadChunk',
      handler: async (request, { params, query }) => {
        const scope = scopeOf(request);
        return knowledge().uploadChunk(
          scope,
          String(params.upload_id),
          Number(query.offset ?? 0),
          request.body as Readable,
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'sessions.abortUpload',
      status: 204,
      handler: (request, { params }) => {
        knowledge().abortUpload(scopeOf(request), String(params.upload_id));
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'sessions.completeUpload',
      status: 201,
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const row = await knowledge().completeUpload(scope, String(params.upload_id));
        return toAttachment(row, scope.profile);
      },
    });

    // ------------------------------------------- the profile's working files (§65)

    registerWorkspaceFileRoutes(app, deps, knowledge);
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

/**
 * The one `file` part of a multipart upload.
 *
 * `purpose` is a thunk on purpose: busboy only parses the fields that follow the file
 * part once the file's stream has been read to the end, so asking for it too early
 * would always answer `undefined` for a browser-built `FormData`.
 */
async function readFilePart(request: FastifyRequest): Promise<{
  filename: string;
  mimetype: string;
  purpose: () => unknown;
  file: Readable;
}> {
  if (!request.isMultipart()) {
    throw new HubError('unsupported_media_type', {
      details: { expected: 'multipart/form-data', received: request.headers['content-type'] ?? '' },
    });
  }
  const part = await request.file();
  if (!part) {
    throw new HubError('validation_failed', {
      details: { fields: [{ path: 'file', message: 'a file part is required' }] },
    });
  }
  return {
    filename: part.filename,
    mimetype: part.mimetype,
    purpose: () => (part.fields as Record<string, { value?: unknown } | undefined>).purpose?.value,
    file: part.file,
  };
}

export const registerRoutes = knowledgeModule.registerRoutes.bind(knowledgeModule);
export const registerEvents = knowledgeModule.registerEvents.bind(knowledgeModule);
