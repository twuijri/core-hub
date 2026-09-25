/**
 * Module `rooms`: several agents and people in one conversation (DECISIONS §57, proposed —
 * owner to confirm).
 *
 * A room has members (people: its maker, who manages it, and whoever joined by its invite
 * code) and seats (agents, each with a name, instructions, a model and a conversation of its
 * own in `sessions`). People write into the room; the seats they mention — or the room's lead
 * seat when they mention nobody — answer in it.
 *
 * Public surface: other modules and `app/` import this file only.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer, Socket } from 'socket.io';
import { loadOpenApiDocument } from '@corehub/contracts';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { defineModule, REALTIME_NAMESPACES } from '../../lib/module.js';
import { clampLimit } from '../../lib/pagination.js';
import { defineRoute } from '../../lib/route.js';
import { requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { roomsRealtimeFor } from './realtime.js';
import { RoomsService, type RoomPorts, type RoomScope, type SeatConfigInput } from './service.js';
import { RoomsStore } from './store.js';
import type { StoredMention } from './schema.js';

export { RoomsService } from './service.js';
export type { RoomPorts, RoomScope } from './service.js';

/**
 * What the module reaches outside itself — `sessions` for the seats' conversations, `agents`
 * for whether an agent can take a turn, `auth` for names and profiles — joined by the
 * composition root (`modules/index.ts`), so this module imports none of them for behaviour.
 */
let portsFactory: ((app: FastifyInstance) => RoomPorts) | null = null;
export function registerRoomPorts(
  factory: ((app: FastifyInstance) => RoomPorts) | null,
): ((app: FastifyInstance) => RoomPorts) | null {
  const previous = portsFactory;
  portsFactory = factory;
  return previous;
}

const noPorts: RoomPorts = {
  seats: null,
  person: () => null,
  enterable: () => [],
};

function portsOf(app: FastifyInstance): RoomPorts {
  return portsFactory?.(app) ?? noPorts;
}

function scopeOf(request: FastifyRequest): RoomScope {
  const workspace = request.workspace;
  const principal = request.principal;
  if (!workspace || !principal) throw new HubError('internal', { message: 'route has no scope' });
  return {
    workspace: workspace.id,
    profile: workspace.slug,
    userId: principal.user.id,
    userName: principal.user.username,
    language: request.language === 'en' ? 'en' : 'ar',
  };
}

/** The service for this app: one store, the app's ports, the app's realtime layer. */
export function roomsServiceFor(app: FastifyInstance): RoomsService {
  return new RoomsService(
    new RoomsStore(requireSqlite(app.hub.database)),
    portsOf(app),
    roomsRealtimeFor(app.hub.io),
  );
}

function hubUrlOf(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

function readBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

type Json = Record<string, unknown>;

export const roomsModule = defineModule({
  name: 'rooms',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };
    const service = (request: FastifyRequest) => roomsServiceFor(request.server);
    const room = (params: Json) => String(params.room_id);
    const seat = (params: Json) => String(params.seat_id);

    // Who may enter a room's channel on `/rt/rooms`: a member, in a profile the socket was
    // admitted to — the same question `GET /rooms/{id}` asks.
    roomsRealtimeFor(app.hub.io).admitWith(async (socket: Socket, roomId: string) => {
      const { principal, workspaces = [] } = socket.data as {
        principal?: { user: { id: string } };
        workspaces?: ReadonlyArray<{ id: string; slug: string }>;
      };
      if (!principal) return null;
      const store = new RoomsStore(requireSqlite(app.hub.database));
      for (const workspace of workspaces) {
        const found = store.getRoom(workspace.id, roomId);
        const member = found ? store.member(found.id, principal.user.id) : undefined;
        if (found && member) {
          const person = portsOf(app).person(principal.user.id);
          return {
            memberId: member.id,
            name: person?.name ?? principal.user.id,
            profile: workspace.slug,
          };
        }
      }
      return null;
    });

    defineRoute(app, deps, {
      operationId: 'rooms.list',
      handler: (request, { query }) =>
        service(request).list(scopeOf(request), {
          archived: readBoolean(query.archived) ?? false,
          ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
          limit: clampLimit(query.limit as number | undefined),
        }),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.create',
      status: 201,
      handler: (request, { body }) =>
        service(request).create(scopeOf(request), body as Parameters<RoomsService['create']>[1]),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.get',
      handler: (request, { params }) => service(request).detail(scopeOf(request), room(params)),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.update',
      handler: (request, { params, body }) =>
        service(request).update(
          scopeOf(request),
          room(params),
          body as Parameters<RoomsService['update']>[2],
        ),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.delete',
      status: 204,
      handler: (request, { params }) => {
        service(request).remove(scopeOf(request), room(params));
        return null;
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.clone',
      status: 201,
      handler: (request, { params, body }) =>
        service(request).clone(
          scopeOf(request),
          room(params),
          (body as { name?: string } | undefined)?.name,
        ),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.rotateInviteCode',
      handler: (request, { params }) =>
        service(request).rotateInvite(scopeOf(request), room(params), hubUrlOf(request)),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.previewInvite',
      handler: (request, { params }) =>
        service(request).previewInvite(principalOf(request).id, String(params.invite_code)),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.join',
      handler: (request, { params }) => {
        const user = principalOf(request);
        return service(request).join(
          {
            userId: user.id,
            userName: user.username,
            language: request.language === 'en' ? 'en' : 'ar',
          },
          String(params.invite_code),
        ).room;
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.listMembers',
      handler: (request, { params }) => ({
        items: service(request).listMembers(scopeOf(request), room(params)),
      }),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.removeMember',
      status: 204,
      handler: (request, { params }) => {
        service(request).removeMember(scopeOf(request), room(params), String(params.member_id));
        return null;
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.addSeat',
      status: 201,
      handler: (request, { params, body }) =>
        service(request).addSeat(scopeOf(request), room(params), body as SeatConfigInput),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.updateSeat',
      handler: (request, { params, body }) =>
        service(request).updateSeat(
          scopeOf(request),
          room(params),
          seat(params),
          body as Partial<SeatConfigInput>,
        ),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.removeSeat',
      status: 204,
      handler: async (request, { params }) => {
        await service(request).removeSeat(scopeOf(request), room(params), seat(params));
        return null;
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.listMessages',
      handler: (request, { params, query }) =>
        service(request).listMessages(scopeOf(request), room(params), {
          ...(typeof query.before === 'string' ? { before: query.before } : {}),
          limit: clampLimit(query.limit as number | undefined),
        }),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.postMessage',
      status: 202,
      handler: (request, { params, body }) => {
        const input = body as {
          content: Json[];
          mentions?: StoredMention[];
          reply_to_message_id?: string | null;
        };
        const posted = service(request).post(scopeOf(request), room(params), input);
        return { message_id: posted.message.id, runs: [] };
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.listSeatPresets',
      handler: async (request) => ({
        items: await service(request).listPresets(scopeOf(request)),
      }),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.createSeatPreset',
      status: 201,
      handler: (request, { body }) =>
        service(request).createPreset(
          scopeOf(request),
          body as { name?: string; seat?: SeatConfigInput },
        ),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.updateSeatPreset',
      handler: (request, { params, body }) =>
        service(request).updatePreset(
          scopeOf(request),
          String(params.preset_id),
          body as { name?: string; seat?: SeatConfigInput },
        ),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.deleteSeatPreset',
      status: 204,
      handler: (request, { params }) => {
        service(request).deletePreset(scopeOf(request), String(params.preset_id));
        return null;
      },
    });
  },
  registerEvents(io: SocketServer) {
    io.of(REALTIME_NAMESPACES.rooms);
    roomsRealtimeFor(io).attach();
  },
});

function principalOf(request: FastifyRequest): { id: string; username: string } {
  const principal = request.principal;
  if (!principal) throw new HubError('unauthorized');
  return principal.user;
}

export const registerRoutes = roomsModule.registerRoutes.bind(roomsModule);
export const registerEvents = roomsModule.registerEvents.bind(roomsModule);
