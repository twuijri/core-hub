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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { hermesManagedEnv, type HermesProcessRole } from './hermes-managed-env.js';
import type { FastifyBaseLogger } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { probeHttp, readVersion, whichSync, type HostEnvironment } from './adapters/host.js';
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
  saysOneGatewayPerHost,
  type GatewayRuntimeRecord,
  type GatewayStatus,
} from './hermes-gateways.js';
// Hermes says why on its last line (`Error: Profile 'x' already exists …`).
import {
  hermesProfileRunner,
  lastLine,
  namedHermesProfiles,
  type ProfileRunner,
} from './hermes-profiles.js';
import { shareProfileWebhooks } from './hermes-webhooks.js';
import { resolveHermesPython, type PythonCommand } from './hermes-python.js';
import {
  personalHermesRoot,
  shareHermesInstall,
  type SharedInstall,
} from './hermes-shared-install.js';
import { IMAGE_WHATSAPP_BRIDGE, prepareWhatsAppBridge } from './whatsapp-bridge.js';
import { HubError } from '../../lib/errors.js';

export type HermesRuntimeMode = 'undecided' | 'external' | 'managed' | 'absent';

/** A Hermes start slower than this is logged as a warning (the timeouts are longer). */
const SLOW_START_MS = 30_000;

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
  /** The quick polls after a managed start, before the gateway is called stalled (tests). */
  warmUpIntervalMs?: number;
  warmUpAttempts?: number;
  /**
   * How often a TUI gateway started with keys that have since changed is checked for a
   * moment with no turn in flight, when it is closed.
   */
  tuiRetireIntervalMs?: number;
  /** Each line of the TUI gateway's stderr (Hermes's log), for the Logs screen's ring. */
  tuiLogLine?: (line: string) => void;
  /**
   * How long the TUI gateway may take to say it is ready (`COREHUB_HERMES_TUI_START_TIMEOUT_MS`).
   * Absent: the channel's own default.
   */
  tuiReadyTimeoutMs?: number;
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
  /** How long channel changes are gathered before the gateway follows (tests shorten it). */
  channelSettleMs?: number;
  /**
   * Reads the installed Hermes's version (`hermes --version`), which says how it places its
   * messaging gateways (`hermes-gateways.ts`). Tests replace it; `null` is "unknown".
   */
  hermesVersion?: (hermes: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** Asks the root gateway to rescan its profiles (tests replace the control socket). */
  rescanProfiles?: (root: string) => Promise<unknown>;
}

/** Hermes's profile id rule (`_PROFILE_ID_RE`); a hub slug always satisfies it. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const HERMES_DEFAULT_ENDPOINT = 'http://127.0.0.1:8642';
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const STOP_GRACE_MS = 10_000;
const WARM_UP_INTERVAL_MS = 2_000;
const WARM_UP_ATTEMPTS = 60;
/** How many of the managed gateway's last lines are kept for the reason it stopped. */
const LAST_LINES_KEPT = 20;
const LAST_LINE_MAX = 300;
/** How long Hermes's own updater may take (a dependency rebuild included). */
const SELF_UPDATE_TIMEOUT_MS = 30 * 60_000;
/** Terminal colour codes (ESC [ … letter) in an updater's output. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const TUI_RETIRE_INTERVAL_MS = 5_000;
/** How long a channel change waits for another before its gateway follows (`channelsChanged`). */
const CHANNEL_SETTLE_MS = 1_000;

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
  /**
   * The person's Hermes install state this home runs on (`hermes-shared-install.ts`), decided
   * once at `start()` — before any Hermes process of this hub starts.
   */
  private shared: SharedInstall | null = null;
  /** Hermes's Python for short programs (`hermes-python.ts`), found at start and restart. */
  private python: PythonCommand | null = null;
  private pythonFor: string | null = null;
  /** The last lines the managed gateway wrote, for the reason shown when it stops or stalls. */
  private readonly lastLines: string[] = [];
  private stopping = false;
  private restartRequested = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  /** Channel changes per profile waiting out `channelSettleMs` before their gateway follows. */
  private readonly channelFollows = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
    }
  >();
  private readonly channelSettleMs: number;
  /** Set while the default gateway is held down on purpose (`withDefaultGatewayStopped`). */
  private relaunchGate: Promise<void> | null = null;
  /**
   * The messaging gateways of the named profiles (`hermes-gateways.ts`). On an older Hermes the
   * process above serves the default profile only and each other profile with a channel gets
   * its own; on one with one gateway per host (v2026.9.21 and later) it serves them all.
   */
  readonly profileGateways: ProfileGateways;
  /**
   * The running gateway was started with a host-lock folder of this home's own
   * (`gatewayLockEnv`), and so is every Hermes command the hub runs while it is.
   */
  private lockIsolated = false;

  constructor(private readonly options: HermesRuntimeOptions) {
    this.endpoint = (options.endpoint ?? HERMES_DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.home = path.join(options.dataDir, 'hermes');
    this.log = options.log;
    this.spawnImpl = options.spawnImpl ?? defaultSpawner;
    this.healthIntervalMs = options.healthIntervalMs ?? 30_000;
    this.channelSettleMs = options.channelSettleMs ?? CHANNEL_SETTLE_MS;
    this.profileGateways = new ProfileGateways({
      // Only a Hermes this hub runs: an external gateway's profiles are somebody else's.
      root: () => (this.mode === 'managed' ? this.home : null),
      executable: () => this.executable(),
      env: () => ({ ...this.cliEnv(), ...this.managedEnv('profile-gateway') }),
      spawnImpl: this.spawnImpl,
      log: this.log,
      prepare: (profile, home) => this.options.prepareGateway?.(profile, home),
      ...(options.gatewayBackoffMs ? { backoffMs: options.gatewayBackoffMs } : {}),
      ...(options.gatewayRescanMs !== undefined ? { rescanMs: options.gatewayRescanMs } : {}),
      ...(options.whatsappBridge ? { whatsappBridge: options.whatsappBridge } : {}),
      ...(options.rescanProfiles ? { rescanProfiles: options.rescanProfiles } : {}),
      // One gateway per host answers the named profiles' webhook routes from the root's file.
      shareWebhooks: async (root) =>
        (await shareProfileWebhooks(root, namedHermesProfiles(root))).listenerSwitchedOn,
      // On a Hermes that runs one gateway per host, the process below serves every profile.
      rootGateway: {
        status: () => ({
          state: this.state,
          pid: this.child?.pid ?? null,
          startedAt: this.child ? this.startedAt : null,
        }),
        restart: () => this.restartRootGateway(),
      },
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
   * Every Hermes process this hub runs, for the Performance screen: the TUI gateway (and one
   * being retired, while it finishes a turn) and every messaging gateway. Empty when the hub
   * does not run Hermes — an external gateway's processes are somebody else's.
   */
  processes(): Array<{
    kind: 'tui_gateway' | 'gateway';
    profile: string | null;
    pid: number | null;
    state: string;
  }> {
    if (this.mode !== 'managed') return [];
    const tuis = [
      ...(this.tui?.alive ? [{ channel: this.tui, state: 'running' }] : []),
      ...[...this.retiredTui]
        .filter((channel) => channel.alive)
        .map((channel) => ({ channel, state: 'retiring' })),
    ];
    return [
      ...tuis.map(({ channel, state }) => ({
        kind: 'tui_gateway' as const,
        profile: null,
        pid: channel.pid ?? null,
        state,
      })),
      ...this.gateways()
        // One gateway per host: a named profile's row is the default one's process, listed once.
        .filter(
          (gateway) =>
            gateway.profile === 'default' ||
            gateway.pid === null ||
            gateway.pid !== this.child?.pid,
        )
        .map((gateway) => ({
          kind: 'gateway' as const,
          profile: gateway.profile,
          pid: gateway.pid,
          state: gateway.state,
        })),
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
   * A channel of `profile` changed — linked, edited, switched on or off, cleared, unlinked, its
   * mode changed — and must answer now, in every profile. A gateway reads its channels when it
   * starts, so the one that serves the profile follows: a named profile's is started, restarted
   * or stopped to match; the default one (which also carries the API server and Hermes's
   * schedulers) is held down for a moment and started again, the way a change to the hub's tools
   * restarts it (decision §79). Before this the default profile waited for somebody to press
   * Restart, and a Telegram linked there stayed silent (the owner's report of 2026-09-26).
   *
   * Changes that arrive within `channelSettleMs` of each other are applied once, after the last
   * (a trailing debounce per profile): toggling a channel five times restarts its gateway once.
   * The promise settles when that one restart is done.
   */
  channelsChanged(profile: string): Promise<void> {
    if (this.mode !== 'managed') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const pending = this.channelFollows.get(profile);
      if (pending) clearTimeout(pending.timer);
      const waiters = pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      const timer = setTimeout(() => {
        this.channelFollows.delete(profile);
        this.followChannels(profile).then(
          () => waiters.forEach((waiter) => waiter.resolve()),
          (error: unknown) => waiters.forEach((waiter) => waiter.reject(error)),
        );
      }, this.channelSettleMs);
      timer.unref?.();
      this.channelFollows.set(profile, { timer, waiters });
    });
  }

  /**
   * True while a channel change of `profile` waits for its gateway to follow
   * (`channelsChanged`): a channel its running gateway does not name yet is about to be served,
   * so it does not read as needing a Restart.
   */
  channelsSettling(profile: string): boolean {
    return this.channelFollows.has(profile);
  }

  private followChannels(profile: string): Promise<void> {
    if (this.mode !== 'managed' || this.stopping) return Promise.resolve();
    if (profile !== 'default') return this.profileGateways.channelsChanged(profile);
    return this.withGatewayStopped('default', () => undefined);
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

  /**
   * Holds down every process of this Hermes that works in the root home while `work` runs (the
   * default profile is being replaced, contract decision §116): the default gateway, started
   * again afterwards as `withGatewayStopped` does, and the TUI gateway — closed now, not retired,
   * because its files are about to move; a conversation running in it ends, and the next one
   * opens a new gateway. The named profiles' gateways keep running: their homes do not move.
   */
  async withRootHeld<T>(work: () => T | Promise<T>): Promise<T> {
    const held = async () => {
      const channels = [this.tui, ...this.retiredTui].filter(
        (channel): channel is TuiChannel => channel !== null,
      );
      this.tui = null;
      this.retiredTui.clear();
      await Promise.all(channels.map((channel) => channel.close()));
      return await work();
    };
    if (this.mode === 'managed' && !this.child && this.restartTimer) {
      // A gateway waiting out its crash backoff must not start in the middle of the move: it
      // starts when the work is done instead.
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      const binary = this.executable();
      try {
        return await held();
      } finally {
        if (binary && !this.stopping && !this.child) this.launch(binary);
      }
    }
    return this.withGatewayStopped('default', held);
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
   * Hermes's own settings in `profile` changed (the Settings page, contract decision §58).
   * Hermes reads them when it builds a session's agent, so the TUI gateway is retired the way a
   * key change retires it: the next message in any conversation opens a fresh one that reads
   * them, and a turn already running finishes on the values it started with. A named profile's
   * messaging gateway is restarted to match now; the default profile's carries the API server and
   * Hermes's schedulers and waits for Restart (a channel change there restarts it,
   * `channelsChanged`).
   */
  settingsChanged(profile: string): Promise<void> {
    if (this.mode !== 'managed') return Promise.resolve();
    if (this.tui) this.retireTui(this.tui);
    this.tui = null;
    return this.profileGateways.channelsChanged(profile);
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
      // The hub's own conversations run here: their calls to the hub's tools say so (§79).
      env: { ...this.cliEnv(), ...this.managedEnv('tui') },
      cwd: home,
      ...(this.options.tuiSpawn ? { spawn: this.options.tuiSpawn } : {}),
      ...(this.options.tuiLogLine ? { onStderrLine: this.options.tuiLogLine } : {}),
      ...(this.options.tuiReadyTimeoutMs !== undefined
        ? { readyTimeoutMs: this.options.tuiReadyTimeoutMs }
        : {}),
      // A slow start is the first sign of a host too busy for the timeout: say how slow.
      onReady: (elapsedMs) => {
        const detail = { elapsedMs, timeoutMs: this.options.tuiReadyTimeoutMs ?? null };
        if (elapsedMs > SLOW_START_MS)
          this.log.warn(detail, 'hermes: the TUI gateway was slow to start');
        else this.log.info(detail, 'hermes: the TUI gateway started');
      },
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
   * afresh (the hub's own tools were switched, contract decision §67). The running one is
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
  /**
   * The managed scope of one kind of Hermes process this hub starts (`hermes-managed-env.ts`):
   * its origin for the hub's tools (§79), and `values`, reaching every profile it serves.
   */
  private managedEnv(
    role: HermesProcessRole,
    inherited: NodeJS.ProcessEnv = this.options.host.inherited ?? {},
    values: Record<string, string> = {},
  ): Record<string, string> {
    return hermesManagedEnv({ dataDir: this.options.dataDir, role, inherited, values });
  }

  cliEnv(): NodeJS.ProcessEnv {
    return {
      ...(this.options.host.inherited ?? {}),
      ...(this.options.host.pathValue ? { PATH: this.options.host.pathValue } : {}),
      ...this.providerEnv,
      ...this.sharedInstallEnv(),
      ...this.gatewayLockEnv(),
      HERMES_HOME: this.status().home ?? this.home,
    };
  }

  /**
   * `HERMES_GATEWAY_LOCK_DIR` inside this home, while the gateway runs with it (`lockIsolated`).
   *
   * A Hermes with one gateway per host (v2026.9.21 and later, `hermes-gateways.ts`) keeps that
   * host's lock and the record of its one gateway per OS user — `$XDG_STATE_HOME/hermes/
   * gateway-locks`, not per home (`gateway/host_rendezvous.py`, `gateway/status.py`
   * §_get_lock_dir). Beside a person's own Hermes (the desktop app's local mode), their gateway
   * for `~/.hermes` is then "the" gateway, and the hub's, for a home of its own, is told the
   * other one already serves its `default` profile and exits 75 — the card said so, and nothing
   * of the hub's home was served. This home is a Hermes root of its own, so it takes the lock
   * folder Hermes lets be moved, inside itself. Only then: an older Hermes keeps its lock folder
   * exactly where it was, and so does a hub whose home is the only one (the image).
   */
  private gatewayLockEnv(): NodeJS.ProcessEnv {
    if (!this.lockIsolated || this.options.host.inherited?.HERMES_GATEWAY_LOCK_DIR) return {};
    return { HERMES_GATEWAY_LOCK_DIR: path.join(this.home, 'gateway-locks') };
  }

  /**
   * Reads the installed Hermes's version and tells the profile gateways how this Hermes places
   * them. Never throws; an unreadable version changes nothing.
   */
  private async probeTopology(): Promise<void> {
    const hermes = this.executable();
    if (!hermes) return;
    const read =
      this.options.hermesVersion ??
      (async (binary: string, env: NodeJS.ProcessEnv) =>
        (await readVersion([binary, '--version'], { env })).version);
    const version = await read(hermes, this.cliEnv()).catch(() => null);
    await this.profileGateways.noteVersion(version);
    // Updated in place to a Hermes with one gateway per host while its gateway runs with the
    // person's host lock: it moves to this home's own, or the person's gateway is refused.
    if (
      this.profileGateways.topology() === 'one-per-host' &&
      !this.lockIsolated &&
      this.child &&
      this.personalInstall()
    ) {
      await this.restartRootGateway();
    }
  }

  /**
   * Stops the root gateway and starts it again at once (no backoff, not a crash), so a Hermes
   * with one gateway per host decides again which profiles it serves. Nothing when a restart
   * is already under way.
   */
  private async restartRootGateway(): Promise<void> {
    const child = this.child;
    if (this.mode !== 'managed' || this.stopping || this.restartRequested || !child) return;
    this.restartRequested = true;
    this.log.info({ pid: child.pid }, 'hermes: gateway restarted to serve every profile');
    await this.terminate(child);
  }

  /**
   * `HERMES_RUNTIME_DIR` when this home runs on the person's Hermes install (`start()`), so
   * Hermes takes its Python and tools from where that install keeps them. A value somebody set
   * for the hub already is theirs and stays.
   */
  private sharedInstallEnv(): NodeJS.ProcessEnv {
    const runtimeDir = this.shared?.runtimeDir;
    if (!runtimeDir || this.options.host.inherited?.HERMES_RUNTIME_DIR) return {};
    return { HERMES_RUNTIME_DIR: runtimeDir };
  }

  /**
   * Puts the person's Hermes install state under this home before anything of Hermes runs
   * here (`hermes-shared-install.ts`). Once; logged, never thrown.
   */
  private shareInstall(): void {
    if (this.shared) return;
    this.shared = shareHermesInstall({ home: this.home, env: this.options.host.inherited ?? {} });
    const { outcome, root, movedAside, error } = this.shared;
    if (error) {
      this.log.warn(
        { home: this.home, err: error },
        "hermes: could not use the installed Hermes's runtime; Hermes will prepare its own",
      );
    } else if (outcome === 'linked' || outcome === 'already') {
      this.log.info(
        { home: this.home, root, movedAside, outcome },
        "hermes: this home runs on the installed Hermes's runtime",
      );
    } else if (outcome === 'own') {
      this.log.info({ home: this.home }, 'hermes: this home keeps the runtime it already has');
    }
  }

  /**
   * How to run a short program on Hermes's own Python and packages, or `null` when this host's
   * Hermes offers none (`hermes-python.ts`). Found in the background at `start()` and after a
   * restart; `null` until then.
   */
  pythonCommand(): PythonCommand | null {
    return this.pythonFor && this.pythonFor === this.executable() ? this.python : null;
  }

  /** Finds Hermes's Python for the executable on this host now. Never throws. */
  async resolvePython(): Promise<PythonCommand | null> {
    const hermes = this.executable();
    if (!hermes) return null;
    // The runtime's environment, so Hermes answers for this home's dependency state.
    const found = await resolveHermesPython(hermes, this.cliEnv()).catch(() => null);
    this.python = found;
    this.pythonFor = hermes;
    if (!found) this.log.info({ hermes }, "hermes: no way to run Hermes's Python on this host");
    return found;
  }

  /**
   * Whether the Hermes on this host is the person's own install — a Hermes home of theirs that
   * is not this hub's (the desktop app's local mode, a hub run beside Hermes) — which Hermes's
   * own updater may update when the person asks (`AgentInstall.self_update`). Never in the
   * image, where Hermes's home is the hub's and Hermes comes with the image.
   */
  personalInstall(): boolean {
    if (!this.executable()) return false;
    const root = personalHermesRoot(this.options.host.inherited ?? {});
    if (!root) return false;
    try {
      if (!statSync(root).isDirectory()) return false;
      return realpathSync(root) !== realpathSync(this.home);
    } catch (error) {
      // No home of the hub's yet: a different folder by definition.
      return (error as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(root);
    }
  }

  /**
   * Hermes's own updater on the person's install (`hermes update --yes`: no prompt, config
   * migrations accepted), in their environment — never this hub's `HERMES_HOME` — with each
   * line of its output to `onLine`. Rejects with Hermes's last line when it fails.
   */
  selfUpdate(onLine: (line: string) => void, timeoutMs = SELF_UPDATE_TIMEOUT_MS): Promise<void> {
    const hermes = this.executable();
    if (!hermes || !this.personalInstall()) {
      return Promise.reject(
        new Error('the Hermes on this computer is not one Core Hub may update'),
      );
    }
    const env: NodeJS.ProcessEnv = {
      ...(this.options.host.inherited ?? {}),
      ...(this.options.host.pathValue ? { PATH: this.options.host.pathValue } : {}),
      PYTHONUNBUFFERED: '1',
      NO_COLOR: '1',
    };
    return new Promise<void>((resolve, reject) => {
      const child = spawn(hermes, ['update', '--yes'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      });
      const said: string[] = [];
      const take = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return;
        createInterface({ input: stream }).on('line', (line) => {
          const text = line.replace(ANSI, '').trim();
          if (!text) return;
          said.push(text);
          if (said.length > LAST_LINES_KEPT) said.shift();
          onLine(text);
        });
      };
      take(child.stdout);
      take(child.stderr);
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      timer.unref?.();
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const why = said.at(-1) ?? `exit ${signal ?? String(code)}`;
        reject(new Error(`hermes update failed: ${why}`));
      });
    });
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
    // Every Hermes command of this hub runs in its home, an external gateway or not (kanban,
    // profiles, plugins): the install state goes in first.
    if (whichSync('hermes', this.options.host)) {
      this.shareInstall();
      void this.resolvePython();
    }
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
    // Beside a person's own Hermes the version is read first: a Hermes with one gateway per
    // host must not take the person's host lock even for a moment (`gatewayLockEnv`).
    const personal = this.personalInstall();
    const probed = personal ? this.probeTopology().catch(() => undefined) : null;
    if (probed) await probed;
    this.launch(binary);
    this.scheduleHealth();
    // Every named profile with a channel to answer on or a job to fire gets its gateway at
    // boot too — once Hermes's version says whether it runs one gateway per host, when the
    // default one serves them all — and the set is checked again from then on.
    void (probed ?? this.probeTopology())
      .then(() => this.profileGateways.reconcile())
      .catch((error: unknown) => {
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
    // Hermes may have been updated in place (`selfUpdate`): its Python is looked for again, and
    // its version read again (a newer one may run one gateway per host).
    void this.resolvePython();
    void this.probeTopology().catch(() => undefined);
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
    for (const { timer, waiters } of this.channelFollows.values()) {
      clearTimeout(timer);
      waiters.forEach((waiter) => waiter.resolve());
    }
    this.channelFollows.clear();
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
    // A Hermes with one gateway per host, beside a person's own: a host lock of this home's own.
    this.lockIsolated =
      this.profileGateways.topology() === 'one-per-host' && this.personalInstall();
    const url = new URL(this.endpoint);
    const env: NodeJS.ProcessEnv = {
      ...(this.options.host.inherited ?? {}),
      // The shared provider keys first: the hub's own variables below are not
      // negotiable, and a provider named `API_SERVER_KEY` would be a very bad joke.
      ...this.providerEnv,
      ...this.sharedInstallEnv(),
      ...this.gatewayLockEnv(),
      HERMES_HOME: this.home,
      API_SERVER_ENABLED: 'true',
      API_SERVER_KEY: this.apiKey() ?? '',
      API_SERVER_HOST: url.hostname,
      API_SERVER_PORT: url.port || '8642',
      HERMES_DASHBOARD: '0',
      PYTHONUNBUFFERED: '1',
    };
    // A messaging gateway: its calls to the hub's tools are its channel turns' (§79). The origin
    // and the API server's key reach every profile it serves (`hermes-managed-env.ts`).
    const apiKey = this.apiKey();
    Object.assign(env, this.managedEnv('gateway', env, apiKey ? { API_SERVER_KEY: apiKey } : {}));
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
    this.lastLines.length = 0;
    // After a crash the card keeps saying why until the new process answers.
    this.setState('starting', this.state === 'error' ? this.lastError : null);
    this.log.info({ pid: child.pid, home: this.home }, 'hermes: gateway started (managed)');
    this.pipe(child.stdout, 'info');
    this.pipe(child.stderr, 'warn');
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      // Hermes says why on its last line (a traceback ends with the exception): shown with it.
      const said = this.lastLine();
      const reason = `hermes gateway exited (${signal ?? `code ${code ?? '?'}`})${
        said ? `: ${said}` : ''
      }`;
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
      if (code === 75 && saysOneGatewayPerHost(this.lastLines.join('\n'))) {
        // Hermes runs one gateway per host and found another one: the person's own (their
        // `~/.hermes`, on the same OS user) or a profile gateway of this hub. Both are the hub's
        // to settle — a lock folder of this home's own, no profile gateway beside this one —
        // and then it starts again at once. Only when that changes something: otherwise the
        // other gateway is nobody the hub can move, and the card says what Hermes said.
        const wasPerProfile = this.profileGateways.topology() === 'per-profile';
        const canIsolate = !this.lockIsolated && this.personalInstall();
        if (wasPerProfile || canIsolate) {
          this.log.info(
            { isolateLock: canIsolate },
            'hermes: another gateway owns this host; this home takes its own and starts again',
          );
          this.setState('starting', null);
          void this.profileGateways
            .useOneGatewayPerHost('the gateway exited 75: one gateway per host')
            .catch(() => undefined)
            .finally(() => {
              if (!this.stopping && !this.child && !this.restartTimer) this.launch(binary);
            });
          return;
        }
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
      if (!text) return;
      this.log[level]({ hermes: true }, text);
      this.lastLines.push(text);
      if (this.lastLines.length > LAST_LINES_KEPT) this.lastLines.shift();
    });
  }

  /** The managed gateway's last line of text (banner frames skipped), shortened. */
  private lastLine(): string | null {
    for (let i = this.lastLines.length - 1; i >= 0; i -= 1) {
      const text = this.lastLines[i]!.trim();
      // The start banner's box-drawing lines say nothing about why.
      if (!/[A-Za-z0-9]/.test(text) || /^[│┌└├─╭╰]/.test(text)) continue;
      return text.length > LAST_LINE_MAX ? `${text.slice(0, LAST_LINE_MAX - 1)}…` : text;
    }
    return null;
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
    if (this.mode === 'managed') this.warmUp(this.options.warmUpAttempts ?? WARM_UP_ATTEMPTS);
  }

  private warmUp(attempts: number): void {
    if (this.stopping || this.state === 'running') return;
    if (attempts <= 0) {
      this.stalled();
      return;
    }
    const timer = setTimeout(() => {
      void this.checkHealth().then(() => this.warmUp(attempts - 1));
    }, this.options.warmUpIntervalMs ?? WARM_UP_INTERVAL_MS);
    timer.unref?.();
  }

  /**
   * The warm-up ended and the gateway is alive but has not answered: still `starting`, now with
   * a reason a person can act on — how long, and the last thing Hermes said (downloading its
   * runtime, waiting on a lock, …). The next healthy answer clears it.
   */
  private stalled(): void {
    if (!this.child || this.state !== 'starting' || this.lastError) return;
    const waited = Math.round(
      ((this.options.warmUpAttempts ?? WARM_UP_ATTEMPTS) *
        (this.options.warmUpIntervalMs ?? WARM_UP_INTERVAL_MS)) /
        1000,
    );
    const said = this.lastLine();
    this.setState(
      'starting',
      `the Hermes gateway has not answered ${this.endpoint}/health after ${waited} s${
        said ? ` — its last line: ${said}` : ''
      }`,
    );
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

/**
 * What a turn that could not reach the gateway is told about the one this hub runs (the
 * adapter adds it to "did not answer"): still starting, and why it is taking long, or why it
 * stopped. Null when the hub does not run it, or it is running (then the failure is the call's).
 */
export function gatewayNote(status: HermesRuntimeStatus): string | null {
  if (status.mode !== 'managed') return null;
  const why = status.lastError ? `: ${status.lastError}` : '';
  if (status.state === 'starting') return `Hermes is still starting${why}; try again in a moment`;
  if (status.state === 'error' || status.state === 'stopped') {
    return `the Hermes gateway Core Hub runs is not running${why}`;
  }
  return null;
}

const defaultSpawner: Spawner = (command, args, options) => {
  const child: ChildProcess = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env,
    cwd: options.cwd,
  });
  return child as unknown as SpawnedProcess;
};
