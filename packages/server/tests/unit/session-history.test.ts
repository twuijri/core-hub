/**
 * Paging back through a long conversation (`sessions.listMessages` with `before`).
 *
 * The chat opens with the newest page and loads the one before it as the person scrolls
 * up (docs/changes/2026-09-24-twuijri-chat-older-messages.md). That only works if walking
 * back by the oldest id held gives every message exactly once, in order, and says when the
 * start is reached — and if a cursor that is not a message of this conversation is refused
 * rather than answered with the newest page again, which a client would take for history.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { requireSqlite } from '../../src/lib/db.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import { sessions } from '../../src/modules/sessions/schema.js';
import { SessionsStore } from '../../src/modules/sessions/store.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub } from './helpers.js';

type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';

interface Page {
  items: Array<{ id: string; seq: number; content: Array<{ type: string; text?: string }> }>;
  has_more: boolean;
}

async function hub() {
  const module = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
    scopes: principalScopeResolver,
  });
  return signedInHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? module : m)) },
  );
}

/** A conversation `count` messages long, written straight into the store. */
async function longSession(h: Hub, count: number): Promise<string> {
  const created = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { agent_id: AGENT },
  });
  const id = (created.json() as { id: string }).id;
  const db = requireSqlite(h.app.hub.database);
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get()!;
  const store = new SessionsStore(db);
  for (let n = 1; n <= count; n += 1) {
    const user = n % 2 === 1;
    store.appendMessage({
      workspace: row.workspace,
      ownerId: row.ownerId,
      sessionId: id,
      runId: null,
      role: user ? 'user' : 'assistant',
      authorKind: user ? 'user' : 'agent',
      authorId: user ? row.ownerId : AGENT,
      content: `رسالة ${n}`,
      parts: [],
      attachmentIds: [],
    });
  }
  return id;
}

const page = async (h: Hub, id: string, query: string) => {
  const response = await authed(h, h.token, {
    method: 'GET',
    url: `/api/v1/sessions/${id}/messages?${query}`,
  });
  return { status: response.statusCode, body: response.json() as Page };
};

describe('sessions: paging back through a conversation', () => {
  it('walks back by the oldest id held: every message once, in order, and then the start', async () => {
    const h = await hub();
    try {
      const id = await longSession(h, 250);
      const newest = await page(h, id, 'limit=100');
      expect(newest.status).toBe(200);
      expect(newest.body.items.map((m) => m.seq)).toEqual(
        Array.from({ length: 100 }, (_, i) => 151 + i),
      );
      expect(newest.body.has_more).toBe(true);

      let held = newest.body.items;
      let more = newest.body.has_more;
      let pages = 0;
      while (more) {
        const older = await page(h, id, `before=${held[0]!.id}&limit=100`);
        expect(older.status).toBe(200);
        // Oldest first, and each page ends right where the held messages begin.
        expect(older.body.items.at(-1)!.seq).toBe(held[0]!.seq - 1);
        held = [...older.body.items, ...held];
        more = older.body.has_more;
        pages += 1;
      }
      expect(pages).toBe(2);
      expect(held.map((m) => m.seq)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
      expect(new Set(held.map((m) => m.id)).size).toBe(250);
      expect(held[0]!.content[0]).toMatchObject({ type: 'text', text: 'رسالة 1' });

      // The first message has nothing before it.
      const start = await page(h, id, `before=${held[0]!.id}&limit=100`);
      expect(start.body).toEqual({ items: [], has_more: false });
    } finally {
      await h.close();
    }
  });

  it('a page is not shifted by messages written while the reader pages back', async () => {
    const h = await hub();
    try {
      const id = await longSession(h, 120);
      const newest = await page(h, id, 'limit=50');
      const oldestHeld = newest.body.items[0]!;
      // The agent keeps talking at the bottom meanwhile.
      const db = requireSqlite(h.app.hub.database);
      const row = db.select().from(sessions).where(eq(sessions.id, id)).get()!;
      new SessionsStore(db).appendMessage({
        workspace: row.workspace,
        ownerId: row.ownerId,
        sessionId: id,
        runId: null,
        role: 'assistant',
        authorKind: 'agent',
        authorId: AGENT,
        content: 'جديدة',
        parts: [],
        attachmentIds: [],
      });
      const older = await page(h, id, `before=${oldestHeld.id}&limit=50`);
      expect(older.body.items.map((m) => m.seq)).toEqual(
        Array.from({ length: 50 }, (_, i) => oldestHeld.seq - 50 + i),
      );
    } finally {
      await h.close();
    }
  });

  it('refuses a cursor that is not a message of this conversation', async () => {
    const h = await hub();
    try {
      const mine = await longSession(h, 5);
      const other = await longSession(h, 5);
      const theirs = (await page(h, other, 'limit=5')).body.items[0]!.id;
      const response = await page(h, mine, `before=${theirs}&limit=5`);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'not_found' });
      // Well-formed but unknown: the same answer.
      const unknown = await page(h, mine, 'before=01KNZZZZZZZZZZZZZZZZZZZZZZ&limit=5');
      expect(unknown.status).toBe(404);
    } finally {
      await h.close();
    }
  });
});
