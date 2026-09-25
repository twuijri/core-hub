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
import { jobRunnerFor } from '../audit/index.js';
import { requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { Conductor } from './conductor.js';
import { roomsRealtimeFor } from './realtime.js';
import { toChain } from './serialize.js';
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

const conductors = new WeakMap<SocketServer, Conductor>();

/** This hub's conductor: the agents' turns in every room (`conductor.ts`). Exported for tests. */
export function conductorFor(app: FastifyInstance): Conductor {
  const existing = conductors.get(app.hub.io);
  if (existing) return existing;
  const created = new Conductor(
    () => new RoomsStore(requireSqlite(app.hub.database)),
    () => portsOf(app).seats,
    roomsRealtimeFor(app.hub.io),
    (userId) => portsOf(app).person(userId)?.name ?? null,
    app.log,
    (scope, roomId) => summariseWhenDue(app, scope, roomId),
  );
  conductors.set(app.hub.io, created);
  return created;
}

/** The service for this app: one store, the app's ports, the app's realtime layer. */
export function roomsServiceFor(app: FastifyInstance): RoomsService {
  return new RoomsService(
    new RoomsStore(requireSqlite(app.hub.database)),
    portsOf(app),
    roomsRealtimeFor(app.hub.io),
    conductorFor(app),
  );
}

/**
 * Rewrite a room's summary as a job (`rooms.run`), so `/rt/jobs` says when it is done. The
 * job answers at once; the summary follows on `memory.updated`.
 */
function startSummary(app: FastifyInstance, scope: RoomScope, roomId: string): { job_id: string } {
  const job = jobRunnerFor(app).start(
    {
      workspace: scope.workspace,
      ownerId: scope.userId,
      kind: 'rooms.run',
      entityKind: 'room',
      entityId: roomId,
      input: { summary: true },
    },
    async () => {
      const memory = await roomsServiceFor(app).refreshMemory(scope, roomId);
      return { memory };
    },
  );
  return { job_id: job.id };
}

/** After a reply: the summary is due when `every_turns` messages are not covered by it yet. */
function summariseWhenDue(app: FastifyInstance, scope: RoomScope, roomId: string): void {
  try {
    const service = roomsServiceFor(app);
    const room = service.store.getRoom(scope.workspace, roomId);
    if (!room || room.summaryEveryTurns <= 0 || room.memoryStatus === 'summarizing') return;
    if (service.uncovered(room).length < room.summaryEveryTurns) return;
    startSummary(app, scope, roomId);
  } catch (error) {
    app.log.warn({ err: error, roomId }, 'rooms: could not start the summary');
  }
}

/** The contract's `Run` of each live id, with the room's ids set. */
function roomRuns(app: FastifyInstance, scope: RoomScope, roomId: string, ids: string[]) {
  const port = portsOf(app).seats;
  if (!port || ids.length === 0) return [];
  return port.runs(scope, ids).map((run) => ({ ...run, room_id: roomId }));
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
    // A restart ends every turn it finds running; the replies it left streaming are closed.
    app.addHook('onReady', async () => {
      try {
        const settled = conductorFor(app).settle();
        if (settled > 0)
          app.log.warn({ replies: settled }, 'rooms: settled replies a restart cut short');
      } catch (error) {
        app.log.warn({ err: error }, 'rooms: could not settle replies left streaming');
      }
    });

    defineRoute(app, deps, {
      operationId: 'rooms.get',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const id = room(params);
        const live = conductorFor(request.server).liveRuns(id);
        return service(request).detail(scope, id, roomRuns(request.server, scope, id, live));
      },
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
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        service(request).requireManager(scope, room(params));
        await conductorFor(request.server).stopRoom(scope, room(params));
        service(request).remove(scope, room(params));
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
        const scope = scopeOf(request);
        const found = service(request).requireManager(scope, room(params));
        const target = service(request).requireSeat(found.id, seat(params));
        await conductorFor(request.server).stopSeat(scope, found, target);
        await service(request).removeSeat(scope, room(params), seat(params));
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
      handler: async (request, { params, body }) => {
        const input = body as {
          content: Json[];
          mentions?: StoredMention[];
          reply_to_message_id?: string | null;
        };
        const scope = scopeOf(request);
        const posted = service(request).post(scope, room(params), input);
        const runs =
          posted.targets.length > 0
            ? await conductorFor(request.server).dispatch(
                scope,
                posted.room,
                posted.targets,
                posted.message,
              )
            : [];
        return { message_id: posted.message.id, runs };
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.stopSeat',
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const { room: found } = service(request).requireRoom(scope, room(params));
        const target = service(request).requireSeat(found.id, seat(params));
        await conductorFor(request.server).stopSeat(scope, found, target);
        return service(request).seatOf(found.id, target.id);
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.listRuns',
      handler: (request, { params, query }) => {
        const scope = scopeOf(request);
        const { room: found } = service(request).requireRoom(scope, room(params));
        const port = portsOf(request.server).seats;
        if (!port) return { items: [], next_cursor: null };
        const sessions = service(request)
          .store.allSeats(found.id)
          .map((row) => row.sessionId);
        const page = port.list(scope, sessions, {
          status: typeof query.status === 'string' ? query.status : undefined,
          cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
          limit: clampLimit(query.limit as number | undefined),
        });
        // Live runs first, then newest: a queue reads top down.
        const live = (run: Record<string, unknown>) =>
          ['queued', 'running', 'waiting'].includes(String(run.status)) ? 0 : 1;
        const items = page.items
          .map((run) => ({ ...run, room_id: found.id }))
          .sort((a, b) => live(a) - live(b));
        return { items, next_cursor: page.next_cursor };
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.listHandoffs',
      handler: (request, { params }) => {
        const { room: found } = service(request).requireRoom(scopeOf(request), room(params));
        return { items: service(request).store.chains(found.id).map(toChain) };
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.continueHandoff',
      status: 202,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const { room: found } = service(request).requireRoom(scope, room(params));
        return conductorFor(request.server).continueChain(scope, found, String(params.chain_id));
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.clearContext',
      status: 204,
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        service(request).requireManager(scope, room(params));
        await conductorFor(request.server).stopRoom(scope, room(params));
        await service(request).clearContext(scope, room(params));
        return null;
      },
    });
    defineRoute(app, deps, {
      operationId: 'rooms.getMemory',
      handler: (request, { params }) => service(request).memoryOf(scopeOf(request), room(params)),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.putMemory',
      handler: (request, { params, body }) =>
        service(request).putMemory(
          scopeOf(request),
          room(params),
          String((body as { summary: string }).summary),
        ),
    });
    defineRoute(app, deps, {
      operationId: 'rooms.refreshMemory',
      status: 202,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const found = service(request).requireManager(scope, room(params));
        if (found.memoryStatus === 'summarizing') {
          throw new HubError('state_invalid', { details: { reason: 'already_summarizing' } });
        }
        return startSummary(request.server, scope, found.id);
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
