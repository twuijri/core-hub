/**
 * Hermes's board on the hub's board, through the routes a person uses.
 *
 * The Hermes here is a small in-memory board that behaves the way the real one was seen to
 * (`hermes-kanban.real.test.ts` checks the real CLI): it lists everything but archived
 * cards, refuses the moves Hermes refuses, and returns the same card for a repeated
 * idempotency key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authed, signedInHub } from '../../../tests/unit/helpers.js';
import { HermesRefusal, type HermesKanban, type HermesTask } from './hermes-kanban.js';
import { registerHermesBoard } from './index.js';
import type { HermesBoardPort } from './hermes-mirror.js';

type Json = Record<string, unknown>;

class FakeHermes implements HermesKanban {
  cards = new Map<string, HermesTask>();
  keys = new Map<string, string>();
  refuse: string | null = null;
  failList = false;
  moves: Array<[string, string, string]> = [];
  private counter = 0;

  add(title: string, status: string, body: string | null = null): HermesTask {
    this.counter += 1;
    const card: HermesTask = {
      id: `t_${this.counter.toString(16).padStart(8, '0')}`,
      title,
      body,
      assignee: null,
      status,
      priority: 0,
      created_at: this.counter,
      result: null,
    };
    this.cards.set(card.id, card);
    return card;
  }

  async list() {
    if (this.failList) throw new Error('hermes is not answering');
    if (this.garbage !== null) return this.garbage as HermesTask[];
    return [...this.cards.values()].filter((card) => card.status !== 'archived');
  }

  async show(id: string) {
    return this.cards.get(id) ?? null;
  }

  async create(input: {
    title: string;
    body?: string | null;
    idempotencyKey: string;
    triage?: boolean;
  }) {
    const known = this.keys.get(input.idempotencyKey);
    if (known) return this.cards.get(known)!;
    if (this.refuse) throw new HermesRefusal('create', this.refuse);
    const card = this.add(input.title, input.triage ? 'triage' : 'ready', input.body ?? null);
    this.keys.set(input.idempotencyKey, card.id);
    return card;
  }

  archived: string[][] = [];
  garbage: unknown = null;

  async archive(ids: readonly string[]) {
    this.archived.push([...ids]);
    for (const id of ids) {
      const card = this.cards.get(id);
      if (card) card.status = 'archived';
    }
  }

  async move(id: string, from: string, to: string) {
    if (this.refuse) throw new HermesRefusal('block', this.refuse);
    this.moves.push([id, from, to]);
    const card = this.cards.get(id);
    if (card) card.status = to;
  }
}

let previous: ReturnType<typeof registerHermesBoard> = null;
let hermes: FakeHermes;
const HERMES_AGENT = '01KHERMESAGENT000000000000';

beforeEach(() => {
  hermes = new FakeHermes();
  const port: HermesBoardPort = {
    kanban: () => hermes,
    agentId: () => HERMES_AGENT,
    throttleMs: 0,
  };
  previous = registerHermesBoard(() => port);
});

afterEach(() => {
  registerHermesBoard(previous);
});

async function board(hub: Awaited<ReturnType<typeof signedInHub>>) {
  const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/task-columns' });
  expect(response.statusCode).toBe(200);
  const columns = (response.json() as { columns: Array<{ status: string; tasks: Json[] }> })
    .columns;
  return new Map(columns.map((column) => [column.status, column.tasks]));
}

const titles = (tasks: Json[] | undefined) => (tasks ?? []).map((task) => task.title);

describe('tasks: Hermes board reflected', () => {
  it("shows Hermes's cards in their columns, marked as Hermes's", async () => {
    hermes.add('Write the release notes', 'ready', 'For 0.4');
    hermes.add('Fix the flaky test', 'blocked');
    const hub = await signedInHub();
    try {
      const columns = await board(hub);
      expect(titles(columns.get('ready'))).toEqual(['Write the release notes']);
      expect(titles(columns.get('blocked'))).toEqual(['Fix the flaky test']);
      const card = columns.get('ready')![0]!;
      expect(card.external).toEqual({ source: 'hermes', id: 't_00000001' });
      expect(card.description).toBe('For 0.4');
      expect((card.assignee as Json | null)?.id).toBe(HERMES_AGENT);
    } finally {
      await hub.close();
    }
  });

  it('lets Hermes win: its changes overwrite the reflection on the next read', async () => {
    const card = hermes.add('Draft', 'ready');
    const hub = await signedInHub();
    try {
      await board(hub);
      card.title = 'Draft, renamed by Hermes';
      card.status = 'review';
      card.result = 'ready for a look';
      const columns = await board(hub);
      expect(titles(columns.get('ready'))).toEqual([]);
      const moved = columns.get('review')![0]!;
      expect(moved.title).toBe('Draft, renamed by Hermes');
      expect(moved.latest_summary).toBe('ready for a look');
    } finally {
      await hub.close();
    }
  });

  it('archives a reflection whose card Hermes no longer lists', async () => {
    const card = hermes.add('Old', 'done');
    const hub = await signedInHub();
    try {
      await board(hub);
      hermes.cards.delete(card.id);
      const columns = await board(hub);
      expect(titles(columns.get('done'))).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('still answers with the last reflection when Hermes cannot be read', async () => {
    hermes.add('Kept', 'ready');
    const hub = await signedInHub();
    try {
      await board(hub);
      hermes.failList = true;
      expect(titles((await board(hub)).get('ready'))).toEqual(['Kept']);
    } finally {
      await hub.close();
    }
  });

  it('moves a Hermes card on Hermes first', async () => {
    const card = hermes.add('Ship it', 'ready');
    const hub = await signedInHub();
    try {
      const id = (await board(hub)).get('ready')![0]!.id as string;
      const moved = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id}/move`,
        payload: { status: 'done' },
      });
      expect(moved.statusCode).toBe(200);
      expect((moved.json() as Json).status).toBe('done');
      expect(hermes.moves).toEqual([[card.id, 'ready', 'done']]);
    } finally {
      await hub.close();
    }
  });

  it("refuses with Hermes's own words when Hermes refuses, and changes nothing", async () => {
    hermes.add('Stuck', 'ready');
    const hub = await signedInHub();
    try {
      const id = (await board(hub)).get('ready')![0]!.id as string;
      hermes.refuse = 'cannot block t_00000001: it has a live run';
      const moved = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id}/move`,
        payload: { status: 'blocked', reason: 'waiting' },
      });
      expect(moved.statusCode).toBe(409);
      expect((moved.json() as Json).details).toMatchObject({
        reason: 'hermes_refused',
        message: 'cannot block t_00000001: it has a live run',
      });
      hermes.refuse = null;
      expect(titles((await board(hub)).get('ready'))).toEqual(['Stuck']);
    } finally {
      await hub.close();
    }
  });

  it("keeps Hermes's words Hermes's: title and description cannot be edited here", async () => {
    hermes.add('Hermes wrote this', 'ready');
    const hub = await signedInHub();
    try {
      const id = (await board(hub)).get('ready')![0]!.id as string;
      const edited = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${id}`,
        payload: { title: 'Mine now' },
      });
      expect(edited.statusCode).toBe(409);
      expect((edited.json() as Json).details).toMatchObject({ reason: 'hermes_owns_text' });
      // What the hub does own — priority — still edits.
      const priority = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${id}`,
        payload: { priority: 'high' },
      });
      expect(priority.statusCode).toBe(200);
    } finally {
      await hub.close();
    }
  });

  it('refuses to delete or stop a Hermes card, since Hermes would bring it back', async () => {
    hermes.add('Not yours to delete', 'ready');
    const hub = await signedInHub();
    try {
      const id = (await board(hub)).get('ready')![0]!.id as string;
      const deleted = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${id}`,
      });
      expect(deleted.statusCode).toBe(409);
      expect((deleted.json() as Json).details).toMatchObject({
        reason: 'hermes_owns_card',
        action: 'delete',
      });
      const stopped = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id}/stop`,
      });
      expect(stopped.statusCode).toBe(409);
    } finally {
      await hub.close();
    }
  });

  it('puts a card given to Hermes on Hermes’s board, once', async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/tasks',
        payload: { title: 'For Hermes', assignee_agent_id: HERMES_AGENT },
      });
      expect(created.statusCode).toBe(201);
      const external = (created.json() as Json).external as Json;
      expect(external.source).toBe('hermes');
      expect(hermes.cards.get(external.id as string)?.title).toBe('For Hermes');

      // Reading the board finds the same card, not a second reflection of it.
      const all = [...(await board(hub)).values()].flat();
      expect(all.filter((task) => task.title === 'For Hermes')).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('makes nothing when Hermes refuses a new card', async () => {
    hermes.refuse = 'board is read-only';
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/tasks',
        payload: { title: 'Refused', assignee_agent_id: HERMES_AGENT },
      });
      expect(created.statusCode).toBe(409);
      hermes.refuse = null;
      const all = [...(await board(hub)).values()].flat();
      expect(all.filter((task) => task.title === 'Refused')).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });

  it('archives on Hermes a card that has been done for a week, in one call', async () => {
    const old = hermes.add('Old report', 'done');
    old.completed_at = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;
    const fresh = hermes.add('Yesterday', 'done');
    fresh.completed_at = Math.floor(Date.now() / 1000) - 24 * 3600;
    const hub = await signedInHub();
    try {
      const columns = await board(hub);
      expect(titles(columns.get('done'))).toEqual(['Yesterday']);
      expect(hermes.archived).toEqual([[old.id]]);
    } finally {
      await hub.close();
    }
  });

  it('still answers when Hermes says something that is not a list', async () => {
    hermes.garbage = { tasks: 'not what we expected' };
    const hub = await signedInHub();
    try {
      await board(hub);
    } finally {
      await hub.close();
    }
  });

  it("leaves the hub's own cards alone", async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/tasks',
        payload: { title: 'Mine' },
      });
      expect((created.json() as Json).external).toBeNull();
      const id = (created.json() as Json).id as string;
      const moved = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id}/move`,
        payload: { status: 'done' },
      });
      expect(moved.statusCode).toBe(200);
      expect(hermes.moves).toEqual([]);
    } finally {
      await hub.close();
    }
  });
});
