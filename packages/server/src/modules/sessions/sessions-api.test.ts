/**
 * The non-streaming half of the module: CRUD, cursor paging, archive,
 * rename, search, fork, export, workspace isolation — and the operations
 * that are honestly still `501`.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadOpenApiDocument } from '@majlis/contracts';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

/**
 * Validate a response body against a `components.schemas` entry of
 * packages/contracts/openapi.yaml. The event schemas already cover these
 * shapes as they travel over the socket; this asserts the HTTP side answers
 * with the same document the contract declares.
 */
const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);

function expectMatchesSchema(name: string, data: unknown): void {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${name}`,
    components: document?.components ?? {},
  });
  expect(
    validate(data)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`),
    `response does not match ${name}`,
  ).toEqual([]);
}

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
  options: { body?: unknown; profile?: string; language?: string } = {},
) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'x-hub-profile': options.profile ?? 'default',
      ...(options.language ? { 'accept-language': options.language } : {}),
    },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  return { status: res.statusCode, body: res.body, json: () => res.json() as never };
}

const create = (app: FastifyInstance, body: Record<string, unknown> = {}, profile?: string) =>
  call(app, 'POST', '/sessions', {
    body: { agent_id: AGENT_ID, ...body },
    ...(profile ? { profile } : {}),
  });

describe('sessions: create, read, rename, archive, delete', () => {
  it('mints the id and returns a complete Session document', async () => {
    const hub = await hubWithAgent();
    try {
      const res = await create(hub.app, { title: 'خطة الإطلاق', working_dir: '/srv/project' });
      expect(res.status).toBe(201);
      const session = res.json() as Record<string, unknown>;
      expect(session).toMatchObject({
        profile: 'default',
        agent_id: AGENT_ID,
        title: 'خطة الإطلاق',
        source: 'chat',
        model: 'hermes-4',
        provider: 'nous',
        working_dir: '/srv/project',
        pinned: false,
        archived: false,
        message_count: 0,
        status: 'idle',
        active_run_id: null,
        parent_session_id: null,
        notify: true,
        usage: null,
        match: null,
      });
      expect(session.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expectMatchesSchema('Session', session);
    } finally {
      await hub.close();
    }
  });

  it('renames, pins and archives through the patch, and hides archived by default', async () => {
    const hub = await hubWithAgent();
    try {
      const id = ((await create(hub.app)).json() as { id: string }).id;
      const renamed = await call(hub.app, 'PATCH', `/sessions/${id}`, {
        body: { title: 'اسم جديد', pinned: true },
      });
      expect(renamed.json()).toMatchObject({ title: 'اسم جديد', pinned: true });

      await call(hub.app, 'PATCH', `/sessions/${id}`, { body: { archived: true } });
      const live = await call(hub.app, 'GET', '/sessions');
      expect((live.json() as { items: unknown[] }).items).toHaveLength(0);

      const archived = await call(hub.app, 'GET', '/sessions?archived=true');
      expect((archived.json() as { items: { archived: boolean }[] }).items[0]?.archived).toBe(true);

      const all = await call(hub.app, 'GET', '/sessions?archived=all');
      expect((all.json() as { items: unknown[] }).items).toHaveLength(1);

      // Un-archiving is the same patch the other way.
      await call(hub.app, 'PATCH', `/sessions/${id}`, { body: { archived: false } });
      expect(
        ((await call(hub.app, 'GET', '/sessions')).json() as { items: unknown[] }).items,
      ).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('404s an unknown or malformed session id with the error envelope, localised', async () => {
    const hub = await hubWithAgent();
    try {
      const unknown = await call(hub.app, 'GET', '/sessions/01J8QK3ZR2W7M5N4P6T8V9X0ZZ');
      expect(unknown.status).toBe(404);
      expect(unknown.json()).toEqual({
        error: 'The requested item does not exist.',
        code: 'not_found',
        details: { resource: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ' },
      });

      const arabic = await call(hub.app, 'GET', '/sessions/not-a-ulid', { language: 'ar' });
      expect(arabic.status).toBe(404);
      expect((arabic.json() as { error: string }).error).toBe('العنصر المطلوب غير موجود.');
    } finally {
      await hub.close();
    }
  });

  it('deletes a session and its transcript', async () => {
    const hub = await hubWithAgent();
    try {
      const id = ((await create(hub.app)).json() as { id: string }).id;
      const deleted = await call(hub.app, 'DELETE', `/sessions/${id}`);
      expect(deleted.status).toBe(204);
      expect((await call(hub.app, 'GET', `/sessions/${id}`)).status).toBe(404);
    } finally {
      await hub.close();
    }
  });
});

describe('sessions: the HTTP documents match the contract', () => {
  it('answers SessionDetail, MessagePage and the run page in their declared shapes', async () => {
    const hub = await hubWithAgent();
    try {
      const id = ((await create(hub.app, { title: 'contract shapes' })).json() as { id: string })
        .id;
      await call(hub.app, 'POST', `/sessions/${id}/runs`, {
        body: { content: [{ type: 'text', text: 'مرحبا' }] },
      });

      expectMatchesSchema('SessionDetail', (await call(hub.app, 'GET', `/sessions/${id}`)).json());
      expectMatchesSchema(
        'MessagePage',
        (await call(hub.app, 'GET', `/sessions/${id}/messages`)).json(),
      );
      const runs = (await call(hub.app, 'GET', `/sessions/${id}/runs`)).json() as {
        items: unknown[];
      };
      for (const run of runs.items) expectMatchesSchema('Run', run);

      const approvals = (await call(hub.app, 'GET', '/approvals')).json() as { items: unknown[] };
      for (const approval of approvals.items) expectMatchesSchema('Approval', approval);
    } finally {
      await hub.close();
    }
  });
});

describe('sessions: listing', () => {
  it('pages with a cursor: three pages equal one, with no repeats and no gaps', async () => {
    const hub = await hubWithAgent();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push(((await create(hub.app, { title: `session ${i}` })).json() as { id: string }).id);
      }
      const first = (await call(hub.app, 'GET', '/sessions?limit=2')).json() as {
        items: { id: string }[];
        next_cursor: string | null;
      };
      expect(first.items).toHaveLength(2);
      expect(first.next_cursor).toBeTypeOf('string');

      const second = (
        await call(
          hub.app,
          'GET',
          `/sessions?limit=2&cursor=${encodeURIComponent(first.next_cursor as string)}`,
        )
      ).json() as { items: { id: string }[]; next_cursor: string | null };
      const third = (
        await call(
          hub.app,
          'GET',
          `/sessions?limit=2&cursor=${encodeURIComponent(second.next_cursor as string)}`,
        )
      ).json() as { items: { id: string }[]; next_cursor: string | null };

      const seen = [...first.items, ...second.items, ...third.items].map((s) => s.id);
      expect(third.next_cursor).toBeNull();
      expect(new Set(seen)).toEqual(new Set(ids));

      // The cursor's only real promise: walking the pages gives exactly what
      // one big page gives, in the same order. (Sessions created inside the
      // same millisecond share a sort key and are ordered by id, so that is
      // not always creation order — but it is always the same order.)
      const single = (await call(hub.app, 'GET', '/sessions?limit=50')).json() as {
        items: { id: string }[];
      };
      expect(seen).toEqual(single.items.map((s) => s.id));
    } finally {
      await hub.close();
    }
  });

  it('filters by agent and by pinned', async () => {
    const hub = await hubWithAgent();
    try {
      const id = ((await create(hub.app)).json() as { id: string }).id;
      await create(hub.app);
      await call(hub.app, 'PATCH', `/sessions/${id}`, { body: { pinned: true } });
      const pinned = (await call(hub.app, 'GET', '/sessions?pinned=true')).json() as {
        items: { id: string }[];
      };
      expect(pinned.items.map((s) => s.id)).toEqual([id]);
      const other = (
        await call(hub.app, 'GET', '/sessions?agent_id=01J8QK3ZR2W7M5N4P6T8V9X0ZZ')
      ).json() as { items: unknown[] };
      expect(other.items).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });

  it('searches titles and carries `match` on every hit', async () => {
    const hub = await hubWithAgent();
    try {
      await create(hub.app, { title: 'خطة الإطلاق' });
      await create(hub.app, { title: 'something else' });
      const hits = (
        await call(hub.app, 'GET', '/sessions?q=%D8%A7%D9%84%D8%A5%D8%B7%D9%84%D8%A7%D9%82')
      ).json() as {
        items: { title: string; match: { snippet: string } | null }[];
      };
      expect(hits.items).toHaveLength(1);
      expect(hits.items[0]?.match).not.toBeNull();
    } finally {
      await hub.close();
    }
  });

  it("never returns another workspace's sessions (invariant 3)", async () => {
    const hub = await hubWithAgent();
    try {
      await create(hub.app, { title: 'work session' }, 'work');
      const home = (await call(hub.app, 'GET', '/sessions', { profile: 'home' })).json() as {
        items: unknown[];
      };
      expect(home.items).toHaveLength(0);
      const work = (await call(hub.app, 'GET', '/sessions', { profile: 'work' })).json() as {
        items: { profile: string }[];
      };
      expect(work.items).toHaveLength(1);
      expect(work.items[0]?.profile).toBe('work');

      // And an id from one workspace is simply not found in another.
      const id = (work.items[0] as unknown as { id: string }).id;
      expect((await call(hub.app, 'GET', `/sessions/${id}`, { profile: 'home' })).status).toBe(404);
    } finally {
      await hub.close();
    }
  });

  it('refuses a malformed workspace slug rather than guessing', async () => {
    const hub = await hubWithAgent();
    try {
      const res = await call(hub.app, 'GET', '/sessions', { profile: 'NOT A SLUG' });
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({ code: 'profile_required' });
    } finally {
      await hub.close();
    }
  });
});

describe('sessions: bulk, fork and export', () => {
  it('reports per-item outcomes for a bulk patch, partial success included', async () => {
    const hub = await hubWithAgent();
    try {
      const id = ((await create(hub.app)).json() as { id: string }).id;
      const res = await call(hub.app, 'PATCH', '/sessions', {
        body: { session_ids: [id, '01J8QK3ZR2W7M5N4P6T8V9X0ZZ'], patch: { archived: true } },
        language: 'ar',
      });
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        results: [
          { id, ok: true, error: null },
          {
            id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ',
            ok: false,
            error: {
              error: 'العنصر المطلوب غير موجود.',
              code: 'not_found',
              details: { resource: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ' },
            },
          },
        ],
      });
    } finally {
      await hub.close();
    }
  });

  it('forks a session with its transcript and a link back to the parent', async () => {
    const hub = await hubWithAgent();
    try {
      const id = ((await create(hub.app, { title: 'original' })).json() as { id: string }).id;
      await call(hub.app, 'POST', `/sessions/${id}/runs`, {
        body: { content: [{ type: 'text', text: 'first question' }] },
      });
      const forked = await call(hub.app, 'POST', `/sessions/${id}/fork`, {
        body: { title: 'تجربة بديلة' },
      });
      expect(forked.status).toBe(201);
      const fork = forked.json() as { id: string; parent_session_id: string; title: string };
      expect(fork.parent_session_id).toBe(id);
      expect(fork.title).toBe('تجربة بديلة');
      const messages = (await call(hub.app, 'GET', `/sessions/${fork.id}/messages`)).json() as {
        items: { content: { text: string }[] }[];
      };
      expect(messages.items[0]?.content[0]?.text).toBe('first question');
    } finally {
      await hub.close();
    }
  });

  it('exports a transcript as JSON or Markdown, as an attachment', async () => {
    const hub = await hubWithAgent();
    try {
      const id = ((await create(hub.app, { title: 'notes' })).json() as { id: string }).id;
      await call(hub.app, 'POST', `/sessions/${id}/runs`, {
        body: { content: [{ type: 'text', text: 'مرحبا' }] },
      });
      const json = await call(hub.app, 'GET', `/sessions/${id}/export`);
      expect(json.status).toBe(200);
      const document = json.json() as { session: { id: string }; messages: unknown[] };
      expect(document.session.id).toBe(id);
      expect(document.messages.length).toBeGreaterThan(0);

      const markdown = await call(hub.app, 'GET', `/sessions/${id}/export?format=markdown`);
      expect(markdown.status).toBe(200);
      expect(markdown.body).toContain('# notes');
      expect(markdown.body).toContain('مرحبا');
    } finally {
      await hub.close();
    }
  });
});

describe('sessions: what is deliberately not implemented', () => {
  it('answers 501 for session categories, and refuses to pretend a category was set', async () => {
    const hub = await hubWithAgent();
    try {
      const list = await call(hub.app, 'GET', '/session-categories');
      expect(list.status).toBe(501);
      expect(list.json()).toMatchObject({ code: 'not_implemented' });

      const id = ((await create(hub.app)).json() as { id: string }).id;
      const patch = await call(hub.app, 'PATCH', `/sessions/${id}`, {
        body: { category_id: '01J8QK3ZR2W7M5N4P6T8V9X0CT' },
      });
      expect(patch.status).toBe(501);
      expect(patch.json()).toMatchObject({
        code: 'not_implemented',
        details: { field: 'category_id' },
      });
    } finally {
      await hub.close();
    }
  });

  it('answers 501 for attachment storage, which `knowledge` owns', async () => {
    const hub = await hubWithAgent();
    try {
      const res = await call(hub.app, 'GET', '/attachments/01J8QK3ZR2W7M5N4P6T8V9X0AT');
      expect(res.status).toBe(501);
      expect(res.json()).toMatchObject({ code: 'not_implemented' });
    } finally {
      await hub.close();
    }
  });

  it('cannot start a session with no agent registry behind it', async () => {
    // The default module list ships the real ports: nothing is installed yet.
    const hub = await testHub();
    try {
      const res = await call(hub.app, 'POST', '/sessions', {
        body: { agent_id: AGENT_ID },
      });
      expect(res.status).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found', details: { resource: 'agent' } });
    } finally {
      await hub.close();
    }
  });
});
