/**
 * The five `agents.*Webhook*` operations (contract decision §96): an agent's incoming webhook
 * routes on its Channels page, and the hub's public door for them. The rules about Hermes's files
 * live in `hermes-webhooks.ts`; this file is the HTTP around them.
 */
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { newUlid } from '../../db/ids.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound, type ErrorCode } from '../../lib/errors.js';
import { defineRoute, type RouteDeps } from '../../lib/route.js';
import { findWorkspace } from '../auth/index.js';
import { activeChannels, ChannelError } from './channels.js';
import { namedHermesProfiles } from './hermes-profiles.js';
import {
  FORWARDED_HEADERS,
  WEBHOOK_MAX_BODY_BYTES,
  WebhookError,
  addWebhook,
  disableUnusedListener,
  ensureWebhookListener,
  findWebhook,
  listWebhooks,
  postToListener,
  removeWebhook,
  testDelivery,
  webhookListener,
  type HermesWebhookRoute,
} from './hermes-webhooks.js';
import { profileHome } from './profile-home.js';

export interface WebhookRouteHelpers {
  /** The selected profile's Hermes home, for a Hermes agent (refuses anything else). */
  toolHome(request: FastifyRequest, agentId: string): { home: string; profile: string };
  /** What the gateway serving the profile says about its `webhook` platform. */
  listenerStatus(
    request: FastifyRequest,
    profile: string,
    home: string,
  ): { status: string; error: string | null };
  /** A channel of the profile changed: its gateway follows. */
  followChannels(request: FastifyRequest, profile: string): void;
  /** Hermes's root home, or null when the hub has no Hermes. */
  root(app: FastifyInstance): string | null;
  fetchImpl?: typeof fetch;
}

/** `/api/v1/hermes-webhooks/<profile>/<route>`. */
export function webhookPath(profileSlug: string, name: string): string {
  return `/api/v1/hermes-webhooks/${profileSlug}/${name}`;
}

const toWire = (route: HermesWebhookRoute, profileSlug: string) => ({
  name: route.name,
  description: route.description,
  prompt: route.prompt,
  events: route.events,
  deliver: route.deliver,
  secret: route.secret,
  path: webhookPath(profileSlug, route.name),
  static: route.static,
  created_at: route.createdAt,
});

function webhookFault(error: unknown): never {
  if (error instanceof WebhookError) {
    if (error.reason === 'webhook_not_found') throw notFound({ resource: 'webhook' });
    if (error.reason === 'webhook_exists' || error.reason === 'webhook_static') {
      throw new HubError('conflict', {
        messageKey: `agents.${error.reason}`,
        details: { reason: error.reason },
      });
    }
    if (error.reason === 'listener_off' || error.reason === 'listener_down') {
      throw new HubError('service_unavailable', {
        messageKey: 'agents.webhook_listener_down',
        details: { reason: error.reason },
      });
    }
    throw new HubError('bad_request', { details: { reason: error.reason } });
  }
  if (error instanceof ChannelError) {
    throw new HubError('bad_request', { details: { reason: error.reason } });
  }
  throw error;
}

/** Hermes's refusal, in the hub's envelope with Hermes's own words (§96). */
const REFUSAL: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  413: 'payload_too_large',
  429: 'rate_limited',
};

export async function registerWebhookRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  helpers: WebhookRouteHelpers,
): Promise<void> {
  const fetchImpl = helpers.fetchImpl ?? fetch;
  const slugOf = (request: FastifyRequest) => request.workspace?.slug ?? 'default';

  /** The homes of the profiles other than `home`, whose listeners' ports are taken. */
  const othersOf = (home: string): string[] => {
    const root = helpers.root(app);
    if (!root) return [];
    return [
      root,
      ...namedHermesProfiles(root).map((name) => path.join(root, 'profiles', name)),
    ].filter((other) => path.resolve(other) !== path.resolve(home));
  };

  defineRoute(app, deps, {
    operationId: 'agents.listWebhooks',
    handler: (request, { params }) => {
      const { home, profile } = helpers.toolHome(request, params.agent_id as string);
      try {
        const listener = webhookListener(home);
        const health = listener.enabled
          ? helpers.listenerStatus(request, profile, home)
          : { status: 'offline', error: null };
        return {
          listener: {
            enabled: listener.enabled,
            port: listener.port,
            status: health.status,
            error: health.error,
          },
          items: listWebhooks(home).map((route) => toWire(route, slugOf(request))),
        };
      } catch (error) {
        return webhookFault(error);
      }
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.createWebhook',
    status: 201,
    handler: async (request, { params, body }) => {
      const { home, profile } = helpers.toolHome(request, params.agent_id as string);
      const input = body as {
        name: string;
        prompt: string;
        description?: string | null;
        events?: string[];
        deliver?: string;
      };
      const deliver = input.deliver?.trim() || 'log';
      if (
        deliver !== 'log' &&
        !activeChannels(home)
          .filter((c) => c !== 'webhook')
          .includes(deliver)
      ) {
        throw new HubError('validation_failed', {
          details: { field: 'deliver', reason: 'not_a_channel_of_the_profile', value: deliver },
        });
      }
      try {
        const route = addWebhook(home, { ...input, deliver });
        const wasOn = webhookListener(home).enabled;
        await ensureWebhookListener(home, othersOf(home));
        // A listener switched on now needs its gateway to start again; a route added to one
        // that listens is read on the next POST.
        if (!wasOn) helpers.followChannels(request, profile);
        request.log.info({ profile, webhook: route.name }, 'agents: webhook route created');
        return toWire(route, slugOf(request));
      } catch (error) {
        return webhookFault(error);
      }
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.deleteWebhook',
    status: 204,
    handler: (request, { params }) => {
      const { home, profile } = helpers.toolHome(request, params.agent_id as string);
      try {
        removeWebhook(home, params.route_name as string);
        if (disableUnusedListener(home)) helpers.followChannels(request, profile);
        request.log.info({ profile, webhook: params.route_name }, 'agents: webhook route deleted');
        return null;
      } catch (error) {
        return webhookFault(error);
      }
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.testWebhook',
    handler: async (request, { params }) => {
      const { home } = helpers.toolHome(request, params.agent_id as string);
      const route = findWebhook(home, params.route_name as string);
      if (!route) throw notFound({ resource: 'webhook' });
      const delivery = testDelivery(
        route,
        `corehub-test-${newUlid()}`,
        'Hello from the Core Hub webhook test',
      );
      try {
        return await postToListener(
          webhookListener(home),
          route.name,
          delivery.body,
          delivery.headers,
          fetchImpl,
        );
      } catch (error) {
        return webhookFault(error);
      }
    },
  });

  // The public door. The body must reach Hermes byte for byte (its signature is over the bytes),
  // so this one route reads it raw, in a scope of its own.
  await app.register(async (door) => {
    door.removeAllContentTypeParsers();
    door.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_MAX_BODY_BYTES },
      (_request, body, done) => done(null, body),
    );
    defineRoute(door, deps, {
      operationId: 'agents.receiveWebhook',
      handler: async (request, { params }, reply: FastifyReply) => {
        const name = String(params.route_name);
        const unknown = notFound({ resource: 'webhook' });
        const root = helpers.root(app);
        const workspace = findWorkspace(requireSqlite(app.hub.database), String(params.profile));
        if (!root || !workspace || workspace.slug !== params.profile) throw unknown;
        const home = profileHome(root, { slug: workspace.slug, isDefault: workspace.isDefault });
        if (!home) throw unknown;
        const body = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(
              request.body === undefined || request.body === null
                ? ''
                : typeof request.body === 'string'
                  ? request.body
                  : JSON.stringify(request.body),
            );
        const headers: Record<string, string> = {};
        for (const header of FORWARDED_HEADERS) {
          const value = request.headers[header];
          if (typeof value === 'string') headers[header] = value;
        }
        let answer;
        try {
          answer = await postToListener(webhookListener(home), name, body, headers, fetchImpl);
        } catch (error) {
          return webhookFault(error);
        }
        if (answer.status >= 200 && answer.status < 300) {
          return reply.status(answer.status).send(answer.body ?? { status: 'accepted' });
        }
        const said = typeof answer.body?.error === 'string' ? answer.body.error : null;
        const code: ErrorCode =
          REFUSAL[answer.status] ?? (answer.status >= 500 ? 'service_unavailable' : 'bad_request');
        throw new HubError(code, {
          details: { reason: 'hermes_refused', hermes_status: answer.status, hermes_error: said },
        });
      },
    });
  });
}
