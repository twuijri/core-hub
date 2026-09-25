/**
 * The three operations of the hub's own tools (contract decision §47): the card's read and
 * write (`agents.getHubTools`, `agents.updateHubTools`) and the MCP endpoint Hermes talks to
 * (`agents.hubMcp`). Mounted by the `agents` module, which lends what they need.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HubError } from '../../../lib/errors.js';
import { defineRoute, type RouteDeps } from '../../../lib/route.js';
import type { WorkspaceScope } from '../../auth/index.js';
import type { HubToolsPatch, HubToolsService } from './service.js';

export interface HubToolRouteHelpers {
  service(app: FastifyInstance): HubToolsService;
  scopeOf(request: FastifyRequest): WorkspaceScope;
  actorOf(request: FastifyRequest): { userId: string };
  /** Throws unless the agent is Hermes (the only agent whose config the hub writes). */
  assertHermes(request: FastifyRequest, agentId: string): void;
}

function bearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return match?.[1]?.trim() || null;
}

export function registerHubToolRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  helpers: HubToolRouteHelpers,
): void {
  defineRoute(app, deps, {
    operationId: 'agents.getHubTools',
    handler: (request, { params }) => {
      helpers.assertHermes(request, params.agent_id as string);
      return helpers.service(request.server).view(helpers.scopeOf(request));
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.updateHubTools',
    handler: (request, { params, body }) => {
      helpers.assertHermes(request, params.agent_id as string);
      const scope = helpers.scopeOf(request);
      const service = helpers.service(request.server);
      try {
        service.update(scope, helpers.actorOf(request).userId, body as HubToolsPatch);
      } catch (error) {
        if (error instanceof HubError) throw error;
        const reason = (error as { reason?: unknown }).reason;
        if (typeof reason === 'string') {
          throw new HubError('bad_request', { details: { reason } });
        }
        throw error;
      }
      return service.view(scope);
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.hubMcp',
    handler: async (request, { body }, reply) => {
      const answer = await helpers
        .service(request.server)
        .handle(bearer(request.headers.authorization), body);
      if (answer === null) {
        void reply.status(202).send();
        return reply;
      }
      return answer;
    },
  });
}
