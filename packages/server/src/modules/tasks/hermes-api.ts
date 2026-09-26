/**
 * The writes Hermes's CLI cannot make, through Hermes's own server (ADR 0015).
 *
 * `hermes kanban` moves a card, but it has no verb to edit a card's title or body, delete
 * it, comment on it as a person, reassign it to another profile or stop its run. Hermes's
 * dashboard plugin does all of those (`plugins/kanban/dashboard/plugin_api.py` in Hermes's
 * MIT source), and the agents module runs that server on demand. This file is the tasks
 * module's side of it: which call means what, with which body — checked against the source
 * of the pinned release and against the real server (`hermes-api.real.test.ts`).
 *
 * The module never sees the server itself. The composition root hands it `request` —
 * already carrying the token, already starting the server when it is not running — and
 * translates the server's errors into the two below, so nothing here imports `agents`.
 */
import { HermesRefusal, type HermesTask } from './hermes-kanban.js';

/** One call to Hermes's server: JSON in, JSON out. Throws `HermesRefusal` / `HermesApiUnavailable`. */
export type HermesApiRequest = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

/** There is no Hermes server to ask: it would not start, or it died and would not come back. */
export class HermesApiUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesApiUnavailable';
  }
}

/** A comment as Hermes keeps it (`task_comments`): who, what, when (epoch seconds). */
export interface HermesComment {
  id?: number;
  author: string;
  body: string;
  created_at: number;
}

/**
 * One line of a card's history as Hermes keeps it (`task_events`): what happened, to which
 * attempt, with Hermes's details, when (epoch seconds).
 */
export interface HermesEvent {
  id: number;
  kind: string;
  payload?: Record<string, unknown> | null;
  created_at: number;
  run_id?: number | null;
}

/** One attempt of Hermes's dispatcher at a card (`task_runs`). */
export interface HermesRun {
  id: number;
  profile?: string | null;
  status: string;
  outcome?: string | null;
  summary?: string | null;
  error?: string | null;
  started_at: number;
  ended_at?: number | null;
}

/** A card as `GET /tasks/{id}` answers it: the card, what was said on it, its history. */
export interface HermesCardDetail {
  task: HermesTask & { current_run_id?: number | null };
  comments: HermesComment[];
  /** Oldest first, as Hermes answers them. */
  events: HermesEvent[];
  /** Oldest first, as Hermes answers them. */
  runs: HermesRun[];
}

/** How much of a card's history the hub hands on (contract `HermesCardHistory`). */
export const HISTORY_EVENTS_MAX = 100;
export const HISTORY_RUNS_MAX = 20;
const HISTORY_TEXT_MAX = 4_000;

const epochIso = (seconds: unknown): string | null => {
  const value = typeof seconds === 'number' ? seconds : Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(Math.round(value * 1000)).toISOString();
};

const shortText = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.length > HISTORY_TEXT_MAX ? `${value.slice(0, HISTORY_TEXT_MAX - 1)}…` : value;
};

const wordOf = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 64) : fallback;

/**
 * A card's history as the contract's `HermesCardHistory` (decision §103): Hermes's own words
 * for each event and run, newest first, capped. Rows Hermes could not date are left out
 * rather than dated now.
 */
export function toHermesHistory(detail: Pick<HermesCardDetail, 'events' | 'runs'>): {
  events: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
} {
  const events = [...detail.events]
    .reverse()
    .flatMap((event) => {
      const created = epochIso(event.created_at);
      const id = Number(event.id);
      if (!created || !Number.isInteger(id)) return [];
      const run = event.run_id === null || event.run_id === undefined ? null : Number(event.run_id);
      return [
        {
          id,
          kind: wordOf(event.kind, 'event'),
          run_id: run !== null && Number.isInteger(run) ? run : null,
          payload:
            event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
              ? event.payload
              : null,
          created_at: created,
        },
      ];
    })
    .slice(0, HISTORY_EVENTS_MAX);
  const runs = [...detail.runs]
    .reverse()
    .flatMap((run) => {
      const started = epochIso(run.started_at);
      const id = Number(run.id);
      if (!started || !Number.isInteger(id)) return [];
      return [
        {
          id,
          profile: typeof run.profile === 'string' && run.profile !== '' ? run.profile : null,
          status: wordOf(run.status, 'unknown'),
          outcome:
            typeof run.outcome === 'string' && run.outcome !== '' ? run.outcome.slice(0, 64) : null,
          summary: shortText(run.summary),
          error: shortText(run.error),
          started_at: started,
          ended_at: epochIso(run.ended_at),
        },
      ];
    })
    .slice(0, HISTORY_RUNS_MAX);
  return { events, runs };
}

export type HubPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Hermes's priority is an integer, `0` by default; the dispatcher claims the higher first
 * (`kanban_db.list_tasks` orders `priority DESC`), and Hermes's own board shows `P1`, `P2`…
 * only above zero. So `normal` is Hermes's default, one step either side is `low` / `high`,
 * and `urgent` is two up. Read back, anything below zero is low and anything from two up is
 * urgent: a priority Hermes set to 5 is still urgent here, never an error.
 */
export function toHermesPriority(priority: HubPriority): number {
  switch (priority) {
    case 'low':
      return -1;
    case 'high':
      return 1;
    case 'urgent':
      return 2;
    default:
      return 0;
  }
}

export function fromHermesPriority(priority: number | null | undefined): HubPriority {
  const value = Number(priority ?? 0);
  if (!Number.isFinite(value) || value === 0) return 'normal';
  if (value < 0) return 'low';
  return value >= 2 ? 'urgent' : 'high';
}

export interface HermesCardApi {
  /** Start Hermes's server in the background, so the next call does not wait for it. */
  warm(): void;
  /** The card, its comments, its event log and its runs. */
  show(id: string): Promise<HermesCardDetail>;
  /** Edit the card's words and priority. Answers the card as Hermes now has it. */
  update(
    id: string,
    patch: { title?: string; body?: string | null; priority?: number },
  ): Promise<HermesTask>;
  remove(id: string): Promise<void>;
  comment(id: string, body: string, author: string): Promise<void>;
  /** Hand the card to another Hermes profile; `reclaimFirst` stops a run it is on first. */
  reassign(
    id: string,
    profile: string,
    options?: { reclaimFirst?: boolean; reason?: string | null },
  ): Promise<void>;
  /**
   * Stop the card's run: terminate the run Hermes has on it; with no run to terminate,
   * reclaim the card, so a refusal is Hermes's own sentence about why there is nothing to
   * stop rather than ours.
   */
  stop(id: string, reason?: string | null): Promise<void>;
}

const BASE = '/api/plugins/kanban';
const task = (id: string) => `${BASE}/tasks/${encodeURIComponent(id)}`;

export function createHermesCardApi(port: {
  request: HermesApiRequest;
  warm(): void;
}): HermesCardApi {
  const { request } = port;
  const api: HermesCardApi = {
    warm: () => port.warm(),
    async show(id) {
      const answer = await request<Partial<HermesCardDetail> | null>('GET', task(id));
      if (!answer?.task) throw new HermesRefusal('show', `Hermes did not answer card ${id}`);
      return {
        task: answer.task,
        comments: Array.isArray(answer.comments) ? answer.comments : [],
        events: Array.isArray(answer.events) ? answer.events : [],
        runs: Array.isArray(answer.runs) ? answer.runs : [],
      };
    },
    async update(id, patch) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      // Hermes's PATCH treats `null` as "not sent", so clearing the body is an empty one.
      if (patch.body !== undefined) body.body = patch.body ?? '';
      if (patch.priority !== undefined) body.priority = patch.priority;
      const answer = await request<{ task: HermesTask | null }>('PATCH', task(id), body);
      if (!answer?.task) throw new HermesRefusal('update', `Hermes no longer has card ${id}`);
      return answer.task;
    },
    async remove(id) {
      await request('DELETE', task(id));
    },
    async comment(id, body, author) {
      await request('POST', `${task(id)}/comments`, { body, author });
    },
    async reassign(id, profile, options = {}) {
      await request('POST', `${task(id)}/reassign`, {
        profile,
        reclaim_first: options.reclaimFirst === true,
        ...(options.reason ? { reason: options.reason } : {}),
      });
    },
    async stop(id, reason) {
      const { task: card } = await api.show(id);
      const because = reason?.trim() ? { reason: reason.trim() } : {};
      if (card.current_run_id !== null && card.current_run_id !== undefined) {
        await request('POST', `${BASE}/runs/${card.current_run_id}/terminate`, because);
        return;
      }
      await request('POST', `${task(id)}/reclaim`, because);
    },
  };
  return api;
}
