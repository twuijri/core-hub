/**
 * The three operations the hub's plugin in Hermes's messaging gateway calls (contract decision
 * §153): the outbox it long-polls, its acknowledgements, and the turns it reports. Not client
 * APIs: the bearer is the key the hub wrote beside the plugin, never a person's token.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { defineRoute, type RouteDeps } from '../../../lib/route.js';
import type { BridgeEvent, ChannelBridge } from './bridge.js';

function bearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return match?.[1]?.trim() || null;
}

export function registerChannelBridgeRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
  bridgeOf: (request: FastifyRequest) => ChannelBridge,
): void {
  defineRoute(app, deps, {
    operationId: 'agents.channelBridgeOutbox',
    handler: (request, { query }) =>
      bridgeOf(request).outbox(
        bearer(request.headers.authorization),
        typeof query.wait === 'number' ? query.wait : Number(query.wait ?? 0),
        () => !request.raw.destroyed && !request.raw.socket?.destroyed,
      ),
  });

  defineRoute(app, deps, {
    operationId: 'agents.channelBridgeAck',
    status: 204,
    handler: (request, { params, body }) => {
      bridgeOf(request).ack(
        bearer(request.headers.authorization),
        String(params.item_id),
        body as { accepted: boolean; reason?: string | null },
      );
      return null;
    },
  });

  defineRoute(app, deps, {
    operationId: 'agents.channelBridgeEvent',
    status: 204,
    handler: (request, { body }) => {
      bridgeOf(request).event(bearer(request.headers.authorization), body as BridgeEvent);
      return null;
    },
  });
}
