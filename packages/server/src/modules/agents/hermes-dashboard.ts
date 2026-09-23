/**
 * Hermes's own web server, run on demand as an internal API the hub calls (ADR 0015).
 *
 * Some things Hermes can do are reachable only through its web server's API — editing a
 * kanban card's title or body, deleting it, commenting, reassigning, terminating a run
 * (`plugins/kanban/dashboard/plugin_api.py` in Hermes's MIT source). The CLI has no verb
 * for them. Rather than import Hermes's private Python functions, the hub runs Hermes's
 * own server and calls it the way Hermes's desktop app does.
 *
 * What runs is `hermes serve --host 127.0.0.1 --port 0`: the headless form of `hermes
 * dashboard` — the same FastAPI app, the same plugin routes, no web UI to build or mount
 * (`hermes_cli/main.py` §cmd_dashboard, `headless_backend`). The image prunes the web UI, so
 * `hermes dashboard` would refuse to start without a stub; `serve` needs none.
 *
 * - **Only when the hub supervises Hermes** (`managed`): the server is a child of this hub,
 *   beside the gateway, against the same `HERMES_HOME`. Anywhere else `available()` is false
 *   and the composition hands out `null`.
 * - **Started on first use**, single-flight: callers that arrive while it starts share the
 *   one start. The OS picks the port (`--port 0`); Hermes announces it on stdout as
 *   `HERMES_BACKEND_READY port=N` after the socket is bound, which is the readiness signal.
 * - **Stopped when idle** (ten minutes with no request, by default), started again on the
 *   next request; started again too when it died. Stopped with the hub.
 * - **Authenticated with a token the hub mints once** (`${DATA_DIR}/keys/
 *   hermes-dashboard.secret`, mode 0600) and hands Hermes in `HERMES_DASHBOARD_SESSION_TOKEN`;
 *   every call carries it in `X-Hermes-Session-Token`. Without it Hermes answers 401, even on
 *   the loopback (`hermes_cli/web_server.py` §_require_token). The token is never logged and
 *   never returned by any API.
 *
 * Out of scope: one server per Hermes profile (`--isolated`) and profile routing. The
 * server runs against the root home, where Hermes keeps its kanban for every profile
 * (`hermes_cli/kanban_db.py` §kanban_home).
 *
 * Everything here is argv arrays, and the environment comes from the runtime's `cliEnv()`,
 * never from the hub's own environment (app/config.ts is the only file that may read it).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { FastifyBaseLogger } from 'fastify';
import {
  loadOrCreateSecret,
  type HermesRuntimeMode,
  type SpawnedProcess,
} from './hermes-runtime.js';

/** What the dashboard needs from the runtime: where Hermes lives and how it is run. */
export interface HermesDashboardHost {
  status(): { mode: HermesRuntimeMode; home: string | null };
  executable(): string | null;
  cliEnv(): NodeJS.ProcessEnv;
}

export type DashboardSpawner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
) => SpawnedProcess;

export interface HermesDashboardOptions {
  host: HermesDashboardHost;
  /** `${DATA_DIR}`: the token lives in its `keys/` folder, next to the API server key. */
  dataDir: string;
  log: FastifyBaseLogger;
  /** Minutes of silence before the server is stopped. Default 10. */
  idleMs?: number;
  /** How long a start may take before it is given up. Default 60 s. */
  startTimeoutMs?: number;
  /** How long one call may take. Default 60 s (Hermes's own verbs are fast; specify is not). */
  requestTimeoutMs?: number;
  /** Between SIGTERM and SIGKILL. Default 10 s. */
  stopGraceMs?: number;
  /** Test seams. */
  spawnImpl?: DashboardSpawner;
  fetchImpl?: typeof fetch;
}

export const DASHBOARD_IDLE_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 10_000;
/** How many of Hermes's last output lines a failed start quotes. */
const TAIL_LINES = 5;
export const DASHBOARD_TOKEN_FILE = 'hermes-dashboard.secret';
const TOKEN_HEADER = 'X-Hermes-Session-Token';
/** `serve` says BACKEND, `dashboard` says DASHBOARD; both mean "bound, here is the port". */
const READY_LINE = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/;

/**
 * Hermes answered, and the answer was no. `message` is Hermes's own sentence — the
 * `detail` of its error body, verbatim — so a client can show it the way the kanban CLI's
 * refusals are shown today (`tasks/hermes-kanban.ts` §HermesRefusal).
 */
export class HermesDashboardRefusal extends Error {
  constructor(
    /** `METHOD /path`, the call that was refused. */
    readonly verb: string,
    /** Hermes's HTTP status (400 bad input, 404 unknown id, 409 refused transition …). */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HermesDashboardRefusal';
  }
}

/** The server could not be reached at all: not managed here, would not start, or died. */
export class HermesDashboardUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesDashboardUnavailable';
  }
}

export interface HermesDashboardStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  startedAt: number | null;
  /** How many times the server was started since the hub booted. */
  starts: number;
}

interface Live {
  child: SpawnedProcess;
  port: number;
  exited: boolean;
}

/** Hermes's error sentence from an error body: `{detail: "..."}`, or FastAPI's 422 list. */
export function detailOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      return detail
        .map((item: unknown) => {
          if (!item || typeof item !== 'object') return String(item);
          const { loc, msg } = item as { loc?: unknown; msg?: unknown };
          const where = Array.isArray(loc) ? loc.filter((p) => p !== 'body').join('.') : '';
          return where ? `${where}: ${String(msg)}` : String(msg);
        })
        .join('; ');
    }
  }
  if (typeof body === 'string' && body.trim()) return body.trim();
  return fallback;
}

export class HermesDashboard {
  private readonly log: FastifyBaseLogger;
  private readonly spawnImpl: DashboardSpawner;
  private readonly fetchImpl: typeof fetch;
  private readonly idleMs: number;
  private token: string | null = null;
  private live: Live | null = null;
  private starting: Promise<Live> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private starts = 0;
  private startedAt: number | null = null;
  private closed = false;

  constructor(private readonly options: HermesDashboardOptions) {
    this.log = options.log;
    this.spawnImpl = options.spawnImpl ?? defaultSpawner;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.idleMs = options.idleMs ?? DASHBOARD_IDLE_MS;
  }

  /** True only where the hub supervises Hermes and can run it: the rule for handing it out. */
  available(): boolean {
    const { mode, home } = this.options.host.status();
    return (
      !this.closed && mode === 'managed' && home !== null && this.options.host.executable() !== null
    );
  }

  status(): HermesDashboardStatus {
    const live = this.live && !this.live.exited ? this.live : null;
    return {
      running: live !== null,
      pid: live?.child.pid ?? null,
      port: live?.port ?? null,
      startedAt: live ? this.startedAt : null,
      starts: this.starts,
    };
  }

  /**
   * One call to Hermes's server: JSON in, JSON out, the token added. Starts the server when
   * it is not running. Throws `HermesDashboardRefusal` with Hermes's own words when Hermes
   * answers with an error, `HermesDashboardUnavailable` when there is no server to ask.
   */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith('/')) throw new Error(`dashboard path must start with "/": ${path}`);
    const verb = `${method.toUpperCase()} ${path}`;
    this.inFlight += 1;
    this.clearIdle();
    try {
      let live = await this.ensure();
      let response: Response;
      try {
        response = await this.send(live, method, path, body);
      } catch (error) {
        // Refused before it landed and the process is gone: it died between calls. One
        // fresh start and one retry — safe, because the request never reached Hermes.
        if (!refusedToConnect(error) || !live.exited) throw this.unreachable(verb, error);
        live = await this.ensure();
        try {
          response = await this.send(live, method, path, body);
        } catch (retryError) {
          throw this.unreachable(verb, retryError);
        }
      }
      const text = await response.text();
      let parsed: unknown = text;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // Not JSON: kept as text, for the error sentence or the caller.
        }
      }
      if (!response.ok) {
        throw new HermesDashboardRefusal(
          verb,
          response.status,
          detailOf(parsed, `Hermes answered ${response.status} to ${verb}`),
        );
      }
      return (text ? parsed : null) as T;
    } finally {
      this.inFlight -= 1;
      this.scheduleIdle();
    }
  }

  /** Stops the server now. The next request starts it again. */
  async stop(reason = 'requested'): Promise<void> {
    this.clearIdle();
    const starting = this.starting;
    if (starting) await starting.catch(() => undefined);
    const live = this.live;
    this.live = null;
    if (!live || live.exited) return;
    this.log.info({ pid: live.child.pid, reason }, 'hermes: dashboard API stopping');
    await terminate(live.child, this.options.stopGraceMs ?? STOP_GRACE_MS);
  }

  /** The hub is closing: stop, and never start again. */
  async close(): Promise<void> {
    this.closed = true;
    await this.stop('hub shutting down');
  }

  // -------------------------------------------------------------- internals

  private ensure(): Promise<Live> {
    if (this.live && !this.live.exited) return Promise.resolve(this.live);
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private launch(): Promise<Live> {
    if (!this.available()) {
      return Promise.reject(
        new HermesDashboardUnavailable(
          this.closed
            ? 'the hub is shutting down'
            : 'Hermes is not supervised by this hub, so its dashboard API cannot be started here',
        ),
      );
    }
    const host = this.options.host;
    const command = host.executable()!;
    const home = host.status().home!;
    if (!this.token) this.token = loadOrCreateSecret(this.options.dataDir, DASHBOARD_TOKEN_FILE);
    const token = this.token;
    const env: NodeJS.ProcessEnv = {
      ...host.cliEnv(),
      HERMES_HOME: home,
      HERMES_DASHBOARD_SESSION_TOKEN: token,
      PYTHONUNBUFFERED: '1',
    };
    // A backend Hermes believes the desktop app spawned ticks cron in-process
    // (`hermes_cli/main.py` §_dashboard_prepare_runtime) — beside the gateway, that would be
    // every job twice. Never inherited, whatever the host says.
    delete env.HERMES_DESKTOP;
    delete env.HERMES_DESKTOP_READY_FILE;

    const began = Date.now();
    const tail: string[] = [];
    const remember = (line: string) => {
      const text = line.split(token).join('[token]').trimEnd();
      if (!text) return;
      tail.push(text);
      if (tail.length > TAIL_LINES) tail.shift();
      this.log.debug({ hermesDashboard: true }, text);
    };

    return new Promise<Live>((resolve, reject) => {
      let child: SpawnedProcess;
      try {
        child = this.spawnImpl(command, ['serve', '--host', '127.0.0.1', '--port', '0'], {
          env,
          cwd: home,
        });
      } catch (error) {
        reject(
          new HermesDashboardUnavailable(
            `could not start Hermes's dashboard API: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      const live: Live = { child, port: 0, exited: false };
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log.warn(
          { pid: child.pid, timeoutMs: this.options.startTimeoutMs ?? START_TIMEOUT_MS },
          'hermes: dashboard API did not become ready; stopping it',
        );
        void terminate(child, this.options.stopGraceMs ?? STOP_GRACE_MS);
        reject(
          new HermesDashboardUnavailable(
            withTail("Hermes's dashboard API did not become ready in time", tail),
          ),
        );
      }, this.options.startTimeoutMs ?? START_TIMEOUT_MS);
      timer.unref?.();

      const onLine = (line: string) => {
        const ready = READY_LINE.exec(line);
        if (!ready || settled) {
          remember(line);
          return;
        }
        settled = true;
        clearTimeout(timer);
        live.port = Number(ready[1]);
        this.live = live;
        this.starts += 1;
        this.startedAt = Date.now();
        this.log.info(
          {
            pid: child.pid,
            port: live.port,
            ms: Date.now() - began,
            reason: this.starts > 1 ? 'restart on demand' : 'first request',
          },
          'hermes: dashboard API started',
        );
        resolve(live);
      };
      if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine);
      if (child.stderr) createInterface({ input: child.stderr }).on('line', remember);

      child.on('exit', (code, signal) => {
        live.exited = true;
        if (this.live === live) this.live = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new HermesDashboardUnavailable(
              withTail(
                `Hermes's dashboard API exited before it was ready (${signal ?? `code ${code ?? '?'}`})`,
                tail,
              ),
            ),
          );
          return;
        }
        // Stopped by the hub (idle, shutdown) is logged where it is asked for; this is the
        // other kind: the next request starts it again.
        if (!stoppedByHub.has(child)) {
          this.log.warn(
            { pid: child.pid, code, signal },
            'hermes: dashboard API exited; it starts again on the next request',
          );
        }
      });
    });
  }

  private async send(live: Live, method: string, path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      [TOKEN_HEADER]: this.token ?? '',
      accept: 'application/json',
    };
    const init: RequestInit = {
      method: method.toUpperCase(),
      headers,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return this.fetchImpl(`http://127.0.0.1:${live.port}${path}`, init);
  }

  private unreachable(verb: string, error: unknown): HermesDashboardUnavailable {
    const reason = error instanceof Error ? error.message : String(error);
    return new HermesDashboardUnavailable(
      `Hermes's dashboard API did not answer ${verb}: ${reason}`,
    );
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    if (this.inFlight > 0 || !this.live || this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight > 0) return;
      void this.stop(`idle for ${Math.round(this.idleMs / 1000)} s`);
    }, this.idleMs);
    // Idle is not a reason for the hub to stay up.
    this.idleTimer.unref?.();
  }
}

function withTail(message: string, tail: readonly string[]): string {
  return tail.length > 0 ? `${message}: ${tail.at(-1)}` : message;
}

/** `fetch` could not connect at all, as opposed to a connection that broke mid-way. */
function refusedToConnect(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown }; code?: unknown } | null) ?? null;
  const code = cause?.cause?.code ?? cause?.code;
  return code === 'ECONNREFUSED';
}

/** Children the hub itself stopped: their exit is not news. */
const stoppedByHub = new WeakSet<SpawnedProcess>();

/** SIGTERM, then SIGKILL after the grace. Marks the child so its exit is not a crash. */
function terminate(child: SpawnedProcess, graceMs: number): Promise<void> {
  stoppedByHub.add(child);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve();
    };
    child.on('exit', finish);
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, graceMs);
    killer.unref?.();
    if (!child.kill('SIGTERM')) finish();
  });
}

const defaultSpawner: DashboardSpawner = (command, args, options) => {
  const child: ChildProcess = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env,
    cwd: options.cwd,
  });
  return child as unknown as SpawnedProcess;
};
