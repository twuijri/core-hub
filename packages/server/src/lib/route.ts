/**
 * One way to mount a route.
 *
 * A route names the `operationId` it implements and nothing else: the path, the method,
 * the request schemas, whether a token is needed, whether `X-Hub-Profile` is needed and
 * which roles may call it all come from `packages/contracts/openapi.yaml` (ADR 0003).
 * Forgetting an authorisation check is therefore not possible — the document decides, and
 * a route whose `operationId` is not in the document fails at boot, not in production.
 *
 * The guards themselves belong to `auth`; they are passed in so this file stays free of
 * module imports (ARCHITECTURE §Modules).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { toRoutePattern } from '@majlis/contracts';
import type { ContractIndex } from './contract.js';

/** The preHandlers `auth` exports, injected so `lib/` never imports a module. */
export interface RouteGuards {
  requireUser: preHandlerHookHandler;
  requireWorkspace: preHandlerHookHandler;
  requireRole(role: 'owner' | 'admin'): preHandlerHookHandler;
}

export interface RouteDefinition {
  /** Must exist in the contract; the index throws at boot otherwise. */
  operationId: string;
  /** Success status; `204` sends no body. Defaults to 200. */
  status?: number;
  /**
   * The reply is passed as well for the handful of operations whose response is not JSON
   * (`models.synthesize` answers audio bytes with a `Content-Type` the provider chose).
   * Such a handler sends on the reply itself and returns it; every other handler ignores
   * the third argument and returns the body, as before.
   */
  handler(
    request: FastifyRequest,
    parts: { body: unknown; query: Record<string, unknown>; params: Record<string, unknown> },
    reply: FastifyReply,
  ): Promise<unknown> | unknown;
}

export interface RouteDeps {
  contract: ContractIndex;
  guards: RouteGuards;
}

/** Mounts one contract operation. Returns the Fastify route pattern it registered. */
export function defineRoute(
  app: FastifyInstance,
  deps: RouteDeps,
  definition: RouteDefinition,
): string {
  const operation = deps.contract.operation(definition.operationId);
  const url = toRoutePattern(operation.path);

  const preHandler: preHandlerHookHandler[] = [];
  if (!operation.public && !operation.optionalAuth) preHandler.push(deps.guards.requireUser);
  if (operation.roles) {
    // `x-roles: [owner, admin]` is the contract's way of saying "admins only"; auth's
    // guard already treats the owner as an admin.
    preHandler.push(deps.guards.requireRole(operation.roles.includes('admin') ? 'admin' : 'owner'));
  }
  if (operation.requiresProfile) preHandler.push(deps.guards.requireWorkspace);

  app.route({
    method: operation.method.toUpperCase() as 'GET',
    url,
    ...(preHandler.length > 0 ? { preHandler } : {}),
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = operation.validateParams(request.params) as Record<string, unknown>;
      const query = operation.validateQuery(request.query) as Record<string, unknown>;
      operation.validateBody(request.body);

      const result = await definition.handler(
        request,
        { body: request.body, query, params },
        reply,
      );
      // A handler that answered on the reply itself (a binary body) is already done.
      if (reply.sent || result === reply) return reply;
      const status = definition.status ?? 200;
      if (status === 204) return reply.status(204).send();
      return reply.status(status).send(result);
    },
  });
  return url;
}
