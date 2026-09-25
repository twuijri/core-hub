// `pnpm contract:test`: channel conversations (contract decision §55) driven through the
// generated TypeScript client against a scripted Hermes — the list of one profile and of every
// profile, one conversation's messages, and the failures (`404` for what is not a channel
// conversation, `503` when Hermes cannot be asked, `unavailable` when the hub does not supervise
// Hermes) — each answer validated against the schema the contract documents for its status.
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
import { listWorkspacesFor, principalScopeResolver } from '../../src/modules/auth/index.js';
import { requireSqlite } from '../../src/lib/db.js';
import { createSessionsModule, registerChannelSource } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import {
  scriptedChannels,
  type ScriptedChannels,
} from '../../src/modules/sessions/testing/scripted-channels.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';
const AGENT = '01KAGENTXYZ000000000000000';
const T0 = 1_790_000_000;
const CONVERSATION = '20260925_091500_aa11bb22';

describe.skipIf(!doc)('contract: channel conversations', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;
  let hermes: ScriptedChannels | null = null;
  let previous: ReturnType<typeof registerChannelSource>;

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
        ...(init.query ? { query: init.query } : {}),
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
    return (data ?? {}) as Record<string, unknown>;
  }

  beforeAll(async () => {
    previous = registerChannelSource(() => hermes);
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
      runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    client = createHubClient({
      baseUrl,
      apiBase: serverBasePath(document),
      profile: 'default',
      token: () => token,
    });
    token = (await call('auth.login', 200, { body: { username: 'admin', password: PASSWORD } }))
      .access_token as string;
  });
  afterAll(async () => {
    registerChannelSource(previous);
    await hub.close();
  });

  it('says why nothing is listed where the hub does not supervise Hermes', async () => {
    hermes = null;
    const listed = await call('sessions.listChannelConversations', 200);
    expect(listed).toEqual({
      items: [],
      unavailable: [{ profile: null, reason: 'hermes_not_managed', message: null }],
    });
    const opened = await call('sessions.listChannelMessages', 503, {
      params: { conversation_id: CONVERSATION },
    });
    expect(opened).toMatchObject({ details: { reason: 'hermes_not_managed' } });
  });

  it('lists and opens a Telegram conversation, and refuses what is not one', async () => {
    // The default workspace is Hermes's `default` profile (ADR 0014).
    const profileOf = (workspace: string) =>
      listWorkspacesFor(requireSqlite(hub.app.hub.database), { id: '', role: 'owner' }).some(
        (row) => row.id === workspace && row.isDefault,
      )
        ? 'default'
        : null;
    hermes = scriptedChannels(
      {
        default: {
          sessions: [
            {
              id: CONVERSATION,
              source: 'telegram',
              user_id: '5550001',
              chat_id: '5550001',
              chat_type: 'dm',
              display_name: 'أحمد',
              title: 'موعد التسليم',
              message_count: 2,
              started_at: T0,
              last_active: T0 + 60,
              preview: 'متى موعد التسليم؟',
            },
            { id: '20260925_070000_ee55ff66', source: 'tui', started_at: T0, message_count: 1 },
          ],
          messages: {
            [CONVERSATION]: [
              { id: 1, role: 'user', content: 'متى موعد التسليم؟', timestamp: T0 },
              { id: 2, role: 'assistant', content: 'يوم الخميس.', timestamp: T0 + 60 },
            ],
          },
        },
      },
      { profileOf },
    );
    const listed = await call('sessions.listChannelConversations', 200);
    expect(listed.items).toEqual([
      expect.objectContaining({ id: CONVERSATION, channel: 'telegram', peer_name: 'أحمد' }),
    ]);
    await call('sessions.listChannelConversations', 200, { query: { profiles: 'all' } });
    await call('sessions.listChannelConversations', 200, { query: { channel: 'whatsapp' } });
    await call('sessions.listChannelConversations', 400, { query: { channel: 'Not A Slug' } });

    const opened = await call('sessions.listChannelMessages', 200, {
      params: { conversation_id: CONVERSATION },
    });
    expect((opened.items as Array<{ text: string }>).map((m) => m.text)).toEqual([
      'متى موعد التسليم؟',
      'يوم الخميس.',
    ]);
    await call('sessions.listChannelMessages', 404, {
      params: { conversation_id: '20260925_070000_ee55ff66' },
    });
    await call('sessions.listChannelMessages', 404, {
      params: { conversation_id: 'no_such_conversation' },
    });

    hermes.down = true;
    const down = await call('sessions.listChannelMessages', 503, {
      params: { conversation_id: CONVERSATION },
    });
    expect(down).toMatchObject({ details: { reason: 'hermes_api_unavailable' } });
  });
});
