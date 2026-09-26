/**
 * Everything "This device" offers agents, apart from Electron (ADR 0022, ADR 0025): the default
 * folder, the programs found on this computer and the person's choices for them, the consent
 * gate, one activity list, and the device connection to a hub on a server.
 *
 * The controller builds it with the OS pieces (the keychain, the native dialog, the shell); the
 * tests build it with fakes and a real hub.
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import type {
  DesktopDeviceState,
  DesktopProgram,
  DesktopProgramsState,
} from '../../../../packages/web/src/desktop/bridge-types.js';
import type { DesktopConfig, DeviceLinkConfig } from '../shared/config.js';
import {
  defaultFolderPath,
  withDefaultFolder,
  type HelperConfig,
  type ProgramSettings,
} from '../shared/helper.js';
import { isResolve, missingFields, type DiscoveredProgram } from '../shared/programs.js';
import { ConsentGate, type ConsentAnswer, type ConsentQuestion } from './consent.js';
import { deviceAnswers } from './device-answers.js';
import { DeviceLink, type HelperReport, type LinkStatus } from './device-link.js';
import { discoverPrograms, type DiscoveryEnv } from './discovery.js';
import type { HelperActivity, HelperEnv } from './helper.js';
import { claimPairing, type PairResult, type ThisComputer as Computer } from './hub.js';
import { ProgramHost } from './programs.js';
import { checkResolve, type Exec, type ResolveReadiness } from './resolve.js';

const ACTIVITY_MAX = 50;

export interface ConfigAccess {
  get(): DesktopConfig;
  update(change: (config: DesktopConfig) => DesktopConfig): DesktopConfig;
}

export interface ThisComputerOptions {
  config: ConfigAccess;
  /** Seals a secret with the OS keychain; `unseal` opens it. */
  seal(text: string): string;
  unseal(text: string): string;
  askConsent(question: ConsentQuestion): Promise<ConsentAnswer>;
  env: HelperEnv;
  version: string;
  /** The product's name, for the default folder (`~/Core Hub`). */
  productName: string;
  discovery?: DiscoveryEnv;
  home?: string;
  exec?: Exec;
  /** How this computer introduces itself when it pairs. */
  computer(): Computer;
  onActivity?: () => void;
  /** Tests: how fast a program answers "running", and the device link's back-off. */
  softDeadlineMs?: number;
  reconnectDelayMs?: number;
  fetchImpl?: typeof fetch;
  makeClient?: ConstructorParameters<typeof ProgramHost>[0]['makeClient'];
}

export class ThisComputerService {
  readonly consent: ConsentGate;
  readonly programs: ProgramHost;
  private catalogue: DiscoveredProgram[] = [];
  private scannedAt: string | null = null;
  private readonly log: HelperActivity[] = [];
  private link: DeviceLink | null = null;
  private linkState: { status: LinkStatus; detail: string | null } = {
    status: 'stopped',
    detail: null,
  };
  private hub: string | null = null;
  private resolve: ResolveReadiness | null = null;
  private readonly errors = new Map<string, string>();

  constructor(private readonly options: ThisComputerOptions) {
    this.consent = new ConsentGate(options.askConsent);
    this.programs = new ProgramHost({
      catalogue: () => this.catalogue,
      settings: () => this.helper().programs,
      unseal: (value) => options.unseal(value),
      clientVersion: options.version,
      consent: this.consent,
      record: (entry) => this.record(entry),
      onTools: (programId, tools) => {
        this.updateHelper((h) => {
          const current = h.programs[programId];
          if (!current) return h;
          return { ...h, programs: { ...h.programs, [programId]: { ...current, tools } } };
        });
      },
      ...(options.softDeadlineMs !== undefined ? { softDeadlineMs: options.softDeadlineMs } : {}),
      ...(options.makeClient ? { makeClient: options.makeClient } : {}),
    });
  }

  helper(): HelperConfig {
    return this.options.config.get().helper;
  }

  private updateHelper(change: (helper: HelperConfig) => HelperConfig): void {
    this.options.config.update((c) => ({ ...c, helper: change(c.helper) }));
    this.link?.reportSoon();
  }

  /** The helper's settings changed through the page: the hub hears it. */
  helperChanged(): void {
    this.link?.reportSoon();
  }

  // ---------------------------------------------------------------- activity

  record(entry: HelperActivity): void {
    this.log.unshift(entry);
    if (this.log.length > ACTIVITY_MAX) this.log.pop();
    this.options.onActivity?.();
  }

  activity(): HelperActivity[] {
    return [...this.log];
  }

  // ---------------------------------------------------------------- default folder

  /**
   * Turned on with nothing shared: `~/Core Hub` is made and shared writable, the default place
   * for program output (owner, 2026-09-26; ADR 0022 as amended). Returns the folder, or null
   * when something was shared already or the disk refused.
   */
  ensureDefaultFolder(): string | null {
    if (this.helper().folders.length > 0) return null;
    const folder = defaultFolderPath(this.options.home ?? os.homedir(), this.options.productName);
    try {
      mkdirSync(folder, { recursive: true });
    } catch {
      return null;
    }
    this.updateHelper((h) => withDefaultFolder(h, folder));
    return folder;
  }

  // ---------------------------------------------------------------- programs

  rescan(): void {
    this.catalogue = discoverPrograms(
      this.options.discovery ?? {
        home: os.homedir(),
        platform: process.platform,
        env: process.env,
      },
    );
    this.scannedAt = new Date().toISOString();
    this.link?.reportSoon();
  }

  catalogueNow(): DiscoveredProgram[] {
    return this.catalogue;
  }

  private statusOf(program: DiscoveredProgram, settings: ProgramSettings | undefined) {
    if (program.kind === 'remote') return 'remote' as const;
    if (program.kind === 'invalid') return 'invalid' as const;
    const values = Object.fromEntries(
      Object.entries(settings?.values ?? {}).map(([k, v]) => [k, v ? 'set' : '']),
    );
    return missingFields(program, values).length > 0 ? ('needs_setup' as const) : ('ready' as const);
  }

  programsState(): DesktopProgramsState {
    const settings = this.helper().programs;
    const programs: DesktopProgram[] = this.catalogue.map((program) => {
      const mine = settings[program.id];
      return {
        id: program.id,
        name: program.name,
        source: program.source,
        origin: program.origin,
        description: program.description,
        status: this.statusOf(program, mine),
        fields: program.fields.map((field) => {
          const sealed = mine?.values[field.key];
          return {
            ...field,
            set: !!sealed,
            value: sealed && !field.sensitive ? this.options.unseal(sealed) : null,
          };
        }),
        profiles: mine?.profiles ?? [],
        tools: (mine?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
        running: this.programs.running(program.id),
        error: this.errors.get(program.id) ?? null,
        resolve: isResolve(program),
      };
    });
    return { programs, scannedAt: this.scannedAt, resolve: this.resolve };
  }

  /** The profiles whose agents may use it; switching it on lists its tools for the hub. */
  async setProfiles(id: string, profiles: string[]): Promise<void> {
    const program = this.catalogue.find((p) => p.id === id);
    if (!program || program.kind !== 'stdio') return;
    const clean = [...new Set(profiles.filter((p) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(p)))];
    const before = this.helper().programs[id];
    this.updateHelper((h) => ({
      ...h,
      programs: {
        ...h.programs,
        [id]: { profiles: clean, values: before?.values ?? {}, tools: before?.tools ?? null },
      },
    }));
    if (clean.length === 0) {
      await this.programs.stop(id);
      return;
    }
    if (this.statusOf(program, this.helper().programs[id]) !== 'ready') return;
    try {
      await this.programs.listTools(id);
      this.errors.delete(id);
    } catch (error) {
      this.errors.set(id, error instanceof Error ? error.message : String(error));
    }
  }

  /** One of its settings: sealed by the keychain; changing it starts the program afresh. */
  async setField(id: string, key: string, value: string | null): Promise<void> {
    const program = this.catalogue.find((p) => p.id === id);
    if (!program || !program.fields.some((f) => f.key === key)) return;
    const before = this.helper().programs[id];
    const values = { ...(before?.values ?? {}) };
    if (value === null || value === '') delete values[key];
    else values[key] = this.options.seal(value);
    this.updateHelper((h) => ({
      ...h,
      programs: {
        ...h.programs,
        [id]: { profiles: before?.profiles ?? [], values, tools: before?.tools ?? null },
      },
    }));
    await this.programs.stop(id);
    if ((before?.profiles.length ?? 0) > 0) await this.setProfiles(id, before!.profiles);
  }

  async checkResolve(): Promise<ResolveReadiness> {
    this.resolve = await checkResolve({
      platform: this.options.discovery?.platform ?? process.platform,
      env: process.env,
      programs: this.catalogue,
      settings: this.helper().programs,
      ...(this.options.exec ? { exec: this.options.exec } : {}),
    });
    return this.resolve;
  }

  // ---------------------------------------------------------------- the hub on a server

  /** What the hub is told the helper offers; null while the helper is off. */
  report(): HelperReport | null {
    const helper = this.helper();
    if (!helper.enabled) return null;
    return {
      folders: helper.folders.map((f) => ({
        path: f.path,
        write: f.write,
        ...(f.path === helper.defaultFolder ? { default: true } : {}),
      })),
      allow_open: helper.allowOpen,
      programs: this.catalogue
        .filter((p) => (helper.programs[p.id]?.profiles.length ?? 0) > 0)
        .map((p) => ({
          id: p.id,
          name: p.name,
          source: p.source,
          profiles: helper.programs[p.id]!.profiles,
          tools: helper.programs[p.id]!.tools ?? [],
        })),
    };
  }

  /** The window now talks to this hub (remote mode), or to none (local mode, first run). */
  async useHub(hub: string | null): Promise<void> {
    if (this.hub === hub && this.link) return;
    this.hub = hub;
    await this.link?.stop();
    this.link = null;
    this.linkState = { status: 'stopped', detail: null };
    const saved = hub ? this.options.config.get().links[hub] : undefined;
    if (hub && saved) this.startLink(hub, saved);
  }

  private startLink(hub: string, saved: DeviceLinkConfig): void {
    let token: string;
    try {
      token = this.options.unseal(saved.token);
    } catch {
      this.linkState = { status: 'refused', detail: 'token_unreadable' };
      return;
    }
    const link = new DeviceLink({
      hub,
      token,
      deviceId: saved.deviceId,
      profiles: () => this.options.config.get().links[hub]?.profiles ?? [],
      report: () => this.report(),
      answer: deviceAnswers({
        config: () => this.helper(),
        env: this.options.env,
        programs: this.programs,
        record: (entry) => this.record(entry),
      }),
      onStatus: (status, detail) => {
        this.linkState = { status, detail };
      },
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.reconnectDelayMs !== undefined
        ? { reconnectDelayMs: this.options.reconnectDelayMs, reconnectDelayMaxMs: 2_000 }
        : {}),
    });
    this.link = link;
    link.start();
  }

  /** Pairing gave this computer a token for that hub: kept (sealed) and used at once. */
  async keepLink(result: Extract<PairResult, { ok: true }>): Promise<void> {
    this.options.config.update((c) => ({
      ...c,
      links: {
        ...c.links,
        [result.hub]: {
          deviceId: result.deviceId,
          userId: result.session.user.id,
          token: this.options.seal(result.session.token),
          profiles: result.profiles,
        },
      },
    }));
    if (this.hub === result.hub) {
      await this.link?.stop();
      this.link = null;
      this.startLink(result.hub, this.options.config.get().links[result.hub]!);
    }
  }

  /** From the page: a pairing the signed-in person just made, claimed by this computer. */
  async linkWithPairing(pairingId: string, code: string): Promise<DesktopDeviceState> {
    const hub = this.hub;
    if (!hub) return this.deviceState();
    const result = await claimPairing(
      { hub, pairingId, code },
      this.options.computer(),
      this.options.fetchImpl ?? fetch,
    );
    if (!result.ok) {
      this.linkState = { status: 'refused', detail: result.message };
      return this.deviceState();
    }
    await this.keepLink(result);
    return this.deviceState();
  }

  async forgetLink(): Promise<DesktopDeviceState> {
    const hub = this.hub;
    await this.link?.stop();
    this.link = null;
    this.linkState = { status: 'stopped', detail: null };
    if (hub)
      this.options.config.update((c) => {
        const links = { ...c.links };
        delete links[hub];
        return { ...c, links };
      });
    return this.deviceState();
  }

  deviceState(): DesktopDeviceState {
    const saved = this.hub ? this.options.config.get().links[this.hub] : undefined;
    return {
      hub: this.hub,
      linked: !!saved,
      deviceId: saved?.deviceId ?? null,
      status: saved ? this.linkState.status : 'unlinked',
      detail: saved ? this.linkState.detail : null,
    };
  }

  async stop(): Promise<void> {
    await this.link?.stop();
    this.link = null;
    await this.programs.stopAll();
  }
}
