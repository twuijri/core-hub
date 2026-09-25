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
import { parse as parseYaml } from 'yaml';
import { probeHttp, whichSync, type HostEnvironment } from './adapters/host.js';
import {
  stdioTuiChannel,
  TUI_STOPPED,
  type Spawned,
  type TuiChannel,
} from './adapters/hermes-tui.js';
import type { RuntimeState } from './adapters/types.js';
import { activeChannels } from './channels.js';
import {
  ProfileGateways,
  activeCronJobs,
  readGatewayRecord,
  type GatewayRuntimeRecord,
  type GatewayStatus,
} from './hermes-gateways.js';
import { hermesProfileRunner, type ProfileRunner } from './hermes-profiles.js';
import { IMAGE_WHATSAPP_BRIDGE, prepareWhatsAppBridge } from './whatsapp-bridge.js';
import { HubError } from '../../lib/errors.js';

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
  /** Injected in tests: a scripted TUI gateway instead of a Python child. */
  tuiSpawn?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ) => Spawned;
  healthIntervalMs?: number;
  probeTimeoutMs?: number;
  /**
   * How often a TUI gateway started with keys that have since changed is checked for a
   * moment with no turn in flight, when it is closed.
   */
  tuiRetireIntervalMs?: number;
  /** Called on every state change (the registry row follows it). */
  onState?: (status: HermesRuntimeStatus) => void;
  /** Injected in tests: a scripted `hermes <argv>` instead of the executable. */
  profileRun?: ProfileRunner;
  /**
   * Called right before any messaging gateway starts — the default one and every profile's —
   * with the Hermes profile and its home: the models module writes the hub's endpoints and
   * that profile's model into its `config.yaml` there, so the gateway resolves the providers
   * a chat in the same profile does. Never expected to throw; a throw is logged.
   */
  prepareGateway?: (profile: string, home: string) => void;
  /** Between two restarts of a crashed profile gateway (tests shorten it). */
  gatewayBackoffMs?: readonly number[];
  /** How often the profiles needing a gateway are checked again (tests turn it off with 0). */
  gatewayRescanMs?: number;
  /** The installed WhatsApp bridge each home's copy links to (`whatsapp-bridge.ts`). */
  whatsappBridge?: string;
}

/** Hermes's profile id rule (`_PROFILE_ID_RE`); a hub slug always satisfies it. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const HERMES_DEFAULT_ENDPOINT = 'http://127.0.0.1:8642';
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const STOP_GRACE_MS = 10_000;
const WARM_UP_INTERVAL_MS = 2_000;
const WARM_UP_ATTEMPTS = 60;
const TUI_RETIRE_INTERVAL_MS = 5_000;

/** Reads or mints the API server key. Kept next to the JWT secret, mode 0600. */
export function loadOrCreateHermesApiKey(dataDir: string): string {
  return loadOrCreateSecret(dataDir, 'hermes-api.secret');
}

/**
 * Reads or mints a secret the hub hands a Hermes process: 32 random bytes as hex, in
 * `${dataDir}/keys/<name>`, the folder 0700 and the file 0600. Kept across restarts so a
 * process started before the hub restarted still matches.
 */
export function loadOrCreateSecret(dataDir: string, name: string): string {
  const dir = path.join(dataDir, 'keys');
  const file = path.join(dir, name);
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
  private tui: TuiChannel | null = null;
  /**
   * TUI gateways started with provider keys that have since changed. New conversations no
   * longer get them; the conversations already on them keep them until nothing is in
   * flight, and then they are closed (`sweepRetiredTui`).
   */
  private readonly retiredTui = new Set<TuiChannel>();
  /** Profiles being made right now, so two turns in the same new profile make it once. */
  private readonly makingProfiles = new Map<string, Promise<void>>();
  private retireTimer: NodeJS.Timeout | null = null;
  private healthyAt: number | null = null;
  private stopping = false;
  private restartRequested = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  /** Set while the default gateway is held down on purpose (`withDefaultGatewayStopped`). */
  private relaunchGate: Promise<void> | null = null;
  /**
   * The messaging gateways of the named profiles (`hermes-gateways.ts`). The process above
   * serves the default profile only; each other profile with a channel gets its own.
   */
  readonly profileGateways: ProfileGateways;

  constructor(private readonly options: HermesRuntimeOptions) {
    this.endpoint = (options.endpoint ?? HERMES_DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.home = path.join(options.dataDir, 'hermes');
    this.log = options.log;
    this.spawnImpl = options.spawnImpl ?? defaultSpawner;
    this.healthIntervalMs = options.healthIntervalMs ?? 30_000;
    this.profileGateways = new ProfileGateways({
      // Only a Hermes this hub runs: an external gateway's profiles are somebody else's.
      root: () => (this.mode === 'managed' ? this.home : null),
      executable: () => this.executable(),
      env: () => this.cliEnv(),
      spawnImpl: this.spawnImpl,
      log: this.log,
      prepare: (profile, home) => this.options.prepareGateway?.(profile, home),
      ...(options.gatewayBackoffMs ? { backoffMs: options.gatewayBackoffMs } : {}),
      ...(options.gatewayRescanMs !== undefined ? { rescanMs: options.gatewayRescanMs } : {}),
      ...(options.whatsappBridge ? { whatsappBridge: options.whatsappBridge } : {}),
    });
  }

  /**
   * Every messaging gateway and its state: the default profile's (this process, when the hub
   * runs Hermes) and each named profile's. Empty when the hub does not run Hermes.
   */
  gateways(): GatewayStatus[] {
    if (this.mode !== 'managed') return [];
    return [
      {
        profile: 'default',
        state: this.state,
        pid: this.child?.pid ?? null,
        restarts: this.restarts,
        startedAt: this.child ? this.startedAt : null,
        lastError: this.lastError,
        channels: activeChannels(this.home),
        cronJobs: activeCronJobs(this.home),
      },
      ...this.profileGateways.status(),
    ];
  }

  /**
   * What Hermes itself reports about the gateway serving `profile` — its platforms' states —
   * when that gateway is the one this hub started. `null` otherwise, including for a record a
   * stopped gateway left behind.
   */
  gatewayRecord(profile: string): GatewayRuntimeRecord | null {
    if (this.mode !== 'managed') return null;
    if (profile !== 'default') return this.profileGateways.record(profile);
    const record = readGatewayRecord(this.home);
    return record && this.child && record.pid === this.child.pid ? record : null;
  }

  /**
   * A channel of `profile` changed. A named profile's gateway exists for its channels, so it
   * is started, restarted or stopped to match now. The default profile's gateway also carries
   * the API server and Hermes's own schedulers, so a change there waits for its next restart,
   * as it always has.
   */
  channelsChanged(profile: string): Promise<void> {
    if (this.mode !== 'managed') return Promise.resolve();
    return this.profileGateways.channelsChanged(profile);
  }

  /**
   * Hermes's scheduled jobs changed somewhere (the hub's schedules page wrote one): a profile
   * that now has an active job gets its gateway, one with neither a job nor a channel left
   * loses it. A gateway reads its jobs on every tick, so a running one is not restarted.
   */
  scheduledJobsChanged(): Promise<void> {
    if (this.mode !== 'managed') return Promise.resolve();
    return this.profileGateways.reconcile();
  }

  /**
   * Holds down the gateway that serves `profile` while `work` runs, then starts it again — so
   * a file that gateway holds open (a WhatsApp session) is not written back behind the hub.
   */
  async withGatewayStopped<T>(profile: string, work: () => T | Promise<T>): Promise<T> {
    if (this.mode !== 'managed') return await work();
    if (profile !== 'default') return this.profileGateways.withStopped(profile, work);
    const child = this.child;
    if (!child) return await work();
    let release: () => void = () => {};
    this.relaunchGate = new Promise<void>((resolve) => (release = resolve));
    this.restartRequested = true;
    this.log.info({ pid: child.pid }, 'hermes: gateway held down while a channel is changed');
    await this.terminate(child);
    try {
      return await work();
    } finally {
      this.relaunchGate = null;
      release();
    }
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
    // The TUI gateway read its keys when it started, so the next conversation starts a new
    // one. The running one is not killed: it may be carrying a turn somebody is watching —
    // forty tool calls in and waiting on a question — and closing it here ended that turn
    // as "the Hermes TUI gateway exited". It is retired instead, and closed once idle.
    if (this.tui) this.retireTui(this.tui);
    this.tui = null;
    return true;
  }

  /**
   * The Hermes TUI gateway conversations go through (ADR 0013): one `python -m
   * tui_gateway.entry` child, started on first use with this Hermes's home and the shared
   * provider keys, and started again after it exits. `null` when there is no Hermes
   * installed beside the hub — a gateway reached from elsewhere keeps the run surface.
   *
   * One child for **every profile** (ADR 0014 stage 3): Hermes binds a profile's home per
   * session (`session.create`'s `profile`), so another profile costs a few MiB inside this
   * process where a process per profile would cost ~220 MiB each (measured 2026-09-24: 217
   * MiB after a turn in one profile, 224 MiB after turns in three). The provider keys in its
   * environment reach every profile — Hermes reads a profile's `.env` first and this
   * environment after it — so nobody enters a key per profile (ADR 0010).
   */
  tuiChannel(): TuiChannel | null {
    if (this.tui?.alive) return this.tui;
    const hermes = this.executable();
    const home = this.status().home;
    if (!hermes || !home) return null;
    // The interpreter of Hermes's own venv, beside its `hermes` entry point.
    const python = path.join(path.dirname(hermes), 'python');
    if (!existsSync(python)) return null;
    this.tui = stdioTuiChannel({
      command: python,
      args: ['-m', 'tui_gateway.entry'],
      env: this.cliEnv(),
      cwd: home,
      ...(this.options.tuiSpawn ? { spawn: this.options.tuiSpawn } : {}),
    });
    const channel = this.tui;
    channel.onExit((reason) => {
      if (this.tui === channel) this.tui = null;
      this.retiredTui.delete(channel);
      // The hub closing it is routine; the process going away on its own is not.
      if (reason === TUI_STOPPED) this.log.info({ reason }, 'hermes: the TUI gateway stopped');
      else this.log.warn({ reason }, 'hermes: the TUI gateway stopped');
    });
    return channel;
  }

  /**
   * Makes sure Hermes has the profile a conversation is about to run in (ADR 0014 stage 3).
   *
   * One TUI gateway serves every profile — `profile` is a parameter of `session.create` —
   * so nothing is started per profile; but Hermes refuses a profile it does not have
   * (`Profile 'x' does not exist.`). A workspace made before workspaces became profiles has
   * none, and neither has one whose profile somebody removed by hand. Such a profile is made
   * the first time a conversation needs it, **as a copy of `default`** — the profile those
   * conversations ran in until now — with Hermes's own `hermes profile create --clone-from
   * default`, so its model, providers, SOUL, memory and skills are what they were and diverge
   * from there. `default` itself is the root home and always exists.
   */
  async ensureProfile(name: string): Promise<void> {
    if (name === 'default') return;
    const home = this.status().home;
    if (!home) return; // no Hermes home of ours: nothing runs here to look for it
    if (!PROFILE_ID.test(name)) {
      throw new HubError('agent_unavailable', {
        message: `"${name}" cannot be a Hermes profile`,
        details: { reason: 'hermes_profile_unavailable', profile: name },
      });
    }
    if (existsSync(path.join(home, 'profiles', name))) return;
    const pending = this.makingProfiles.get(name);
    if (pending) return pending;
    const making = this.makeProfile(home, name).finally(() => this.makingProfiles.delete(name));
    this.makingProfiles.set(name, making);
    return making;
  }

  private async makeProfile(home: string, name: string): Promise<void> {
    const hermes = this.executable();
    const run =
      this.options.profileRun ??
      (hermes ? hermesProfileRunner({ command: hermes, home, env: this.cliEnv() }) : null);
    const refuse = (message: string) =>
      new HubError('agent_unavailable', {
        message: `the Hermes profile "${name}" could not be made: ${message}`,
        details: { reason: 'hermes_profile_unavailable', profile: name },
      });
    if (!run) throw refuse('no `hermes` executable on this host');
    const result = await run(['profile', 'create', name, '--no-alias', '--clone-from', 'default']);
    // Another hub process (or a person) may have made it meanwhile; what counts is that it is there.
    if (result.code !== 0 && !existsSync(path.join(home, 'profiles', name))) {
      const why = lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`;
      this.log.warn({ profile: name, reason: why }, 'hermes: could not make a missing profile');
      throw refuse(why);
    }
    this.log.info({ profile: name }, 'hermes: made a missing profile as a copy of default');
  }

  /**
   * The next conversation starts a new TUI gateway, which reads the profiles' MCP servers
   * afresh (the hub's own tools were switched, contract decision §58). The running one is
   * retired, not killed, for the reason `setProviderEnv` gives.
   */
  refreshTui(): void {
    if (this.tui) this.retireTui(this.tui);
    this.tui = null;
  }

  private retireTui(channel: TuiChannel): void {
    if (!channel.alive) return;
    this.retiredTui.add(channel);
    this.sweepRetiredTui();
  }

  /** Closes every retired TUI gateway with nothing in flight; checks again later if any is busy. */
  private sweepRetiredTui(): void {
    for (const channel of [...this.retiredTui]) {
      if (channel.alive && channel.busy) continue;
      this.retiredTui.delete(channel);
      if (!channel.alive) continue;
      this.log.info('hermes: closing the TUI gateway started with the previous provider keys');
      void channel.close();
    }
    if (this.retiredTui.size === 0 || this.retireTimer || this.stopping) return;
    this.retireTimer = setTimeout(() => {
      this.retireTimer = null;
      this.sweepRetiredTui();
    }, this.options.tuiRetireIntervalMs ?? TUI_RETIRE_INTERVAL_MS);
    // A conversation still running must never be the reason the hub cannot exit.
    this.retireTimer.unref?.();
  }

  /** How the hub reaches this gateway's API — the same `fetch` every chat turn uses. */
  apiFetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  /**
   * The zone Hermes evaluates cron expressions in, resolved the way Hermes resolves it
   * (`hermes_time.py`): `HERMES_TIMEZONE`, then `timezone:` in its `config.yaml`, then the
   * machine's own zone. The last is the hub's zone too when Hermes runs beside it.
   */
  timezone(): string {
    const fromEnv = this.options.host.inherited?.HERMES_TIMEZONE?.trim();
    if (fromEnv) return fromEnv;
    const home = this.status().home;
    if (home) {
      try {
        const config = parseYaml(readFileSync(path.join(home, 'config.yaml'), 'utf8')) as {
          timezone?: unknown;
        } | null;
        if (typeof config?.timezone === 'string' && config.timezone.trim()) {
          return config.timezone.trim();
        }
      } catch {
        // No config yet, or one Hermes itself would also fail to read: the machine's zone.
      }
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
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
    // Every named profile with a channel to answer on or a job to fire gets its gateway at
    // boot too, and the set is checked again from then on.
    void this.profileGateways.reconcile().catch((error: unknown) => {
      this.log.warn({ err: error }, 'hermes: could not start the profile gateways');
    });
    this.profileGateways.watch();
    return this.mode;
  }

  /** `agents.restart`: only a managed runtime can be restarted by the hub. */
  async restart(): Promise<void> {
    if (this.mode !== 'managed') {
      throw new Error(`hermes runtime is ${this.mode}, not managed by this hub`);
    }
    // Every messaging gateway: the keys and endpoints a restart makes live are theirs too.
    const others = this.profileGateways.restartAll();
    const child = this.child;
    if (child) {
      this.log.info({ pid: child.pid }, 'hermes: restart requested');
      this.restartRequested = true;
      await this.terminate(child);
    }
    await others;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retireTimer) clearTimeout(this.retireTimer);
    this.retireTimer = null;
    const retired = [...this.retiredTui];
    this.retiredTui.clear();
    await Promise.all([this.tui?.close(), ...retired.map((channel) => channel.close())]);
    this.tui = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.restartTimer = null;
    this.healthTimer = null;
    const child = this.child;
    await Promise.all([child ? this.terminate(child) : null, this.profileGateways.stopAll()]);
    if (this.mode === 'managed') this.setState('stopped', null);
  }

  /**
   * Gives the root home its copy of the WhatsApp bridge on the image's dependencies
   * (`whatsapp-bridge.ts`) — before the default gateway serves WhatsApp, and before Hermes's
   * pairing screen, which runs the bridge from the root home whatever the profile. Never throws:
   * a copy the hub could not make is logged, and Hermes falls back to its own.
   */
  prepareWhatsAppBridge(): void {
    try {
      const bridge = prepareWhatsAppBridge(
        this.home,
        this.options.whatsappBridge ?? IMAGE_WHATSAPP_BRIDGE,
      );
      if (bridge !== 'current' && bridge !== 'no-image-bridge') {
        this.log.info({ profile: 'default', bridge }, 'hermes: WhatsApp bridge prepared');
      }
    } catch (error) {
      this.log.warn({ err: error }, 'hermes: could not prepare the WhatsApp bridge');
    }
  }

  // -------------------------------------------------------------- internals

  private launch(binary: string): void {
    mkdirSync(this.home, { recursive: true });
    try {
      this.options.prepareGateway?.('default', this.home);
    } catch (error) {
      this.log.warn({ err: error }, 'hermes: could not prepare the gateway configuration');
    }
    if (activeChannels(this.home).includes('whatsapp')) this.prepareWhatsAppBridge();
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
        const gate = this.relaunchGate;
        if (gate) {
          void gate.then(() => {
            if (!this.stopping && !this.child) this.launch(binary);
          });
        } else {
          this.launch(binary);
        }
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

/** Hermes says why on its last line (`Error: Profile 'x' already exists …`). */
function lastLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
}
