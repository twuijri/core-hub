/**
 * Module `agents`: the curated catalog, the registry, the adapters (ADR 0002) and the
 * install lifecycle as jobs (ADR 0006).
 *
 * Implemented: `agents.list`, `agents.get`, `agents.update`, `agents.getSettings`,
 * `agents.updateSettings`, `agents.install`, `agents.uninstall`, `agents.upgrade`,
 * `agents.checkUpdate`, `agents.discover`.
 *
 * `agents.restart` restarts the Hermes runtime when this hub supervises it (ADR 0008,
 * `hermes-runtime.ts`); an external or absent runtime answers `409 state_invalid`.
 *
 * The three tool operations that need Hermes to act — `agents.testMcpServer`,
 * `agents.loginChannel` (WhatsApp by QR) — go through Hermes's own API in the selected
 * profile (`hermes-tools.ts`, ADR 0015); `agents.importSkills` installs an uploaded pack into
 * the profile's `skills/` (`skill-import.ts`), because Hermes has no importer. The plugin
 * operations (`agents.listPlugins`, `updatePlugin`, `installPlugin`, `deletePlugin`) run
 * Hermes's own `hermes plugins` command against the selected profile's home
 * (`hermes-plugins.ts`).
 *
 * `agents.getAvatar` serves the picture `agents.update` stored (`avatars.ts`); an agent without
 * one is drawn from its slug by the client.
 *
 * Still documented 501 stubs, with the reason:
 * - presets and config files — each waits for an owner decision (the change record
 *   `docs/changes/2026-09-26-twuijri-close-501-stubs.md` says which).
 *
 * `agents.getJourney` is Hermes's own learning graph for the selected profile, read from
 * Hermes's server (`hermes-journey.ts`).
 *
 * Composition note: the module object is a singleton shared by every `buildServer()` in a
 * test process, so the service is kept per Socket.IO server (one per app), the same way
 * `auth` keeps its context.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument, serverBasePath } from '@corehub/contracts';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { createContractIndex } from '../../lib/contract.js';
import { defineModule } from '../../lib/module.js';
import { createRealtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import { registerWebhookRoutes } from './webhook-routes.js';
import { registerPresetRoutes } from './presets.js';
import { registerMcpOAuthRoutes } from './mcp-oauth-routes.js';
import { mcpLoginSpawner, oauthStateOf, type McpLoginSpawner } from './mcp-oauth.js';
import { levelOfHermesLine } from '../../lib/log-ring.js';
import { t } from '../../i18n/index.js';
import {
  defaultWorkspace,
  findWorkspace,
  ownerUser,
  registerWorkspaceStatsProvider,
  requireRole,
  requireUser,
  requireWorkspace,
  type WorkspaceScope,
} from '../auth/index.js';
import { auditFor, jobRunnerFor } from '../audit/index.js';
import { createAdapterSet, type AdapterSet, type AdapterSetOptions } from './adapters/index.js';
import type { AdapterKind, AgentTarget } from './adapters/types.js';
import { HERMES_ENTRY, catalogEntry } from './catalog/index.js';
import {
  HermesRuntime,
  gatewayNote,
  type HermesRuntimeStatus,
  type Spawner,
} from './hermes-runtime.js';
import { HermesDashboard, type DashboardSpawner } from './hermes-dashboard.js';
import { QR_PLATFORMS, pairWhatsApp, testMcpServer, type HermesApiCall } from './hermes-tools.js';
import { readJourney } from './hermes-journey.js';
import { AgentAvatars } from './avatars.js';
import { namedHermesProfiles } from './hermes-profiles.js';
import { RunLeases } from './hub-tools/leases.js';
import { HUB_SERVER_NAME, removeBlock } from './hub-tools/block.js';
import { removeHook } from './hub-tools/hook.js';
import {
  createDefaultProfileReplacement,
  type DefaultProfileReplacement,
  type SwapFs,
} from './hermes-default-swap.js';
import { registerHubToolRoutes } from './hub-tools/routes.js';
import {
  HubToolsService,
  type HubToolsHandOver,
  type HubToolsNotify,
} from './hub-tools/service.js';
import { telegramGetMe } from './telegram-api.js';
import { TELEGRAM_OPTIONS } from './telegram-settings.js';
import {
  SettingError,
  readChannelSettings,
  writeChannelSettings,
  type OptionSpec,
} from './channel-settings.js';
import {
  CredentialError,
  PLATFORMS,
  checkCredentials,
  credentialPlatform,
  identityValue,
  linkCredentials,
  platformSpec,
  type PlatformSpec,
} from './channel-platforms.js';
import { probePlatform, type ProbeOptions } from './channel-validate.js';
import { HermesSettingError, readHermesSettings, writeHermesSettings } from './hermes-settings.js';
import {
  PendingWriteError,
  approvePendingWrite,
  hermesPythonRunner,
  listPendingWrites,
  pendingWriteExists,
  rejectPendingWrite,
  type HermesPython,
  type PendingKind,
} from './hermes-pending-writes.js';
import {
  hermesCliRunner,
  installPlugin,
  listPlugins,
  removePlugin,
  setPluginEnabled,
  type HermesCli,
} from './hermes-plugins.js';
import { hermesProfileName, profileHome } from './profile-home.js';
import { hermesSecrets, type HermesSecret } from './secret-files.js';
import { SkillImportError, installPack, planImport, type UploadedFile } from './skill-import.js';
import { createNpmInstaller, managedBinDirs, type AgentInstaller } from './installer.js';
import { AgentSignIns, type SpawnSignIn } from './agent-sign-in.js';
import { agentEnvironment } from './adapters/acp.js';
import { hostEnvNames } from './adapters/child-env.js';
import type { AgentDirectoryPort, AgentInfo, AgentModelsPort, AgentRunnerPort } from './ports.js';
import { AgentRunner } from './runner.js';
import { ConfigFileError, ConfigFileStore } from './config-files.js';
import { CodingAgentMcpStore, managesCodingAgentMcp } from './coding-agent-mcp.js';
import { subagentSupport } from './serialize.js';
import {
  AgentUpdateChecker,
  createPackageRegistry,
  type PackageRegistry,
} from './update-policy.js';
import { AgentsService, type AgentPatchInput, type HermesUpdater } from './service.js';
import {
  ChannelError,
  clearChannel,
  listChannels,
  putChannel,
  unlinkWhatsApp,
  linkTelegram,
  unlinkTelegram,
  unlinkPlatform,
  readEnv,
  setWhatsAppMode,
  setWhatsAppReplyTitle,
  defaultReplyTitle,
  cleanReplyTitle,
  telegramToken,
  TELEGRAM_TOKEN,
  whatsappLink,
  whatsappSessionDir,
  type Channel,
  type WhatsAppMode,
} from './channels.js';
import { stopOrphanBridge, type GatewayStatus } from './hermes-gateways.js';
import { approvePairing, denyPairing, listPairing, revokePairing } from './hermes-pairing.js';
import {
  MemoryError,
  deleteMemory,
  listMemory,
  migrateLegacyMemory,
  putMemory,
  type MemoryDocument,
} from './memory.js';
import {
  McpError,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  putMcpServer,
  setMcpToolFilter,
  type McpServer,
  type McpToolFilter,
} from './mcp.js';
import { McpTestStore, readOnlyHints, viewOfTest } from './mcp-last-test.js';
import {
  SkillError,
  categoryDescription,
  deleteSkill,
  skillsDir,
  getSkill,
  listSkills,
  putSkill,
  setSkillEnabled,
  type Skill,
  type SkillFolderOptions,
} from './skills.js';
import {
  LIBRARY_CATEGORY,
  LibraryError,
  libraryStatus,
  restoreLibrarySkill,
  seedLibrary,
  seedLibraryOfEveryProfile,
  setLibraryEnabled,
  type LibraryStatus,
} from './skill-library.js';

export { AgentsService } from './service.js';
/** The Hermes profile's Telegram bot token, for a workflow's "Send message" step (§124). */
export { telegramToken } from './channels.js';
export type { AgentPatchInput, AgentsServiceOptions, ReconcileReport } from './service.js';
export { createAdapterSet } from './adapters/index.js';
export type { AdapterSet, AdapterSetOptions } from './adapters/index.js';
export {
  agentBinDir,
  agentPrefix,
  agentsRoot,
  createNpmInstaller,
  managedBinDirs,
} from './installer.js';
export type { AgentInstaller } from './installer.js';
export {
  CATALOG,
  HERMES_ENTRY,
  INSTALLABLE,
  assertCatalogIsWellFormed,
  catalogEntry,
  entriesFor,
  isManaged,
  pinnedVersion,
} from './catalog/index.js';
export type { CatalogEntry, HealthCheck, InstallRecipe } from './catalog/index.js';
export {
  AgentUpdateChecker,
  compareVersions,
  createPackageRegistry,
  isStableVersion,
} from './update-policy.js';
export type { PackageRegistry, UpdateCheckReport } from './update-policy.js';
export type {
  AgentDirectoryPort,
  AgentGatewayGrant,
  AgentGatewayPort,
  AgentGatewayTurn,
  AgentGatewayUsage,
  AgentInfo,
  AgentModelsPort,
  AgentRunnerPort,
  RunnerEvent,
} from './ports.js';

/**
 * The shared provider store (ADR 0010), registered by the `models` module at boot.
 *
 * A slot rather than a constructor argument because `agents` mounts before `models` in
 * the composition order, and inverting that order would make the registry depend on the
 * provider store being up. Until it is registered, an agent starts with its own settings
 * only — never with a wrong key.
 *
 * Keyed to the app's own Socket.IO server, exactly like `contexts` below: two hubs in one
 * process (the test suite builds dozens) must never share a port, or one hub's agents
 * would resolve credentials out of another hub's database.
 */
const modelsPorts = new WeakMap<SocketServer, AgentModelsPort>();

export function registerAgentModelsPort(io: SocketServer, port: AgentModelsPort): void {
  modelsPorts.set(io, port);
}

export function agentModelsPort(io: SocketServer): AgentModelsPort | null {
  return modelsPorts.get(io) ?? null;
}
export { AgentRunner, toRunnerEvent, toolKindOf, mintSessionRef } from './runner.js';
export type { HermesApiCall } from './hermes-tools.js';
export type { HermesCli } from './hermes-plugins.js';
export { HermesRuntime, loadOrCreateHermesApiKey } from './hermes-runtime.js';
export {
  HERMES_COMPRESSION_DEFAULTS,
  HermesCompressionError,
  readHermesCompression,
  writeHermesCompression,
  type HermesCompression,
} from './hermes-compression.js';
export { profileHome } from './profile-home.js';
export {
  SHARED_AT_ROOT,
  createDefaultProfileReplacement,
  swapDefaultProfile,
  type DefaultProfileReplacement,
  type DefaultReplaceRequest,
  type DefaultSwapReport,
  type SwapFs,
} from './hermes-default-swap.js';
// The models module asks a signed-in provider's own model list from Hermes's Python (§83).
export { hermesPythonRunner } from './hermes-pending-writes.js';
export {
  HermesProfileError,
  PROFILE_ARCHIVE_TIMEOUT_MS,
  createHermesProfileArchives,
  createHermesProfiles,
  hermesProfileRunner,
  namedHermesProfiles,
  type HermesProfileArchives,
  type HermesProfiles,
} from './hermes-profiles.js';
export type {
  HermesRuntimeMode,
  HermesRuntimeStatus,
  SpawnedProcess,
  Spawner,
} from './hermes-runtime.js';
export {
  HermesDashboard,
  HermesDashboardRefusal,
  HermesDashboardUnavailable,
  type DashboardSpawner,
  type HermesDashboardStatus,
} from './hermes-dashboard.js';

/** Test seams: a fake PATH, a fake adapter set, a fake installer. Set before the app boots. */
export interface AgentsOverrides {
  adapters?: AdapterSet;
  /** Hermes's own updater for `agents.upgrade` (a scripted one in tests). */
  hermesUpdate?: HermesUpdater;
  installer?: AgentInstaller;
  /** How long each installed agent's health check may take at boot (a short one in tests). */
  bootHealthTimeoutMs?: number;
  pathValue?: string;
  /** Options for the real adapter set (a stubbed `fetch` for the Hermes gateway probe). */
  adapterOptions?: Omit<AdapterSetOptions, 'host'>;
  /** The Hermes runtime supervisor's seams (a fake spawner, a health interval). */
  runtime?: {
    spawnImpl?: Spawner;
    healthIntervalMs?: number;
    gatewayBackoffMs?: number[];
    gatewayRescanMs?: number;
    channelSettleMs?: number;
  };
  /** Hermes's dashboard API's seams (a fake spawner and `fetch`, a short idle). */
  dashboard?: { spawnImpl?: DashboardSpawner; fetchImpl?: typeof fetch; idleMs?: number };
  /**
   * Hermes's API as the agent tools call it (MCP test, WhatsApp pairing), in place of the
   * dashboard — for a hub that does not supervise a real Hermes (the tests, the e2e hub).
   */
  hermesApi?: HermesApiCall;
  /**
   * Hermes's own command as the plugin pages run it (`hermes plugins …` against a profile's
   * home), in place of the real `hermes` — for the tests and the e2e hub.
   */
  hermesCli?: HermesCli;
  /**
   * Hermes's own `hermes mcp login` as MCP OAuth runs it (DECISIONS §122), in place of the real
   * command — for the tests and the e2e hub.
   */
  mcpLogin?: McpLoginSpawner;
  /**
   * Hermes's interpreter as approving a pending memory or skill write runs it, in place of the
   * real one — for the tests and the e2e hub.
   */
  hermesPython?: HermesPython;
  /** Between two questions to Hermes while a pairing runs. Default 1 s. */
  pairingPollMs?: number;
  /** Telegram's Bot API as linking asks it (`getMe`), scripted — for the tests and the e2e hub. */
  telegramFetch?: typeof fetch;
  /**
   * How linking asks the other platforms who an account is (`channel-validate.ts`), scripted —
   * for the tests and the e2e hub.
   */
  channelProbe?: ProbeOptions;
  /**
   * The update policy's seams (`update-policy.ts`): a scripted registry, and the periodic
   * check's timing — `intervalMs: null` keeps the timer from being armed at all.
   */
  updates?: {
    registry?: PackageRegistry;
    intervalMs?: number | null;
    idleRetryMs?: number;
    firstCheckMs?: number;
  };
  /** The home coding agents read their config files from (`config-files.ts`), for the tests. */
  agentHome?: string;
  /** How an agent's own sign-in command is started (`agent-sign-in.ts`), scripted in tests. */
  signIn?: { spawnImpl?: SpawnSignIn; promptTimeoutMs?: number };
}

/** Platforms linked by pasting a bot token (`agents.linkChannel`). */
const TOKEN_PLATFORMS = ['telegram'] as const;

/**
 * The profile other than `home`'s that already holds `token`, if any. Telegram lets one process
 * poll a bot, and Hermes refuses a second holder in its own words at start; saying which profile
 * has it, before anything is written, is the kinder answer.
 */
function telegramTokenOwner(root: string, home: string, token: string): string | null {
  const homes: Array<[string, string]> = [
    ['default', root],
    ...namedHermesProfiles(root).map((name): [string, string] => [
      name,
      path.join(root, 'profiles', name),
    ]),
  ];
  for (const [name, other] of homes) {
    if (path.resolve(other) === path.resolve(home)) continue;
    if (telegramToken(other) === token) return name;
  }
  return null;
}

/**
 * The profile other than `home`'s that already holds this account of `spec`, for the platforms
 * Hermes lets one process hold (Discord, Slack, …): Hermes refuses a second holder at start, in
 * its own words; saying which profile has it before anything is written is the kinder answer.
 */
function accountOwner(
  root: string,
  home: string,
  spec: PlatformSpec,
  value: string,
): string | null {
  const homes: Array<[string, string]> = [
    ['default', root],
    ...namedHermesProfiles(root).map((name): [string, string] => [
      name,
      path.join(root, 'profiles', name),
    ]),
  ];
  for (const [name, other] of homes) {
    if (path.resolve(other) === path.resolve(home)) continue;
    if (identityValue(spec, readEnv(other)) === value) return name;
  }
  return null;
}

/** A channel's own options: Telegram's (#97), then each full platform's (`channel-platforms.ts`). */
function settingsOf(platform: string): readonly OptionSpec[] | null {
  if (platform === 'telegram') return TELEGRAM_OPTIONS;
  return platformSpec(platform)?.settings ?? null;
}

let pendingOverrides: AgentsOverrides | null = null;
const overrides = new WeakMap<SocketServer, AgentsOverrides>();

/**
 * Used by the test helpers: the next app to build takes these. Keyed to the app's own
 * Socket.IO server as soon as it exists, so two hubs in one process never share fakes.
 */
export function overrideAgents(next: AgentsOverrides | null): void {
  pendingOverrides = next;
}

/** What the gateway serving a profile says about one of its channels (`channelStatus`). */
interface ChannelHealth {
  status: string;
  error: string | null;
  /** Switched on and linked, but the running gateway started before it (`restart_needed`). */
  restartNeeded: boolean;
}

interface AgentsContext {
  service: AgentsService;
  adapters: AdapterSet;
  runner: AgentRunner;
  /** Who each live run acts for, for the hub's own tools (contract decision §67). */
  leases: RunLeases;
  /** The hub's own tools: settings, the profile block, the MCP endpoint (§67). */
  hubTools: HubToolsService;
  /** The six-hourly registry check and the idle-only auto-update. */
  updates: AgentUpdateChecker;
  /** Whether `updates` should arm its timer when the hub is ready. */
  updatesArmed: boolean;
  runtime: HermesRuntime;
  dashboard: HermesDashboard;
  /** Hermes's API for the agent tools, or `null` where the hub does not supervise Hermes. */
  hermesApi(): HermesApiCall | null;
  /** Hermes's own command, or `null` where the hub does not supervise Hermes. */
  hermesCli(): HermesCli | null;
  /** Hermes's `mcp login`, or `null` where the hub does not run Hermes (DECISIONS §122). */
  mcpLogin(): McpLoginSpawner | null;
  /** The last test of each MCP server, per profile home (DECISIONS §134). */
  mcpTests: McpTestStore;
  /** Hermes's own Python, or `null` where the hub does not supervise Hermes. */
  hermesPython(): HermesPython | null;
  pairingPollMs: number;
  /** How linking asks Telegram who a bot is. */
  telegramFetch: typeof fetch;
  /** How linking asks the other platforms who an account is. */
  channelProbe: ProbeOptions;
  /** The coding agents' own config files, one set for the hub (decision §78). */
  configFiles: ConfigFileStore;
  /** The coding agents' own MCP servers, one set for the hub like their config files. */
  codingMcp: CodingAgentMcpStore;
  /** Agents signing in to their own vendor account (catalog `signIn`). */
  signIns: AgentSignIns;
  /** The environment a coding agent's process inherits, before its own variables. */
  agentInherited: NodeJS.ProcessEnv;
}

/**
 * The uploaded files a skill import reads, lent by `knowledge` (which owns the bytes) through
 * the composition root. Without it there is nothing to import from.
 */
export interface AgentAttachmentsPort {
  materialise(
    workspace: string,
    ids: readonly string[],
    directory: string,
  ): Array<{ id: string; name: string; path: string; mime: string; sizeBytes: number }>;
}

let attachmentsFactory: ((app: FastifyInstance) => AgentAttachmentsPort) | null = null;

/** Called once from `src/modules/index.ts`; `knowledge` provides the implementation. */
export function registerAgentAttachments(
  factory: (app: FastifyInstance) => AgentAttachmentsPort,
): void {
  attachmentsFactory = factory;
}

/**
 * Earlier hubs wrote `MEMORY.md` / `USER.md` at a profile's root, where Hermes never reads.
 * At boot every profile's are moved once into `memories/` (`memory.ts` §migrateLegacyMemory),
 * so the words reach the agent's next conversation without anyone opening the Memory page.
 * Best effort: a profile that cannot be moved is logged and tried again on its next memory read.
 */
export function migrateMemoryOfEveryProfile(
  root: string | null | undefined,
  log: Pick<FastifyInstance['log'], 'info' | 'warn'>,
): void {
  if (!root) return;
  const homes = [
    { profile: 'default', home: root },
    ...namedHermesProfiles(root).map((name) => ({
      profile: name,
      home: path.join(root, 'profiles', name),
    })),
  ];
  for (const { profile, home } of homes) {
    try {
      const moved = migrateLegacyMemory(home);
      if (moved.length > 0) {
        log.info({ profile, moved }, 'agents: memory moved to where Hermes reads it');
      }
    } catch (error) {
      log.warn({ profile, err: error }, 'agents: could not move memory to where Hermes reads it');
    }
  }
}

let hubToolsNotifyFactory: ((app: FastifyInstance) => HubToolsNotify) | null = null;
let hubToolsHandOverFactory: ((app: FastifyInstance) => HubToolsHandOver | null) | null = null;

/**
 * `devices.fetch_file` puts what a device sent on the run's reply (§89); `sessions` owns the
 * reply, so the composition root lends it here.
 */
export function registerHubToolsHandOver(
  factory: (app: FastifyInstance) => HubToolsHandOver | null,
): void {
  hubToolsHandOverFactory = factory;
}

/**
 * `notifications.notify`, the one hub tool with no REST operation to go through: a notice
 * in the run owner's inbox. `notify` owns notices; the composition root lends the writer.
 */
export function registerHubToolsNotify(factory: (app: FastifyInstance) => HubToolsNotify): void {
  hubToolsNotifyFactory = factory;
}

/**
 * Where Hermes reaches the hub's MCP server (contract decision §67): this process, on the
 * loopback — Hermes runs beside the hub (ADR 0008). The port the server listens on once it
 * does, the configured one before.
 */
function hubMcpUrl(app: FastifyInstance): string | null {
  const address = app.server.address();
  const port = address && typeof address === 'object' ? address.port : app.hub.config.port;
  if (!port) return null;
  return `http://127.0.0.1:${port}/api/v1/hub-mcp`;
}

/**
 * Core Hub's skill library into every profile Hermes has (`skill-library.ts`, decision §71): at
 * boot, so an upgraded image updates the skills it wrote and a profile made outside the hub gets
 * them too. A profile switched off, and every skill the person edited, are left as they are.
 * Called only when the hub runs Hermes itself (`managed`).
 */
export function seedSkillLibraryOfEveryProfile(
  root: string | null | undefined,
  log: Pick<FastifyInstance['log'], 'info' | 'warn'>,
): void {
  if (!root) return;
  seedLibraryOfEveryProfile(
    [
      { profile: 'default', home: root },
      ...namedHermesProfiles(root).map((name) => ({
        profile: name,
        home: path.join(root, 'profiles', name),
      })),
    ],
    log,
  );
}

/** The library into one profile just made (a copy carries its source's manifest and choice). */
export function seedSkillLibraryOf(
  home: string,
  log: Pick<FastifyInstance['log'], 'info' | 'warn'>,
): void {
  try {
    seedLibrary(home);
  } catch (error) {
    log.warn({ home, err: error }, 'agents: could not seed the Core Hub skill library');
  }
}

/** The library in one profile's home, as the contract's `SkillLibrary`. */
function toLibrary(status: LibraryStatus): Record<string, unknown> {
  const states = [...status.skills.values()];
  return {
    enabled: status.enabled,
    available: status.available,
    installed: states.length,
    edited: states.filter((state) => state === 'edited').length,
  };
}

/**
 * How long the hub, getting ready, waits for the agents to be checked against the volume before
 * it serves anyway and lets the check finish in the background.
 */
export const RECONCILE_BOOT_WAIT_MS = 1_000;

const contexts = new WeakMap<SocketServer, AgentsContext>();

function contextOf(app: FastifyInstance): AgentsContext {
  const { hub } = app;
  const existing = contexts.get(hub.io);
  if (existing) return existing;
  if (pendingOverrides) {
    overrides.set(hub.io, pendingOverrides);
    pendingOverrides = null;
  }
  const own = overrides.get(hub.io) ?? {};
  // Coding agents live in the data volume, one directory each (ADR 0006); the adapters
  // must see those binaries exactly like a CLI the person installed themselves.
  const host = {
    pathValue: [...managedBinDirs(hub.config.dataDir), own.pathValue ?? hub.config.hostEnv.path]
      .filter(Boolean)
      .join(':'),
    pathExt: hub.config.hostEnv.pathExt,
    inherited: hub.config.hostEnv.inherited,
  };
  // The supervised Hermes (ADR 0008). Its API key is what the adapter sends; an external
  // gateway is expected to carry the same key file (docs/DEPLOY.md).
  const hermesFetch = own.adapterOptions?.hermes?.fetchImpl;
  const runtime = new HermesRuntime({
    dataDir: hub.config.dataDir,
    host,
    log: app.log,
    endpoint: own.adapterOptions?.hermes?.defaultEndpoint ?? HERMES_ENTRY.defaultEndpoint!,
    ...(hermesFetch ? { fetchImpl: hermesFetch } : {}),
    ...(own.runtime?.spawnImpl ? { spawnImpl: own.runtime.spawnImpl } : {}),
    ...(own.runtime?.healthIntervalMs !== undefined
      ? { healthIntervalMs: own.runtime.healthIntervalMs }
      : {}),
    ...(own.runtime?.gatewayBackoffMs ? { gatewayBackoffMs: own.runtime.gatewayBackoffMs } : {}),
    ...(own.runtime?.gatewayRescanMs !== undefined
      ? { gatewayRescanMs: own.runtime.gatewayRescanMs }
      : {}),
    ...(own.runtime?.channelSettleMs !== undefined
      ? { channelSettleMs: own.runtime.channelSettleMs }
      : {}),
    // Every messaging gateway starts on the providers and model a chat in its profile uses
    // (`models` writes them, looked up per start because it mounts after this module).
    // Hermes's own log from the TUI gateway, into the Logs screen's ring only (never the
    // hub's log volume, `adapters/hermes-tui.ts`).
    tuiLogLine: (line: string) => {
      hub.logs.push({
        source: 'hermes',
        profile: 'tui',
        level: levelOfHermesLine(line, 'info'),
        message: line,
      });
    },
    prepareGateway: (profile: string, home: string) => {
      modelsPorts.get(hub.io)?.prepareGatewayProfile?.(profile, home);
    },
    onState: (status: HermesRuntimeStatus) => {
      const ctx = contexts.get(hub.io);
      if (!ctx) return;
      try {
        ctx.service.setRuntime(HERMES_ENTRY.id, {
          state: status.state,
          url: status.state === 'running' ? status.endpoint : null,
          error: status.lastError,
        });
      } catch {
        // The hub closing stops Hermes after its database is gone; there is no row to update.
        return;
      }
      if (status.state === 'running') {
        void ctx.service.reprobe(HERMES_ENTRY.id).catch((error: unknown) => {
          app.log.warn({ err: error }, 'agents: hermes reprobe failed');
        });
      }
    },
  });
  const adapters =
    own.adapters ??
    createAdapterSet({
      ...own.adapterOptions,
      hermes: {
        apiKey: () => runtime.apiKey(),
        tui: () => runtime.tuiChannel(),
        gatewayNote: () => gatewayNote(runtime.status()),
        // Made if it is missing, then given the hub's providers before its turn: a profile
        // made later — here, in Hermes, or on first use — runs on them like any other.
        ensureProfile: async (name: string) => {
          await runtime.ensureProfile(name);
          const home = runtime.status().home;
          if (home && name !== 'default') {
            modelsPorts.get(hub.io)?.prepareRuntimeProfile?.(path.join(home, 'profiles', name));
          }
        },
        ...own.adapterOptions?.hermes,
      },
      // A coding agent over ACP gets the hub's own tools in its session, when the profile
      // offers them and the agent can reach an HTTP server (contract decision §67).
      acp: {
        mcpServers: (target: AgentTarget) =>
          target.workspace
            ? (contexts.get(hub.io)?.hubTools.acpServersFor(target.workspace) ?? [])
            : [],
        ...own.adapterOptions?.acp,
      },
      // The hub's own agent reaches the providers through the same port every other
      // agent's credentials come from, looked up per turn because `models` registers it
      // after this module mounts (ADR 0010; ADOPTION-BACKLOG §2.15).
      direct: {
        models: () => modelsPorts.get(hub.io) ?? null,
        ...own.adapterOptions?.direct,
      },
      host,
    });
  // Asked, never installed from: `update-policy.ts`.
  const registry = own.updates?.registry ?? createPackageRegistry();
  const service = new AgentsService({
    db: requireSqlite(hub.database),
    avatars: new AgentAvatars(path.join(hub.config.dataDir, 'avatars', 'agents')),
    log: app.log,
    realtime: createRealtime(hub.io),
    audit: auditFor(app),
    jobs: jobRunnerFor(app),
    adapters,
    installer: own.installer ?? createNpmInstaller({ dataDir: hub.config.dataDir, host }),
    ...(own.bootHealthTimeoutMs !== undefined
      ? { bootHealthTimeoutMs: own.bootHealthTimeoutMs }
      : {}),
    // The same home and environment as the Config files page (`config-files.ts`).
    credentialProbe: {
      env: hub.config.hostEnv.inherited ?? {},
      ...(own.agentHome ? { home: own.agentHome } : {}),
    },
    models: () => modelsPorts.get(hub.io) ?? null,
    // Files the hub writes for agents on the gateway (Gemini CLI's own home, §141).
    gatewayStateDir: path.join(hub.config.dataDir, 'gateway', 'agents'),
    // A workspace is a Hermes profile (ADR 0014): its slug, or `default` for the hub's
    // default workspace whatever it is called. An archived or unknown one has none.
    profileOf: (workspaceId: string) => {
      const row = findWorkspace(requireSqlite(hub.database), workspaceId);
      if (!row || row.id !== workspaceId) return null;
      return hermesProfileName(row);
    },
    // Hermes's card shows every messaging gateway the hub runs (the default one and each
    // named profile's).
    gateways: () => runtime.gateways().map(toMessagingGateway),
    registry,
    // An auto-update is filed under, and announced in, the hub's default workspace.
    systemScope: () => {
      const row = defaultWorkspace(requireSqlite(hub.database));
      return row ? { id: row.id, slug: row.slug, name: row.name, isDefault: row.isDefault } : null;
    },
    // A Hermes the person installed on this computer is updated by its own updater when they
    // ask from its card; the image's Hermes comes with the image (`personalInstall`).
    hermesUpdate: own.hermesUpdate ?? {
      available: () => runtime.personalInstall(),
      run: (onLine) => runtime.selfUpdate(onLine),
      restart: async () => {
        if (runtime.status().mode === 'managed') await runtime.restart();
        runtime.refreshTui();
      },
    },
  });
  const leases = new RunLeases();
  const runner = new AgentRunner({ service, adapters, log: app.log, leases });
  // An agent installed again or updated: its open sessions run the old CLI.
  service.onSettled((agentId) => runner.retireSessionsOf(agentId));
  const updates = new AgentUpdateChecker({
    store: service,
    activity: runner,
    registry,
    log: app.log,
    ...(typeof own.updates?.intervalMs === 'number' ? { intervalMs: own.updates.intervalMs } : {}),
    ...(own.updates?.idleRetryMs !== undefined ? { idleRetryMs: own.updates.idleRetryMs } : {}),
    ...(own.updates?.firstCheckMs !== undefined ? { firstCheckMs: own.updates.firstCheckMs } : {}),
  });
  // Hermes's own web server as an internal API (ADR 0015): nothing runs until a caller
  // asks, and only where `runtime` is managed (`hermesDashboardFor`).
  const dashboard = new HermesDashboard({
    host: runtime,
    dataDir: hub.config.dataDir,
    log: app.log,
    ...(own.dashboard?.spawnImpl ? { spawnImpl: own.dashboard.spawnImpl } : {}),
    ...(own.dashboard?.fetchImpl ? { fetchImpl: own.dashboard.fetchImpl } : {}),
    ...(own.dashboard?.idleMs !== undefined ? { idleMs: own.dashboard.idleMs } : {}),
  });
  const hubTools = new HubToolsService({
    app,
    db: requireSqlite(hub.database),
    leases,
    dataDir: hub.config.dataDir,
    version: hub.version,
    hermesAgentId: (workspaceId) =>
      service
        .list({ id: workspaceId, slug: '', name: '', isDefault: false }, { kind: 'hermes' })
        .find((agent) => agent.slug === 'hermes')?.id ?? null,
    notify: () => hubToolsNotifyFactory?.(app) ?? null,
    handOver: () => hubToolsHandOverFactory?.(app) ?? null,
    timezone: () => runtime.timezone(),
    refreshRuntime: () => runtime.refreshTui(),
    homeOf: (workspace) => {
      const root = runtime.status().home;
      if (!root) return { home: null, reason: 'runtime_absent' };
      const home = profileHome(root, workspace);
      return home ? { home, reason: null } : { home: null, reason: 'hermes_profile_absent' };
    },
    url: () => hubMcpUrl(app),
    // Hermes's messaging gateway reads its hooks when it starts (decision §79): the one that
    // serves the profile starts again — a named profile's at once, the default one held down
    // and started again (it also carries the API server).
    gatewayChanged: (workspace) => {
      const profile = hermesProfileName(workspace);
      const restart =
        profile === 'default'
          ? runtime.withGatewayStopped('default', () => undefined)
          : runtime.channelsChanged(profile);
      restart.catch((error: unknown) =>
        app.log.warn({ err: error, profile }, 'agents: could not restart the profile gateway'),
      );
    },
  });
  const created: AgentsContext = {
    service,
    adapters,
    runner,
    leases,
    hubTools,
    updates,
    updatesArmed: own.updates?.intervalMs !== null,
    runtime,
    dashboard,
    hermesApi: () =>
      own.hermesApi ??
      (dashboard.available()
        ? (method, route, body, options) => dashboard.request(method, route, body, options)
        : null),
    hermesCli: () => {
      if (own.hermesCli) return own.hermesCli;
      // The same rule as Hermes's API: only a Hermes this hub runs, on this host.
      const { mode, home } = runtime.status();
      const command = runtime.executable();
      if (mode !== 'managed' || !home || !command) return null;
      return hermesCliRunner({ command, env: () => runtime.cliEnv() });
    },
    mcpLogin: () => {
      if (own.mcpLogin) return own.mcpLogin;
      const { mode, home } = runtime.status();
      const command = runtime.executable();
      if (mode !== 'managed' || !home || !command) return null;
      return mcpLoginSpawner({ command, env: () => runtime.cliEnv() });
    },
    mcpTests: new McpTestStore(hub.config.dataDir),
    hermesPython: () => {
      if (own.hermesPython) return own.hermesPython;
      const { mode, home } = runtime.status();
      if (mode !== 'managed' || !home) return null;
      // Hermes's own interpreter and packages, however it was installed (`hermes-python.ts`).
      const python = runtime.pythonCommand();
      if (!python) return null;
      return hermesPythonRunner({ python, env: () => runtime.cliEnv() });
    },
    pairingPollMs: own.pairingPollMs ?? 1000,
    telegramFetch: own.telegramFetch ?? fetch,
    channelProbe: own.channelProbe ?? {},
    configFiles: new ConfigFileStore({
      env: hub.config.hostEnv.inherited ?? {},
      ...(own.agentHome ? { home: own.agentHome } : {}),
      dataDir: hub.config.dataDir,
    }),
    codingMcp: new CodingAgentMcpStore({
      env: hub.config.hostEnv.inherited ?? {},
      ...(own.agentHome ? { home: own.agentHome } : {}),
      dataDir: hub.config.dataDir,
    }),
    signIns: new AgentSignIns({
      ...(own.signIn?.spawnImpl ? { spawnImpl: own.signIn.spawnImpl } : {}),
      ...(own.signIn?.promptTimeoutMs !== undefined
        ? { promptTimeoutMs: own.signIn.promptTimeoutMs }
        : {}),
    }),
    agentInherited: host.inherited ?? {},
  };
  // The home coding agents read their files from exists before anything is spawned: the
  // image's `/data/home` is made on the first boot of a volume that predates it.
  try {
    created.configFiles.ensureHome();
  } catch (error) {
    app.log.warn({ err: error }, 'agents: could not make the home coding agents read from');
  }
  contexts.set(hub.io, created);
  return created;
}

export function agentsServiceFor(app: FastifyInstance): AgentsService {
  return contextOf(app).service;
}

/**
 * The enabled skills of the hub's Hermes in one profile, by name — what the Skills usage
 * report compares with the skills actually loaded (contract decision §50). `null` when the
 * hub cannot see them: no Hermes home, or a profile Hermes does not have.
 */
export function installedSkillNames(
  app: FastifyInstance,
  profile: { slug: string; isDefault: boolean },
): string[] | null {
  const root = contextOf(app).runtime.status().home;
  if (!root) return null;
  const home = profileHome(root, profile);
  if (!home) return null;
  return listSkills(home)
    .filter((skill) => skill.enabled && !skill.broken)
    .map((skill) => skill.name);
}

/** The Hermes runtime this hub supervises or found (ADR 0008). */
/**
 * The secrets in the Hermes profiles' own files the hub knows are secret — channel variables,
 * MCP credentials, incoming webhook secrets — by name, each able to read its value again; for
 * the owner's step-up-guarded Settings → Secrets alone (DECISIONS §125). None without a Hermes
 * home this hub can read.
 */
export function hermesSecretsFor(app: FastifyInstance, defaultSlug: string): HermesSecret[] {
  const root = hermesRuntimeFor(app).status().home;
  return root ? hermesSecrets(root, defaultSlug) : [];
}
export type { HermesSecret, HermesSecretKind } from './secret-files.js';

export function hermesRuntimeFor(app: FastifyInstance): HermesRuntime {
  return contextOf(app).runtime;
}

/**
 * Hermes's dashboard API (ADR 0015) — Hermes's own web server, started on the first call
 * and stopped when idle — or `null` where this hub does not supervise Hermes. For the
 * composition root: a module that needs it is handed a port built from this.
 */
export function hermesDashboardFor(app: FastifyInstance): HermesDashboard | null {
  const { dashboard } = contextOf(app);
  return dashboard.available() ? dashboard : null;
}

/**
 * Every Hermes process this hub runs, for the Performance screen (through the composition
 * root): the TUI gateway, `hermes serve` (started on demand, so often `stopped`) and every
 * profile's messaging gateway. Empty where the hub does not supervise Hermes.
 */
export function hermesProcessesFor(app: FastifyInstance): Array<{
  kind: 'tui_gateway' | 'dashboard' | 'gateway';
  profile: string | null;
  pid: number | null;
  state: string;
}> {
  const { runtime, dashboard } = contextOf(app);
  const processes: ReturnType<typeof hermesProcessesFor> = runtime.processes();
  if (dashboard.available()) {
    const status = dashboard.status();
    processes.push({
      kind: 'dashboard',
      profile: null,
      pid: status.pid,
      state: status.running ? 'running' : 'stopped',
    });
  }
  return processes;
}

/** The hub's own tools of this app (contract decision §67). */
export function hubToolsFor(app: FastifyInstance): HubToolsService {
  return contextOf(app).hubTools;
}

/**
 * Replacing Hermes's default profile with an archive (contract decision §116), where this hub
 * runs Hermes itself — `null` anywhere else. While it works, the root gateway and the TUI gateway
 * are held down and Hermes's dashboard server is stopped (it reads the root's files too); once
 * the hub's rows are in, the hub's tools go back into the new root (when on there) and leave the
 * backup (their key is the default's), and the skill library is seeded in both. Afterwards the
 * profile gateways are checked again: the backup brought the old default's channels and jobs.
 */
export function hermesDefaultReplacementFor(
  app: FastifyInstance,
  fs?: SwapFs,
): DefaultProfileReplacement | null {
  const ctx = contextOf(app);
  const { mode, home } = ctx.runtime.status();
  if (mode !== 'managed' || !home) return null;
  return createDefaultProfileReplacement({
    home,
    hold: (work) =>
      ctx.runtime.withRootHeld(async () => {
        await ctx.dashboard.stop('the default profile is being replaced');
        return work();
      }),
    prepare: (report) => {
      removeBlock(report.backup);
      removeHook(report.backup);
      ctx.hubTools.syncAll();
      seedSkillLibraryOf(home, app.log);
      seedSkillLibraryOf(report.backup, app.log);
    },
    after: () => ctx.runtime.scheduledJobsChanged(),
    ...(fs ? { fs } : {}),
    log: app.log,
  });
}

/** Who each live run acts for — the hub's own tools read it; a test opens one by hand. */
export function runLeasesFor(app: FastifyInstance): RunLeases {
  return contextOf(app).leases;
}

/** The live turns, for anything that must not interrupt one (`models` recycles Hermes). */
export function agentRunnerFor(app: FastifyInstance): AgentRunner {
  return contextOf(app).runner;
}

/** The registry check and idle-only auto-update (`update-policy.ts`), for the tests. */
export function agentUpdatesFor(app: FastifyInstance): AgentUpdateChecker {
  return contextOf(app).updates;
}

const scopeOf = (request: FastifyRequest): WorkspaceScope => {
  const workspace = request.workspace;
  if (!workspace) throw new HubError('internal', { message: 'route has no workspace' });
  // Jobs store the workspace id and report its slug; registering the pair here is what
  // lets a `/rt/jobs` event name the profile it belongs to.
  auditFor(request.server).rememberWorkspace(workspace.id, workspace.slug);
  return workspace;
};

const actorOf = (request: FastifyRequest): { userId: string } => {
  const principal = request.principal;
  if (!principal) throw new HubError('internal', { message: 'route has no principal' });
  return { userId: principal.user.id };
};

/**
 * The contract's `Skill`.
 *
 * `use_count` is **0 and says nothing**, because nothing records skill use yet — the same
 * reason `audit.getReport` refuses the Skills report rather than answering zeros that
 * would read as a measurement. Here the field is required by the contract, so it is 0 and
 * this comment is the footnote.
 *
 * `source` is read from the files: a skill Hermes seeded from its bundle is `builtin` (and
 * read-only here), one that names the pack it came from is `external`, and one that names
 * none was written by a person, which is `user`.
 */
function toSkill(
  skill: Skill,
  pinned: readonly string[],
  library?: LibraryStatus,
): Record<string, unknown> {
  // One of Core Hub's own (§71): in the library's category folder and recorded by its manifest.
  const state =
    skill.category === LIBRARY_CATEGORY && !skill.bundled
      ? (library?.skills.get(skill.key) ?? null)
      : null;
  return {
    key: skill.key,
    name: skill.name,
    description: skill.broken ? `[${skill.broken}]` : skill.description,
    enabled: skill.enabled,
    pinned: pinned.includes(skill.key),
    source: skill.bundled ? 'builtin' : state ? 'library' : skill.pack ? 'external' : 'user',
    use_count: 0,
    updated_at: skill.updatedAt.toISOString(),
    content: skill.content,
    library: state,
  };
}

/**
 * Group the folder into the contract's categories.
 *
 * A skill in a category folder (`skills/<category>/<name>/`, Hermes's layout for its own
 * skills) lists under that category, described by its `DESCRIPTION.md`. A skill directly under
 * `skills/` has no folder to say, so the grouping is the one its file carries: the pack it came
 * from. Everything hand-written lands in one category of its own, and pinned skills come first
 * inside each — an order a person chose beats one the filesystem chose.
 */
function categorise(
  home: string,
  skills: readonly Skill[],
  pinned: readonly string[],
  library?: LibraryStatus,
): Array<Record<string, unknown>> {
  const groups = new Map<string, Skill[]>();
  const folders = new Set<string>();
  for (const skill of skills) {
    if (skill.category) folders.add(skill.category);
    const key = skill.category ?? skill.pack ?? 'user';
    const list = groups.get(key);
    if (list) list.push(skill);
    else groups.set(key, [skill]);
  }
  return (
    [...groups.entries()]
      // The person's own skills first; packs after, in name order.
      .sort(([a], [b]) => (a === 'user' ? -1 : b === 'user' ? 1 : a.localeCompare(b)))
      .map(([key, list]) => ({
        key,
        name: key,
        description: folders.has(key) ? categoryDescription(home, key) : null,
        skills: list
          .sort((a, b) => Number(pinned.includes(b.key)) - Number(pinned.includes(a.key)))
          .map((skill) => toSkill(skill, pinned, library)),
      }))
  );
}

export const agentsModule = defineModule({
  name: 'agents',
  async registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };
    const service = agentsServiceFor(app);

    // `Profile.agent_count` comes from the registry, not from a number auth invents.
    const unregisterStats = registerWorkspaceStatsProvider((workspaceId) => ({
      agentCount: service.countEnabled(workspaceId),
    }));
    // Taken back on close, or every hub a process ever built (the test suite builds hundreds)
    // stays reachable through this one closure, routes and schemas and all.
    app.addHook('onClose', async () => unregisterStats());

    // First boot seeds the catalog; every boot reconciles it against the data volume.
    // Rows the hub creates for itself are attributed to the owner account (domain README).
    // Mounting only writes the catalog's rows: checking each agent runs its CLI, which may be
    // slow on a busy host, so it happens once the hub is ready (below), never while it mounts.
    const owner = ownerUser(requireSqlite(app.hub.database));
    const seeded = service.seed(owner?.id ?? 'system');

    // The Hermes runtime: decided once the server is ready to serve, stopped with it.
    const ctx = contextOf(app);
    app.addHook('onReady', async () => {
      const began = performance.now();
      const reconciled = service.reconcileInstalls().then(
        (report) => {
          app.log.info(
            {
              installed: report.installed.length,
              missing: report.missing.length,
              interrupted: seeded.interrupted.length,
              ms: Math.round(performance.now() - began),
            },
            'agents: registry reconciled with the data volume',
          );
        },
        (error: unknown) => {
          app.log.warn({ err: error }, 'agents: could not reconcile the registry');
        },
      );
      // A quick check is waited for, so the first request reads a checked registry; a slow
      // one goes on while the hub serves (the rows keep what the last boot learned meanwhile).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        reconciled.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), RECONCILE_BOOT_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!waited) {
        app.log.warn(
          { waited_ms: RECONCILE_BOOT_WAIT_MS },
          'agents: checking the installed agents goes on in the background',
        );
      }
      const mode = await ctx.runtime.start();
      app.log.info({ mode, endpoint: ctx.runtime.endpoint }, 'agents: hermes runtime');
      migrateMemoryOfEveryProfile(ctx.runtime.status().home, app.log);
      // The hub's own tools go back into every profile that has them on (§67).
      ctx.hubTools.syncAll();
      if (ctx.updatesArmed) ctx.updates.start();
      // Only into a Hermes this hub runs itself: an external gateway's home is somebody else's,
      // and there the Skills page installs the library when asked (`agents.updateSkillLibrary`).
      if (mode === 'managed') seedSkillLibraryOfEveryProfile(ctx.runtime.status().home, app.log);
    });
    // Again once the port is known for certain (a hub on port 0 learns it only now).
    app.addHook('onListen', async () => {
      ctx.hubTools.syncAll();
    });
    app.addHook('onClose', async () => {
      ctx.updates.stop();
      ctx.signIns.close();
      await ctx.runner.closeAll();
      await ctx.dashboard.close();
      await ctx.runtime.stop();
    });

    defineRoute(app, deps, {
      operationId: 'agents.list',
      handler: (request, { query }) => ({
        items: service.list(scopeOf(request), {
          ...(query.kind ? { kind: query.kind as AdapterKind } : {}),
          // An agent whose name is a word, not a brand, reads in the caller's language
          // (`service.ts` §`displayName`).
          language: request.language,
        }),
      }),
    });

    defineRoute(app, deps, {
      operationId: 'agents.get',
      handler: (request, { params }) =>
        service.get(scopeOf(request), params.agent_id as string, request.language),
    });

    defineRoute(app, deps, {
      operationId: 'agents.update',
      handler: (request, { params, body }) =>
        service.update(scopeOf(request), params.agent_id as string, body as AgentPatchInput),
    });

    // Presets (contract decision §100): read and applied through the routes above and below,
    // as the caller (`presets.ts`).
    registerPresetRoutes(app, deps, {
      db: (request) => requireSqlite(request.server.hub.database),
      scope: scopeOf,
      actor: actorOf,
      requireAgent: (request, agentId) => {
        service.get(scopeOf(request), agentId, request.language);
      },
      base: serverBasePath(document),
    });

    /**
     * Skills. They are folders in the agent's own home (`skills.ts`), so the hub has to
     * know where that home is — which it only does for the runtime it supervises. An
     * external Hermes keeps its skills somewhere this process cannot see, and saying so
     * is better than listing an empty folder as if the agent had no skills.
     *
     * The home is **the selected profile's** (ADR 0014): Hermes's root home for the default
     * profile, `profiles/<slug>` for any other. A profile Hermes does not have is said to be
     * missing rather than shown the default profile's files as if they were its own.
     */
    const toolHome = (
      request: FastifyRequest,
      agentId: string,
      onlyHermes = 'skills_are_hermes_only',
    ): { home: string; profile: string } => {
      const context = contextOf(request.server);
      const scope = scopeOf(request);
      const row = context.service.get(scope, agentId, request.language);
      if (row.kind !== 'hermes') {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: onlyHermes },
        });
      }
      const root = context.runtime.status().home;
      if (!root) {
        // No Hermes at all: no folder to read, and no folder to invent.
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'runtime_absent' },
        });
      }
      const profile = hermesProfileName(scope);
      const home = profileHome(root, scope);
      if (!home) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'hermes_profile_absent', profile },
        });
      }
      return { home, profile };
    };
    const skillHome = (request: FastifyRequest, agentId: string): string =>
      toolHome(request, agentId).home;

    /**
     * Where an agent's skills are, for the Skills page (DECISIONS §139): Hermes's profile home, or
     * Claude Code's own folder (`$CLAUDE_CONFIG_DIR` or `~/.claude`), whose `skills/` holds the
     * same `SKILL.md` folders — one set for every profile, as its Config files and MCP pages are.
     * Any other agent is still `skills_are_hermes_only`.
     */
    const PLAIN_SKILLS: ReadonlySet<string> = new Set(['claude-code']);
    const skillPlace = (
      request: FastifyRequest,
      agentId: string,
    ): { home: string; options: SkillFolderOptions } => {
      const context = contextOf(request.server);
      const row = context.service.get(scopeOf(request), agentId, request.language);
      if (row.kind !== 'hermes' && PLAIN_SKILLS.has(row.slug)) {
        const home = context.configFiles.agentFolder(row.slug);
        if (home) return { home, options: { agent: 'plain' } };
      }
      return { home: toolHome(request, agentId).home, options: { agent: 'hermes' } };
    };

    /** The agent's name as the hub shows it to the person asking. */
    const agentNameOf = (request: FastifyRequest, agentId: string): string =>
      contextOf(request.server).service.get(scopeOf(request), agentId, request.language).name;

    /** Hermes's API for the tools that need Hermes to act, or the reason there is none. */
    const hermesApiOf = (request: FastifyRequest, agentId: string): HermesApiCall => {
      const api = contextOf(request.server).hermesApi();
      if (!api) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'hermes_not_supervised' },
        });
      }
      return api;
    };

    /**
     * Settings. Hermes's are its own keys in the selected profile's `config.yaml` and `.env`
     * (`hermes-settings.ts`, contract decision §58); any other agent's are the form its adapter
     * declares, stored by the hub.
     */
    const isHermes = (request: FastifyRequest, agentId: string): boolean =>
      contextOf(request.server).service.get(scopeOf(request), agentId, request.language).kind ===
      'hermes';

    const settingFault = (error: unknown): never => {
      if (error instanceof HermesSettingError) {
        if (error.reason === 'config_unreadable') {
          throw new HubError('state_invalid', { details: { reason: 'config_unreadable' } });
        }
        if (error.reason === 'section_unknown') {
          throw notFound({ resource: 'settings_section', id: error.key });
        }
        throw new HubError('validation_failed', {
          details: { field: `values.${error.key}`, reason: error.reason },
        });
      }
      throw error;
    };

    defineRoute(app, deps, {
      operationId: 'agents.getSettings',
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const scope = scopeOf(request);
        if (!isHermes(request, agentId)) return { sections: service.settings(scope, agentId) };
        const { home } = toolHome(request, agentId, 'settings_are_hermes_only');
        try {
          return { sections: readHermesSettings(home, scope.isDefault) };
        } catch (error) {
          return settingFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateSettings',
      handler: async (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const scope = scopeOf(request);
        const input = body as { section: string; values: Record<string, unknown> };
        if (!isHermes(request, agentId)) return service.updateSettings(scope, agentId, input);
        const { home, profile } = toolHome(request, agentId, 'settings_are_hermes_only');
        let section;
        try {
          section = writeHermesSettings(home, scope.isDefault, input.section, input.values ?? {});
        } catch (error) {
          return settingFault(error);
        }
        request.log.info(
          { profile, section: input.section, keys: Object.keys(input.values ?? {}) },
          'agents: hermes settings saved',
        );
        // The values reach Hermes: the hub's conversations from the next message (a fresh TUI
        // gateway), a named profile's messaging gateway restarted now. The default profile's
        // proxy needs the whole of Hermes restarted, which is a job the page can follow.
        const context = contextOf(request.server);
        await context.runtime.settingsChanged(profile).catch((error: unknown) => {
          request.log.warn({ err: error, profile }, 'agents: hermes did not take the settings');
        });
        let restartJobId: string | null = null;
        if (section.applies === 'restart' && scope.isDefault) {
          const managed = context.runtime.status().mode === 'managed';
          if (managed) {
            restartJobId = service.restart(scope, actorOf(request), agentId, {
              managed: () => true,
              restart: () => context.runtime.restart(),
            }).id;
          }
        }
        return { section, restart_job_id: restartJobId };
      },
    });

    /**
     * Memory and skill writes waiting for review (`hermes-pending-writes.ts`): Hermes's own
     * queue in the selected profile, approved by Hermes's own code.
     */
    const pendingFault = (error: unknown): never => {
      if (error instanceof PendingWriteError) {
        if (error.reason === 'pending_not_found') throw notFound({ resource: 'pending_write' });
        if (error.reason === 'pending_id_invalid') {
          throw new HubError('validation_failed', {
            details: { field: 'write_id', reason: error.reason },
          });
        }
        throw new HubError('state_invalid', {
          details: { reason: error.reason, message: error.hermesMessage },
        });
      }
      throw error;
    };
    const pendingKind = (raw: unknown): PendingKind => {
      if (raw === 'memory' || raw === 'skills') return raw;
      throw new HubError('validation_failed', {
        details: { field: 'write_kind', reason: 'kind_invalid' },
      });
    };

    defineRoute(app, deps, {
      operationId: 'agents.listPendingWrites',
      handler: (request, { params }) => {
        const { home } = toolHome(
          request,
          params.agent_id as string,
          'pending_writes_are_hermes_only',
        );
        return { items: listPendingWrites(home) };
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.approvePendingWrite',
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const { home, profile } = toolHome(request, agentId, 'pending_writes_are_hermes_only');
        const kind = pendingKind(params.write_kind);
        const id = params.write_id as string;
        const python = contextOf(request.server).hermesPython();
        try {
          if (!python) {
            // Checked after the record, so a write that is not there is still a 404.
            if (!pendingWriteExists(home, kind, id))
              throw new PendingWriteError('pending_not_found');
            throw new HubError('state_invalid', {
              details: { agent_id: agentId, reason: 'hermes_not_supervised' },
            });
          }
          await approvePendingWrite(python, home, kind, id);
        } catch (error) {
          return pendingFault(error);
        }
        request.log.info({ profile, kind, id }, 'agents: pending write approved');
        return { id, kind, applied: true };
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.rejectPendingWrite',
      status: 204,
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const { home, profile } = toolHome(request, agentId, 'pending_writes_are_hermes_only');
        const kind = pendingKind(params.write_kind);
        try {
          rejectPendingWrite(home, kind, params.write_id as string);
        } catch (error) {
          return pendingFault(error);
        }
        request.log.info({ profile, kind, id: params.write_id }, 'agents: pending write rejected');
        return null;
      },
    });

    /** Hermes's own command for the plugin pages, or the reason there is none. */
    const hermesCliOf = (request: FastifyRequest, agentId: string): HermesCli => {
      const cli = contextOf(request.server).hermesCli();
      if (!cli) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'hermes_not_supervised' },
        });
      }
      return cli;
    };

    const skillFault = (error: unknown): never => {
      if (error instanceof SkillError) {
        if (error.reason === 'skill_not_found') throw notFound({ resource: 'skill' });
        // Hermes's own skill: it keeps it in step with its bundle, so the hub leaves it be.
        if (error.reason === 'skill_bundled') {
          throw new HubError('conflict', { details: { reason: 'skill_bundled' } });
        }
        // Hermes's manual: Hermes never lets it be off, so neither does the hub (§103).
        if (error.reason === 'skill_essential') {
          throw new HubError('conflict', { details: { reason: 'skill_essential' } });
        }
        throw new HubError('bad_request', { details: { reason: error.reason } });
      }
      throw error;
    };

    defineRoute(app, deps, {
      operationId: 'agents.listSkills',
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const { home, options } = skillPlace(request, agentId);
        const pinned = contextOf(request.server).service.pinnedSkills(scopeOf(request), agentId);
        if (options.agent === 'plain') {
          // Core Hub's library is Hermes's (§71): another agent's folder lists without it.
          return {
            categories: categorise(home, listSkills(home, process.platform, options), pinned),
            home: skillsDir(home),
          };
        }
        const library = libraryStatus(home);
        return {
          categories: categorise(home, listSkills(home), pinned, library),
          library: toLibrary(library),
          // Which folder this is. A Hermes somebody else started with a different home
          // would otherwise read as "no skills", and a path on screen is the difference
          // between an empty agent and the wrong directory.
          home: skillsDir(home),
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.getSkill',
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const key = params.skill_key as string;
        const { home, options } = skillPlace(request, agentId);
        const skill = getSkill(home, key, options);
        if (!skill) throw notFound({ resource: 'skill', id: key });
        return toSkill(
          skill,
          contextOf(request.server).service.pinnedSkills(scopeOf(request), agentId),
          options.agent === 'plain' ? undefined : libraryStatus(home),
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.putSkill',
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const key = params.skill_key as string;
        const { home, options } = skillPlace(request, agentId);
        try {
          const written = putSkill(home, key, {
            content: String((body as { content: string }).content),
          });
          return toSkill(
            written,
            contextOf(request.server).service.pinnedSkills(scopeOf(request), agentId),
            options.agent === 'plain' ? undefined : libraryStatus(home),
          );
        } catch (error) {
          return skillFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateSkill',
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const key = params.skill_key as string;
        const { home, options } = skillPlace(request, agentId);
        const patch = body as { enabled?: boolean; pinned?: boolean };
        const service = contextOf(request.server).service;
        const scope = scopeOf(request);
        try {
          let skill = getSkill(home, key, options);
          if (!skill) throw notFound({ resource: 'skill', id: key });
          if (patch.enabled !== undefined) {
            skill = setSkillEnabled(home, key, patch.enabled, options);
          }
          let pinned = service.pinnedSkills(scope, agentId);
          if (patch.pinned !== undefined) {
            pinned = service.setPinnedSkills(
              scope,
              agentId,
              patch.pinned ? [...pinned, key] : pinned.filter((entry) => entry !== key),
            );
          }
          return toSkill(
            skill,
            pinned,
            options.agent === 'plain' ? undefined : libraryStatus(home),
          );
        } catch (error) {
          return skillFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.deleteSkill',
      handler: (request, { params }) => {
        const { home } = skillPlace(request, params.agent_id as string);
        try {
          deleteSkill(home, params.skill_key as string);
        } catch (error) {
          return skillFault(error);
        }
        return null;
      },
    });

    /**
     * Core Hub's skill library in this profile (§71): on by default; off removes the library's
     * skills that are still as the hub wrote them and leaves the edited ones as the person's.
     */
    defineRoute(app, deps, {
      operationId: 'agents.updateSkillLibrary',
      handler: (request, { params, body }) => {
        const home = skillHome(request, params.agent_id as string);
        setLibraryEnabled(home, (body as { enabled: boolean }).enabled === true);
        return toLibrary(libraryStatus(home));
      },
    });

    /** One library skill back as the library ships it — the only write over a person's edit. */
    defineRoute(app, deps, {
      operationId: 'agents.restoreSkill',
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const key = params.skill_key as string;
        const home = skillHome(request, agentId);
        try {
          restoreLibrarySkill(home, key);
        } catch (error) {
          if (error instanceof LibraryError) {
            throw new HubError('conflict', { details: { reason: error.reason } });
          }
          throw error;
        }
        const skill = getSkill(home, key);
        if (!skill) throw notFound({ resource: 'skill', id: key });
        return toSkill(
          skill,
          contextOf(request.server).service.pinnedSkills(scopeOf(request), agentId),
          libraryStatus(home),
        );
      },
    });

    /**
     * Importing a skill pack: the uploaded files, read from `knowledge`, checked as Hermes
     * reads a skill, and installed all together or not at all (`skill-import.ts`).
     */
    defineRoute(app, deps, {
      operationId: 'agents.importSkills',
      status: 201,
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const { home, options } = skillPlace(request, agentId);
        const scope = scopeOf(request);
        const ids = [...new Set((body as { attachment_ids: string[] }).attachment_ids)];
        const port = attachmentsFactory?.(request.server);
        if (!port) {
          throw new HubError('service_unavailable', {
            details: { reason: 'attachments_unavailable' },
          });
        }
        const scratch = mkdtempSync(path.join(tmpdir(), 'corehub-skill-import-'));
        try {
          const landed = port.materialise(scope.id, ids, scratch);
          const missing = ids.filter((id) => !landed.some((file) => file.id === id));
          if (missing.length > 0) throw notFound({ resource: 'attachment', id: missing[0] });
          const uploads: UploadedFile[] = ids.map((id) => {
            const file = landed.find((entry) => entry.id === id)!;
            return { name: file.name, data: readFileSync(file.path) };
          });
          const keys = installPack(home, planImport(home, uploads));
          const pinned = contextOf(request.server).service.pinnedSkills(scope, agentId);
          return {
            items: keys
              .map((key) => getSkill(home, key, options))
              .filter((skill): skill is Skill => skill !== null)
              .map((skill) => toSkill({ ...skill, content: null }, pinned)),
          };
        } catch (error) {
          if (error instanceof SkillImportError) {
            throw new HubError(error.kind === 'conflict' ? 'conflict' : 'bad_request', {
              message: error.message,
              details: {
                reason: error.reason,
                skill: error.where.skill ?? null,
                file: error.where.file ?? null,
                message: error.message,
              },
            });
          }
          throw error;
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    });

    /**
     * MCP servers. One block of `config.yaml`, edited in place (`mcp.ts`).
     *
     * `agents.testMcpServer` asks Hermes to connect (`hermes-tools.ts`): the hub writes the
     * file, and Hermes — the one that will run the server — is the one that tries it. The
     * rows themselves still claim nothing: `connected` stays false until Hermes starts.
     */
    /** The block the hub writes for its own tools is edited from their card only (§67). */
    const refuseManaged = (name: string): void => {
      if (name === HUB_SERVER_NAME) {
        throw new HubError('conflict', { details: { reason: 'mcp_managed', name } });
      }
    };

    const mcpFault = (error: unknown): never => {
      if (error instanceof McpError) {
        if (error.reason === 'mcp_not_found') throw notFound({ resource: 'mcp_server' });
        // The file is the agent's and it is writing it, or the hub does not edit that agent's.
        if (error.reason === 'config_busy' || error.reason === 'mcp_not_managed') {
          throw new HubError('state_invalid', { details: { reason: error.reason } });
        }
        throw new HubError('bad_request', { details: { reason: error.reason } });
      }
      throw error;
    };

    /**
     * The contract's `McpServer`. `connected` and `tools` are not measured — see above. A
     * remote server also says whether it is signed in by OAuth in this profile, read from the
     * metadata of Hermes's token file, never its values (`mcp-oauth.ts`, DECISIONS §122).
     */
    const toMcpServer = (server: McpServer, home: string): Record<string, unknown> => {
      // The last test the hub kept, and whether the server changed since (DECISIONS §134).
      const kept = contextOf(app).mcpTests.get(home, server.name);
      return {
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
        connected: false,
        tools: [],
        error: null,
        config: server.config,
        updated_at: new Date().toISOString(),
        ...(server.transport === 'stdio'
          ? {}
          : { oauth: oauthStateOf(home, server.name, server.oauth) }),
        last_test: kept
          ? viewOfTest(kept, server.fingerprint, readOnlyHints(home, server.name))
          : null,
        tool_filter: server.toolFilter,
      };
    };

    /** Keep what Hermes said about `name` in this profile, on the settings it was said about. */
    const rememberTest = (
      home: string,
      name: string,
      result: Parameters<McpTestStore['put']>[2],
    ): void => {
      try {
        const server = getMcpServer(home, name);
        if (server) contextOf(app).mcpTests.put(home, name, result, server.fingerprint);
      } catch (error) {
        // Not kept is not lost: the answer still goes back to whoever asked.
        app.log.warn({ err: error, server: name }, 'agents: could not keep an MCP test result');
      }
    };

    /**
     * A coding agent's MCP page edits the agent's own file (`coding-agent-mcp.ts`): its slug,
     * or `null` for Hermes (whose servers are its profile's `config.yaml`). A coding agent whose
     * file the hub does not edit yet is `409`, `mcp_not_managed`; the page then points to its
     * Config files, and the Core Hub tools card still works.
     */
    const codingMcpSlug = (request: FastifyRequest, agentId: string): string | null => {
      const row = contextOf(request.server).service.get(
        scopeOf(request),
        agentId,
        request.language,
      );
      if (row.kind === 'hermes') return null;
      if (row.kind !== 'acp' || !managesCodingAgentMcp(row.slug)) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'mcp_not_managed' },
        });
      }
      return row.slug;
    };

    /** The contract's `McpServer` for a coding agent: no test, sign-in or tool filter here. */
    const toCodingMcpServer = (server: McpServer): Record<string, unknown> => ({
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      connected: false,
      tools: [],
      error: null,
      config: server.config,
      updated_at: new Date().toISOString(),
    });

    defineRoute(app, deps, {
      operationId: 'agents.listMcpServers',
      handler: (request, { params }) => {
        const coding = codingMcpSlug(request, params.agent_id as string);
        if (coding) {
          try {
            return {
              items: contextOf(request.server).codingMcp.list(coding).map(toCodingMcpServer),
            };
          } catch (error) {
            return mcpFault(error);
          }
        }
        const home = skillHome(request, params.agent_id as string);
        try {
          return { items: listMcpServers(home).map((server) => toMcpServer(server, home)) };
        } catch (error) {
          return mcpFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.createMcpServer',
      handler: (request, { params, body }) => {
        const input = body as {
          name: string;
          transport: string;
          enabled?: boolean;
          config: Record<string, unknown>;
        };
        refuseManaged(input.name);
        const coding = codingMcpSlug(request, params.agent_id as string);
        if (coding) {
          const store = contextOf(request.server).codingMcp;
          try {
            if (store.get(coding, input.name)) {
              throw new HubError('conflict', {
                details: { reason: 'mcp_name_taken', name: input.name },
              });
            }
            return toCodingMcpServer(
              store.put(
                coding,
                input.name,
                { config: input.config, enabled: input.enabled ?? true },
                input.transport as McpServer['transport'],
              ),
            );
          } catch (error) {
            return mcpFault(error);
          }
        }
        const home = skillHome(request, params.agent_id as string);
        try {
          if (getMcpServer(home, input.name)) {
            throw new HubError('conflict', {
              details: { reason: 'mcp_name_taken', name: input.name },
            });
          }
          return toMcpServer(
            putMcpServer(home, input.name, {
              config: input.config,
              enabled: input.enabled ?? true,
            }),
            home,
          );
        } catch (error) {
          return mcpFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateMcpServer',
      handler: (request, { params, body }) => {
        const name = params.server_name as string;
        const patch = body as {
          enabled?: boolean;
          config?: Record<string, unknown>;
          tool_filter?: McpToolFilter;
        };
        refuseManaged(name);
        const coding = codingMcpSlug(request, params.agent_id as string);
        if (coding) {
          // Which tools the agent may use is Hermes's own filter (§134); a coding agent has none.
          if (patch.tool_filter !== undefined) {
            throw new HubError('state_invalid', {
              details: { reason: 'tool_filter_is_hermes_only' },
            });
          }
          const store = contextOf(request.server).codingMcp;
          try {
            const current = store.get(coding, name);
            if (!current) throw notFound({ resource: 'mcp_server', id: name });
            if (patch.enabled === undefined && patch.config === undefined) {
              return toCodingMcpServer(current);
            }
            return toCodingMcpServer(
              store.put(coding, name, {
                ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
                ...(patch.config === undefined ? {} : { config: patch.config }),
              }),
            );
          } catch (error) {
            return mcpFault(error);
          }
        }
        const home = skillHome(request, params.agent_id as string);
        try {
          if (!getMcpServer(home, name)) throw notFound({ resource: 'mcp_server', id: name });
          let written =
            patch.enabled === undefined && patch.config === undefined
              ? null
              : putMcpServer(home, name, {
                  ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
                  ...(patch.config === undefined ? {} : { config: patch.config }),
                });
          // Which tools Hermes gives the agent, after the config it belongs to (§134).
          if (patch.tool_filter !== undefined) {
            written = setMcpToolFilter(home, name, {
              include: patch.tool_filter.include ?? null,
              exclude: patch.tool_filter.exclude ?? null,
            });
          }
          return toMcpServer(written ?? getMcpServer(home, name)!, home);
        } catch (error) {
          return mcpFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.deleteMcpServer',
      handler: (request, { params }) => {
        refuseManaged(params.server_name as string);
        const coding = codingMcpSlug(request, params.agent_id as string);
        if (coding) {
          try {
            contextOf(request.server).codingMcp.delete(coding, params.server_name as string);
          } catch (error) {
            return mcpFault(error);
          }
          return null;
        }
        const home = skillHome(request, params.agent_id as string);
        try {
          deleteMcpServer(home, params.server_name as string);
        } catch (error) {
          return mcpFault(error);
        }
        contextOf(request.server).mcpTests.forget(home, params.server_name as string);
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.testMcpServer',
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const name = params.server_name as string;
        const { home, profile } = toolHome(request, agentId);
        let server: McpServer | null;
        try {
          server = getMcpServer(home, name);
        } catch (error) {
          return mcpFault(error);
        }
        if (!server) throw notFound({ resource: 'mcp_server', id: name });
        const result = await testMcpServer(hermesApiOf(request, agentId), {
          profile,
          name,
          config: server.config,
          language: request.language,
        });
        rememberTest(home, name, result);
        return result;
      },
    });

    registerMcpOAuthRoutes(app, deps, {
      toolHome,
      loginSpawner: (server) => contextOf(server).mcpLogin(),
      hermesApi: (server) => contextOf(server).hermesApi(),
      toMcpServer,
      rememberTest,
      refuseManaged,
      mcpFault,
      apiBase: serverBasePath(document),
    });

    defineRoute(app, deps, {
      operationId: 'agents.getAvatar',
      handler: async (request, { params }, reply) => {
        const agentId = params.agent_id as string;
        const picture = contextOf(request.server).service.avatar(agentId);
        if (!picture) throw notFound({ resource: 'agent_avatar', id: agentId });
        return reply
          .type(picture.mime)
          .header('cache-control', 'private, no-cache')
          .send(picture.bytes);
      },
    });

    /**
     * Journey: what Hermes has learned in the selected profile, read from Hermes's own server
     * (`hermes-journey.ts`). Hermes decides every node; the hub renames the fields.
     */
    defineRoute(app, deps, {
      operationId: 'agents.getJourney',
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const { profile } = toolHome(request, agentId, 'journey_is_hermes_only');
        return readJourney(hermesApiOf(request, agentId), profile);
      },
    });

    /**
     * A coding agent's own config files (decision §78): a fixed list per agent, one set for
     * every profile, in the home of the user the hub runs as (`config-files.ts`).
     */
    const configFileFault = (error: unknown, agentId: string, key?: string): never => {
      if (!(error instanceof ConfigFileError)) throw error;
      const { fault } = error;
      switch (fault.kind) {
        case 'unknown':
          throw notFound({ resource: 'config_file', id: key ?? agentId });
        case 'symlink_outside':
          throw new HubError('conflict', { details: { reason: 'symlink_outside' } });
        case 'too_large':
          throw new HubError('payload_too_large', { details: { limit_bytes: fault.limit } });
        case 'not_text':
          throw new HubError('unsupported_media_type', { details: { reason: 'not_utf8' } });
        case 'changed':
          throw new HubError('conflict', {
            details: { reason: 'changed', revision: fault.revision },
          });
        case 'invalid_json':
          throw new HubError('validation_failed', {
            details: { field: 'content', reason: 'invalid_json', message: fault.message },
          });
      }
    };
    const agentSlug = (request: FastifyRequest, agentId: string): string =>
      contextOf(request.server).service.get(scopeOf(request), agentId, request.language).slug;

    defineRoute(app, deps, {
      operationId: 'agents.listConfigFiles',
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        return { items: contextOf(request.server).configFiles.list(agentSlug(request, agentId)) };
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.getConfigFile',
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const key = params.file_key as string;
        try {
          return contextOf(request.server).configFiles.read(agentSlug(request, agentId), key);
        } catch (error) {
          return configFileFault(error, agentId, key);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.putConfigFile',
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const key = params.file_key as string;
        const scope = scopeOf(request);
        const slug = agentSlug(request, agentId);
        const input = body as { content: string; revision: string | null };
        try {
          const written = contextOf(request.server).configFiles.write(slug, key, {
            content: input.content,
            revision: input.revision ?? null,
          });
          const actor = actorOf(request).userId;
          auditFor(request.server).record({
            workspace: scope.id,
            ownerId: actor,
            actorKind: 'user',
            actorId: actor,
            action: 'agent_config_file.written',
            entityKind: 'agent',
            entityId: agentId,
            summary: `config file written: ${slug} ${written.view.path}`.slice(0, 500),
            data: {
              agent: slug,
              key,
              path: written.view.path,
              bytes: written.view.size_bytes,
              previous_revision: written.previous,
              revision: written.view.revision,
              backup: written.backup,
            },
            requestId: String(request.id),
          });
          return written.view;
        } catch (error) {
          return configFileFault(error, agentId, key);
        }
      },
    });

    // An installed agent signing in to its own vendor account (catalog `signIn`): the hub runs
    // the agent's device-code command and relays its link and code; the agent keeps the token.
    defineRoute(app, deps, {
      operationId: 'agents.startSignIn',
      status: 201,
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const row = service.loadAgent(agentId);
        const entry = catalogEntry(row.slug);
        if (!entry?.signIn) {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, reason: 'sign_in_unsupported' },
          });
        }
        if (row.installState !== 'installed' || !row.executablePath) {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, reason: 'not_installed' },
          });
        }
        const ctx = contextOf(request.server);
        // Only the agent's own variables, as when it runs (§139).
        const env = agentEnvironment(
          ctx.agentInherited,
          { executablePath: row.executablePath },
          hostEnvNames(entry),
        );
        const started = await ctx.signIns.start(
          agentId,
          [row.executablePath, ...entry.signIn.args],
          env,
        );
        const scope = scopeOf(request);
        const actor = actorOf(request).userId;
        auditFor(request.server).record({
          workspace: scope.id,
          ownerId: actor,
          actorKind: 'user',
          actorId: actor,
          action: 'agent.sign_in_started',
          entityKind: 'agent',
          entityId: agentId,
          summary: `sign-in of ${row.slug} started`,
          data: { agent: row.slug },
          requestId: String(request.id),
        });
        return started;
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.getSignIn',
      handler: (request, { params }) =>
        contextOf(request.server).signIns.get(
          params.agent_id as string,
          params.sign_in_id as string,
        ),
    });

    registerHubToolRoutes(app, deps, {
      service: (server) => contextOf(server).hubTools,
      scopeOf,
      actorOf,
      assertHubToolsAgent: (request, agentId) => {
        const row = contextOf(request.server).service.get(
          scopeOf(request),
          agentId,
          request.language,
        );
        // The settings are the profile's: Hermes reads them from its config, and a coding agent
        // over ACP is handed the same server when its conversation starts (decision §67).
        if (row.kind !== 'hermes' && row.kind !== 'acp') {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, reason: 'skills_are_hermes_only' },
          });
        }
      },
    });

    /**
     * Memory: the three documents Hermes reads (`memory.ts`) — `soul`, `memory`, `user`.
     * Three and not a folder, because that is what the contract's `item_id` says and what
     * Hermes actually reads; a hub that offered arbitrary filenames here would be offering
     * a place the agent never looks.
     */
    const memoryFault = (error: unknown): never => {
      if (error instanceof MemoryError) {
        if (error.reason === 'memory_document_unknown') throw notFound({ resource: 'memory' });
        if (error.reason === 'memory_document_protected') {
          throw new HubError('conflict', { details: { reason: error.reason } });
        }
        throw new HubError('bad_request', { details: { reason: error.reason, ...error.details } });
      }
      throw error;
    };

    /** The contract's `MemoryItem`. Hermes's memory is documents, so `kind` is fixed. */
    const toMemoryItem = (item: MemoryDocument): Record<string, unknown> => ({
      id: item.id,
      kind: 'document',
      title: item.title,
      content: item.content,
      tags: [],
      // Files have no revision of their own; the hub does not invent a version number
      // for something a person can also edit with an editor.
      revision: 0,
      updated_at: item.updatedAt?.toISOString() ?? null,
      // Decision §102: the entries as Hermes reads them, and the budget they count against.
      entries: item.entries,
      char_limit: item.limit,
      char_count: item.length,
    });

    defineRoute(app, deps, {
      operationId: 'agents.listMemory',
      handler: (request, { params, query }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          return {
            items: listMemory(home, query.q as string | undefined).map(toMemoryItem),
            next_cursor: null,
          };
        } catch (error) {
          return memoryFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.putMemoryItem',
      handler: (request, { params, body }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          return toMemoryItem(
            putMemory(
              home,
              params.item_id as string,
              String((body as { content: string }).content),
            ),
          );
        } catch (error) {
          return memoryFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.deleteMemoryItem',
      handler: (request, { params }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          deleteMemory(home, params.item_id as string);
        } catch (error) {
          return memoryFault(error);
        }
        return null;
      },
    });

    /**
     * Channels: the other block of `config.yaml` (`channels.ts`).
     *
     * `agents.loginChannel` pairs WhatsApp by QR through Hermes's own onboarding, as a job
     * whose progress carries the code (`hermes-tools.ts` §pairWhatsApp).
     *
     * `status` is `unknown`, deliberately. The hub writes the file; whether Telegram is
     * actually answering is something only the gateway knows, and `online` would be a
     * word nobody checked.
     */
    const channelFault = (error: unknown): never => {
      if (error instanceof ChannelError) {
        if (error.reason === 'channel_not_found') throw notFound({ resource: 'channel' });
        throw new HubError('bad_request', { details: { reason: error.reason } });
      }
      throw error;
    };

    /**
     * `status` is what the gateway serving the profile says about the platform
     * (`gateway_state.json`, written by Hermes): `online` connected, `error` with Hermes's
     * sentence, `offline` otherwise. `unknown` where the hub does not run that gateway — an
     * external Hermes — or while it has not said anything yet.
     */
    const channelStatus = (
      request: FastifyRequest,
      profile: string,
      channel: Channel,
    ): ChannelHealth => {
      const { runtime } = contextOf(request.server);
      const health = (status: string, error: string | null, restartNeeded = false) => ({
        status,
        error,
        restartNeeded,
      });
      if (runtime.status().mode !== 'managed') return health('unknown', null);
      if (!channel.enabled || !channel.configured) return health('offline', null);
      const record = runtime.gatewayRecord(profile);
      const platform = record?.platforms[channel.platform];
      if (record && !platform && record.gatewayState === 'running') {
        // A change the gateway is about to follow (`channelsChanged`) is not one for Restart.
        if (runtime.channelsSettling(profile)) return health('unknown', null);
        // One gateway per host: it takes a named profile's changed channels on its own scan.
        if (profile !== 'default' && runtime.profileGateways.topology() === 'one-per-host') {
          return health('unknown', null);
        }
        // Hermes names every platform it was started with (`connecting` first), so a running
        // gateway that does not name this one started before it was switched on.
        return health('offline', null, true);
      }
      if (!record || !platform) {
        const gateway = runtime.gateways().find((entry) => entry.profile === profile);
        return health(
          gateway && gateway.state === 'starting' ? 'unknown' : 'offline',
          gateway?.lastError ?? null,
        );
      }
      if (platform.state === 'connected') return health('online', null);
      if (platform.state === 'fatal' || platform.state === 'error') {
        return health('error', platform.errorMessage);
      }
      // Still signing in after a (re)start: not known yet, rather than `offline`.
      if (platform.state === 'connecting') return health('unknown', null);
      return health('offline', platform.errorMessage);
    };

    const toChannel = (
      channel: Channel,
      health: ChannelHealth = { status: 'unknown', error: null, restartNeeded: false },
    ): Record<string, unknown> => ({
      platform: channel.platform,
      // The platform's own name. A table of pretty labels would go stale the moment
      // Hermes adds one, and the slug is what the person put in the file.
      label: channel.platform,
      enabled: channel.enabled,
      configured: channel.configured,
      exclusive: channel.exclusive,
      status: health.status,
      error: health.error,
      restart_needed: health.restartNeeded,
      login: (QR_PLATFORMS as readonly string[]).includes(channel.platform)
        ? 'qr'
        : (TOKEN_PLATFORMS as readonly string[]).includes(channel.platform)
          ? 'token'
          : credentialPlatform(channel.platform)
            ? 'credentials'
            : null,
      link: channel.link
        ? {
            linked: channel.link.linked,
            account_id: channel.link.accountId,
            account_name: channel.link.accountName,
            account_phone: channel.link.accountPhone,
            account_username: channel.link.accountUsername,
            mode: channel.link.mode,
            reply_title: channel.link.replyTitle ?? null,
          }
        : null,
      fields: channel.fields.map((field) => ({
        key: field.key,
        label: { ar: field.key, en: field.key },
        kind: field.kind === 'boolean' ? 'toggle' : field.kind,
        target: field.kind === 'secret' ? 'credentials' : 'configuration',
        value: field.value,
        hint: null,
      })),
    });

    /** The gateway that serves the profile's channels, as the Channels page shows it. */
    const channelGateway = (request: FastifyRequest, profile: string) => {
      const { runtime } = contextOf(request.server);
      if (runtime.status().mode !== 'managed') return null;
      const gateway = runtime.gateways().find((entry) => entry.profile === profile);
      return {
        profile,
        state: gateway ? gatewayState(gateway.state) : 'stopped',
        // The hub restarts the gateway serving any profile after a channel change, the default
        // one included (`hermes-runtime.ts` §channelsChanged).
        applies: 'now',
        error: gateway?.lastError ?? null,
      };
    };

    /**
     * A channel of the profile changed: the gateway serving it restarts to follow, the default
     * profile's too, once a burst of changes has settled (`hermes-runtime.ts` §channelsChanged).
     * Not awaited — a gateway may take seconds to stop — and never the reason a save fails.
     */
    const followChannels = (request: FastifyRequest, profile: string): void => {
      void contextOf(request.server)
        .runtime.channelsChanged(profile)
        .catch((error: unknown) => {
          request.log.warn({ err: error, profile }, 'agents: a profile gateway did not follow');
        });
    };

    /** Every platform the hub links, and what each takes (`channel-platforms.ts`). */
    defineRoute(app, deps, {
      operationId: 'agents.listChannelPlatforms',
      handler: (request, { params }) => {
        toolHome(request, params.agent_id as string);
        const order = { full: 0, generic: 1 } as const;
        return {
          items: [...PLATFORMS]
            .sort((a, b) => order[a.support] - order[b.support])
            .map((spec) => ({
              platform: spec.platform,
              label: spec.label,
              support: spec.support,
              login: spec.login,
              credentials: spec.credentials.map((credential) => ({
                key: credential.key,
                kind: credential.kind,
                required: credential.required,
              })),
              allowed_users_key: spec.allowedUsers?.key ?? null,
              validates: spec.validates,
              pairs: spec.pairs,
              allowlist: spec.allowlist,
              settings: settingsOf(spec.platform) !== null,
              exclusive: spec.exclusive,
              packages: spec.packages,
              inbound: spec.inbound,
              program: spec.program,
              docs_url: spec.docsUrl,
            })),
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.listChannels',
      handler: (request, { params }) => {
        const { home, profile } = toolHome(request, params.agent_id as string);
        try {
          return {
            items: listChannels(home).map((channel) =>
              toChannel(channel, channelStatus(request, profile, channel)),
            ),
            gateway: channelGateway(request, profile),
          };
        } catch (error) {
          return channelFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateChannel',
      handler: (request, { params, body }) => {
        const { home, profile } = toolHome(request, params.agent_id as string);
        const input = body as {
          enabled?: boolean;
          credentials?: Record<string, string>;
          configuration?: Record<string, unknown>;
        };
        try {
          return toChannel(
            putChannel(home, params.platform as string, {
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
              // The contract splits them by where they go; the file does not, so they
              // are merged back into the one node they came from.
              values: { ...(input.configuration ?? {}), ...(input.credentials ?? {}) },
            }),
          );
        } catch (error) {
          return channelFault(error);
        } finally {
          followChannels(request, profile);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.clearChannel',
      handler: (request, { params }) => {
        const { home, profile } = toolHome(request, params.agent_id as string);
        try {
          return toChannel(clearChannel(home, params.platform as string));
        } catch (error) {
          return channelFault(error);
        } finally {
          followChannels(request, profile);
        }
      },
    });

    // Incoming webhooks (`webhook-routes.ts`, decision §97): Hermes's `webhook` platform.
    await registerWebhookRoutes(app, deps, {
      toolHome: (request, agentId) => toolHome(request, agentId),
      listenerStatus: (request, profile, home) => {
        const channel = listChannels(home).find((entry) => entry.platform === 'webhook');
        if (!channel) return { status: 'offline', error: null };
        const health = channelStatus(request, profile, channel);
        return { status: health.status, error: health.error };
      },
      followChannels,
      root: (server) => contextOf(server).runtime.status().home,
      // One gateway per host (DECISIONS §129, §132): its root listener answers every profile.
      sharedIngress: (server) => {
        const { runtime } = contextOf(server);
        return (
          runtime.status().mode === 'managed' &&
          runtime.profileGateways.topology() === 'one-per-host'
        );
      },
      shareWebhooks: (server) => contextOf(server).runtime.profileGateways.reconcile(),
    });

    /**
     * Unlink WhatsApp: the gateway that runs the bridge is held down while the session goes,
     * so the bridge cannot write it back, and comes back up when the profile still needs it.
     */
    defineRoute(app, deps, {
      operationId: 'agents.unlinkChannel',
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const platform = params.platform as string;
        const { home, profile } = toolHome(request, agentId);
        if (platform === 'telegram') {
          if (!telegramToken(home)) {
            throw new HubError('state_invalid', {
              details: { agent_id: agentId, platform, reason: 'not_linked' },
            });
          }
          // Held down while the token goes, so the bot stops answering now in every profile —
          // the default one's gateway included, as Unlink WhatsApp does.
          const channel = await contextOf(request.server).runtime.withGatewayStopped(profile, () =>
            unlinkTelegram(home),
          );
          request.log.info({ profile }, 'agents: Telegram unlinked');
          return toChannel(channel, channelStatus(request, profile, channel));
        }
        const spec = credentialPlatform(platform);
        if (spec) {
          const current = listChannels(home).find((entry) => entry.platform === platform);
          if (!current?.link?.linked) {
            throw new HubError('state_invalid', {
              details: { agent_id: agentId, platform, reason: 'not_linked' },
            });
          }
          // Held down while the credentials go, so the account stops answering now.
          const channel = await contextOf(request.server).runtime.withGatewayStopped(profile, () =>
            unlinkPlatform(home, spec),
          );
          request.log.info({ profile, platform }, 'agents: channel unlinked');
          return toChannel(channel, channelStatus(request, profile, channel));
        }
        if (platform !== 'whatsapp') {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'unlink_not_supported' },
          });
        }
        if (!whatsappLink(home).linked) {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'not_linked' },
          });
        }
        const { runtime } = contextOf(request.server);
        const channel = await runtime.withGatewayStopped(profile, () => {
          if (stopOrphanBridge(whatsappSessionDir(home))) {
            request.log.info({ profile }, 'agents: stopped a WhatsApp bridge left running');
          }
          return unlinkWhatsApp(home);
        });
        request.log.info({ profile }, 'agents: WhatsApp unlinked');
        return toChannel(channel, channelStatus(request, profile, channel));
      },
    });

    /**
     * How a linked WhatsApp number is used (`channels.ts` §whatsappMode): written with the gateway
     * that serves the profile held down, then started again — the default profile's too — so the
     * new mode is live when the answer arrives.
     */
    defineRoute(app, deps, {
      operationId: 'agents.setChannelMode',
      handler: async (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const platform = params.platform as string;
        const { home, profile } = toolHome(request, agentId);
        if (platform !== 'whatsapp') {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'mode_not_supported' },
          });
        }
        if (!whatsappLink(home).linked) {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'not_linked' },
          });
        }
        const mode = (body as { mode: WhatsAppMode }).mode;
        const { runtime } = contextOf(request.server);
        let channel: Channel;
        try {
          channel = await runtime.withGatewayStopped(profile, () => {
            // Self-chat replies carry a header: the agent's name where none was written yet.
            if (mode === 'self-chat') defaultReplyTitle(home, agentNameOf(request, agentId));
            return setWhatsAppMode(home, mode);
          });
        } catch (error) {
          return channelFault(error);
        }
        request.log.info({ profile, mode }, 'agents: WhatsApp mode changed');
        return toChannel(channel, channelStatus(request, profile, channel));
      },
    });

    /**
     * The header over the agent's replies in WhatsApp's self-chat (`channels.ts` §replyPrefixFor):
     * the agent's name as the hub names it, or a title the person typed. Written to the profile's
     * `.env`; the gateway serving the profile follows like any other channel change.
     */
    defineRoute(app, deps, {
      operationId: 'agents.setChannelReplyHeader',
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const platform = params.platform as string;
        const { home, profile } = toolHome(request, agentId);
        if (platform !== 'whatsapp') {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'reply_header_not_supported' },
          });
        }
        if (!whatsappLink(home).linked) {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'not_linked' },
          });
        }
        const input = body as { use: 'agent_name' | 'custom'; title?: string };
        let title: string | null;
        if (input.use === 'custom') {
          title = cleanReplyTitle(input.title ?? '');
          if (!title) {
            throw new HubError('validation_failed', {
              details: { field: 'title', reason: 'reply_title_invalid' },
            });
          }
        } else {
          title = cleanReplyTitle(agentNameOf(request, agentId));
          if (!title) {
            throw new HubError('state_invalid', {
              details: { agent_id: agentId, platform, reason: 'agent_name_unusable' },
            });
          }
        }
        let channel: Channel;
        try {
          channel = setWhatsAppReplyTitle(home, title);
        } catch (error) {
          return channelFault(error);
        }
        followChannels(request, profile);
        request.log.info({ profile, use: input.use }, 'agents: WhatsApp reply header changed');
        return toChannel(channel, channelStatus(request, profile, channel));
      },
    });

    /**
     * Link a platform by its variables (`channel-platforms.ts`): each checked against what the
     * platform declares, the platform asked who the account is where it can be
     * (`channel-validate.ts`), then written to the profile's own `.env`, the channel switched on,
     * the gateway following. Nothing is written before every check has passed.
     */
    const linkByCredentials = async (
      request: FastifyRequest,
      agentId: string,
      home: string,
      profile: string,
      spec: PlatformSpec,
      body: unknown,
    ) => {
      // The same rule as WhatsApp's pairing: only a Hermes this hub runs has a gateway to answer.
      hermesApiOf(request, agentId);
      const input = (body ?? {}) as {
        credentials?: Record<string, unknown>;
        allowed_users?: string[];
      };
      let values: Record<string, string | null>;
      try {
        values = checkCredentials(spec, input.credentials ?? {});
      } catch (error) {
        if (error instanceof CredentialError) {
          throw new HubError('validation_failed', {
            details: {
              field: `credentials.${error.field}`,
              reason: 'credentials_invalid',
              platform: spec.platform,
              message: error.reason,
            },
          });
        }
        throw error;
      }
      let allowed: string[] | undefined;
      if (input.allowed_users !== undefined) {
        allowed = [...new Set(input.allowed_users.map((id) => id.trim()).filter(Boolean))];
        const item = spec.allowedUsers?.item;
        const bad = allowed.find((entry) => (item ? !item.test(entry) : true));
        if (bad !== undefined) {
          throw new HubError('validation_failed', {
            details: {
              field: 'allowed_users',
              reason: 'credentials_invalid',
              platform: spec.platform,
            },
          });
        }
      }
      const context = contextOf(request.server);
      const root = context.runtime.status().home;
      const account = identityValue(
        spec,
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? ''])),
      );
      if (root && spec.exclusive && account) {
        const owner = accountOwner(root, home, spec, account);
        if (owner) {
          throw new HubError('conflict', {
            details: {
              agent_id: agentId,
              platform: spec.platform,
              reason: 'token_in_use',
              profile: owner,
            },
          });
        }
      }
      const identity = await probePlatform(spec, values, context.channelProbe);
      let channel: Channel | undefined;
      try {
        linkCredentials(home, spec, { values, allowedUsers: allowed, identity });
        channel = listChannels(home).find((entry) => entry.platform === spec.platform);
      } catch (error) {
        return channelFault(error);
      }
      if (!channel) return channelFault(new ChannelError('channel_write_failed'));
      request.log.info(
        { profile, platform: spec.platform, checked: identity !== null },
        'agents: channel linked',
      );
      followChannels(request, profile);
      return toChannel(channel, channelStatus(request, profile, channel));
    };

    /**
     * Link Telegram by a bot token: shape checked, Telegram asked who the bot is, the token
     * into the profile's own `.env`, the channel on with pairing, the gateway following.
     */
    defineRoute(app, deps, {
      operationId: 'agents.linkChannel',
      handler: async (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const platform = params.platform as string;
        const { home, profile } = toolHome(request, agentId);
        const spec = credentialPlatform(platform);
        if (spec) return linkByCredentials(request, agentId, home, profile, spec, body);
        if (!(TOKEN_PLATFORMS as readonly string[]).includes(platform)) {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'link_not_supported' },
          });
        }
        // The same rule as WhatsApp's pairing: only a Hermes this hub runs has a gateway to
        // answer on the bot.
        hermesApiOf(request, agentId);
        const input = body as { token?: string; allowed_users?: string[] };
        const token = String(input.token ?? '').trim();
        if (!TELEGRAM_TOKEN.test(token)) {
          throw new HubError('validation_failed', {
            details: { field: 'token', reason: 'token_invalid' },
          });
        }
        const context = contextOf(request.server);
        const root = context.runtime.status().home;
        if (root) {
          const owner = telegramTokenOwner(root, home, token);
          if (owner) {
            throw new HubError('conflict', {
              details: { agent_id: agentId, platform, reason: 'token_in_use', profile: owner },
            });
          }
        }
        const bot = await telegramGetMe(token, { fetchImpl: context.telegramFetch });
        const allowed =
          input.allowed_users === undefined
            ? undefined
            : [...new Set(input.allowed_users.map((id) => id.trim()).filter(Boolean))];
        let channel: Channel;
        try {
          channel = linkTelegram(home, { token, bot, allowedUsers: allowed });
        } catch (error) {
          return channelFault(error);
        }
        request.log.info({ profile, bot: bot.username }, 'agents: Telegram linked');
        followChannels(request, profile);
        return toChannel(channel, channelStatus(request, profile, channel));
      },
    });

    /**
     * A channel's own settings (Telegram's today): read and written where Hermes reads each one
     * (`telegram-settings.ts`), the gateway following a change like any other channel change.
     */
    const settingsTarget = (request: FastifyRequest, agentId: string, platform: string) => {
      const target = toolHome(request, agentId);
      const options = settingsOf(platform);
      if (!options) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, platform, reason: 'settings_not_supported' },
        });
      }
      return { ...target, options };
    };

    defineRoute(app, deps, {
      operationId: 'agents.getChannelSettings',
      handler: (request, { params }) => {
        const platform = params.platform as string;
        const { home, options } = settingsTarget(request, params.agent_id as string, platform);
        try {
          return { platform, options: readChannelSettings(home, options) };
        } catch (error) {
          return channelFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateChannelSettings',
      handler: (request, { params, body }) => {
        const platform = params.platform as string;
        const target = settingsTarget(request, params.agent_id as string, platform);
        const { home, profile } = target;
        const values = (body as { values: Record<string, unknown> }).values;
        let options;
        try {
          options = writeChannelSettings(home, platform, target.options, values);
        } catch (error) {
          if (error instanceof SettingError) {
            throw new HubError('validation_failed', {
              details: { field: `values.${error.key}`, reason: error.reason },
            });
          }
          return channelFault(error);
        }
        request.log.info({ profile, keys: Object.keys(values) }, 'agents: channel settings saved');
        followChannels(request, profile);
        return { platform, options };
      },
    });

    /**
     * Pairing: who may message the agent. Hermes's own API in the selected profile
     * (`hermes-pairing.ts`); turning one request down is the hub's, because Hermes has no verb
     * for it.
     */
    defineRoute(app, deps, {
      operationId: 'agents.listPairing',
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const { profile } = toolHome(request, agentId);
        return listPairing(hermesApiOf(request, agentId), profile);
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.approvePairing',
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const { profile } = toolHome(request, agentId);
        return approvePairing(hermesApiOf(request, agentId), {
          profile,
          platform: params.platform as string,
          requestId: params.request_id as string,
        });
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.denyPairing',
      status: 204,
      handler: (request, { params }) => {
        const { home } = toolHome(request, params.agent_id as string);
        denyPairing(home, params.platform as string, params.request_id as string);
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.revokePairing',
      status: 204,
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const { profile } = toolHome(request, agentId);
        await revokePairing(hermesApiOf(request, agentId), {
          profile,
          platform: params.platform as string,
          userId: params.user_id as string,
        });
        return null;
      },
    });

    /**
     * Plugins: what Hermes itself lists and changes in the selected profile, through its own
     * `hermes plugins` command (`hermes-plugins.ts` says why not its dashboard routes).
     */
    const pluginTarget = (request: FastifyRequest, agentId: string) => {
      const { home, profile } = toolHome(request, agentId, 'plugins_are_hermes_only');
      return { home, profile, cli: hermesCliOf(request, agentId) };
    };

    defineRoute(app, deps, {
      operationId: 'agents.listPlugins',
      handler: async (request, { params }) => {
        const { home, cli } = pluginTarget(request, params.agent_id as string);
        return listPlugins(cli, home, request.language);
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updatePlugin',
      handler: async (request, { params, body }) => {
        const { home, cli } = pluginTarget(request, params.agent_id as string);
        return setPluginEnabled(
          cli,
          home,
          params.plugin_key as string,
          (body as { enabled: boolean }).enabled,
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.deletePlugin',
      status: 204,
      handler: async (request, { params }) => {
        const { home, cli } = pluginTarget(request, params.agent_id as string);
        await removePlugin(cli, home, params.plugin_key as string);
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.installPlugin',
      status: 202,
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const { home, profile, cli } = pluginTarget(request, agentId);
        const identifier = String((body as { identifier: string }).identifier).trim();
        const scope = scopeOf(request);
        const language = request.language;
        const job = jobRunnerFor(request.server).start(
          {
            kind: 'agents.plugin_install',
            workspace: scope.id,
            ownerId: actorOf(request).userId,
            entityKind: 'agent',
            entityId: agentId,
            input: { identifier, profile },
            message: t('jobs.plugin_install.started', language),
          },
          (handle) => installPlugin(cli, handle, { home, identifier, language }),
        );
        return { job_id: job.id };
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.loginChannel',
      status: 202,
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const platform = params.platform as string;
        const { home, profile } = toolHome(request, agentId);
        if (!(QR_PLATFORMS as readonly string[]).includes(platform)) {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'login_not_supported' },
          });
        }
        const api = hermesApiOf(request, agentId);
        const scope = scopeOf(request);
        const language = request.language;
        const pollMs = contextOf(request.server).pairingPollMs;
        // Asked of the person, never guessed from the number; `bot` is what every link was before.
        const mode: WhatsAppMode = (body as { mode?: WhatsAppMode } | undefined)?.mode ?? 'bot';
        const allowedUsers = readEnv(home).WHATSAPP_ALLOWED_USERS;
        const agentName = agentNameOf(request, agentId);
        const job = jobRunnerFor(request.server).start(
          {
            kind: 'agents.channel_login',
            workspace: scope.id,
            ownerId: actorOf(request).userId,
            entityKind: 'agent',
            entityId: agentId,
            input: { platform, profile, mode },
            message: t('jobs.channel_login.started', language),
          },
          async (handle) => {
            const outcome = await pairWhatsApp(api, handle, {
              profile,
              language,
              pollMs,
              mode,
              ...(allowedUsers === undefined ? {} : { allowedUsers }),
            });
            // Linked: the gateway that serves the profile starts, or starts again, now — the
            // default profile's too — so the number is answered without anyone pressing Restart.
            if (outcome.status === 'connected') {
              // Self-chat replies carry a header: the agent's name where none was written yet.
              if (mode === 'self-chat') defaultReplyTitle(home, agentName);
              await contextOf(app)
                .runtime.channelsChanged(profile)
                .catch((error: unknown) => {
                  app.log.warn(
                    { err: error, profile },
                    'agents: the profile gateway did not start',
                  );
                });
            }
            return { ...outcome, applies: 'now' };
          },
        );
        return { job_id: job.id };
      },
    });

    // Long work: `202 { job_id }` now, progress and outcome on `/rt/jobs` (invariant 4).
    const lifecycle = {
      'agents.install': service.install.bind(service),
      'agents.upgrade': service.upgrade.bind(service),
      'agents.uninstall': service.uninstall.bind(service),
      'agents.checkUpdate': service.checkUpdate.bind(service),
    } as const;
    for (const [operationId, run] of Object.entries(lifecycle)) {
      defineRoute(app, deps, {
        operationId,
        status: 202,
        handler: (request, { params }) => ({
          job_id: run(scopeOf(request), actorOf(request), params.agent_id as string).id,
        }),
      });
    }

    defineRoute(app, deps, {
      operationId: 'agents.discover',
      status: 202,
      handler: (request) => ({ job_id: service.discover(scopeOf(request), actorOf(request)).id }),
    });

    defineRoute(app, deps, {
      operationId: 'agents.restart',
      status: 202,
      handler: (request, { params }) => ({
        job_id: service.restart(scopeOf(request), actorOf(request), params.agent_id as string, {
          managed: () => ctx.runtime.status().mode === 'managed',
          restart: () => ctx.runtime.restart(),
        }).id,
      }),
    });
  },
  registerEvents(_io: SocketServer) {
    // The registry's own event, `agent.updated`, rides on `/rt/jobs` because it is always
    // the outcome of hub-level work (packages/contracts/events/README.md). No client
    // command is accepted on that namespace.
  },
});

export const registerRoutes = agentsModule.registerRoutes.bind(agentsModule);
export const registerEvents = agentsModule.registerEvents.bind(agentsModule);

/**
 * The `AgentRunner` port `sessions` needs: one runner per app, over the app's adapters.
 * Wired next to the directory in `src/modules/index.ts`.
 */
export function agentRunner(app: FastifyInstance): AgentRunnerPort {
  return contextOf(app).runner;
}

/**
 * The `AgentDirectory` port `sessions` needs (`modules/sessions/ports.ts`). Wiring it is
 * one line in `src/modules/index.ts`:
 *
 *     createSessionsModule({ agents: agentDirectory, runner: agentRunner, scopes })
 *
 * so nothing inside `sessions` has to change when the registry grows.
 */
export function agentDirectory(app: FastifyInstance): AgentDirectoryPort {
  return {
    find(workspace: string, agentId: string): Promise<AgentInfo | null> {
      const service = agentsServiceFor(app);
      let row;
      try {
        row = service.loadAgent(agentId);
      } catch {
        return Promise.resolve(null);
      }
      const enabled = service.isEnabled(workspace, row.id);
      const available = row.installState === 'installed' && enabled;
      // What the workspace's providers resolve to for this agent (ADR 0010): the model
      // pinned to it, else the workspace default for its kind. A session that names no
      // model starts on this one, and nobody configured it per agent.
      const model = service.defaultModelOf(row, workspace);
      return Promise.resolve({
        id: row.id,
        name: row.name,
        adapterKind: row.adapterKind,
        defaultModel: model?.model ?? null,
        defaultProvider: model?.provider_id ?? null,
        available,
        ...(available ? {} : { unavailableReason: enabled ? row.installState : 'disabled' }),
        subagents: subagentSupport(row),
      });
    },
  };
}

/** A gateway's state as the contract says it: nothing in between is not applicable here. */
function gatewayState(state: GatewayStatus['state']): 'running' | 'starting' | 'stopped' | 'error' {
  return state === 'not_applicable' ? 'stopped' : state;
}

/** The contract's `MessagingGateway`. */
function toMessagingGateway(gateway: GatewayStatus) {
  return {
    profile: gateway.profile,
    state: gatewayState(gateway.state),
    pid: gateway.pid,
    restarts: gateway.restarts,
    started_at: gateway.startedAt === null ? null : new Date(gateway.startedAt).toISOString(),
    error: gateway.lastError,
    channels: gateway.channels,
    scheduled_jobs: gateway.cronJobs,
  };
}
