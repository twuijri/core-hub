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
 * (`channels.ts` §activeChannels) **or at least one active scheduled job of Hermes's own**
 * (`activeCronJobs`) gets its own `hermes -p <profile> gateway run`, supervised the way the
 * default one is: restarted with backoff when it dies, its lines in the hub's log with the
 * profile's name, stopped with the hub. A profile with neither gets none — each is a Python
 * process of about 200 MB.
 *
 * Why scheduled jobs: Hermes keeps a profile's jobs in that profile's own `cron/jobs.json` and
 * only a gateway scoped to that profile fires them (`cron/jobs.py`: "a profile-scoped gateway
 * runs that profile's jobs under that same HERMES_HOME"). A job an agent scheduled in «manger»
 * never ran while «manger» had no gateway. Jobs change without the hub — an agent schedules one
 * in a chat, a person runs `hermes cron` — so the set is checked again every half minute too,
 * the interval Hermes's own multiplexer rescans at.
 *
 * Hermes's kanban has one board for every profile and one dispatcher for it. A gateway runs
 * the dispatcher unless told not to, and the first gateway to take its lock keeps it, so a
 * profile gateway started first would dispatch every profile's cards in its own environment.
 * Profile gateways are started with `HERMES_KANBAN_DISPATCH_IN_GATEWAY=false`; the default
 * gateway stays the one dispatcher (`gateway/kanban_watchers.py` §_kanban_dispatcher_boot).
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
 *
 * ── One gateway per host (Hermes v2026.9.21, `0.21.4`, and later) ──────────────────────────────
 *
 * Everything above is the **per-profile** topology, kept exactly as it was for an older Hermes.
 * From v2026.9.21 Hermes allows one `hermes gateway run` per host (per OS user) and makes it
 * serve every profile (`gateway/host_attach.py`, `hermes_cli/gateway_multiplex_mode.py`): a
 * second gateway asks the first whether it serves its profile and, when it does, prints "One
 * gateway per host serves every profile; manage it with `hermes -p default gateway restart`"
 * and exits 75 — so a per-profile gateway the hub started only ever crash-looped. Read from the
 * MIT source of v2026.9.21 and v2026.9.24:
 * - the gateway started first multiplexes unless only one profile exists or another profile
 *   still runs its own gateway (`implicit_multiplex_blocker`); it writes the profiles it serves
 *   to its `gateway_state.json` (`served_profiles`: every one when it multiplexes, `[]` when it
 *   does not) and each served profile's platforms there as `<profile>:<platform>`;
 * - a served profile's secrets are no longer process-wide: each turn runs under that profile's
 *   own `.env` through a secret scope, without touching `os.environ` (`_profile_runtime_scope`),
 *   so the old reason for a process per profile is gone;
 * - its scheduler fires the jobs of **every** profile whether or not it multiplexes
 *   (`_cron_tick_profile_homes`), and it is the one kanban dispatcher and the one API server;
 * - it rebuilds a served profile whose `config.yaml` or `.env` changed, and starts serving a new
 *   profile, every 30 s or at once on its control socket's `rescan-profiles`
 *   (`gateway/run_profile_reconcile.py`, `hermes-control.ts`); whether it multiplexes at all is
 *   decided when it starts, so a root gateway that came up alone is restarted to serve more;
 * - the host lock lives per OS user, not per home (`gateway/host_rendezvous.py`), which is why
 *   the root gateway of a hub beside a person's own Hermes gets a lock folder of its own
 *   (`hermes-runtime.ts` §gatewayLockEnv);
 * - Hermes itself does not yet run a named profile's WhatsApp under the multiplexer (it marks it
 *   `multiplex_shared_ingress`); the card shows Hermes's own reason.
 *
 * So once this Hermes is known to run one gateway per host — its version, or a gateway that
 * exited 75 saying so — the hub starts no profile gateway: the root one (`hermes-runtime.ts`)
 * serves every profile, each named profile's row on the card follows it, and a channel change
 * in a named profile asks it to rescan (or restarts it when it does not multiplex yet).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { HUB_ORIGIN_ENV } from './hub-tools/block.js';
import type { FastifyBaseLogger } from 'fastify';
import type { RuntimeState } from './adapters/types.js';
import { activeChannels, ensureWhatsAppBridgePort } from './channels.js';
import { rescanGatewayProfiles } from './hermes-control.js';
import { namedHermesProfiles } from './hermes-profiles.js';
import type { SpawnedProcess, Spawner } from './hermes-runtime.js';
import { compareVersions } from './update-policy.js';
import { IMAGE_WHATSAPP_BRIDGE, prepareWhatsAppBridge } from './whatsapp-bridge.js';

/** How this Hermes places its messaging gateways (see the top of this file). */
export type GatewayTopology = 'per-profile' | 'one-per-host';

/** The first Hermes release with one gateway per host: v2026.9.21, `0.21.4`. */
export const ONE_GATEWAY_PER_HOST_SINCE = '0.21.4';

/** The topology a Hermes version implies; `null` when the version is unknown. */
export function topologyForVersion(version: string | null | undefined): GatewayTopology | null {
  const plain = version?.trim().split('+')[0];
  if (!plain || !/^\d+\.\d+/.test(plain)) return null;
  return compareVersions(plain, ONE_GATEWAY_PER_HOST_SINCE) >= 0 ? 'one-per-host' : 'per-profile';
}

/**
 * The first Hermes release where a plugin may put a message only into its own profile's
 * conversations: v0.22.3 (`gateway/run_plugin_injection.py` §_plugin_messaging_session_owned —
 * under one gateway per host a session belongs to the profile its key names, `agent:<profile>:…`,
 * and the plugin's profile is the home it was loaded from). Before it, the root home's copy of a
 * plugin reached every profile's conversations.
 */
export const OWN_PROFILE_INJECTION_SINCE = '0.22.3';

/** Whether this Hermes version lets a plugin inject only into its own profile's conversations. */
export function injectsOnlyIntoOwnProfile(version: string | null | undefined): boolean {
  const plain = version?.trim().split('+')[0];
  if (!plain || !/^\d+\.\d+/.test(plain)) return false;
  return compareVersions(plain, OWN_PROFILE_INJECTION_SINCE) >= 0;
}

/**
 * Whether a gateway's last words are Hermes refusing to be a second gateway on this host
 * (`gateway/host_attach.py` §attach_message, §_refuse_message, `gateway/run.py`
 * §_refuse_second_host_gateway). Exit code 75 alone is not enough: Hermes also exits 75 to be
 * restarted by its supervisor.
 */
export function saysOneGatewayPerHost(text: string): boolean {
  return /one gateway per host|already owns this host|host gateway already serves/i.test(text);
}

/**
 * The profiles the gateway of `home` says it serves (`gateway_state.json` §served_profiles):
 * every one when it multiplexes, `[]` when it serves only its own, `null` from a Hermes that
 * does not write the key (older than one gateway per host) or when there is no record.
 */
export function readServedProfiles(home: string): string[] | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(home, 'gateway_state.json'), 'utf8')) as {
      served_profiles?: unknown;
    } | null;
    return Array.isArray(raw?.served_profiles)
      ? raw.served_profiles.filter((name): name is string => typeof name === 'string')
      : null;
  } catch {
    return null;
  }
}

/** The root gateway the hub runs, as a one-gateway-per-host Hermes needs it. */
export interface RootGatewayHandle {
  status: () => { state: RuntimeState; pid: number | null; startedAt: number | null };
  /** Stops and starts it again (no backoff), so it decides again which profiles it serves. */
  restart: () => Promise<void>;
}

const LAST_LINES_KEPT = 20;
/** What a named profile's row says when the root gateway came up and still does not serve it. */
const NOT_SERVED =
  "Hermes's gateway does not serve this profile; Hermes's log says why (`hermes gateway migrate --multiplex`)";

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
  /** Hermes's scheduled jobs in the profile that are neither paused nor finished. */
  cronJobs: number;
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
  /** How often the set of profiles needing a gateway is checked again. 0 turns it off. */
  rescanMs?: number;
  /** The installed WhatsApp bridge a profile's copy links to (`whatsapp-bridge.ts`). */
  whatsappBridge?: string;
  /** The root gateway, which serves every profile on a one-gateway-per-host Hermes. */
  rootGateway?: RootGatewayHandle;
  /** Asks the root gateway to rescan its profiles now (tests replace the control socket). */
  rescanProfiles?: (root: string) => Promise<unknown>;
  /** Called when the topology becomes one gateway per host. */
  onTopology?: (topology: GatewayTopology, reason: string) => void;
  /**
   * One gateway per host: the named profiles' webhook routes are copied to the root's file before
   * it serves them (`hermes-webhooks.ts` §shareProfileWebhooks). Resolves true when the root's
   * listener had to be switched on, so the root gateway starts again to listen.
   */
  shareWebhooks?: (root: string) => Promise<boolean>;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;
/** Hermes's own multiplexer rescans its profiles this often (`_PROFILE_RESCAN_INTERVAL_SECS`). */
export const GATEWAY_RESCAN_MS = 30_000;
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

/**
 * Hermes's scheduled jobs in `<home>/cron/jobs.json` that will still fire: switched on, not
 * paused, not a one-shot that already ran (`cron/jobs.py` §is_job_runnable, §is_terminal_job —
 * a recurring job in `error` still has occurrences and counts).
 */
export function activeCronJobs(home: string): number {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(home, 'cron', 'jobs.json'), 'utf8'));
  } catch {
    return 0;
  }
  const jobs = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (raw as { jobs?: unknown }).jobs
      : [];
  const list = Array.isArray(jobs)
    ? jobs
    : jobs && typeof jobs === 'object'
      ? Object.values(jobs as Record<string, unknown>)
      : [];
  return list.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const job = entry as Record<string, unknown>;
    if (job.enabled === false || job.state === 'paused' || job.paused_at) return false;
    if (job.state === 'completed') return false;
    if (job.state === 'error') {
      const kind = (job.schedule as { kind?: unknown } | undefined)?.kind;
      return kind === 'cron' || kind === 'interval';
    }
    return true;
  }).length;
}

/** Whether a named profile needs a gateway: a channel to answer on, or a job to fire. */
export function needsGateway(home: string): boolean {
  return activeChannels(home).length > 0 || activeCronJobs(home) > 0;
}

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
  /** The running process's last lines, for Hermes's reason when it exits. */
  private readonly lastLines: string[] = [];
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
      cronJobs: this.home ? activeCronJobs(this.home) : 0,
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
    Object.assign(env, {
      HERMES_HOME: root,
      HERMES_DASHBOARD: '0',
      PYTHONUNBUFFERED: '1',
      // One board, one dispatcher: the default gateway's (see the top of this file).
      HERMES_KANBAN_DISPATCH_IN_GATEWAY: 'false',
      // A messaging gateway: its calls to the hub's tools are its channel turns' (§79).
      [HUB_ORIGIN_ENV]: 'gateway',
    });
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
    this.lastLines.length = 0;
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
      if (code === 75 && saysOneGatewayPerHost(this.lastLines.join('\n'))) {
        // Hermes runs one gateway per host and another one already serves this profile: not a
        // crash to restart, but the sign that the root gateway serves every profile here.
        options.log.info(
          { profile: this.profile },
          'hermes: this Hermes runs one gateway per host; the profile is served by that one',
        );
        void this.owner.useOneGatewayPerHost('a profile gateway exited 75: one gateway per host');
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
      if (!text) return;
      this.owner.options.log[level]({ hermes: true, profile: this.profile }, text);
      this.lastLines.push(text);
      if (this.lastLines.length > LAST_LINES_KEPT) this.lastLines.shift();
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
  private rescanTimer: NodeJS.Timeout | null = null;
  private topologyNow: GatewayTopology = 'per-profile';
  /** The Hermes version last noted (`hermes --version`), or null before the hub read one. */
  private versionNow: string | null = null;
  /** Named profiles already prepared for the root gateway (one gateway per host). */
  private readonly prepared = new Set<string>();
  /**
   * The profiles the root gateway was last restarted for on its own (one gateway per host): when
   * it came up and still does not serve them, Hermes has a reason, and it is not restarted again
   * for the same set until somebody changes a channel or presses Restart.
   */
  private rootRestartedFor: string | null = null;

  constructor(readonly options: ProfileGatewaysOptions) {}

  /** How this Hermes places its gateways, as far as the hub knows. */
  topology(): GatewayTopology {
    return this.topologyNow;
  }

  /**
   * Whether this Hermes lets a plugin inject only into its own profile's conversations
   * (v0.22.3 and later, `injectsOnlyIntoOwnProfile`); false while the version is unknown.
   */
  injectsOnlyIntoOwnProfile(): boolean {
    return injectsOnlyIntoOwnProfile(this.versionNow);
  }

  /**
   * The version of the Hermes the hub runs (`hermes --version`): from v2026.9.21 (`0.21.4`) one
   * gateway serves every profile. An older or unreadable version changes nothing — a gateway that
   * exits 75 saying so still switches (`useOneGatewayPerHost`).
   */
  noteVersion(version: string | null): Promise<void> {
    if (version) this.versionNow = version;
    if (topologyForVersion(version) !== 'one-per-host') return Promise.resolve();
    return this.useOneGatewayPerHost(`Hermes ${version} runs one gateway per host`);
  }

  /**
   * From now on no profile gateway is started: the root one serves every profile. The ones
   * running are stopped and the root gateway is brought to serve the profiles that need it.
   */
  useOneGatewayPerHost(reason: string): Promise<void> {
    if (this.topologyNow === 'one-per-host') return Promise.resolve();
    this.topologyNow = 'one-per-host';
    this.options.log.info({ reason }, 'hermes: one gateway per host serves every profile');
    this.options.onTopology?.('one-per-host', reason);
    return this.reconcile();
  }

  /** Every profile gateway the hub runs or is about to restart, by profile name. */
  status(): GatewayStatus[] {
    if (this.topologyNow === 'one-per-host') return this.servedByRoot();
    return [...this.gateways.values()]
      .map((gateway) => gateway.status())
      .sort((a, b) => a.profile.localeCompare(b.profile));
  }

  /** The gateway Hermes reports for `profile`, when it is the one this hub started. */
  record(profile: string): GatewayRuntimeRecord | null {
    if (this.topologyNow === 'one-per-host') return this.rootRecordFor(profile);
    const gateway = this.gateways.get(profile);
    const home = gateway?.home;
    if (!gateway?.child || !home) return null;
    const record = readGatewayRecord(home);
    return record && record.pid === gateway.child.pid ? record : null;
  }

  /**
   * Checks the set again every half minute: a job an agent schedules in a chat, or a person
   * with `hermes cron`, is not something the hub hears about. Called once the runtime is
   * managed.
   */
  watch(): void {
    const every = this.options.rescanMs ?? GATEWAY_RESCAN_MS;
    if (every <= 0 || this.rescanTimer || this.closed) return;
    this.rescanTimer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.options.log.warn({ err: error }, 'hermes: could not check the profile gateways');
      });
    }, every);
    this.rescanTimer.unref?.();
  }

  /** Brings the set of running gateways in line with the profiles' channels and jobs. */
  reconcile(): Promise<void> {
    if (this.topologyNow === 'one-per-host') return this.serial(() => this.reconcileOnRoot());
    return this.serial(async () => {
      const root = this.options.root();
      const wanted = new Set(
        root
          ? namedHermesProfiles(root).filter((name) =>
              needsGateway(path.join(root, 'profiles', name)),
            )
          : [],
      );
      for (const [name, gateway] of [...this.gateways]) {
        if (wanted.has(name)) continue;
        await gateway.stop();
        this.gateways.delete(name);
        this.options.log.info(
          { profile: name },
          'hermes: no channel and no scheduled job left; profile gateway stopped',
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
    if (this.topologyNow === 'one-per-host') {
      return this.serial(() => this.followOnRoot(profile));
    }
    return this.serial(async () => {
      const root = this.options.root();
      if (!root) return;
      const home = path.join(root, 'profiles', profile);
      const wanted = namedHermesProfiles(root).includes(profile) && needsGateway(home);
      const gateway = this.gateways.get(profile);
      if (!wanted) {
        if (!gateway) return;
        await gateway.stop();
        this.gateways.delete(profile);
        this.options.log.info(
          { profile },
          'hermes: no channel and no scheduled job left; profile gateway stopped',
        );
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
    if (this.topologyNow === 'one-per-host') {
      // No gateway of its own to hold down; the root one takes the change on its next scan.
      return this.serial(async () => {
        try {
          return await work();
        } finally {
          if (profile !== 'default' && !this.closed) await this.followOnRoot(profile);
        }
      });
    }
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
          needsGateway(path.join(root, 'profiles', profile))
        ) {
          this.startOne(profile);
        }
        this.changed();
      }
    });
  }

  /** The Hermes card's Restart: every profile gateway, then the set checked again. */
  restartAll(): Promise<void> {
    // The root gateway is restarted by the runtime; it decides afresh what it serves.
    this.rootRestartedFor = null;
    return this.serial(async () => {
      await Promise.all([...this.gateways.values()].map((gateway) => gateway.restart()));
    }).then(() => this.reconcile());
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    await this.serial(async () => {
      await Promise.all([...this.gateways.values()].map((gateway) => gateway.stop()));
      this.gateways.clear();
    });
  }

  /**
   * Makes a profile's files ready for its gateway: its own bridge port and its copy of the
   * bridge on the image's dependencies (so Hermes installs nothing), the hub's providers.
   */
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
      const bridge = prepareWhatsAppBridge(
        home,
        this.options.whatsappBridge ?? IMAGE_WHATSAPP_BRIDGE,
      );
      if (bridge !== 'current' && bridge !== 'no-image-bridge') {
        this.options.log.info(
          { profile, bridge },
          'hermes: WhatsApp bridge prepared for a profile',
        );
      }
    }
    this.options.prepare?.(profile, home);
  }

  changed(): void {
    this.options.onChange?.();
  }

  // ------------------------------------------------ one gateway per host (see the top of the file)

  private rootStatus(): { state: RuntimeState; pid: number | null; startedAt: number | null } {
    return this.options.rootGateway?.status() ?? { state: 'stopped', pid: null, startedAt: null };
  }

  /**
   * What the root gateway says about itself, when it is the process the hub runs now and Hermes
   * calls it running; with the profiles it serves (`null`: it does not say).
   */
  private liveRoot(): { record: GatewayRuntimeRecord; served: string[] | null } | null {
    const root = this.options.root();
    const { pid } = this.rootStatus();
    if (!root || pid === null) return null;
    const record = readGatewayRecord(root);
    if (!record || record.pid !== pid || record.gatewayState !== 'running') return null;
    return { record, served: readServedProfiles(root) };
  }

  /** Each named profile that needs serving, as a row that follows the root gateway. */
  private servedByRoot(): GatewayStatus[] {
    const root = this.options.root();
    if (!root) return [];
    const rootNow = this.rootStatus();
    const live = this.liveRoot();
    return namedHermesProfiles(root)
      .map((profile) => ({ profile, home: path.join(root, 'profiles', profile) }))
      .filter(({ home }) => needsGateway(home))
      .map(({ profile, home }) => {
        const channels = activeChannels(home);
        let state: RuntimeState = rootNow.state;
        let lastError: string | null = null;
        // A job needs no serving: Hermes's one scheduler fires every profile's jobs.
        if (channels.length > 0 && live && !live.served?.includes(profile)) {
          const given = this.rootRestartedFor !== null && live.record.pid === rootNow.pid;
          state = given ? 'error' : 'starting';
          lastError = given ? NOT_SERVED : null;
        }
        return {
          profile,
          state,
          pid: rootNow.pid,
          restarts: 0,
          startedAt: rootNow.pid === null ? null : rootNow.startedAt,
          lastError,
          channels,
          cronJobs: activeCronJobs(home),
        };
      })
      .sort((a, b) => a.profile.localeCompare(b.profile));
  }

  /** The root gateway's record narrowed to `profile`'s platforms, when it serves the profile. */
  private rootRecordFor(profile: string): GatewayRuntimeRecord | null {
    const live = this.liveRoot();
    if (!live?.served?.includes(profile)) return null;
    const prefix = `${profile}:`;
    const platforms: GatewayRuntimeRecord['platforms'] = {};
    for (const [key, value] of Object.entries(live.record.platforms)) {
      if (key.startsWith(prefix)) platforms[key.slice(prefix.length)] = value;
    }
    return { pid: live.record.pid, gatewayState: live.record.gatewayState, platforms };
  }

  /** The profiles with a channel to answer on, each prepared once for the root gateway. */
  private channelProfiles(root: string): string[] {
    const wanted = namedHermesProfiles(root).filter((name) =>
      needsGateway(path.join(root, 'profiles', name)),
    );
    for (const name of [...this.prepared]) if (!wanted.includes(name)) this.prepared.delete(name);
    for (const name of wanted) {
      if (this.prepared.has(name)) continue;
      this.prepareQuietly(name, path.join(root, 'profiles', name));
      this.prepared.add(name);
    }
    return wanted.filter((name) => activeChannels(path.join(root, 'profiles', name)).length > 0);
  }

  private prepareQuietly(profile: string, home: string): void {
    try {
      this.prepareHome(profile, home, activeChannels(home));
    } catch (error) {
      this.options.log.warn(
        { profile, err: error },
        'hermes: could not prepare a profile for the gateway',
      );
    }
  }

  private async reconcileOnRoot(): Promise<void> {
    for (const [name, gateway] of [...this.gateways]) {
      await gateway.stop();
      this.gateways.delete(name);
    }
    const root = this.options.root();
    if (root && !this.closed) {
      const profiles = this.channelProfiles(root);
      if (await this.shareWebhooks(root)) await this.options.rootGateway?.restart();
      else await this.bringRootToServe(profiles, false);
    }
    this.changed();
  }

  /** `shareWebhooks`, never throwing: a route that cannot be copied costs only that route. */
  private async shareWebhooks(root: string): Promise<boolean> {
    try {
      return (await this.options.shareWebhooks?.(root)) ?? false;
    } catch (error) {
      this.options.log.warn(
        { err: error },
        "hermes: could not give the gateway the named profiles' webhook routes",
      );
      return false;
    }
  }

  /** A channel or setting of `profile` changed: the root gateway takes it now. */
  private async followOnRoot(profile: string): Promise<void> {
    const root = this.options.root();
    if (!root || this.closed) return;
    const home = path.join(root, 'profiles', profile);
    if (namedHermesProfiles(root).includes(profile)) this.prepareQuietly(profile, home);
    this.rootRestartedFor = null;
    const profiles = this.channelProfiles(root);
    if (await this.shareWebhooks(root)) await this.options.rootGateway?.restart();
    else await this.bringRootToServe(profiles, true);
    this.changed();
  }

  /**
   * Makes the running root gateway serve `profiles`. One that multiplexes is asked to rescan
   * (it would within 30 s anyway); one that serves only the default profile decided so when it
   * started — with a single profile, or while a profile gateway of the old kind still ran — so it
   * is restarted, once for the same set unless somebody changed something (`explicit`).
   */
  private async bringRootToServe(profiles: string[], explicit: boolean): Promise<void> {
    const root = this.options.root();
    const live = this.liveRoot();
    if (!root || !live) return;
    const missing = profiles.filter((name) => !live.served?.includes(name));
    const multiplexing = (live.served?.length ?? 0) > 0;
    if (missing.length === 0 || multiplexing) {
      if (explicit || missing.length > 0) {
        await (this.options.rescanProfiles ?? rescanGatewayProfiles)(root).catch(() => null);
      }
      return;
    }
    const key = missing.join(',');
    if (!explicit && this.rootRestartedFor === key) return;
    this.rootRestartedFor = key;
    this.options.log.info(
      { profiles: missing },
      'hermes: restarting the gateway so it serves every profile',
    );
    await this.options.rootGateway?.restart();
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
