// `pnpm contract:test`: a room from making it to reading its transcript, driven through the
// generated TypeScript client — every answer validated against the schema the contract
// documents for its status, and every `/rt/rooms` envelope against its event schema.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import { conductorFor } from '../../src/modules/rooms/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';
const AGENT = '01KAGENTXYZ000000000000000';
const eventsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/events',
);

function eventValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
    addFormatsModule) as FormatsPlugin;
  addFormats(ajv);
  return (namespace: string, envelope: { event: string }): string[] => {
    const file = path.join(eventsDir, namespace, `${envelope.event}.schema.json`);
    const schema = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete schema.$id;
    const validate = ajv.compile(schema);
    return validate(envelope)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
  };
}

type Json = Record<string, unknown>;

describe.skipIf(!doc)('contract: rooms', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  const validEvent = eventValidator();
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;
  const envelopes: Array<{ event: string }> = [];

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { params?: Record<string, string>; body?: unknown; query?: Json } = {},
  ): Promise<Json> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
        ...(init.query ? { query: init.query as Record<string, string> } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      status = res.status;
      data = res.data;
    } catch (error) {
      if (!(error instanceof HubApiError)) throw error;
      status = error.status;
      data = error.body;
    }
    expect(status, `${operationId}: ${JSON.stringify(data)}`).toBe(expectedStatus);
    const schema = responseSchema(op, status);
    if (schema) expect(schemas.validate(schema, data), operationId).toEqual([]);
    return (data ?? {}) as Json;
  }

  beforeAll(async () => {
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
      runner: new FakeAgentRunner({
        script: [{ type: 'message_delta', text: 'تم.' }, { type: 'completed' }],
        // In the handoff room, one seat passes to the other and back until the cap stops it.
        scriptFor(_request, prompt) {
          if (prompt.startsWith('You are @أ,'))
            return [
              { type: 'reasoning_delta', text: 'أفكّر' },
              {
                type: 'tool_started',
                ref: 't1',
                name: 'read_file',
                kind: 'shell',
                title: 'plan.md',
              },
              { type: 'tool_completed', ref: 't1', output: 'ok', exitCode: 0 },
              { type: 'message_delta', text: 'إليك يا @ب' },
              { type: 'usage', inputTokens: 3, outputTokens: 2 },
              { type: 'completed' },
            ];
          if (prompt.startsWith('You are @ب,'))
            return [{ type: 'message_delta', text: 'وإليك يا @أ' }, { type: 'completed' }];
          if (prompt.startsWith('You are @البطيء,'))
            return [{ type: 'message_delta', text: 'أعمل' }, { type: 'await_input' }];
          return null;
        },
      }),
      agentTimeoutMs: 5_000,
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    // Every envelope the rooms namespace sends, as a socket in the room would get it.
    const nsp = hub.app.hub.io.of('/rt/rooms');
    const to = nsp.to.bind(nsp);
    nsp.to = ((room: string) => {
      const target = to(room);
      return {
        emit: (event: string, envelope: { event: string }) => {
          envelopes.push(envelope);
          return target.emit(event, envelope);
        },
      };
    }) as never;
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    client = createHubClient({
      baseUrl,
      apiBase: serverBasePath(document),
      profile: 'default',
      token: () => token,
    });
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
    });
    token = login.access_token as string;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('makes, reads, edits and talks in a room as the contract says', async () => {
    const created = await call('rooms.create', 201, {
      body: {
        name: 'غرفة العقد',
        seats: [
          { agent_id: AGENT, name: 'المخطِّط', instructions: 'خطط' },
          { agent_id: AGENT, name: 'all' },
        ],
      },
    });
    const room = created.room as Json & { id: string; invite_code: string; seats: Json[] };
    expect((created.seat_results as Json[]).map((r) => r.ok)).toEqual([true, false]);
    const roomId = room.id;
    const seatId = String(room.seats[0]!.id);

    await call('rooms.list', 200);
    await call('rooms.list', 200, { query: { archived: 'true' } });
    await call('rooms.get', 200, { params: { room_id: roomId } });
    await call('rooms.update', 200, {
      params: { room_id: roomId },
      body: { name: 'غرفة العقد ٢' },
    });
    await call('rooms.addSeat', 201, {
      params: { room_id: roomId },
      body: { agent_id: AGENT, name: 'المبرمج' },
    });
    await call('rooms.addSeat', 409, {
      params: { room_id: roomId },
      body: { agent_id: AGENT, name: 'المبرمج' },
    });
    await call('rooms.updateSeat', 200, {
      params: { room_id: roomId, seat_id: seatId },
      body: { description: 'يضع الخطة' },
    });
    const invite = await call('rooms.rotateInviteCode', 200, { params: { room_id: roomId } });
    const code = String(invite.invite_code);
    await call('rooms.previewInvite', 200, { params: { invite_code: code } });
    await call('rooms.previewInvite', 404, { params: { invite_code: 'ZZZZ2222' } });
    await call('rooms.join', 200, { params: { invite_code: code }, body: {} });
    const members = await call('rooms.listMembers', 200, { params: { room_id: roomId } });
    const owner = (members.items as Json[])[0]!;
    await call('rooms.removeMember', 403, {
      params: { room_id: roomId, member_id: String(owner.id) },
    });

    const posted = await call('rooms.postMessage', 202, {
      params: { room_id: roomId },
      body: {
        content: [{ type: 'text', text: '@المخطِّط ما الخطوة التالية؟' }],
        mentions: [{ kind: 'seat', seat_id: seatId }],
      },
    });
    expect(posted.message_id).toEqual(expect.any(String));
    await call('rooms.postMessage', 404, {
      params: { room_id: roomId },
      body: {
        content: [{ type: 'text', text: 'x' }],
        mentions: [{ kind: 'seat', seat_id: '01KAGENTNAWAY0000000000000' }],
      },
    });
    await call('rooms.listMessages', 200, { params: { room_id: roomId } });

    const clone = await call('rooms.clone', 201, { params: { room_id: roomId }, body: {} });
    await call('rooms.removeSeat', 204, { params: { room_id: roomId, seat_id: seatId } });
    await call('rooms.update', 200, { params: { room_id: roomId }, body: { archived: true } });
    await call('rooms.postMessage', 409, {
      params: { room_id: roomId },
      body: { content: [{ type: 'text', text: 'late' }] },
    });
    await call('rooms.delete', 204, { params: { room_id: String(clone.id) } });
    await call('rooms.get', 404, { params: { room_id: String(clone.id) } });

    const preset = await call('rooms.createSeatPreset', 201, {
      body: { name: 'مراجع', seat: { agent_id: AGENT, name: 'المراجع' } },
    });
    await call('rooms.listSeatPresets', 200);
    await call('rooms.updateSeatPreset', 200, {
      params: { preset_id: String(preset.id) },
      body: { name: 'مراجع دقيق' },
    });
    await call('rooms.deleteSeatPreset', 204, { params: { preset_id: String(preset.id) } });
    await call('rooms.deleteSeatPreset', 404, { params: { preset_id: String(preset.id) } });

    // Part 2: agents answer, pass the turn, stop at the cap, go one more round, stop, forget.
    const talk = await call('rooms.create', 201, {
      body: {
        name: 'غرفة التسليم',
        seats: [
          { agent_id: AGENT, name: 'أ' },
          { agent_id: AGENT, name: 'ب' },
          { agent_id: AGENT, name: 'البطيء' },
        ],
        handoff: { enabled: true, max_depth: 1 },
      },
    });
    const talkRoom = talk.room as Json & { id: string; seats: Array<Json & { id: string }> };
    const [a, , slow] = talkRoom.seats;
    const accepted = await call('rooms.postMessage', 202, {
      params: { room_id: talkRoom.id },
      body: {
        content: [{ type: 'text', text: '@أ ابدأ' }],
        mentions: [{ kind: 'seat', seat_id: a!.id }],
      },
    });
    expect((accepted.runs as Json[]).length).toBe(1);
    await conductorFor(hub.app).idle();
    const chains = await call('rooms.listHandoffs', 200, { params: { room_id: talkRoom.id } });
    const chain = (chains.items as Json[])[0]!;
    expect(chain).toMatchObject({ status: 'stopped', stop_reason: 'max_depth' });
    await call('rooms.continueHandoff', 202, {
      params: { room_id: talkRoom.id, chain_id: String(chain.id) },
    });
    await conductorFor(hub.app).idle();
    await call('rooms.continueHandoff', 409, {
      params: { room_id: talkRoom.id, chain_id: String(chain.id) },
    });
    await call('rooms.continueHandoff', 404, {
      params: { room_id: talkRoom.id, chain_id: '01KAGENTNAWAY0000000000000' },
    });
    await call('rooms.postMessage', 202, {
      params: { room_id: talkRoom.id },
      body: {
        content: [{ type: 'text', text: '@البطيء' }],
        mentions: [{ kind: 'seat', seat_id: slow!.id }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await call('rooms.get', 200, { params: { room_id: talkRoom.id } });
    await call('rooms.stopSeat', 200, { params: { room_id: talkRoom.id, seat_id: slow!.id } });
    await call('rooms.stopSeat', 404, {
      params: { room_id: talkRoom.id, seat_id: '01KAGENTNAWAY0000000000000' },
    });
    await conductorFor(hub.app).idle();
    await call('rooms.listRuns', 200, { params: { room_id: talkRoom.id } });
    await call('rooms.listRuns', 404, { params: { room_id: '01KAGENTNAWAY0000000000000' } });
    await call('rooms.clearContext', 204, { params: { room_id: talkRoom.id } });

    const names = envelopes.map((e) => e.event);
    for (const event of [
      'room.created',
      'room.updated',
      'room.deleted',
      'seat.added',
      'seat.updated',
      'seat.removed',
      'message.created',
      'message.delta',
      'reasoning.delta',
      'tool.started',
      'tool.completed',
      'run.completed',
      'run.cancelled',
      'handoff.updated',
      'room.cleared',
    ]) {
      expect(names).toContain(event);
    }
    for (const envelope of envelopes) {
      expect(validEvent('rooms', envelope), envelope.event).toEqual([]);
    }
  });
});
