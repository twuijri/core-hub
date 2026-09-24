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

/** A card as `GET /tasks/{id}` answers it: the card, what was said on it, its runs. */
export interface HermesCardDetail {
  task: HermesTask & { current_run_id?: number | null };
  comments: HermesComment[];
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
  /** The card, its comments and its current run. */
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
      return { task: answer.task, comments: answer.comments ?? [] };
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
