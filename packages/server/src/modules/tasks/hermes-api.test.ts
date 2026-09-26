/**
 * Hermes's cards edited from the hub through Hermes's own server (ADR 0015), through the
 * routes a person uses.
 *
 * The server here is a small in-memory stand-in behind the real `createHermesCardApi`, so
 * every write is checked down to the method, the path and the body Hermes's plugin reads
 * (`plugins/kanban/dashboard/plugin_api.py`); `hermes-api.real.test.ts` runs the same writes
 * against the real server in the image.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSqlite } from '../../lib/db.js';
import { listWorkspacesFor } from '../auth/index.js';
import { authed, signedInHub } from '../../../tests/unit/helpers.js';
import { HermesRefusal, type HermesKanban, type HermesTask } from './hermes-kanban.js';
import {
  HermesApiUnavailable,
  createHermesCardApi,
  fromHermesPriority,
  toHermesPriority,
  type HermesComment,
  type HermesEvent,
  type HermesRun,
} from './hermes-api.js';
import { registerHermesBoard } from './index.js';
import type { HermesBoardPort } from './hermes-mirror.js';

type Json = Record<string, unknown>;
type Card = HermesTask & { current_run_id: number | null };

/** Hermes's board, as the CLI and the server both see it. */
class FakeBoard implements HermesKanban {
  cards = new Map<string, Card>();
  comments = new Map<string, HermesComment[]>();
  /** Hermes's `task_events` and `task_runs` of each card, oldest first as Hermes answers. */
  events = new Map<string, HermesEvent[]>();
  runs = new Map<string, HermesRun[]>();
  created: Array<Record<string, unknown>> = [];
  private counter = 0;

  add(title: string, status: string, extra: Partial<Card> = {}): Card {
    this.counter += 1;
    const card: Card = {
      id: `t_${this.counter.toString(16).padStart(8, '0')}`,
      title,
      body: null,
      assignee: null,
      status,
      priority: 0,
      created_at: this.counter,
      result: null,
      current_run_id: null,
      ...extra,
    };
    this.cards.set(card.id, card);
    return card;
  }

  async list() {
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
    assignee?: string | null;
    priority?: number;
  }) {
    this.created.push(input);
    return this.add(input.title, input.triage ? 'triage' : 'ready', {
      body: input.body ?? null,
      assignee: input.assignee ?? null,
      priority: input.priority ?? 0,
    });
  }
  async archive() {}
  async move(id: string, _from: string, to: string) {
    const card = this.cards.get(id);
    if (card) card.status = to;
  }
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Hermes's server over the same board: the routes the plugin has, and its refusals. */
class FakeServer {
  calls: Call[] = [];
  warmed = 0;
  refuse: string | null = null;
  down = false;

  constructor(private readonly board: FakeBoard) {}

  request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    this.calls.push({ method, path, body });
    if (this.down) throw new HermesApiUnavailable('Hermes did not start: No module named uvicorn');
    const verb = `${method} ${path}`;
    if (this.refuse && method !== 'GET') throw new HermesRefusal(verb, this.refuse);
    const input = (body ?? {}) as Record<string, unknown>;
    const match = /^\/api\/plugins\/kanban\/(tasks|runs)\/([^/]+)(?:\/(\w+))?$/.exec(path);
    if (!match) throw new HermesRefusal(verb, 'Not Found');
    const [, kind, rawId, action] = match;
    const id = decodeURIComponent(rawId!);
    if (kind === 'runs') {
      const card = [...this.board.cards.values()].find((c) => String(c.current_run_id) === id);
      if (!card) throw new HermesRefusal(verb, `run ${id} not found`);
      card.status = 'ready';
      card.current_run_id = null;
      return { ok: true, run_id: Number(id), task_id: card.id } as T;
    }
    const card = this.board.cards.get(id);
    if (!card) throw new HermesRefusal(verb, `task ${id} not found`);
    switch (`${method} ${action ?? ''}`) {
      case 'GET ':
        return {
          task: card,
          comments: this.board.comments.get(id) ?? [],
          events: this.board.events.get(id) ?? [],
          runs: this.board.runs.get(id) ?? [],
        } as T;
      case 'PATCH ':
        if (typeof input.title === 'string') card.title = input.title.trim();
        if (typeof input.body === 'string') card.body = input.body;
        if (typeof input.priority === 'number') card.priority = input.priority;
        return { task: card } as T;
      case 'DELETE ':
        this.board.cards.delete(id);
        return { deleted: true, task_id: id } as T;
      case 'POST comments': {
        const list = this.board.comments.get(id) ?? [];
        list.push({
          author: String(input.author),
          body: String(input.body),
          created_at: Math.floor(Date.now() / 1000),
        });
        this.board.comments.set(id, list);
        return { ok: true } as T;
      }
      case 'POST reassign':
        if (card.status === 'running' && input.reclaim_first !== true) {
          throw new HermesRefusal(
            verb,
            `cannot reassign ${id}: unknown id, or still running (pass reclaim_first=true to release the claim first)`,
          );
        }
        if (card.status === 'running') card.status = 'ready';
        card.assignee = (input.profile as string | null) ?? null;
        return { ok: true, task_id: id, assignee: card.assignee } as T;
      case 'POST reclaim':
        if (card.status !== 'running') {
          throw new HermesRefusal(
            verb,
            `cannot reclaim ${id}: not in a claimable state (not running, or unknown id)`,
          );
        }
        card.status = 'ready';
        return { ok: true, task_id: id } as T;
      default:
        throw new HermesRefusal(verb, 'Method Not Allowed');
    }
  };
}

let previous: ReturnType<typeof registerHermesBoard> = null;
let board: FakeBoard;
let server: FakeServer;
let withApi = true;
const HERMES_AGENT = '01KHERMESAGENT000000000000';

beforeEach(() => {
  board = new FakeBoard();
  server = new FakeServer(board);
  withApi = true;
  const api = createHermesCardApi({
    request: server.request,
    warm: () => {
      server.warmed += 1;
    },
  });
  let profiles: NonNullable<HermesBoardPort['profiles']> = () => [];
  const port: HermesBoardPort = {
    kanban: () => board,
    agentId: () => HERMES_AGENT,
    throttleMs: 0,
    api: () => (withApi ? api : null),
    profiles: () => profiles(),
  };
  previous = registerHermesBoard((app) => {
    // The real composition maps every workspace to its profile; the test reads the hub's.
    profiles = () => workspacesOf(app);
    return port;
  });
});

afterEach(() => {
  registerHermesBoard(previous);
});

/** A test hub's workspaces, as the composition root lists them. */
function workspacesOf(app: FastifyInstance) {
  return listWorkspacesFor(requireSqlite(app.hub.database), { id: '', role: 'owner' }).map(
    (row) => ({
      workspace: row.id,
      slug: row.slug,
      profile: row.isDefault ? 'default' : row.slug,
    }),
  );
}

type Hub = Awaited<ReturnType<typeof signedInHub>>;

async function columns(hub: Hub) {
  const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/task-columns' });
  expect(response.statusCode).toBe(200);
  const list = (response.json() as { columns: Array<{ status: string; tasks: Json[] }> }).columns;
  return list.flatMap((column) => column.tasks);
}

async function reflectionOf(hub: Hub, card: HermesTask): Promise<Json> {
  const found = (await columns(hub)).find((task) => (task.external as Json | null)?.id === card.id);
  expect(found).toBeTruthy();
  return found!;
}

const writes = () => server.calls.filter((call) => call.method !== 'GET');

describe('tasks: Hermes cards edited through Hermes', () => {
  it("edits a card's title and description on Hermes first, and shows what Hermes kept", async () => {
    const card = board.add('مسودة', 'ready');
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      const edited = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${id as string}`,
        payload: { title: '  خطة الإطلاق  ', description: 'الخطوات الثلاث', tags: ['release'] },
      });
      expect(edited.statusCode).toBe(200);
      expect(writes()).toEqual([
        {
          method: 'PATCH',
          path: `/api/plugins/kanban/tasks/${card.id}`,
          body: { title: '  خطة الإطلاق  ', body: 'الخطوات الثلاث' },
        },
      ]);
      // Hermes trims a title; the reflection shows Hermes's, and keeps the hub's own tags.
      expect(edited.json()).toMatchObject({
        title: 'خطة الإطلاق',
        description: 'الخطوات الثلاث',
        tags: ['release'],
      });
      // And the next read agrees, because Hermes has it too.
      expect(await reflectionOf(hub, card)).toMatchObject({ title: 'خطة الإطلاق' });
    } finally {
      await hub.close();
    }
  });

  it("maps priority to Hermes's scale both ways", async () => {
    const card = board.add('Urgent fix', 'ready');
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      const edited = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${id as string}`,
        payload: { priority: 'high' },
      });
      expect(edited.statusCode).toBe(200);
      expect(writes()[0]!.body).toEqual({ priority: 1 });
      expect(card.priority).toBe(1);
      expect((edited.json() as Json).priority).toBe('high');
      // Hermes raising it wins on the next read.
      card.priority = 5;
      expect((await reflectionOf(hub, card)).priority).toBe('urgent');
    } finally {
      await hub.close();
    }
  });

  it("refuses with Hermes's words when Hermes refuses an edit, and changes nothing", async () => {
    const card = board.add('Keep me', 'ready');
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      server.refuse = 'title cannot be empty';
      const edited = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${id as string}`,
        payload: { title: 'x', tags: ['lost'] },
      });
      expect(edited.statusCode).toBe(409);
      expect((edited.json() as Json).details).toMatchObject({
        reason: 'hermes_refused',
        message: 'title cannot be empty',
      });
      server.refuse = null;
      expect(await reflectionOf(hub, card)).toMatchObject({ title: 'Keep me', tags: [] });
    } finally {
      await hub.close();
    }
  });

  it("says Hermes's API is not available when its server cannot be reached", async () => {
    const card = board.add('Offline', 'ready');
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      server.down = true;
      const edited = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${id as string}`,
        payload: { title: 'Changed' },
      });
      expect(edited.statusCode).toBe(503);
      const body = edited.json() as Json;
      expect(body.code).toBe('service_unavailable');
      expect(body.details).toMatchObject({ reason: 'hermes_api_unavailable' });
      expect(String((body.details as Json).message)).toContain('No module named uvicorn');
      server.down = false;
      expect((await reflectionOf(hub, card)).title).toBe('Offline');
    } finally {
      await hub.close();
    }
  });

  it('deletes on Hermes, then the reflection; a refusal keeps both', async () => {
    const kept = board.add('Refused delete', 'ready');
    const gone = board.add('Delete me', 'ready');
    const hub = await signedInHub();
    try {
      const keptId = (await reflectionOf(hub, kept)).id as string;
      const goneId = (await reflectionOf(hub, gone)).id as string;
      server.refuse = `task ${kept.id} not found`;
      const refused = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${keptId}`,
      });
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as Json).details).toMatchObject({ reason: 'hermes_refused' });
      server.refuse = null;
      const deleted = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${goneId}`,
      });
      expect(deleted.statusCode).toBe(204);
      expect(writes().at(-1)).toEqual({
        method: 'DELETE',
        path: `/api/plugins/kanban/tasks/${gone.id}`,
        body: undefined,
      });
      expect(board.cards.has(gone.id)).toBe(false);
      const titles = (await columns(hub)).map((task) => task.title);
      expect(titles).toContain('Refused delete');
      expect(titles).not.toContain('Delete me');
    } finally {
      await hub.close();
    }
  });

  it("posts a comment on Hermes's card in the person's name, and shows Hermes's own", async () => {
    const card = board.add('Discuss', 'ready');
    board.comments.set(card.id, [
      { author: 'default', body: 'بدأت العمل', created_at: 1_700_000_000 },
    ]);
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      const posted = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id as string}/comments`,
        payload: { content: 'ممتاز، أكمل' },
      });
      expect(posted.statusCode).toBe(201);
      expect(writes()).toEqual([
        {
          method: 'POST',
          path: `/api/plugins/kanban/tasks/${card.id}/comments`,
          body: { body: 'ممتاز، أكمل', author: 'Admin' },
        },
      ]);
      expect(posted.json()).toMatchObject({
        content: 'ممتاز، أكمل',
        author: { kind: 'user', id: hub.userId, name: 'Admin' },
      });

      const opened = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/tasks/${id as string}`,
      });
      const comments = (opened.json() as { comments: Json[] }).comments;
      expect(comments.map((c) => c.content)).toEqual(['بدأت العمل', 'ممتاز، أكمل']);
      // Hermes's profile is an agent; the person is a person.
      expect((comments[0]!.author as Json).kind).toBe('agent');
      expect(comments[0]!.created_at).toBe(new Date(1_700_000_000 * 1000).toISOString());
      // Opening the card again does not copy anything twice.
      const again = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/tasks/${id as string}`,
      });
      expect((again.json() as { comments: Json[] }).comments).toHaveLength(2);
    } finally {
      await hub.close();
    }
  });

  it("reads a card from Hermes when it is opened, and survives a Hermes that can't answer", async () => {
    const card = board.add('Before', 'ready');
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      card.title = 'After, on Hermes';
      const opened = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/tasks/${id as string}`,
      });
      expect((opened.json() as Json).title).toBe('After, on Hermes');
      server.down = true;
      const offline = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/tasks/${id as string}`,
      });
      expect(offline.statusCode).toBe(200);
      expect((offline.json() as Json).title).toBe('After, on Hermes');
    } finally {
      await hub.close();
    }
  });

  it("shows Hermes's own events and runs when a card is opened, newest first (§102)", async () => {
    const card = board.add('Report', 'review');
    board.events.set(card.id, [
      { id: 1, kind: 'created', payload: { assignee: 'default' }, created_at: 1_790_000_000 },
      { id: 2, kind: 'claimed', payload: null, created_at: 1_790_000_060, run_id: 4 },
      {
        id: 3,
        kind: 'review_requested',
        payload: { summary: 'done' },
        created_at: 1_790_000_600,
        run_id: 4,
      },
      // Hermes wrote no time: it is left out rather than dated now.
      { id: 4, kind: 'broken', payload: null, created_at: 0 },
    ]);
    board.runs.set(card.id, [
      {
        id: 4,
        profile: 'default',
        status: 'review',
        outcome: 'review_requested',
        summary: 'Wrote the report.',
        error: null,
        started_at: 1_790_000_060,
        ended_at: 1_790_000_600,
      },
      { id: 5, profile: 'default', status: 'running', started_at: 1_790_000_700 },
    ]);
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      const opened = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${id as string}` })
      ).json() as Json;
      expect(opened.hermes).toEqual({
        events: [
          {
            id: 3,
            kind: 'review_requested',
            run_id: 4,
            payload: { summary: 'done' },
            created_at: '2026-09-21T14:23:20.000Z',
          },
          {
            id: 2,
            kind: 'claimed',
            run_id: 4,
            payload: null,
            created_at: '2026-09-21T14:14:20.000Z',
          },
          {
            id: 1,
            kind: 'created',
            run_id: null,
            payload: { assignee: 'default' },
            created_at: '2026-09-21T14:13:20.000Z',
          },
        ],
        runs: [
          {
            id: 5,
            profile: 'default',
            status: 'running',
            outcome: null,
            summary: null,
            error: null,
            started_at: '2026-09-21T14:25:00.000Z',
            ended_at: null,
          },
          {
            id: 4,
            profile: 'default',
            status: 'review',
            outcome: 'review_requested',
            summary: 'Wrote the report.',
            error: null,
            started_at: '2026-09-21T14:14:20.000Z',
            ended_at: '2026-09-21T14:23:20.000Z',
          },
        ],
      });
      // Hermes not answering: the card still opens, without a history it could not read.
      server.down = true;
      const offline = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${id as string}` })
      ).json() as Json;
      expect(offline.hermes).toBeNull();
      // A hub card has none.
      const own = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/tasks',
        payload: { title: 'mine' },
      });
      const mine = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/tasks/${(own.json() as Json).id as string}`,
        })
      ).json() as Json;
      expect(mine.hermes).toBeNull();
    } finally {
      await hub.close();
    }
  });

  it("sets priority and says a comment on Hermes's cards in bulk, Hermes first (§102)", async () => {
    const one = board.add('One', 'ready');
    const two = board.add('Two', 'ready');
    const hub = await signedInHub();
    try {
      const a = (await reflectionOf(hub, one)).id as string;
      const b = (await reflectionOf(hub, two)).id as string;
      const own = (
        await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/tasks',
          payload: { title: 'mine' },
        })
      ).json() as Json;
      const bulk = await authed(hub, hub.token, {
        method: 'PATCH',
        url: '/api/v1/tasks',
        payload: {
          task_ids: [a, b, own.id],
          patch: { priority: 'urgent', comment: 'راجعوها قبل الخميس' },
        },
      });
      expect(bulk.statusCode).toBe(200);
      expect((bulk.json() as { results: Json[] }).results.map((r) => r.ok)).toEqual([
        true,
        true,
        true,
      ]);
      expect(one.priority).toBe(2);
      expect(two.priority).toBe(2);
      expect(board.comments.get(one.id)?.map((c) => c.body)).toEqual(['راجعوها قبل الخميس']);
      expect(board.comments.get(two.id)?.map((c) => c.author)).toEqual(['Admin']);
      // The hub's own task keeps the comment itself.
      const mine = (
        await authed(hub, hub.token, { method: 'GET', url: `/api/v1/tasks/${own.id as string}` })
      ).json() as Json;
      expect((mine.comments as Json[]).map((c) => c.content)).toEqual(['راجعوها قبل الخميس']);
      expect(mine.priority).toBe('urgent');

      // Hermes says no: that card's own result says so, in Hermes's words; the rest stand.
      server.refuse = 'task is archived';
      const refused = await authed(hub, hub.token, {
        method: 'PATCH',
        url: '/api/v1/tasks',
        payload: { task_ids: [a, own.id], patch: { comment: 'again' } },
      });
      expect((refused.json() as { results: Json[] }).results).toEqual([
        { id: a, ok: false, error: { error: 'conflict', code: 'conflict' } },
        { id: own.id, ok: true, error: null },
      ]);
      expect(board.comments.get(one.id)).toHaveLength(1);
    } finally {
      await hub.close();
    }
  });

  it('refuses a definition of done on a Hermes card, whose worker Hermes briefs (§103)', async () => {
    const card = board.add('Hermes owns it', 'ready');
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      const refused = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${id as string}`,
        payload: { definition_of_done: [{ text: 'tests pass' }] },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ details: { reason: 'hermes_owns_card' } });
      expect(writes()).toEqual([]);
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/tasks',
        payload: {
          title: 'for Hermes',
          assignee_agent_id: HERMES_AGENT,
          constraints: [{ text: 'no new dependencies' }],
        },
      });
      expect(created.statusCode).toBe(409);
      expect(board.created).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("stops a running card by terminating Hermes's run, and relays Hermes when there is none", async () => {
    const running = board.add('Working', 'running', { current_run_id: 7 });
    const idle = board.add('Idle', 'ready');
    const hub = await signedInHub();
    try {
      const runningId = (await reflectionOf(hub, running)).id as string;
      const idleId = (await reflectionOf(hub, idle)).id as string;
      const stopped = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${runningId}/stop`,
      });
      expect(stopped.statusCode).toBe(204);
      expect(writes()).toEqual([
        { method: 'POST', path: '/api/plugins/kanban/runs/7/terminate', body: {} },
      ]);
      expect((await reflectionOf(hub, running)).status).toBe('ready');

      const nothing = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${idleId}/stop`,
      });
      expect(nothing.statusCode).toBe(409);
      expect((nothing.json() as Json).details).toMatchObject({
        reason: 'hermes_refused',
        message: `cannot reclaim ${idle.id}: not in a claimable state (not running, or unknown id)`,
      });
    } finally {
      await hub.close();
    }
  });

  it("hands a card to another workspace's Hermes profile, and the card follows", async () => {
    const card = board.add('Logo', 'ready', { assignee: 'default' });
    const busy = board.add('Busy', 'running', { assignee: 'default', current_run_id: 3 });
    const hub = await signedInHub();
    try {
      await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/profiles',
        payload: { slug: 'design', name: 'Design' },
      });
      const { id } = await reflectionOf(hub, card);
      const handed = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id as string}/assign`,
        payload: { agent_id: HERMES_AGENT, profile: 'design' },
      });
      expect(handed.statusCode).toBe(202);
      expect(writes()).toEqual([
        {
          method: 'POST',
          path: `/api/plugins/kanban/tasks/${card.id}/reassign`,
          body: { profile: 'design', reclaim_first: false },
        },
      ]);
      expect(card.assignee).toBe('design');
      expect((await reflectionOf(hub, card)).profile).toBe('design');
      // It is read in its new workspace now.
      const there = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/tasks/${id as string}`,
        profile: 'design',
      });
      expect(there.statusCode).toBe(200);

      // A running card: Hermes stops its run first, which the person already agreed to.
      const busyId = (await reflectionOf(hub, busy)).id as string;
      const moved = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${busyId}/assign`,
        payload: { agent_id: HERMES_AGENT, profile: 'design' },
      });
      expect(moved.statusCode).toBe(202);
      expect(writes().at(-1)!.body).toEqual({ profile: 'design', reclaim_first: true });
      expect(busy.status).toBe('ready');

      // A workspace that does not exist is not a profile to hand anything to.
      const nowhere = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${busyId}/assign`,
        profile: 'design',
        payload: { agent_id: HERMES_AGENT, profile: 'marketing' },
      });
      expect(nowhere.statusCode).toBe(404);
    } finally {
      await hub.close();
    }
  });

  it("shows a card Hermes gave to a profile in that profile's workspace", async () => {
    const hub = await signedInHub();
    try {
      await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/profiles',
        payload: { slug: 'design', name: 'Design' },
      });
      const card = board.add('For design', 'ready', { assignee: 'design' });
      expect((await reflectionOf(hub, card)).profile).toBe('design');
    } finally {
      await hub.close();
    }
  });

  it("gives a new card for Hermes to the workspace's profile, with its priority", async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/tasks',
        payload: { title: 'For Hermes', assignee_agent_id: HERMES_AGENT, priority: 'urgent' },
      });
      expect(created.statusCode).toBe(201);
      expect(board.created[0]).toMatchObject({ assignee: 'default', priority: 2 });
      expect((await columns(hub)).find((t) => t.title === 'For Hermes')?.priority).toBe('urgent');
    } finally {
      await hub.close();
    }
  });

  it('warms Hermes’s server whenever the board is read', async () => {
    board.add('Anything', 'ready');
    const hub = await signedInHub();
    try {
      await columns(hub);
      await columns(hub);
      expect(server.warmed).toBe(2);
      expect(server.calls).toEqual([]);
    } finally {
      await hub.close();
    }
  });
});

describe('tasks: Hermes cards where the hub does not run Hermes’s server', () => {
  it('keeps the refusals: the words, deletion and stopping stay Hermes’s', async () => {
    withApi = false;
    const card = board.add('Hermes wrote this', 'ready');
    const hub = await signedInHub();
    try {
      const { id } = await reflectionOf(hub, card);
      const edited = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${id as string}`,
        payload: { title: 'Mine now' },
      });
      expect(edited.statusCode).toBe(409);
      expect((edited.json() as Json).details).toMatchObject({ reason: 'hermes_owns_text' });
      const deleted = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/tasks/${id as string}`,
      });
      expect((deleted.json() as Json).details).toMatchObject({ reason: 'hermes_owns_card' });
      const stopped = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id as string}/stop`,
      });
      expect(stopped.statusCode).toBe(409);
      const handed = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id as string}/assign`,
        payload: { agent_id: HERMES_AGENT, profile: 'default' },
      });
      expect(handed.statusCode).toBe(409);
      expect((handed.json() as Json).details).toMatchObject({
        reason: 'hermes_owns_card',
        action: 'reassign',
      });
      // A comment stays the hub's, as before.
      const said = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/tasks/${id as string}/comments`,
        payload: { content: 'noted' },
      });
      expect(said.statusCode).toBe(201);
      expect(server.calls).toEqual([]);
      expect(server.warmed).toBe(0);
    } finally {
      await hub.close();
    }
  });
});

describe('Hermes card API: the calls it makes', () => {
  function recorder(answer: unknown = { ok: true }) {
    const calls: Call[] = [];
    const api = createHermesCardApi({
      warm: () => {},
      request: async <T>(method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        return answer as T;
      },
    });
    return { calls, api };
  }

  it('escapes the id, and sends an empty body to clear one (Hermes reads null as unsent)', async () => {
    const { calls, api } = recorder({ task: { id: 't/1' } });
    await api.update('t/1', { body: null });
    expect(calls).toEqual([
      { method: 'PATCH', path: '/api/plugins/kanban/tasks/t%2F1', body: { body: '' } },
    ]);
  });

  it('passes a reason to reassign only when there is one', async () => {
    const { calls, api } = recorder();
    await api.reassign('t_1', 'design', { reclaimFirst: true, reason: 'model broken' });
    expect(calls[0]!.body).toEqual({
      profile: 'design',
      reclaim_first: true,
      reason: 'model broken',
    });
  });

  it("maps the hub's priorities to Hermes's integers and back", () => {
    expect(['low', 'normal', 'high', 'urgent'].map((p) => toHermesPriority(p as never))).toEqual([
      -1, 0, 1, 2,
    ]);
    expect([-3, -1, 0, 1, 2, 9, null].map((n) => fromHermesPriority(n))).toEqual([
      'low',
      'low',
      'normal',
      'high',
      'urgent',
      'urgent',
      'normal',
    ]);
  });
});
