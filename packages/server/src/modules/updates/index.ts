/**
 * Module `updates`: the client builds this hub offers, and where they come from.
 *
 * Implemented (Phase 4): all seven operations.
 *
 *   updates.check          GET    /updates/check                     any signed-in client
 *   updates.listReleases   GET    /updates/releases                  admin
 *   updates.publishRelease POST   /updates/releases                  admin, runs as a job
 *   updates.deleteRelease  DELETE /updates/releases/{id}             admin
 *   updates.download       GET    /updates/releases/{id}/download    streams, honours Range
 *   updates.getSettings    GET    /updates/settings                  admin
 *   updates.setSettings    PUT    /updates/settings                  admin
 *
 * **The bytes are always ours.** A release published from an uploaded attachment keeps the
 * attachment's own checksum and size; a release published from a `source_url` is fetched
 * by the hub, with the hub's token, into the hub's own blob store. Either way
 * `download_url` is a path on this hub, because a client that follows a link we did not
 * serve is a client we cannot vouch for.
 *
 * Publishing is a `202` and a job, because fetching and checksumming an artefact is not
 * something to hold a request open for.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadOpenApiDocument } from '@corehub/contracts';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { defineModule } from '../../lib/module.js';
import { clampLimit, decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { defineRoute } from '../../lib/route.js';
import { auditFor, jobRunnerFor, serializeJob } from '../audit/index.js';
import {
  DEFAULT_WORKSPACE_SLUG,
  requireRole,
  requireUser,
  requireWorkspace,
  resolveWorkspaceFor,
  type WorkspaceScope,
} from '../auth/index.js';
import { knowledgeServiceFor } from '../knowledge/index.js';
import {
  UpdatesService,
  isNewer,
  parseVersion,
  toRelease,
  type ChannelKey,
  type ClientPlatform,
} from './service.js';

export { UpdatesService, compareRelease, isNewer, parseVersion, toRelease } from './service.js';
export type { ChannelKey, ClientPlatform, Settings, WireRelease } from './service.js';

/** Injected so a test can publish from a URL without reaching the network. */
export interface UpdatesOverrides {
  fetchImpl?: typeof fetch;
}
let overrides: UpdatesOverrides = {};
export function overrideUpdates(next: UpdatesOverrides): void {
  overrides = next;
}

function serviceOf(request: FastifyRequest): UpdatesService {
  return new UpdatesService(requireSqlite(request.server.hub.database));
}

/**
 * Publishing is a global operation — a release belongs to the hub, not to a workspace —
 * but its *bytes* are an attachment, and attachments are a workspace's. So the artefact's
 * home is whichever workspace the caller named, or their default when they named none.
 */
function artefactWorkspace(request: FastifyRequest): WorkspaceScope {
  if (request.workspace) return request.workspace;
  const principal = request.principal;
  if (!principal) throw new HubError('internal', { message: 'route has no principal' });
  return resolveWorkspaceFor(
    requireSqlite(request.server.hub.database),
    principal.user,
    (request.headers['x-hub-profile'] as string | undefined) ?? DEFAULT_WORKSPACE_SLUG,
  );
}

function ownerOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (!principal) throw new HubError('internal', { message: 'route has no principal' });
  return principal.user.id;
}

export const updatesModule = defineModule({
  name: 'updates',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    defineRoute(app, deps, {
      operationId: 'updates.check',
      handler: (request, { query }) => {
        const service = serviceOf(request);
        const platform = query.platform as ClientPlatform;
        const channelKey = query.channel as ChannelKey;
        const channel = service.channel(channelKey, ownerOf(request));
        const latest = service.latest(platform, channel.id);
        // Three distinct answers, and none of them is an error: nothing published yet,
        // the client is current, or here is the build.
        if (!latest) return { available: false, reason: 'not_configured', release: null };
        const current = parseVersion(String(query.current_version));
        const candidate = { release: latest.version, build: latest.buildNumber ?? 0 };
        if (!isNewer(candidate, current)) {
          return { available: false, reason: 'up_to_date', release: null };
        }
        return { available: true, reason: null, release: toRelease(latest, channelKey) };
      },
    });

    defineRoute(app, deps, {
      operationId: 'updates.listReleases',
      handler: (request, { query }) => {
        const service = serviceOf(request);
        const channelKey = query.channel as ChannelKey | undefined;
        const limit = clampLimit(query.limit as number | undefined);
        const rows = service.list({
          platform: query.platform as ClientPlatform | undefined,
          channelId: channelKey ? service.channel(channelKey, ownerOf(request)).id : undefined,
          cursor: decodeCursor(query.cursor as string | undefined),
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        return {
          items: page.map((row) => toRelease(row, service.keyOf(row.channelId))),
          next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : null,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'updates.publishRelease',
      status: 202,
      handler: (request, { body }) => {
        const input = body as {
          platform: ClientPlatform;
          channel: ChannelKey;
          version: string;
          build: number;
          notes: { ar?: string; en?: string };
          attachment_id?: string | null;
          source_url?: string | null;
          mandatory?: boolean;
        };
        if (!input.attachment_id && !input.source_url) {
          throw new HubError('bad_request', {
            details: { reason: 'artifact_required', fields: ['attachment_id', 'source_url'] },
          });
        }
        const workspace = artefactWorkspace(request);
        const ownerId = ownerOf(request);
        const service = serviceOf(request);
        const channel = service.channel(input.channel, ownerId);
        const knowledge = knowledgeServiceFor(request.server);
        const fetchImpl = overrides.fetchImpl ?? fetch;

        const job = jobRunnerFor(request.server).start(
          {
            workspace: workspace.id,
            ownerId,
            kind: 'updates.update',
            entityKind: 'release',
            input: { platform: input.platform, channel: input.channel, version: input.version },
          },
          async (handle) => {
            handle.progress(10, 'resolving the artefact');
            let artifact: {
              attachmentId: string;
              workspace: string;
              sha256: string;
              sizeBytes: number;
            } | null = null;

            if (input.attachment_id) {
              const found = knowledge.resolve(workspace.id, [input.attachment_id]);
              const row = found.get(input.attachment_id);
              if (!row) throw notFound({ resource: 'attachment', id: input.attachment_id });
              artifact = {
                attachmentId: row.id,
                workspace: workspace.id,
                sha256: row.sha256,
                sizeBytes: row.sizeBytes,
              };
            } else if (input.source_url) {
              handle.progress(30, 'fetching the artefact');
              const token = service.sourceToken();
              const response = await fetchImpl(input.source_url, {
                headers: token ? { authorization: `Bearer ${token}` } : {},
              });
              if (!response.ok || !response.body) {
                throw new HubError('bad_request', {
                  details: { reason: 'source_unreachable', status: response.status },
                });
              }
              // Straight into our own store, checksummed on the way in.
              const bytes = Buffer.from(await response.arrayBuffer());
              const blob = await knowledge.storeStream(
                { workspace: workspace.id, profile: workspace.slug, userId: ownerId },
                Readable.from(bytes),
              );
              const row = knowledge.registerBlob(
                { workspace: workspace.id, profile: workspace.slug, userId: ownerId },
                {
                  filename: `${input.platform}-${input.version}`,
                  declaredMime: response.headers.get('content-type') ?? 'application/octet-stream',
                  purpose: 'release',
                  blob,
                  // The hub fetched these bytes on a person's instruction: `export` is the
                  // source kind the schema has for "produced by the hub itself".
                  sourceKind: 'export',
                  sourceId: null,
                  expiresAt: null,
                  meta: {},
                },
              );
              artifact = {
                attachmentId: row.id,
                workspace: workspace.id,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                sizeBytes: bytes.byteLength,
              };
            }

            handle.progress(80, 'publishing');
            const row = service.publish({
              ownerId,
              channelId: channel.id,
              platform: input.platform,
              version: input.version,
              build: input.build,
              notes: input.notes,
              mandatory: input.mandatory ?? false,
              artifact,
              sourceUrl: input.source_url ?? null,
            });
            auditFor(request.server).record({
              actorKind: 'user',
              actorId: ownerId,
              ownerId,
              action: 'release.published',
              entityKind: 'release',
              entityId: row.id,
              summary: `${input.platform} ${input.version} on ${input.channel}`,
            });
            return { release_id: row.id };
          },
        );
        return serializeJob(job, workspace.slug);
      },
    });

    defineRoute(app, deps, {
      operationId: 'updates.deleteRelease',
      status: 204,
      handler: (request, { params }) => {
        const id = params.release_id as string;
        if (!serviceOf(request).yank(id)) throw notFound({ resource: 'release', id });
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'updates.download',
      handler: (request, _parts, reply: FastifyReply) => {
        const id = (request.params as { release_id: string }).release_id;
        const service = serviceOf(request);
        const row = service.get(id);
        if (!row) throw notFound({ resource: 'release', id });
        if (!row.artifactAttachmentId || !row.artifactWorkspace) {
          // A row with no bytes behind it is a row, not a download.
          throw notFound({ resource: 'release', id, reason: 'artifact_missing' });
        }
        const handle = knowledgeServiceFor(request.server).download(
          {
            workspace: row.artifactWorkspace,
            profile: request.workspace?.slug ?? DEFAULT_WORKSPACE_SLUG,
            userId: ownerOf(request),
          },
          row.artifactAttachmentId,
          request.headers.range,
        );
        reply.status(handle.status).headers(handle.headers);
        return reply.send(handle.stream);
      },
    });

    defineRoute(app, deps, {
      operationId: 'updates.getSettings',
      handler: (request) => serviceOf(request).settings(),
    });

    defineRoute(app, deps, {
      operationId: 'updates.setSettings',
      handler: (request, { body }) =>
        serviceOf(request).saveSettings(
          ownerOf(request),
          body as Parameters<UpdatesService['saveSettings']>[1],
        ),
    });
  },
  registerEvents(_io) {
    // This module does not stream (ARCHITECTURE §Realtime).
  },
});

export const registerRoutes = updatesModule.registerRoutes.bind(updatesModule);
export const registerEvents = updatesModule.registerEvents.bind(updatesModule);
