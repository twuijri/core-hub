/**
 * The HTTP surface of `sessions`, one route per `operationId` in
 * `packages/contracts/openapi.yaml`.
 *
 * Every route does the same four things and nothing else: validate with zod
 * (`lib/validate.ts`), resolve the workspace scope from `X-Hub-Profile`
 * (invariant 3), call the service, answer with the documented status. Errors
 * leave as `HubError` and the app's error handler turns them into the one
 * `{ error, code }` envelope, localised by `Accept-Language`.
 *
 * Operations of this module that are deliberately **not** here stay `501`
 * through the app's contract stubs:
 *
 * - `sessions.listCategories` / `createCategory` / `updateCategory` /
 *   `deleteCategory` — `session_categories` has no table in the domain model
 *   yet (docs/domain/sessions.md owns session, message, run, tool_call,
 *   approval only).
 * - every attachment operation (`uploadAttachment`, `getAttachment`,
 *   `downloadAttachment`, `deleteAttachment`, `startUpload`, `uploadChunk`,
 *   `abortUpload`, `completeUpload`) — they are declared on this module's tag
 *   but implemented in `modules/knowledge/index.ts`, which owns the bytes and
 *   the limits (docs/domain/knowledge.md §attachment). This module holds ids:
 *   it refuses a run whose attachment does not exist, materialises the ones it
 *   does into the run's folder, and renders every one with the download URL
 *   the contract declares.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { HubError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import type { EngineScope } from './engine.js';
import type { ScopeResolver } from './scope.js';
import type { SessionsService } from './service.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from './store.js';

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'must be a ULID');
const limit = z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);
const cursor = z.string().max(512).optional();
const reasoningEffort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'max']).nullable();

const contentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), attachment_id: ulid }).loose(),
  z.object({ type: z.literal('file'), attachment_id: ulid }).loose(),
  z.object({ type: z.literal('audio'), attachment_id: ulid }).loose(),
  z.object({ type: z.literal('location'), latitude: z.number(), longitude: z.number() }).loose(),
]);

const sessionCreate = z.object({
  agent_id: ulid,
  title: z.string().max(200).nullish(),
  model: z.string().nullish(),
  provider: z.string().nullish(),
  reasoning_effort: reasoningEffort.optional(),
  working_dir: z.string().nullish(),
  category_id: ulid.nullish(),
});

const sessionPatch = z.object({
  title: z.string().max(200).nullish(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  category_id: ulid.nullish(),
  model: z.string().nullish(),
  provider: z.string().nullish(),
  reasoning_effort: reasoningEffort.optional(),
  working_dir: z.string().nullish(),
  notify: z.boolean().optional(),
});

const runCreate = z.object({
  content: z.array(contentBlock).min(1),
  model: z.string().nullish(),
  provider: z.string().nullish(),
  reasoning_effort: reasoningEffort.optional(),
  when: z.enum(['queue', 'next', 'interrupt']).default('queue'),
  reply_to_message_id: ulid.nullish(),
});

const approvalResponse = z.object({
  decision: z.enum(['approve_once', 'approve_session', 'approve_always', 'deny']).nullish(),
  answer: z.string().max(4000).nullish(),
});

const listQuery = z.object({
  profiles: z.enum(['all']).optional(),
  agent_id: ulid.optional(),
  source: z
    .enum(['chat', 'global_agent', 'room', 'task', 'schedule', 'workflow', 'channel', 'cli', 'api'])
    .optional(),
  category_id: z.string().max(26).optional(),
  pinned: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  archived: z.enum(['true', 'false', 'all']).default('false'),
  q: z.string().max(200).optional(),
  cursor,
  limit,
});

/**
 * Path ids are matched, not validated: an id that is not a ULID cannot name
 * an existing row, so it is `404 not_found` like any unknown id (invariant 2)
 * rather than a `400`. Body and query fields still fail validation loudly.
 */
function pathId(params: unknown, name: string, resource: string): string {
  const value = (params as Record<string, unknown> | null)?.[name];
  if (typeof value !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)) {
    throw notFound({ resource, id: typeof value === 'string' ? value : null });
  }
  return value;
}

export interface RouteDeps {
  service(request: FastifyRequest): SessionsService;
  scopes: ScopeResolver;
}

export function registerSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const scopeOf = async (request: FastifyRequest): Promise<EngineScope> => {
    const profile = request.hubProfile;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile)) {
      throw new HubError('profile_required', { details: { header: 'X-Hub-Profile', profile } });
    }
    const scope = await deps.scopes.resolve(profile, request);
    if (!scope) throw new HubError('profile_not_found', { details: { profile } });
    return { ...scope, workspace: scope.workspaceId, language: request.language };
  };

  // ------------------------------------------------------------- sessions

  app.get('/sessions', async (request) => {
    // The header is checked even for a list across profiles: it must still name a
    // workspace the caller may enter, so `profiles=all` never answers a request that
    // would otherwise have been refused.
    const scope = await scopeOf(request);
    const query = parse(listQuery, request.query, 'query');
    const filters = {
      agentId: query.agent_id,
      source: query.source,
      categoryId: query.category_id,
      pinned: query.pinned,
      archived: query.archived,
      q: query.q,
    };
    if (query.profiles === 'all') {
      // Which profiles "all" means is `auth`'s rule (ADR 0016), asked here, never a list
      // the client sends. A resolver that cannot say lists the header's profile alone.
      const enterable = deps.scopes.enterable
        ? (await deps.scopes.enterable(request)).map((entry): EngineScope => ({
            ...entry,
            workspace: entry.workspaceId,
            language: request.language,
          }))
        : [scope];
      return deps.service(request).listAcross(enterable, filters, query.cursor, query.limit);
    }
    return deps.service(request).list(scope, filters, query.cursor, query.limit);
  });

  app.post('/sessions', async (request, reply) => {
    const scope = await scopeOf(request);
    const body = parse(sessionCreate, request.body);
    const session = await deps.service(request).create(scope, body);
    return reply.status(201).send(session);
  });

  app.patch('/sessions', async (request) => {
    const scope = await scopeOf(request);
    const body = parse(
      z.object({
        session_ids: z.array(ulid).min(1).max(100),
        patch: sessionPatch,
      }),
      request.body,
    );
    return deps.service(request).bulkUpdate(scope, body.session_ids, body.patch);
  });

  app.delete('/sessions', async (request) => {
    const scope = await scopeOf(request);
    const query = parse(z.object({ ids: z.string().max(2800) }), request.query, 'query');
    const ids = query.ids
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0 || ids.length > 100) {
      throw new HubError('validation_failed', {
        details: { issues: [{ path: 'ids', message: 'between 1 and 100 ids' }] },
      });
    }
    return deps.service(request).bulkDelete(scope, ids);
  });

  // Before `/sessions/:session_id`: a static segment must never be read as an id.
  app.get('/sessions/working-dirs', async (request) => {
    const scope = await scopeOf(request);
    return deps.service(request).workingDirs(scope);
  });

  app.get('/sessions/:session_id', async (request) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    return deps.service(request).get(scope, session_id);
  });

  app.patch('/sessions/:session_id', async (request) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    const body = parse(sessionPatch, request.body);
    return deps.service(request).update(scope, session_id, body);
  });

  app.delete('/sessions/:session_id', async (request, reply) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    await deps.service(request).remove(scope, session_id);
    return reply.status(204).send();
  });

  app.post('/sessions/:session_id/fork', async (request, reply) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    const body = parse(
      z.object({
        at_message_id: ulid.nullish(),
        title: z.string().max(200).nullish(),
        // Continuing with another agent (contract decision §26); all three are optional
        // and a body without them is the fork that existed before, unchanged.
        agent_id: ulid.nullish(),
        model: z.string().nullish(),
        provider: z.string().nullish(),
      }),
      request.body ?? {},
    );
    return reply.status(201).send(await deps.service(request).fork(scope, session_id, body));
  });

  app.get('/sessions/:session_id/export', async (request, reply: FastifyReply) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    const { format } = parse(
      z.object({ format: z.enum(['json', 'markdown']).default('json') }),
      request.query,
      'query',
    );
    const file = deps.service(request).export(scope, session_id, format);
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .send(file.body);
  });

  app.get('/sessions/:session_id/trajectory', async (request, reply: FastifyReply) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    const { download } = parse(
      z.object({
        download: z
          .enum(['true', 'false'])
          .default('false')
          .transform((value) => value === 'true'),
      }),
      request.query,
      'query',
    );
    const trajectory = deps.service(request).trajectory(scope, session_id);
    if (download) {
      reply.header('content-disposition', `attachment; filename="session-${session_id}-log.json"`);
    }
    return trajectory;
  });

  // ---------------------------------------------------------------- files

  app.get('/sessions/:session_id/files', async (request) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    return deps.service(request).listFiles(scope, session_id);
  });

  app.get('/sessions/:session_id/files/content', async (request, reply: FastifyReply) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    const query = parse(
      z.object({
        path: z.string().min(1).max(4096),
        download: z
          .enum(['true', 'false'])
          .default('false')
          .transform((value) => value === 'true'),
      }),
      request.query,
      'query',
    );
    const file = deps.service(request).openFile(scope, session_id, query.path, query.download);
    const name = file.relative.split('/').at(-1) ?? 'file';
    // Opened directly, an HTML file still runs nothing in the hub's origin: the sandbox
    // gives it an origin of its own and `default-src 'none'` loads nothing (decision §47).
    return reply
      .header('content-type', file.type.contentType)
      .header('content-length', String(file.size))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('cache-control', 'no-store')
      .header('content-disposition', contentDisposition(query.download, name))
      .send(createReadStream('', { fd: file.fd, start: 0, end: Math.max(0, file.size - 1) }));
  });

  // ------------------------------------------------------------- messages

  app.get('/sessions/:session_id/messages', async (request) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    const query = parse(z.object({ before: ulid.optional(), limit }), request.query, 'query');
    return deps.service(request).listMessages(scope, session_id, query.before, query.limit);
  });

  // ----------------------------------------------------------------- runs

  app.get('/sessions/:session_id/runs', async (request) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    const query = parse(
      z.object({
        status: z
          .enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'])
          .optional(),
        cursor,
        limit,
      }),
      request.query,
      'query',
    );
    return deps
      .service(request)
      .listRuns(scope, session_id, query.status, query.cursor, query.limit);
  });

  app.post('/sessions/:session_id/runs', async (request, reply) => {
    const scope = await scopeOf(request);
    const session_id = pathId(request.params, 'session_id', 'session');
    const body = parse(runCreate, request.body);
    const accepted = await deps.service(request).createRun(scope, session_id, body);
    // The run continues after the response; never awaited here (invariant 4).
    void accepted.started;
    return reply.status(202).send(accepted.payload);
  });

  app.get('/sessions/:session_id/runs/:run_id', async (request) => {
    const scope = await scopeOf(request);
    const params = {
      session_id: pathId(request.params, 'session_id', 'session'),
      run_id: pathId(request.params, 'run_id', 'run'),
    };
    return deps.service(request).getRun(scope, params.session_id, params.run_id);
  });

  app.post('/sessions/:session_id/runs/:run_id/cancel', async (request) => {
    const scope = await scopeOf(request);
    const params = {
      session_id: pathId(request.params, 'session_id', 'session'),
      run_id: pathId(request.params, 'run_id', 'run'),
    };
    return deps.service(request).cancelRun(scope, params.session_id, params.run_id);
  });

  // ------------------------------------------------------------ approvals

  app.get('/approvals', async (request) => {
    const scope = await scopeOf(request);
    const query = parse(
      z.object({
        status: z
          .enum(['pending', 'approved', 'denied', 'answered', 'expired', 'cancelled'])
          .optional(),
        session_id: ulid.optional(),
        cursor,
        limit,
      }),
      request.query,
      'query',
    );
    return deps
      .service(request)
      .listApprovals(
        scope,
        { status: query.status, session_id: query.session_id },
        query.cursor,
        query.limit,
      );
  });

  app.get('/approvals/:approval_id', async (request) => {
    const scope = await scopeOf(request);
    const approval_id = pathId(request.params, 'approval_id', 'approval');
    return deps.service(request).getApproval(scope, approval_id);
  });

  app.post('/approvals/:approval_id/respond', async (request) => {
    const scope = await scopeOf(request);
    const approval_id = pathId(request.params, 'approval_id', 'approval');
    const body = parse(approvalResponse, request.body);
    return deps.service(request).respondApproval(scope, approval_id, body);
  });
}

/** `inline` or `attachment`, with the name in both forms (RFC 6266 / RFC 5987). */
function contentDisposition(download: boolean, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
