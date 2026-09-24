/**
 * One messaging gateway per Hermes profile that has a channel to answer on.
 *
 * The hub supervises one `hermes gateway run` against Hermes's root home (`hermes-runtime.ts`),
 * and that process serves **the default profile only**: Hermes scopes a gateway to one profile
 * (`hermes_cli/profiles.py` §profiles_to_serve — exactly the active profile unless
 * `gateway.multiplex_profiles` is on). A WhatsApp paired in profile «manger» is written to
 * `profiles/manger/`, and nothing served it: messages to the number went unanswered
 * (the owner's report of 2026-09-24).
 *
 * So each named profile with at least one channel switched on and able to sign in
 * (`channels.ts` §activeChannels) gets its own `hermes -p <profile> gateway run`, supervised
 * the way the default one is: restarted with backoff when it dies, its lines in the hub's log
 * with the profile's name, stopped with the hub. A profile with no channel gets none — each is
 * a Python process of about 200 MB.
 *
 * Why a process per profile and not Hermes's multiplexer (one gateway serving every profile):
 * under the multiplexer `os.environ` is process-wide and first-writer-wins, so a profile's own
 * `.env` keys cannot differ from the default's, which is the direction of the providers work
 * (shared providers plus a profile's own keys in its own `.env`). A process per profile is
 * Hermes's historical mode and keeps every profile's environment its own.
 *
 * What two gateways side by side must not share, read from Hermes's MIT source (v2026.9.14):
 * - the pid, lock and state files and the control socket live in the profile's home
 *   (`gateway/status.py`, `gateway/control_socket.py`), so they never meet;
 * - the API server binds 8642 when `API_SERVER_KEY` is in the environment
 *   (`gateway/config_env.py` §_api_server). Only the default gateway gets it — the hub talks to
 *   that one alone — and the key is left out of every other one's environment;
 * - the WhatsApp bridge listens on 3000 unless the profile says otherwise, and a second bridge
 *   on the same port adopts or kills the first (`channels.ts` §ensureWhatsAppBridgePort), so a
 *   named profile's bridge is given a port of its own before its gateway starts;
 * - a platform identity (a bot token, a WhatsApp session) is locked machine-wide by its
 *   identity, so one identity in two profiles is refused by Hermes itself, in its words.
 *
 * Keys reach a profile gateway the way they reach every Hermes process the hub starts: the
 * shared provider environment (ADR 0010), with the profile's own `.env` read by Hermes over it.
 * Before each start the models module writes the hub's endpoints and the profile's model into
 * the profile's `config.yaml` (`prepare`), so the gateway resolves the same providers a chat in
 * that profile does.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyBaseLogger } from 'fastify';
import type { RuntimeState } from './adapters/types.js';
import { activeChannels, ensureWhatsAppBridgePort } from './channels.js';
import { namedHermesProfiles } from './hermes-profiles.js';
import type { SpawnedProcess, Spawner } from './hermes-runtime.js';

export interface GatewayStatus {
  /** Hermes's profile name; `default` is the root home's gateway. */
  profile: string;
  state: RuntimeState;
  pid: number | null;
  restarts: number;
  startedAt: number | null;
  lastError: string | null;
  /** The channels it was started to serve. */
  channels: string[];
}

/** What Hermes writes about a running gateway (`gateway/status.py` §write_runtime_status). */
export interface GatewayRuntimeRecord {
  pid: number | null;
  gatewayState: string | null;
  platforms: Record<string, { state: string | null; errorMessage: string | null }>;
}

export interface ProfileGatewaysOptions {
  /** Hermes's root home when the hub supervises Hermes; `null` otherwise. */
  root: () => string | null;
  executable: () => string | null;
  /** The environment every Hermes process gets: the host's, PATH and the provider keys. */
  env: () => NodeJS.ProcessEnv;
  spawnImpl: Spawner;
  log: FastifyBaseLogger;
  /** Puts the hub's providers and the profile's model into its `config.yaml` (models). */
  prepare?: (profile: string, home: string) => void;
  /** Called whenever a gateway's state changes (the registry row follows it). */
  onChange?: () => void;
  backoffMs?: readonly number[];
  stopGraceMs?: number;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;
const STOP_GRACE_MS = 10_000;
/** A gateway that stayed up this long earned a fresh backoff. */
const HEALTHY_AFTER_MS = 60_000;
/** Variables that would make a profile gateway open the API server on the default's port. */
const API_SERVER_VARIABLES = [
  'API_SERVER_ENABLED',
  'API_SERVER_KEY',
  'API_SERVER_HOST',
  'API_SERVER_PORT',
] as const;

/** Reads `<home>/gateway_state.json`; `null` when there is none or it cannot be read. */
export function readGatewayRecord(home: string): GatewayRuntimeRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(home, 'gateway_state.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const platforms: GatewayRuntimeRecord['platforms'] = {};
  if (record.platforms && typeof record.platforms === 'object') {
    for (const [name, value] of Object.entries(record.platforms as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      platforms[name] = {
        state: typeof entry.state === 'string' ? entry.state : null,
        errorMessage: typeof entry.error_message === 'string' ? entry.error_message : null,
      };
    }
  }
  return {
    pid: typeof record.pid === 'number' ? record.pid : null,
    gatewayState: typeof record.gateway_state === 'string' ? record.gateway_state : null,
    platforms,
  };
}

class ProfileGateway {
  child: SpawnedProcess | null = null;
  restarts = 0;
  startedAt: number | null = null;
  lastError: string | null = null;
  channels: string[] = [];
  private stopping = false;
  private relaunch = false;
  private timer: NodeJS.Timeout | null = null;
  private exited: Promise<void> = Promise.resolve();

  constructor(
    readonly profile: string,
    private readonly owner: ProfileGateways,
  ) {}

  get home(): string | null {
    const root = this.owner.options.root();
    return root ? path.join(root, 'profiles', this.profile) : null;
  }

  status(): GatewayStatus {
    return {
      profile: this.profile,
      state: this.state(),
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      startedAt: this.child ? this.startedAt : null,
      lastError: this.lastError,
      channels: [...this.channels],
    };
  }

  private state(): RuntimeState {
    if (!this.child) return this.timer ? 'error' : 'stopped';
    const home = this.home;
    const record = home ? readGatewayRecord(home) : null;
    // Hermes says `running` once its adapters are up; until then, and for a record another
    // process left behind, the gateway is still starting.
    if (record && record.pid === this.child.pid && record.gatewayState === 'running') {
      return 'running';
    }
    return 'starting';
  }

  /** Spawns the gateway now. `false` when there is nothing to spawn it with. */
  launch(): boolean {
    const { options } = this.owner;
    const root = options.root();
    const hermes = options.executable();
    const home = this.home;
    if (!root || !hermes || !home) return false;
    this.stopping = false;
    this.channels = activeChannels(home);
    try {
      this.owner.prepareHome(this.profile, home, this.channels);
    } catch (error) {
      // A file the hub could not write is logged; the gateway still starts with what is there.
      options.log.warn(
        { profile: this.profile, err: error },
        'hermes: could not prepare a profile gateway',
      );
    }
    const env: NodeJS.ProcessEnv = { ...options.env() };
    for (const name of API_SERVER_VARIABLES) delete env[name];
    Object.assign(env, { HERMES_HOME: root, HERMES_DASHBOARD: '0', PYTHONUNBUFFERED: '1' });
    let child: SpawnedProcess;
    try {
      child = options.spawnImpl(hermes, ['-p', this.profile, 'gateway', 'run'], {
        env,
        cwd: home,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleRestart();
      return true;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.lastError = null;
    options.log.info(
      { profile: this.profile, pid: child.pid, channels: this.channels },
      'hermes: messaging gateway started for a profile',
    );
    this.pipe(child.stdout, 'info');
    this.pipe(child.stderr, 'warn');
    let settle: () => void = () => {};
    this.exited = new Promise<void>((resolve) => (settle = resolve));
    child.on('exit', (code, signal) => {
      settle();
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        options.log.info(
          { profile: this.profile, code, signal },
          'hermes: profile gateway stopped',
        );
        this.owner.changed();
        return;
      }
      if (this.relaunch) {
        this.relaunch = false;
        this.launch();
        this.owner.changed();
        return;
      }
      this.lastError = `hermes gateway exited (${signal ?? `code ${code ?? '?'}`})`;
      options.log.error(
        { profile: this.profile, code, signal },
        'hermes: profile gateway crashed; restarting',
      );
      this.scheduleRestart();
      this.owner.changed();
    });
    this.owner.changed();
    return true;
  }

  private pipe(stream: NodeJS.ReadableStream | null, level: 'info' | 'warn'): void {
    if (!stream) return;
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => {
      const text = line.trimEnd();
      if (text) this.owner.options.log[level]({ hermes: true, profile: this.profile }, text);
    });
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const backoff = this.owner.options.backoffMs ?? BACKOFF_MS;
    if (this.startedAt !== null && Date.now() - this.startedAt > HEALTHY_AFTER_MS)
      this.restarts = 0;
    const delay = backoff[Math.min(this.restarts, backoff.length - 1)] ?? 1_000;
    this.restarts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopping) this.launch();
    }, delay);
    this.timer.unref?.();
  }

  /** Stops it and waits until it is gone (SIGKILL after the grace period). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.relaunch = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    if (child) await this.terminate(child);
    this.child = null;
  }

  /** Stops it and starts it again at once — no backoff, not a crash. */
  async restart(): Promise<void> {
    const child = this.child;
    if (!child) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.launch();
      return;
    }
    this.relaunch = true;
    await this.terminate(child);
  }

  private terminate(child: SpawnedProcess): Promise<void> {
    const grace = this.owner.options.stopGraceMs ?? STOP_GRACE_MS;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killer);
        resolve();
      };
      void this.exited.then(finish);
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, grace);
      killer.unref?.();
      if (!child.kill('SIGTERM')) finish();
    });
  }
}

export class ProfileGateways {
  private readonly gateways = new Map<string, ProfileGateway>();
  /** One change at a time: two saves in a row must not start one profile's gateway twice. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(readonly options: ProfileGatewaysOptions) {}

  /** Every profile gateway the hub runs or is about to restart, by profile name. */
  status(): GatewayStatus[] {
    return [...this.gateways.values()]
      .map((gateway) => gateway.status())
      .sort((a, b) => a.profile.localeCompare(b.profile));
  }

  /** The gateway Hermes reports for `profile`, when it is the one this hub started. */
  record(profile: string): GatewayRuntimeRecord | null {
    const gateway = this.gateways.get(profile);
    const home = gateway?.home;
    if (!gateway?.child || !home) return null;
    const record = readGatewayRecord(home);
    return record && record.pid === gateway.child.pid ? record : null;
  }

  /** Brings the set of running gateways in line with the profiles' channels. */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      const root = this.options.root();
      const wanted = new Set(
        root
          ? namedHermesProfiles(root).filter(
              (name) => activeChannels(path.join(root, 'profiles', name)).length > 0,
            )
          : [],
      );
      for (const [name, gateway] of [...this.gateways]) {
        if (wanted.has(name)) continue;
        await gateway.stop();
        this.gateways.delete(name);
        this.options.log.info(
          { profile: name },
          'hermes: no channel left; profile gateway stopped',
        );
      }
      for (const name of wanted) {
        if (this.gateways.has(name)) continue;
        this.startOne(name);
      }
      this.changed();
    });
  }

  /**
   * A channel of `profile` changed (linked, switched, edited, cleared, unlinked). A gateway
   * reads its channels when it starts, so the one that serves the profile is started,
   * restarted or stopped to match — a change here is live without anyone pressing Restart.
   */
  channelsChanged(profile: string): Promise<void> {
    if (profile === 'default') return Promise.resolve();
    return this.serial(async () => {
      const root = this.options.root();
      if (!root) return;
      const home = path.join(root, 'profiles', profile);
      const wanted = namedHermesProfiles(root).includes(profile) && activeChannels(home).length > 0;
      const gateway = this.gateways.get(profile);
      if (!wanted) {
        if (!gateway) return;
        await gateway.stop();
        this.gateways.delete(profile);
        this.options.log.info({ profile }, 'hermes: no channel left; profile gateway stopped');
      } else if (gateway) {
        await gateway.restart();
      } else {
        this.startOne(profile);
      }
      this.changed();
    });
  }

  /** Stops `profile`'s gateway, runs `work`, and starts it again if the profile still needs one. */
  withStopped<T>(profile: string, work: () => T | Promise<T>): Promise<T> {
    return this.serial(async () => {
      const gateway = this.gateways.get(profile);
      if (gateway) {
        await gateway.stop();
        this.gateways.delete(profile);
      }
      try {
        return await work();
      } finally {
        const root = this.options.root();
        if (
          root &&
          !this.closed &&
          profile !== 'default' &&
          namedHermesProfiles(root).includes(profile) &&
          activeChannels(path.join(root, 'profiles', profile)).length > 0
        ) {
          this.startOne(profile);
        }
        this.changed();
      }
    });
  }

  /** The Hermes card's Restart: every profile gateway, then the set checked again. */
  restartAll(): Promise<void> {
    return this.serial(async () => {
      await Promise.all([...this.gateways.values()].map((gateway) => gateway.restart()));
    }).then(() => this.reconcile());
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    await this.serial(async () => {
      await Promise.all([...this.gateways.values()].map((gateway) => gateway.stop()));
      this.gateways.clear();
    });
  }

  /** Makes a profile's files ready for its gateway: its own bridge port, the hub's providers. */
  prepareHome(profile: string, home: string, channels: readonly string[]): void {
    const root = this.options.root();
    if (root && channels.includes('whatsapp')) {
      const others = [
        root,
        ...namedHermesProfiles(root)
          .filter((name) => name !== profile)
          .map((name) => path.join(root, 'profiles', name)),
      ];
      ensureWhatsAppBridgePort(home, others);
    }
    this.options.prepare?.(profile, home);
  }

  changed(): void {
    this.options.onChange?.();
  }

  private startOne(profile: string): void {
    if (this.closed) return;
    const gateway = new ProfileGateway(profile, this);
    if (gateway.launch()) this.gateways.set(profile, gateway);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * Stops a WhatsApp bridge still running from `sessionDir`. Hermes starts the bridge in a
 * session of its own (`start_new_session`), so a gateway killed hard can leave it behind,
 * holding the session in memory and its port. Only a `node` process whose command line names
 * this very session folder is touched — the same check Hermes makes before it kills one
 * (`adapter.py` §_bridge_pid_is_ours). Returns whether one was stopped.
 */
export function stopOrphanBridge(sessionDir: string): boolean {
  let text: string;
  try {
    text = readFileSync(path.join(sessionDir, 'bridge.pid'), 'utf8');
  } catch {
    return false;
  }
  const pid = Number((text.split('\n')[0] ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return false;
  }
  if (!cmdline.includes('node') || !cmdline.includes(sessionDir)) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
