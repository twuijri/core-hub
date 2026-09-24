/**
 * The global agent (contract decision §45): one standing conversation per person per
 * profile, opened — and made the first time — by `sessions.openGlobalAgent`, never archived,
 * and never copied into a second one by a fork.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadOpenApiDocument } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const MISSING_AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0ZZ';

const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);
const validateSession = ajv.compile({
  $ref: '#/components/schemas/Session',
  components: document?.components ?? {},
});

async function hubWithAgent(): Promise<TestHub> {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({
      script: [{ type: 'message_delta', text: 'ok' }, { type: 'completed' }],
    }),
  });
  return testHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
}

async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-hub-profile': 'default' },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: () => res.json() as Record<string, unknown> };
}

const open = (app: FastifyInstance, agentId = AGENT_ID) =>
  call(app, 'POST', '/sessions/global-agent', { agent_id: agentId });

describe('sessions.openGlobalAgent', () => {
  it('makes the conversation on the first open and returns the same one afterwards', async () => {
    const hub = await hubWithAgent();
    try {
      const first = await open(hub.app);
      expect(first.status).toBe(201);
      const session = first.json();
      expect(session).toMatchObject({
        source: 'global_agent',
        agent_id: AGENT_ID,
        archived: false,
      });
      expect(validateSession(session)).toBe(true);

      const again = await open(hub.app);
      expect(again.status).toBe(200);
      expect(again.json().id).toBe(session.id);

      // Search finds it by its source, which is how the web routes a hit to its page.
      const listed = await call(hub.app, 'GET', '/sessions?source=global_agent');
      expect((listed.json().items as Array<{ id: string }>).map((s) => s.id)).toEqual([session.id]);
    } finally {
      await hub.close();
    }
  });

  it('refuses an unknown agent on the first open and makes nothing', async () => {
    const hub = await hubWithAgent();
    try {
      const res = await open(hub.app, MISSING_AGENT);
      expect(res.status).toBe(404);
      const listed = await call(hub.app, 'GET', '/sessions?source=global_agent');
      expect(listed.json().items).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('two first opens at once land on one conversation', async () => {
    const hub = await hubWithAgent();
    try {
      const [a, b] = await Promise.all([open(hub.app), open(hub.app)]);
      expect(a.json().id).toBe(b.json().id);
      const listed = await call(hub.app, 'GET', '/sessions?source=global_agent');
      expect(listed.json().items).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('is never archived, alone or in a bulk update', async () => {
    const hub = await hubWithAgent();
    try {
      const id = (await open(hub.app)).json().id as string;
      const one = await call(hub.app, 'PATCH', `/sessions/${id}`, { archived: true });
      expect(one.status).toBe(409);
      expect(one.json().code).toBe('state_invalid');

      const bulk = await call(hub.app, 'PATCH', '/sessions', {
        session_ids: [id],
        patch: { archived: true },
      });
      expect(bulk.status).toBe(200);
      const [result] = bulk.json().results as Array<{ ok: boolean; error: { code: string } }>;
      expect(result).toMatchObject({ ok: false, error: { code: 'state_invalid' } });

      // Everything else a conversation may be patched with still works.
      const renamed = await call(hub.app, 'PATCH', `/sessions/${id}`, { title: 'يومي' });
      expect(renamed.status).toBe(200);
      expect(renamed.json().archived).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it('a fork of it is an ordinary chat, and a deleted one is made again on the next open', async () => {
    const hub = await hubWithAgent();
    try {
      const id = (await open(hub.app)).json().id as string;
      const forked = await call(hub.app, 'POST', `/sessions/${id}/fork`, {});
      expect(forked.status).toBe(201);
      expect(forked.json().source).toBe('chat');
      expect((await open(hub.app)).json().id).toBe(id);

      expect((await call(hub.app, 'DELETE', `/sessions/${id}`)).status).toBe(204);
      const remade = await open(hub.app);
      expect(remade.status).toBe(201);
      expect(remade.json().id).not.toBe(id);
    } finally {
      await hub.close();
    }
  });
});
