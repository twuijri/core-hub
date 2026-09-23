/**
 * Hermes's own scheduler, spoken to the way Hermes offers it.
 *
 * Hermes keeps its schedules in `cron/jobs.json` and runs them itself. The file is Hermes's
 * (it locks it, migrates it, repairs it), so the hub never writes it. It asks Hermes's API
 * server instead — the same gateway and the same key every chat turn already uses
 * (`gateway/platforms/api_server.py`, `/api/jobs`, in Hermes's MIT source). Hermes
 * validates, stores and fires; the hub asks and reports what Hermes answered.
 */

/** A job as `/api/jobs` returns it. Only the fields the hub reads are named. */
export interface HermesJob {
  id: string;
  name: string;
  prompt: string | null;
  skills?: string[] | null;
  schedule: {
    kind: 'cron' | 'interval' | 'once' | string;
    expr?: string;
    minutes?: number;
    run_at?: string;
    display?: string;
  };
  schedule_display?: string;
  repeat?: { times: number | null; completed: number } | null;
  enabled: boolean;
  state?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  deliver?: string | null;
}

/** What the hub sends when it creates or edits a job. `schedule` is Hermes's own grammar. */
export interface HermesJobWrite {
  name?: string;
  schedule?: string;
  prompt?: string;
  skills?: string[];
  repeat?: number | null;
  deliver?: string;
  paused?: boolean;
}

/** Hermes said no, in its own words. The caller answers 409 with them. */
export class HermesJobRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HermesJobRefusal';
  }
}

/** Hermes did not answer at all — not a refusal, and not the hub's fault either. */
export class HermesUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesUnreachable';
  }
}

export interface HermesJobs {
  list(): Promise<HermesJob[]>;
  create(input: HermesJobWrite): Promise<HermesJob>;
  update(id: string, patch: HermesJobWrite & { enabled?: boolean }): Promise<HermesJob>;
  /** `false` when Hermes had no such job — already gone is what the caller wanted. */
  remove(id: string): Promise<boolean>;
  pause(id: string): Promise<HermesJob>;
  resume(id: string): Promise<HermesJob>;
  /** Fire on Hermes's next tick. Does not wait for the run. */
  run(id: string): Promise<HermesJob>;
}

export function createHermesJobs(options: {
  baseUrl: string;
  apiKey: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): HermesJobs {
  const base = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const key = options.apiKey();
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      // Not a refusal: Hermes did not answer. The caller decides what that means.
      throw new HermesUnreachable(
        `hermes did not answer ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (a proxy's error page, say): the words below fall back to the raw text.
      parsed = null;
    }
    if (!response.ok) {
      const said =
        (parsed as { error?: unknown; message?: unknown } | null)?.error ??
        (parsed as { message?: unknown } | null)?.message ??
        (text.trim() || `HTTP ${response.status}`);
      throw new HermesJobRefusal(response.status, String(said));
    }
    return parsed;
  }

  const job = async (method: string, path: string, body?: unknown) =>
    ((await call(method, path, body)) as { job: HermesJob }).job;

  return {
    async list() {
      const answer = (await call('GET', '/api/jobs?include_disabled=true')) as {
        jobs?: HermesJob[];
      };
      return answer.jobs ?? [];
    },
    create: (input) => job('POST', '/api/jobs', input),
    update: (id, patch) => job('PATCH', `/api/jobs/${encodeURIComponent(id)}`, patch),
    async remove(id) {
      try {
        await call('DELETE', `/api/jobs/${encodeURIComponent(id)}`);
        return true;
      } catch (error) {
        if (error instanceof HermesJobRefusal && error.status === 404) return false;
        throw error;
      }
    },
    pause: (id) => job('POST', `/api/jobs/${encodeURIComponent(id)}/pause`),
    resume: (id) => job('POST', `/api/jobs/${encodeURIComponent(id)}/resume`),
    run: (id) => job('POST', `/api/jobs/${encodeURIComponent(id)}/run`, {}),
  };
}

/** The hub's trigger, in the grammar Hermes's `parse_schedule` reads. */
export function hermesScheduleOf(trigger: {
  kind: string;
  expression?: string | null;
  every_minutes?: number | null;
  run_at?: string | null;
}): string {
  if (trigger.kind === 'cron') return String(trigger.expression ?? '').trim();
  if (trigger.kind === 'interval') return `every ${Number(trigger.every_minutes)}m`;
  // An aware instant: Hermes keeps the offset, so the hub's zone and Hermes's cannot disagree.
  return new Date(String(trigger.run_at)).toISOString();
}

/** A Hermes delivery string (`local`, `origin`, `telegram`, `telegram:12345`) as the hub's. */
export function deliveryOfHermes(deliver: string | null | undefined): {
  channel: string | null;
  address: string | null;
} | null {
  const value = (deliver ?? 'local').trim();
  if (value === '' || value === 'local') return null;
  const colon = value.indexOf(':');
  return colon < 0
    ? { channel: value, address: null }
    : { channel: value.slice(0, colon), address: value.slice(colon + 1) || null };
}
