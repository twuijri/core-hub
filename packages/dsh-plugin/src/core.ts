/**
 * The plugin's state for one harness process: the link, the device connection, the programs,
 * the screen runner, the agent bridge, and the activity list. `index.ts` wires it to the
 * harness's services as they become available; everything here is reachable without them.
 */
import { HubApiError } from '@corehub/contracts';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsentGate, systemAsker, type Asker, type ConsentQuestion } from './consent.js';
import { deviceAnswers, type Activity } from './device-answers.js';
import { DeviceLink, type LinkStatus } from './device-link.js';
import { cleanFolders, systemOpener, type FolderConfig } from './folders.js';
import { AgentBridge, type AskResult } from './hermes.js';
import type { ConfigEditor, McpServerManager, ToolRegistry } from './host.js';
import {
  HubConnection,
  LinkRefused,
  claimPairing,
  gatewayModels,
  type GatewayState,
} from './hub.js';
import { translator, pickLanguage, type Language, type Translate } from './i18n.js';
import {
  AGENT_COMMAND_NAME,
  COMMAND_NAME,
  HARNESS_ROWS,
  PLUGIN_NAME,
  SCREEN_CAPABILITY,
} from './names.js';
import { parsePairing } from './pairing.js';
import {
  ProgramHost,
  cleanProgramProfiles,
  type HarnessMcp,
  type ProgramTool,
} from './programs.js';
import {
  providerRow,
  sameProvider,
  withBearer,
  withProvider,
  withoutProvider,
} from './provider.js';
import {
  ScreenRunner,
  computerUseInstalled,
  dshCommand,
  dshHome,
  type ScreenRequest,
} from './screen.js';
import { PluginStore } from './store.js';

declare const __PLUGIN_VERSION__: string | undefined;
export const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : 'dev';

const ACTIVITY_MAX = 50;

/** What the settings page holds, read fresh at each use (live config fields). */
export interface Settings {
  folders: unknown;
  allowOpen: boolean;
  programs: unknown;
  agentProfile: string;
  agent: string;
  screenTasks: boolean;
  screenModel: string;
  dshCommand: string[];
  language: string;
}

/** A command's or the page's answer: whether it did what was asked, and the sentence. */
export interface Outcome {
  ok: boolean;
  text: string;
}

/** The settings the page may change (each a live field of the plugin's row). */
export interface SettingsPatch {
  folders?: Array<{ path: string; write: boolean }>;
  allowOpen?: boolean;
  programs?: Record<string, string[]>;
  agentProfile?: string;
  screenTasks?: boolean;
  screenModel?: string;
  language?: 'auto' | 'en' | 'ar';
}

/** What the settings page shows: the link, the computer's offer, the activity. Never the token. */
export interface StatusView {
  version: string;
  language: string;
  resolvedLanguage: Language;
  linked: boolean;
  link: {
    hub: string;
    user: string;
    deviceId: string;
    profiles: string[];
    defaultProfile: string;
    tokenExpires: string | null;
    linkedAt: string;
    status: LinkStatus | 'unlinked';
    detail: string | null;
    degraded: string | null;
  } | null;
  models: { ok: true; ids: string[] } | { ok: false; reason: string; detail: string } | null;
  folders: Array<{ path: string; write: boolean }>;
  allowOpen: boolean;
  servers: Array<{ name: string; state: string; profiles: string[] }>;
  agentProfile: string;
  screen: {
    enabled: boolean;
    model: string;
    available: boolean;
    why: string | null;
  };
  activity: Activity[];
  canPickFolder: boolean;
  linkFileOpen: boolean;
}

export interface CoreOptions {
  dataDir: string;
  settings(): Settings;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
  /** Whether the host composes Computer Use (its `computerUse` service). */
  hostHasComputerUse(): boolean;
  /** A harness service by name, when the profile composes it (`directoryPicker`). */
  hostService?(name: string): unknown;
  fetch?: typeof fetch;
}

export class CoreHub {
  readonly store: PluginStore;
  readonly consent: ConsentGate;
  readonly programs: ProgramHost;
  readonly screen: ScreenRunner;
  readonly agent: AgentBridge;
  private connection: HubConnection | null = null;
  private link: DeviceLink | null = null;
  private linkState: { status: LinkStatus | 'unlinked'; detail: string | null } = {
    status: 'unlinked',
    detail: null,
  };
  private readonly activity: Activity[] = [];
  private lastModels: GatewayState | null = null;

  tools: ToolRegistry | null = null;
  mcpManager: McpServerManager | null = null;
  configEditor: ConfigEditor | null = null;

  constructor(private readonly options: CoreOptions) {
    this.store = new PluginStore(options.dataDir);
    this.consent = new ConsentGate(this.asker());
    this.programs = new ProgramHost({
      mcp: this.harnessMcp(),
      profiles: () => cleanProgramProfiles(this.settings().programs),
      consent: this.consent,
      question: (program, tool, profile) => {
        const t = this.t();
        return {
          key: `program:${program.id}`,
          title: t('consent.title'),
          message: t('consent.program', {
            hub: this.connection?.hub ?? '',
            profile: profile ?? '',
            program: program.server,
            tool,
          }),
          labels: {
            once: t('consent.once'),
            session: t('consent.session'),
            deny: t('consent.deny'),
          },
        };
      },
      record: (a) =>
        this.record({
          at: a.at,
          kind: 'apps',
          tool: `${a.program} · ${a.tool}`,
          target: a.target,
          ok: a.ok,
          detail: a.detail,
        }),
    });
    this.screen = new ScreenRunner({
      hub: () =>
        this.connection ? { hub: this.connection.hub, token: this.connection.token } : null,
      pickModel: (requested) => this.pickScreenModel(requested),
      upload: async (profile, file) => {
        if (!this.link) throw new Error('not linked');
        return (await this.link.upload(profile, file)).attachment_id;
      },
      command: () => dshCommand(this.settings().dshCommand),
      consentPlugin: fileURLToPath(new URL('./screen-consent.js', import.meta.url)),
      workDir: options.dataDir,
      dshHome: dshHome(),
    });
    this.agent = new AgentBridge({
      connection: () => this.connection,
      store: this.store,
      settings: () => ({
        profile: this.settings().agentProfile.trim() || null,
        agent: this.settings().agent.trim() || 'hermes',
      }),
    });
  }

  /** The real bearer on a request to the Core Hub provider (`llm-pi-ai/request-headers`). */
  authorize(provider: string | undefined, headers: Headers): void {
    withBearer(provider, headers, this.connection?.token ?? null);
  }

  settings(): Settings {
    return this.options.settings();
  }

  language(): Language {
    return pickLanguage(this.settings().language);
  }

  t(): Translate {
    return translator(this.language());
  }

  folders(): FolderConfig {
    const s = this.settings();
    return { folders: cleanFolders(s.folders), allowOpen: s.allowOpen === true };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Picks up a stored link: the token for the model provider, then the device connection. */
  start(): void {
    const stored = this.store.link();
    if (!stored) return;
    this.useLink(new HubConnection(stored, this.connectionOptions()));
    void this.refreshModels().catch(() => undefined);
  }

  stop(): void {
    this.link?.stop();
    this.link = null;
    this.screen.stopAll();
  }

  private connectionOptions() {
    return {
      store: this.store,
      language: () => this.language(),
      onRefused: (code: string) => {
        this.linkState = { status: 'refused', detail: code };
        this.link?.stop();
      },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    };
  }

  private useLink(connection: HubConnection): void {
    this.link?.stop();
    this.connection = connection;
    const stored = connection.stored;
    const link = new DeviceLink({
      hub: stored.hub,
      token: () => connection.token,
      deviceId: stored.device_id,
      client: connection.client,
      profiles: () => this.connection?.stored.profiles ?? [],
      report: () => ({
        folders: this.folders().folders.map((f) => ({ path: f.path, write: f.write })),
        allow_open: this.folders().allowOpen,
        programs: safe(() => this.programs.report(), []),
        screen: this.screenAvailable().ok,
      }),
      answer: deviceAnswers({
        folders: () => this.folders(),
        open: systemOpener(),
        programs: this.programs,
        consent: this.consent,
        record: (entry) => this.record(entry),
        screen: {
          available: () => this.screenAvailable().ok,
          question: (request, profile) => this.screenQuestion(request, profile),
          run: (request, profile) => this.screen.run(request, profile),
          status: (callId) => this.screen.status(callId),
        },
      }),
      beforeConnect: () => connection.renewIfDue(),
      onStatus: (status, detail) => {
        this.linkState = { status, detail };
        if (status === 'refused')
          this.options.log.warn('the hub refused this computer: %s', detail);
      },
    });
    this.link = link;
    void link.start();
  }

  /** Settings changed (folders, programs, screen tasks): the hub hears it. */
  settingsChanged(): void {
    this.consent.forget();
    this.link?.reportSoon();
  }

  // ------------------------------------------------------------------ link / unlink

  async linkWith(raw: string): Promise<Outcome> {
    const t = this.t();
    const parsed = parsePairing(raw, this.connection?.hub ?? null);
    if (!parsed.ok)
      return {
        ok: false,
        text:
          parsed.error === 'empty'
            ? t('link.usage', { command: COMMAND_NAME, scheme: COMMAND_NAME })
            : t(`link.parse.${parsed.error}`, { command: COMMAND_NAME }),
      };
    let stored;
    try {
      stored = await claimPairing({
        pairing: parsed.pairing,
        deviceKey: this.store.deviceKey(),
        pluginVersion: PLUGIN_VERSION,
        harnessVersion: harnessVersion(),
        language: this.language(),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
    } catch (error) {
      return { ok: false, text: t('link.failed', { reason: claimReason(error, t) }) };
    }
    // A link to another hub replaces this one; the old token is revoked there.
    if (this.connection && this.connection.hub !== stored.hub) await this.connection.revoke();
    this.store.saveLink(stored);
    this.useLink(new HubConnection(stored, this.connectionOptions()));
    const models = await this.refreshModels();
    return {
      ok: true,
      text: [t('link.done', { hub: stored.hub, user: stored.user.display_name }), models.text].join(
        '\n\n',
      ),
    };
  }

  async unlink(): Promise<Outcome> {
    const t = this.t();
    const connection = this.connection;
    if (!connection) return { ok: false, text: t('unlink.none') };
    this.link?.stop();
    this.link = null;
    await connection.revoke();
    this.connection = null;
    this.linkState = { status: 'unlinked', detail: null };
    this.store.forgetLink();
    await this.editProvider((current) => withoutProvider(current)).catch(() => undefined);
    return { ok: true, text: t('unlink.done', { hub: connection.hub }) };
  }

  // ------------------------------------------------------------------ models

  /** Asks the gateway for the models and writes the provider row; the person's sentence. */
  async refreshModels(): Promise<Outcome> {
    const t = this.t();
    const connection = this.connection;
    if (!connection) return { ok: false, text: t('status.unlinked', { command: COMMAND_NAME }) };
    const state = await gatewayModels(connection);
    this.lastModels = state;
    if (!state.ok) {
      if (state.reason === 'refused')
        return { ok: false, text: t('models.refused', { command: COMMAND_NAME }) };
      if (state.reason === 'unreachable')
        return { ok: false, text: t('models.unreachable', { detail: state.detail }) };
      return {
        ok: false,
        text: t(state.reason === 'off' ? 'models.off' : 'models.missing', {
          detail: state.detail,
        }),
      };
    }
    if (state.models.length === 0) return { ok: true, text: t('models.none') };
    const row = providerRow(connection.hub, state.models);
    try {
      await this.editProvider((current) =>
        sameProvider(current, row) ? current : withProvider(current, row),
      );
    } catch (error) {
      return {
        ok: false,
        text: t('models.not_written', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
    return { ok: true, text: t('models.ready', { count: state.models.length }) };
  }

  private async editProvider(
    change: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const editor = this.configEditor;
    if (!editor) throw new Error('the harness has no configuration editor here');
    const entry = editor.entries().find((e) => rowIs(e, HARNESS_ROWS.llm));
    if (!entry) throw new Error(`the profile has no "${HARNESS_ROWS.llm}" row`);
    await editor.edit(entry, (current, inherited) => {
      const providers = {
        ...((inherited.providers as Record<string, unknown> | undefined) ?? {}),
        ...((current.providers as Record<string, unknown> | undefined) ?? {}),
      };
      const merged = { ...inherited, ...current, providers };
      const next = change(merged);
      return JSON.stringify(next) === JSON.stringify(merged) ? current : next;
    });
  }

  private async pickScreenModel(requested: string | null): Promise<string | null> {
    if (requested) return requested;
    const configured = this.settings().screenModel.trim();
    if (configured) return configured;
    const connection = this.connection;
    if (!connection) return null;
    const state = this.lastModels?.ok ? this.lastModels : await gatewayModels(connection);
    return state.ok ? (state.models[0]?.id ?? null) : null;
  }

  // ------------------------------------------------------------------ the hub's agent

  async askAgent(
    harnessSession: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; text: string }> {
    const t = this.t();
    let result: AskResult;
    try {
      result = await this.agent.ask(harnessSession, message, signal);
    } catch (error) {
      if (error instanceof LinkRefused)
        return { ok: false, text: t('models.refused', { command: COMMAND_NAME }) };
      return {
        ok: false,
        text: t('agent.failed', { reason: error instanceof Error ? error.message : String(error) }),
      };
    }
    switch (result.state) {
      case 'answered':
        return { ok: true, text: result.text || t('agent.empty') };
      case 'waiting':
        return { ok: false, text: t('agent.waiting') };
      case 'timeout':
        return { ok: false, text: t('agent.timeout') };
      case 'failed':
        if (result.message === 'not_linked')
          return { ok: false, text: t('agent.not_linked', { command: COMMAND_NAME }) };
        if (result.message === 'no_agent') return { ok: false, text: t('agent.no_agent') };
        return { ok: false, text: t('agent.failed', { reason: result.message }) };
    }
  }

  // ------------------------------------------------------------------ screen

  screenAvailable():
    { ok: true } | { ok: false; why: 'platform' | 'disabled' | 'cua' | 'unlinked' } {
    if (process.platform !== 'darwin') return { ok: false, why: 'platform' };
    if (!this.settings().screenTasks) return { ok: false, why: 'disabled' };
    if (!this.connection) return { ok: false, why: 'unlinked' };
    if (!this.options.hostHasComputerUse() && !computerUseInstalled())
      return { ok: false, why: 'cua' };
    return { ok: true };
  }

  private screenQuestion(request: ScreenRequest, profile: string): ConsentQuestion {
    const t = this.t();
    return {
      key: SCREEN_CAPABILITY,
      title: t('consent.title'),
      message: t('consent.screen', {
        hub: this.connection?.hub ?? '',
        profile,
        app: request.app ? t('consent.screen_app', { app: request.app }) : '',
        task: request.task.slice(0, 800),
        budget: request.timeBudgetS,
      }),
      labels: { once: t('consent.allow'), session: null, deny: t('consent.deny') },
    };
  }

  // ------------------------------------------------------------------ status

  record(entry: Activity): void {
    this.activity.unshift(entry);
    if (this.activity.length > ACTIVITY_MAX) this.activity.pop();
  }

  recentActivity(): Activity[] {
    return [...this.activity];
  }

  /** `/corehub status` as Markdown: one bullet per fact, then the recent activity. */
  statusText(): string {
    const t = this.t();
    const connection = this.connection;
    const where = t('status.settings');
    if (!connection) return `${t('status.unlinked', { command: COMMAND_NAME })}\n\n${where}`;
    const stored = connection.stored;
    const lines = [
      t('status.linked', {
        hub: stored.hub,
        user: stored.user.display_name,
        device: stored.device_id,
      }),
      t('status.link', {
        status: this.linkState.status,
        detail: this.linkState.detail ? ` (${this.linkState.detail})` : '',
      }),
    ];
    const degraded = this.link?.state().degraded;
    if (degraded) lines.push(t('status.degraded', { what: degraded }));
    if (stored.token_expires_at)
      lines.push(t('status.token', { expires: stored.token_expires_at }));
    const folders = this.folders().folders;
    lines.push(
      folders.length > 0
        ? t('status.folders', {
            folders: folders.map((f) => `\`${f.path}\`${f.write ? ' (rw)' : ''}`).join(', '),
          })
        : t('status.folders_none'),
    );
    const programs = safe(() => this.programs.report(), []);
    lines.push(
      programs.length > 0
        ? t('status.programs', {
            programs: programs.map((p) => `${p.name} → ${p.profiles.join('/')}`).join(', '),
          })
        : t('status.programs_none'),
    );
    const screen = this.screenAvailable();
    lines.push(
      screen.ok
        ? t('status.screen_on')
        : t('status.screen_off', { why: t(`screen.why.${screen.why}`) }),
    );
    if (this.store.linkFileTooOpen())
      lines.push(t('status.file_open', { file: this.store.linkFile }));
    const out = lines.map((line) => `- ${line}`);
    if (this.activity.length > 0) {
      out.push('', `**${t('status.activity')}**`, '');
      for (const a of this.activity.slice(0, 10))
        out.push(
          `- ${a.ok ? '✓' : '✗'} \`${a.at.slice(0, 19).replace('T', ' ')}\` ${a.kind} · ${a.tool}${a.target ? ` \`${a.target}\`` : ''}${a.detail ? ` — ${a.detail}` : ''}`,
        );
    }
    out.push('', where);
    return out.join('\n');
  }

  /** The settings page's view of everything (never the token). */
  statusView(): StatusView {
    const connection = this.connection;
    const stored = connection?.stored ?? null;
    const settings = this.settings();
    const chosen = cleanProgramProfiles(settings.programs);
    const servers = safe(
      () =>
        (this.mcpManager?.list() ?? [])
          .filter((s) => s.configured)
          .map((s) => ({
            name: s.name,
            state: s.status?.state ?? 'unknown',
            profiles: chosen[s.name] ?? [],
          })),
      [],
    );
    const screen = this.screenAvailable();
    const models = this.lastModels;
    return {
      version: PLUGIN_VERSION,
      language: settings.language,
      resolvedLanguage: this.language(),
      linked: !!stored,
      link: stored
        ? {
            hub: stored.hub,
            user: stored.user.display_name,
            deviceId: stored.device_id,
            profiles: stored.profiles,
            defaultProfile: stored.default_profile,
            tokenExpires: stored.token_expires_at ?? null,
            linkedAt: stored.linked_at,
            status: this.linkState.status,
            detail: this.linkState.detail,
            degraded: this.link?.state().degraded ?? null,
          }
        : null,
      models: !stored
        ? null
        : models === null
          ? null
          : models.ok
            ? { ok: true, ids: models.models.map((m) => m.id) }
            : { ok: false, reason: models.reason, detail: models.detail },
      folders: this.folders().folders.map((f) => ({ path: f.path, write: f.write })),
      allowOpen: this.folders().allowOpen,
      servers,
      agentProfile: settings.agentProfile,
      screen: {
        enabled: settings.screenTasks,
        model: settings.screenModel,
        available: screen.ok,
        why: screen.ok ? null : screen.why,
      },
      activity: this.activity.slice(0, 20),
      canPickFolder: this.folderPicker() !== null,
      linkFileOpen: this.store.linkFileTooOpen(),
    };
  }

  /** Writes the page's changes into the plugin's row (live fields: no restart). */
  async updateSettings(patch: SettingsPatch): Promise<void> {
    const editor = this.configEditor;
    if (!editor) throw new Error('the harness has no configuration editor here');
    const entry = editor.entries().find((e) => rowIs(e, PLUGIN_NAME));
    if (!entry) throw new Error(`the profile has no "${PLUGIN_NAME}" row`);
    await editor.edit(entry, (current) => ({ ...current, ...patch }));
    this.settingsChanged();
  }

  /** The harness's own folder chooser on this computer, when the profile composes one. */
  private folderPicker(): { pick(signal: AbortSignal): Promise<string | null> } | null {
    const service = this.options.hostService?.('directoryPicker') as
      { capability?: () => { kind?: string; pick?: unknown } } | undefined;
    const capability = safe(() => service?.capability?.() ?? null, null);
    if (capability?.kind !== 'native' || typeof capability.pick !== 'function') return null;
    return capability as { pick(signal: AbortSignal): Promise<string | null> };
  }

  /** Opens the operating system's folder chooser; null when cancelled or unavailable. */
  async pickFolder(signal: AbortSignal): Promise<string | null> {
    const picker = this.folderPicker();
    return picker ? picker.pick(signal) : null;
  }

  /** The commands as a Markdown list, then where the settings page is. */
  help(): string {
    const t = this.t();
    const lines = t('help', { command: COMMAND_NAME, agentCommand: AGENT_COMMAND_NAME })
      .split('\n')
      .map((line) => `- ${line}`);
    return [...lines, '', t('status.settings')].join('\n');
  }

  // ------------------------------------------------------------------ harness glue

  /**
   * The consent for a request from the hub. Always the system's own dialog: the harness's
   * question prompt answers only questions asked inside one of its chats, and a hub request has
   * none, so a question put there waited, unseen, until the hub gave up (owner's Mac,
   * 2026-11-22: two screen tasks ended in `device_timeout` with no prompt shown).
   */
  private asker(): Asker {
    return systemAsker();
  }

  private harnessMcp(): HarnessMcp {
    return {
      servers: () =>
        (this.mcpManager?.list() ?? [])
          .filter((s) => s.configured)
          .map((s) => ({ name: s.name, state: s.status?.state ?? 'unknown' })),
      tools: (server) => {
        const prefix = `mcp__${server}__`;
        return (this.tools?.definitions() ?? [])
          .filter((d) => d.name.startsWith(prefix) && d.name !== `${prefix}load_tools`)
          .map((d): ProgramTool => ({
            name: d.name.slice(prefix.length),
            description: (d.description ?? '').slice(0, 2000),
            input_schema: d.parameters ?? { type: 'object' },
          }));
      },
      call: async (server, tool, args, signal) => {
        const tools = this.tools;
        if (!tools) throw new Error('the harness tool registry is not available');
        const name = `mcp__${server}__${tool}`;
        const id = `corehub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        // The manager's client registered the tool; run it directly (the person already allowed
        // the program here), so no root executor (PTC) or chat-bound approval stands in between.
        const definition = tools.get(name);
        if (definition) {
          try {
            const value = (await definition.execute(args, {
              callId: id,
              name,
              arguments: args,
              signal,
              concludeTurn: () => undefined,
            })) as { content?: unknown } | null;
            const content = Array.isArray(value?.content)
              ? (value.content as Array<Record<string, unknown>>)
              : [{ type: 'text', text: JSON.stringify(value ?? null) }];
            return { content, isError: false };
          } catch (error) {
            const err = error as { name?: string; message?: string };
            if (err?.name === 'McpToolError' || signal.aborted)
              return {
                content: [{ type: 'text', text: err?.message ?? String(error) }],
                isError: true,
              };
            // Anything else: the harness may want its own execution context; use its executor.
          }
        }
        const batch = await tools.execute({
          calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
          signal,
        });
        const result = batch.results[0]?.result;
        if (!result) throw new Error('the harness returned no result');
        const value = result.value as { content?: unknown } | undefined;
        const content = Array.isArray(value?.content)
          ? (value.content as Array<Record<string, unknown>>)
          : (result.content as Array<Record<string, unknown>>);
        return { content, isError: result.isError };
      },
    };
  }
}

/** A Loader entry by its patch id (`llm-pi-ai`), however the loader prefixes it (`include:…`). */
export function rowIs(entry: { id: string; options?: { id?: string } }, id: string): boolean {
  return entry.options?.id === id || entry.id === id || entry.id.endsWith(`:${id}`);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function harnessVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const file = require.resolve('@deepseek-ai/dsh/package.json');
    return (require(file) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function claimReason(error: unknown, t: Translate): string {
  if (error instanceof HubApiError) {
    if (error.status === 401) return t('link.claim.401');
    if (error.status === 404) return t('link.claim.404');
    if (error.status === 409) return t('link.claim.409');
    if (error.status === 403) return t('link.claim.403');
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The data folder: the setting, else `corehub/` beside the active profile's patch. */
export function dataDirOf(setting: string, documentPath: string | null): string {
  if (setting.trim()) return path.resolve(setting.trim());
  if (documentPath) return path.join(path.dirname(documentPath), COMMAND_NAME);
  return path.join(dshHome(), COMMAND_NAME);
}
