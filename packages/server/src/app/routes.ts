// HTTP composition: error envelope, workspace scope header, the health route, every module's
// routes under /api/v1, and a 501 stub for each contract operation no module implements yet.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PRODUCT,
  listOperations,
  toRoutePattern,
  type ClientMethod,
  type OpenApiDocument,
} from '@majlis/contracts';
import { pickLanguage, type Language } from '../i18n/index.js';
import { HubError, notImplemented } from '../lib/errors.js';
import type { HubModule } from '../lib/module.js';
import type { HubDatabase } from './db.js';

export const API_PREFIX = '/api/v1';
export const PROFILE_HEADER = 'x-hub-profile';
export const DEFAULT_PROFILE = 'default';

declare module 'fastify' {
  interface FastifyRequest {
    /** Workspace scope (ADR 0005). Defaults to `default` until auth enforces it. */
    hubProfile: string;
    language: Language;
  }
}

export interface RoutesOptions {
  version: string;
  database: HubDatabase;
  modules: readonly HubModule[];
  contract: OpenApiDocument | null;
  /** Whether this hub still has no owner (ADR 0011). Injected: `auth` owns the answer. */
  setupRequired?: () => boolean;
}

/** The display name. One hub, one name; an owner-set one is a later setting, not a guess. */
const HUB_NAME = PRODUCT.name;

/** The two languages this client and this server are written in (`docs/CONTENT-DIRECTION`). */
const LOCALES = ['ar', 'en'] as const;

export interface RoutesReport {
  modules: string[];
  stubs: string[];
}

export async function registerRoutes(
  app: FastifyInstance,
  options: RoutesOptions,
): Promise<RoutesReport> {
  app.decorateRequest('hubProfile', DEFAULT_PROFILE);
  app.decorateRequest('language', 'en');
  app.addHook('onRequest', async (request) => {
    const header = request.headers[PROFILE_HEADER];
    request.hubProfile = (Array.isArray(header) ? header[0] : header)?.trim() || DEFAULT_PROFILE;
    request.language = pickLanguage(request.headers['accept-language']);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(new HubError('not_found').toEnvelope(request.language));
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HubError) {
      if (error.headers) void reply.headers(error.headers);
      return reply.status(error.status).send(error.toEnvelope(request.language));
    }
    const fastifyError = error as { validation?: unknown; statusCode?: number; message?: string };
    if (fastifyError.validation) {
      return reply
        .status(400)
        .send(
          new HubError('validation_failed', { details: fastifyError.validation }).toEnvelope(
            request.language,
          ),
        );
    }
    if (
      typeof fastifyError.statusCode === 'number' &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      return reply
        .status(fastifyError.statusCode)
        .send(new HubError('bad_request').toEnvelope(request.language));
    }
    request.log.error({ err: error }, 'unhandled error');
    // The request id is the thread from the screen to the log line: a person can quote it,
    // and the owner finds the stack under it. It says nothing about the error itself.
    return reply
      .status(500)
      .send(
        new HubError('internal', { details: { request_id: String(request.id) } }).toEnvelope(
          request.language,
        ),
      );
  });

  const report: RoutesReport = { modules: [], stubs: [] };

  await app.register(
    async (api) => {
      api.get('/health', async (_request: FastifyRequest, _reply: FastifyReply) => {
        await options.database.ping();
        // Shape is the contract's `Health` schema (packages/contracts/openapi.yaml).
        return {
          ok: true,
          server_version: options.version,
          uptime_seconds: Math.floor(process.uptime()),
        };
      });

      /**
       * `meta.get`: who this server is and what it speaks. Unauthenticated, because a
       * client compares `contract_version` **before** it signs in — that is the whole
       * point of the call, and putting it behind a token would mean discovering the
       * mismatch only after a login that was never going to work.
       *
       * It lives beside `/health` rather than in a module: every field is the app's own
       * (the stamped build, the contract it loaded, the namespaces it opened), and a
       * module that owned it would have to be told all three.
       */
      api.get('/meta', async (_request: FastifyRequest, _reply: FastifyReply) => {
        const info = (options.contract?.info ?? {}) as { version?: string };
        return {
          name: HUB_NAME,
          // A working tree is not a release, so it says 0.0.0 rather than inventing one.
          server_version: options.version,
          contract_version: info.version ?? '0.0.0',
          api_versions: ['v1'],
          // What this process actually opened, not a list written twice.
          realtime_namespaces: [...app.hub.namespaces].sort(),
          locales: [...LOCALES],
          // The owner account decides; `auth` owns that question and answers it here.
          setup_required: options.setupRequired?.() ?? false,
        };
      });

      for (const module of options.modules) {
        await module.registerRoutes(api);
        report.modules.push(module.name);
      }

      // Contract operations nobody implements yet answer 501 with the documented envelope,
      // so clients and the contract test see the gap instead of a misleading 404.
      if (options.contract) {
        for (const op of listOperations(options.contract)) {
          const url = toRoutePattern(op.path);
          const method = op.method.toUpperCase() as Uppercase<ClientMethod>;
          if (api.hasRoute({ method, url: `${API_PREFIX}${url}` })) continue;
          api.route({
            method,
            url,
            handler: async () => {
              throw notImplemented({ operationId: op.operationId });
            },
          });
          report.stubs.push(`${method} ${API_PREFIX}${url}`);
        }
      }
    },
    { prefix: API_PREFIX },
  );

  return report;
}
