/**
 * The Hermes runtime the hub supervises (ADR 0008).
 *
 * The image ships the hub and Hermes only (ADR 0006). On boot the hub decides, in order:
 *
 *   1. a gateway already answers `GET /health` at the endpoint  -> `external`: use it, own nothing;
 *   2. a `hermes` executable is on PATH                          -> `managed`: spawn
 *      `hermes gateway run` as a child, restart it when it dies, probe its health, and
 *      write its log lines into the hub's logger;
 *   3. neither                                                   -> `absent`: the registry
 *      shows Hermes as "not configured" (ADR 0006), the hub keeps running.
 *
 * The child gets its own home under `${DATA_DIR}/hermes` (`HERMES_HOME`) — model keys,
 * memory, skills and sessions live there, in the data volume, never in the hub's database
 * — and the API server key the hub minted (`${DATA_DIR}/keys/hermes-api.secret`). Hermes
 * enables its API server when a strong `API_SERVER_KEY` is present in its environment
 * (`gateway/config_env.py` in Hermes's MIT source) and refuses to start it otherwise, so
 * the key is not optional and never logged.
 *
 * Everything here is argv arrays and a spawner the tests replace; the child's environment
 * is built from the injected `HostEnvironment`, never read from the process (app/config.ts
 * is the only file that may).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyBaseLogger } from 'fastify';
import { probeHttp, whichSync, type HostEnvironment } from './adapters/host.js';
import type { RuntimeState } from './adapters/types.js';

export type HermesRuntimeMode = 'undecided' | 'external' | 'managed' | 'absent';

export interface HermesRuntimeStatus {
  mode: HermesRuntimeMode;
  state: RuntimeState;
  endpoint: string;
  /** Where the supervised process keeps its home; null when not managed. */
  home: string | null;
  pid: number | null;
  restarts: number;
  /**
   * When the process last started, in ms — null when nothing is running. It is the only
   * honest answer to "did the runtime take the file the hub just wrote": the gateway
   * reads its `.env` and `config.yaml` at start (`gateway/run.py` §load_hermes_dotenv).
   */
  startedAt: number | null;
  lastError: string | null;
}

export interface SpawnedProcess {
  pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type Spawner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
) => SpawnedProcess;

export interface HermesRuntimeOptions {
  dataDir: string;
  host: HostEnvironment;
  log: FastifyBaseLogger;
  endpoint?: string;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  spawnImpl?: Spawner;
  healthIntervalMs?: number;
  probeTimeoutMs?: number;
  /** Called on every state change (the registry row follows it). */
  onState?: (status: HermesRuntimeStatus) => void;
}

export const HERMES_DEFAULT_ENDPOINT = 'http://127.0.0.1:8642';
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const STOP_GRACE_MS = 10_000;
const WARM_UP_INTERVAL_MS = 2_000;
const WARM_UP_ATTEMPTS = 60;

/** Reads or mints the API server key. Kept next to the JWT secret, mode 0600. */
export function loadOrCreateHermesApiKey(dataDir: string): string {
  const dir = path.join(dataDir, 'keys');
  const file = path.join(dir, 'hermes-api.secret');
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

export class HermesRuntime {
  readonly endpoint: string;
  readonly home: string;
  private readonly log: FastifyBaseLogger;
  private readonly spawnImpl: Spawner;
  private readonly healthIntervalMs: number;
  private key: string | null = null;
  private child: SpawnedProcess | null = null;
  private mode: HermesRuntimeMode = 'undecided';
  private state: RuntimeState = 'not_applicable';
  private lastError: string | null = null;
  private restarts = 0;
  private startedAt: number | null = null;
  /**
   * The workspace's provider credentials, put into the child's environment at spawn.
   *
   * Hermes does read `${HERMES_HOME}/.env` itself (`hermes_cli/env_loader.py`, at import,
   * with override), and the hub keeps writing that file because `hermes model`, `hermes
   * config` and a shell inside the container all expect it. But a running gateway that
   * depends on somebody else's loader running in the right entrypoint, in the right
   * order, over a file with the right encoding, is a chain with four links where there
   * could be one. The environment is the one: the process cannot start without it.
   */
  private providerEnv: Record<string, string> = {};
  private healthyAt: number | null = null;
  private stopping = false;
  private restartRequested = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: HermesRuntimeOptions) {
    this.endpoint = (options.endpoint ?? HERMES_DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.home = path.join(options.dataDir, 'hermes');
    this.log = options.log;
    this.spawnImpl = options.spawnImpl ?? defaultSpawner;
    this.healthIntervalMs = options.healthIntervalMs ?? 30_000;
  }

  /** The key the adapter sends; minted lazily so a hub that never uses Hermes writes none. */
  apiKey(): string | null {
    if (this.mode === 'absent') return null;
    if (!this.key) this.key = loadOrCreateHermesApiKey(this.options.dataDir);
    return this.key;
  }

  status(): HermesRuntimeStatus {
    return {
      mode: this.mode,
      state: this.state,
      endpoint: this.endpoint,
      // Reported for `external` too, because that mode means "a gateway answers on this
      // host" — and the home this hub prepared is the one it was told to use. `absent`
      // is the only mode with no home at all. A caller that reads files there shows the
      // path, so a Hermes started by somebody else with a different home is visible as a
      // wrong folder rather than as an empty list.
      home: this.mode === 'absent' || this.mode === 'undecided' ? null : this.home,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }

  /**
   * Hands the runtime the workspace's provider credentials. Returns true when they
   * changed, which is the caller's signal that a restart is what makes them live — this
   * process holds its environment from spawn time and there is no reload surface
   * (ADR 0008 §2: the API server on 8642 exposes no configuration write at all).
   */
  setProviderEnv(env: Record<string, string>): boolean {
    const before = Object.keys(this.providerEnv).sort();
    const after = Object.keys(env).sort();
    const same =
      before.length === after.length &&
      before.every((key, index) => key === after[index] && this.providerEnv[key] === env[key]);
    if (same) return false;
    this.providerEnv = { ...env };
    return true;
  }

  /**
   * The environment a one-off `hermes` command runs in (the kanban and cron bridges): the
   * host's, the shared provider keys — `specify` asks a model — and this Hermes's home.
   */
  cliEnv(): NodeJS.ProcessEnv {
    return {
      ...(this.options.host.inherited ?? {}),
      ...(this.options.host.pathValue ? { PATH: this.options.host.pathValue } : {}),
      ...this.providerEnv,
      HERMES_HOME: this.status().home ?? this.home,
    };
  }

  /**
   * The `hermes` executable on this host, or `null` when there is none.
   *
   * Looked up on demand rather than kept from `start()`, because an external gateway never
   * needed the executable to start — but the kanban bridge still runs `hermes kanban` on
   * the same host, against the same home, whoever started the gateway.
   */
  executable(): string | null {
    return whichSync('hermes', this.options.host);
  }

  /** Decide the mode and, when managed, start the child. Never throws. */
  async start(): Promise<HermesRuntimeMode> {
    if (this.mode !== 'undecided') return this.mode;
    if (await this.healthy()) {
      this.mode = 'external';
      this.setState('running', null);
      this.log.info({ endpoint: this.endpoint }, 'hermes: using the gateway already running');
      this.scheduleHealth();
      return this.mode;
    }
    const binary = whichSync('hermes', this.options.host);
    if (!binary) {
      this.mode = 'absent';
      this.setState('stopped', null);
      this.log.warn(
        { endpoint: this.endpoint },
        'hermes: no gateway answers and no `hermes` executable on PATH — not configured (ADR 0006)',
      );
      return this.mode;
    }
    this.mode = 'managed';
    this.launch(binary);
    this.scheduleHealth();
    return this.mode;
  }

  /** `agents.restart`: only a managed runtime can be restarted by the hub. */
  async restart(): Promise<void> {
    if (this.mode !== 'managed') {
      throw new Error(`hermes runtime is ${this.mode}, not managed by this hub`);
    }
    const child = this.child;
    if (!child) return;
    this.log.info({ pid: child.pid }, 'hermes: restart requested');
    this.restartRequested = true;
    await this.terminate(child);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.restartTimer = null;
    this.healthTimer = null;
    const child = this.child;
    if (child) await this.terminate(child);
    if (this.mode === 'managed') this.setState('stopped', null);
  }

  // -------------------------------------------------------------- internals

  private launch(binary: string): void {
    mkdirSync(this.home, { recursive: true });
    const url = new URL(this.endpoint);
    const env: NodeJS.ProcessEnv = {
      ...(this.options.host.inherited ?? {}),
      // The shared provider keys first: the hub's own variables below are not
      // negotiable, and a provider named `API_SERVER_KEY` would be a very bad joke.
      ...this.providerEnv,
      HERMES_HOME: this.home,
      API_SERVER_ENABLED: 'true',
      API_SERVER_KEY: this.apiKey() ?? '',
      API_SERVER_HOST: url.hostname,
      API_SERVER_PORT: url.port || '8642',
      HERMES_DASHBOARD: '0',
      PYTHONUNBUFFERED: '1',
    };
    let child: SpawnedProcess;
    try {
      child = this.spawnImpl(binary, ['gateway', 'run'], { env, cwd: this.home });
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error));
      this.scheduleRestart(binary);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.setState('starting', null);
    this.log.info({ pid: child.pid, home: this.home }, 'hermes: gateway started (managed)');
    this.pipe(child.stdout, 'info');
    this.pipe(child.stderr, 'warn');
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      const reason = `hermes gateway exited (${signal ?? `code ${code ?? '?'}`})`;
      if (this.stopping) {
        this.log.info({ code, signal }, 'hermes: gateway stopped');
        return;
      }
      if (this.restartRequested) {
        // Asked for: no backoff, not a crash.
        this.restartRequested = false;
        this.log.info({ code, signal }, 'hermes: gateway stopped for restart');
        this.setState('starting', null);
        this.launch(binary);
        return;
      }
      this.log.error({ code, signal }, 'hermes: gateway crashed; restarting');
      this.setState('error', reason);
      this.scheduleRestart(binary);
    });
  }

  private pipe(stream: NodeJS.ReadableStream | null, level: 'info' | 'warn'): void {
    if (!stream) return;
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => {
      const text = line.trimEnd();
      if (text) this.log[level]({ hermes: true }, text);
    });
  }

  private scheduleRestart(binary: string): void {
    if (this.stopping) return;
    // A process that stayed healthy for a minute earned a fresh backoff.
    if (this.healthyAt !== null && Date.now() - this.healthyAt > 60_000) this.restarts = 0;
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]!;
    this.restarts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.launch(binary);
    }, delay);
    this.restartTimer.unref?.();
  }

  private scheduleHealth(): void {
    if (this.healthIntervalMs <= 0) return;
    this.healthTimer = setInterval(() => void this.checkHealth(), this.healthIntervalMs);
    this.healthTimer.unref?.();
    // Warm-up: a gateway takes a few seconds to bind; poll quickly until the first answer
    // so the registry says `running` when it is, not one interval later.
    if (this.mode === 'managed') this.warmUp(WARM_UP_ATTEMPTS);
  }

  private warmUp(attempts: number): void {
    if (attempts <= 0 || this.stopping || this.state === 'running') return;
    const timer = setTimeout(() => {
      void this.checkHealth().then(() => this.warmUp(attempts - 1));
    }, WARM_UP_INTERVAL_MS);
    timer.unref?.();
  }

  private async checkHealth(): Promise<void> {
    if (this.stopping) return;
    const ok = await this.healthy();
    if (ok) {
      if (this.state !== 'running')
        this.log.info({ endpoint: this.endpoint }, 'hermes: gateway healthy');
      this.healthyAt = this.healthyAt ?? Date.now();
      this.setState('running', null);
      return;
    }
    if (this.mode === 'managed' && this.child) {
      // Alive but not answering yet (or any more): report it; the exit handler restarts.
      if (this.state === 'running') this.setState('error', 'gateway stopped answering /health');
      return;
    }
    if (this.mode === 'external') this.setState('stopped', 'external gateway stopped answering');
  }

  private async healthy(): Promise<boolean> {
    const probe = await probeHttp(`${this.endpoint}/health`, {
      timeoutMs: this.options.probeTimeoutMs ?? 2_000,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    return probe.ok;
  }

  private setState(state: RuntimeState, error: string | null): void {
    const changed = state !== this.state || error !== this.lastError;
    this.state = state;
    this.lastError = error;
    if (state === 'running') this.healthyAt = this.healthyAt ?? Date.now();
    else if (state !== 'starting') this.healthyAt = null;
    if (changed) this.options.onState?.(this.status());
  }

  private terminate(child: SpawnedProcess): Promise<void> {
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
      }, STOP_GRACE_MS);
      killer.unref?.();
      if (!child.kill('SIGTERM')) finish();
    });
  }
}

const defaultSpawner: Spawner = (command, args, options) => {
  const child: ChildProcess = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env,
    cwd: options.cwd,
  });
  return child as unknown as SpawnedProcess;
};
