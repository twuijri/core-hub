/**
 * The eleven `knowledge.*WorkspaceFile*` operations (contract decision §65): the profile's
 * working files for its owner and admins. The rules about paths live in
 * `workspace-files.ts`; this file is the HTTP around them — who is asking, which profile's
 * folder, what the reply carries — and the audit line every write leaves.
 *
 * Roles come from the contract (`x-roles: [owner, admin]`), so a member is refused by
 * `defineRoute` before a handler runs.
 */
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HubError } from '../../lib/errors.js';
import { defineRoute, type RouteDeps } from '../../lib/route.js';
import { auditFor } from '../audit/index.js';
import { contentDispositionOf, sanitiseFilename } from './media.js';
import { toAttachment } from './serialize.js';
import type { KnowledgeService } from './service.js';
import { WORKSPACE_FILE_LIMITS, WorkspaceFiles } from './workspace-files.js';
import { zipStream } from './zip.js';

/** The contract's `WorkspaceFileLimits`. */
export const workspaceFileLimits = () => ({
  max_upload_bytes: WORKSPACE_FILE_LIMITS.maxUploadBytes,
  max_edit_bytes: WORKSPACE_FILE_LIMITS.maxEditBytes,
  max_archive_bytes: WORKSPACE_FILE_LIMITS.maxArchiveBytes,
  max_archive_entries: WORKSPACE_FILE_LIMITS.maxArchiveEntries,
});

/**
 * Types a browser may show in place. Anything else is sent as bytes to save: an HTML or SVG
 * file an agent wrote must never run as a page of the hub's own origin.
 */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'application/pdf',
  'text/plain',
]);

interface Scope {
  workspace: string;
  profile: string;
  userId: string;
}

function scopeOf(request: FastifyRequest): Scope {
  const workspace = request.workspace;
  const principal = request.principal;
  if (!workspace || !principal) throw new HubError('internal', { message: 'route has no scope' });
  return { workspace: workspace.id, profile: workspace.slug, userId: principal.user.id };
}

/** `${DATA_DIR}/workspaces/<profile>` — the same root a conversation works under. */
export function workspaceFilesOf(dataDir: string, profile: string): WorkspaceFiles {
  return new WorkspaceFiles(path.join(dataDir, 'workspaces', profile));
}

export function registerWorkspaceFileRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  knowledge: () => KnowledgeService,
): void {
  const files = (scope: Scope) => workspaceFilesOf(app.hub.config.dataDir, scope.profile);

  /** Every write leaves one line in the audit log: who, which profile, what, where. */
  const audit = (
    request: FastifyRequest,
    scope: Scope,
    action: string,
    data: Record<string, unknown>,
  ) => {
    auditFor(app).record({
      workspace: scope.workspace,
      ownerId: scope.userId,
      actorKind: 'user',
      actorId: scope.userId,
      action: `workspace_file.${action}`,
      entityKind: 'workspace_file',
      entityId: null,
      summary: `profile file ${action}: ${String(data.path ?? data.from ?? '')}`.slice(0, 500),
      data,
      requestId: String(request.id),
    });
  };

  const pathOf = (query: Record<string, unknown>) =>
    typeof query.path === 'string' ? query.path : '';

  // ------------------------------------------------------------------ reads

  defineRoute(app, deps, {
    operationId: 'knowledge.listWorkspaceFiles',
    handler: (request, { query }) => {
      const scope = scopeOf(request);
      const listed = files(scope).list(pathOf(query));
      return { profile: scope.profile, ...listed, limits: workspaceFileLimits() };
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.downloadWorkspaceFile',
    handler: (request, { query }, reply: FastifyReply) => {
      const scope = scopeOf(request);
      const file = files(scope).open(pathOf(query));
      const inline = query.disposition === 'inline' && INLINE_TYPES.has(file.mime);
      return reply
        .status(200)
        .headers({
          'content-type': inline ? file.mime : 'application/octet-stream',
          'content-length': String(file.size),
          etag: file.etag,
          'last-modified': file.modifiedAt.toUTCString(),
          'content-disposition': inline
            ? contentDispositionOf(file.name).replace(/^attachment/, 'inline')
            : contentDispositionOf(file.name),
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'cache-control': 'private, no-store',
        })
        .send(file.stream);
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.downloadWorkspaceFolder',
    handler: (request, { query }, reply: FastifyReply) => {
      const scope = scopeOf(request);
      const archive = files(scope).archive(pathOf(query));
      const name = `${archive.name || scope.profile}.zip`;
      audit(request, scope, 'zipped', {
        path: pathOf(query),
        entries: archive.items.length,
      });
      return reply
        .status(200)
        .headers({
          'content-type': 'application/zip',
          'content-disposition': contentDispositionOf(name),
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        })
        .send(zipStream(archive.items));
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.readWorkspaceText',
    handler: (request, { query }) => files(scopeOf(request)).readText(pathOf(query)),
  });

  // ----------------------------------------------------------------- writes

  defineRoute(app, deps, {
    operationId: 'knowledge.writeWorkspaceText',
    handler: (request, { body }) => {
      const scope = scopeOf(request);
      const input = body as { path: string; content: string; etag: string | null };
      const saved = files(scope).writeText(input.path, input.content, input.etag);
      audit(request, scope, input.etag === null ? 'created' : 'written', {
        path: saved.path,
        bytes: saved.size_bytes,
      });
      return saved;
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.uploadWorkspaceFile',
    status: 201,
    handler: async (request, { query }) => {
      const scope = scopeOf(request);
      const part = await readFilePart(request);
      const entry = await files(scope).upload(
        pathOf(query),
        part.filename,
        part.file,
        query.overwrite === true || query.overwrite === 'true',
      );
      audit(request, scope, 'uploaded', { path: entry.path, bytes: entry.size_bytes });
      return entry;
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.createWorkspaceFolder',
    status: 201,
    handler: (request, { body }) => {
      const scope = scopeOf(request);
      const entry = files(scope).mkdir((body as { path: string }).path);
      audit(request, scope, 'folder_created', { path: entry.path });
      return entry;
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.moveWorkspaceFile',
    handler: (request, { body }) => {
      const scope = scopeOf(request);
      const input = body as { from: string; to: string };
      const entry = files(scope).move(input.from, input.to);
      audit(request, scope, 'moved', { from: input.from, path: entry.path });
      return entry;
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.copyWorkspaceFile',
    status: 201,
    handler: (request, { body }) => {
      const scope = scopeOf(request);
      const input = body as { from: string; to: string };
      const entry = files(scope).copy(input.from, input.to);
      audit(request, scope, 'copied', { from: input.from, path: entry.path });
      return entry;
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.deleteWorkspaceFile',
    status: 204,
    handler: (request, { query }) => {
      const scope = scopeOf(request);
      const target = pathOf(query);
      files(scope).remove(target);
      audit(request, scope, 'deleted', { path: target });
      return null;
    },
  });

  defineRoute(app, deps, {
    operationId: 'knowledge.attachWorkspaceFile',
    status: 201,
    handler: async (request, { body }) => {
      const scope = scopeOf(request);
      const wanted = (body as { path: string }).path;
      const file = files(scope).open(wanted);
      if (file.size > WORKSPACE_FILE_LIMITS.maxUploadBytes) {
        file.stream.destroy();
        throw new HubError('payload_too_large', {
          details: { max_bytes: WORKSPACE_FILE_LIMITS.maxUploadBytes },
        });
      }
      const service = knowledge();
      const attachmentScope = { ...scope };
      const blob = await service.storeStream(attachmentScope, file.stream);
      const row = service.registerBlob(attachmentScope, {
        filename: sanitiseFilename(file.name),
        declaredMime: file.mime === 'application/octet-stream' ? null : file.mime,
        purpose: 'message',
        blob,
        sourceKind: 'upload',
        sourceId: null,
        expiresAt: null,
        meta: { workspacePath: wanted },
      });
      audit(request, scope, 'attached', { path: wanted, attachment_id: row.id });
      return toAttachment(row, scope.profile);
    },
  });
}

/** The one `file` part of a multipart upload. */
async function readFilePart(
  request: FastifyRequest,
): Promise<{ filename: string; file: Readable }> {
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
  return { filename: part.filename, file: part.file };
}
