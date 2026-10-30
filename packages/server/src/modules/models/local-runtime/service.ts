/**
 * Ollama on the computer the hub runs on (ADR 0032): installed by the hub and run as its child,
 * or found already there and managed through its own API. Desktop app only — on a server image
 * the whole feature reports itself unavailable and nothing here runs.
 *
 * Two ways Ollama is here, and what each allows:
 * - **managed** (`<DATA_DIR>/runtimes/ollama/`): the hub installed it. It starts and stops with
 *   the hub, its models live beside it, and the hub updates and removes it.
 * - **external**: an Ollama that answers on `127.0.0.1:11434` and that the hub did not install.
 *   The hub lists, pulls and deletes its models; the program itself stays the person's.
 */
import { readFile, rm, statfs, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { HubError } from '../../../lib/errors.js';
import type { HostEnvironment } from '../../agents/adapters/host.js';
import type { JobRow, JobRunner } from '../../audit/index.js';
import { detectGpu, type GpuReading } from './gpu.js';
import {
  deleteOllamaModel,
  listOllamaModels,
  loadedOllamaModels,
  ollamaVersion,
  pullOllamaModel,
  type OllamaLoaded,
  type OllamaModel,
} from './ollama-api.js';
import { installOllama, ollamaExecutable, planInstall } from './ollama-install.js';
import { OllamaProcess } from './ollama-process.js';
import {
  compareVersions,
  latestOllamaRelease,
  runtimePlatform,
  type OllamaRelease,
  type RuntimePlatform,
} from './ollama-release.js';
import { SUGGESTED_MODELS, type SuggestedModel } from './suggestions.js';

/** Where an Ollama the person installed themselves listens. */
export const EXTERNAL_OLLAMA = 'http://127.0.0.1:11434';
/** How long a "newest release" answer is trusted before GitHub is asked again. */
const LATEST_TTL_MS = 6 * 60 * 60_000;

export type RuntimeMode = 'none' | 'managed' | 'external';

export interface LocalRuntimeView {
  available: boolean;
  mode: RuntimeMode;
  /** managed: the child's state; external: `running`; none: `stopped`. */
  state: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
  version: string | null;
  latest_version: string | null;
  update_available: boolean;
  base_url: string | null;
  platform: string | null;
  gpu: { vendor: GpuReading['vendor']; name: string | null; cuda: string | null } | null;
  /** What installing (or updating) would download, when known. */
  download_bytes: number | null;
  /** The install or update job in progress, if any. */
  job_id: string | null;
}

export interface LocalModelsView {
  installed: OllamaModel[];
  loaded: OllamaLoaded[];
  suggested: (SuggestedModel & { installed: boolean; fits: boolean })[];
  memory_bytes: number;
  disk_free_bytes: number | null;
  pulls: { name: string; job_id: string }[];
}

interface ManagedState {
  version: string;
  port: number | null;
  cuda: string | null;
  installed_at: string;
}

export interface LocalRuntimeOptions {
  available: boolean;
  dataDir: string;
  host: HostEnvironment;
  env: NodeJS.ProcessEnv;
  log: FastifyBaseLogger;
  jobs: JobRunner;
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
  /** Tells the models module where Ollama now answers, so its provider row points there. */
  onAddress(baseUrl: string): Promise<void>;
  /** After a model came or went: the provider's model list is fetched again. */
  onModelsChanged(): void;
  /** For tests: the address of "an Ollama already on this computer". */
  externalUrl?: string;
}

interface Actor {
  workspace: string;
  userId: string;
}

export class LocalRuntimeService {
  private readonly process: OllamaProcess;
  private readonly fetchImpl: typeof fetch;
  private readonly platform: RuntimePlatform | null;
  private gpu: GpuReading | null = null;
  private latest: { release: OllamaRelease; at: number } | null = null;
  private planned: { key: string; bytes: number } | null = null;
  private installJob: string | null = null;
  private readonly pulls = new Map<string, { jobId: string; abort: AbortController }>();

  constructor(private readonly options: LocalRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.platform = runtimePlatform(
      options.platform ?? process.platform,
      options.arch ?? os.arch(),
    );
    this.process = new OllamaProcess({
      log: options.log,
      env: options.env,
      fetchImpl: this.fetchImpl,
    });
    this.process.onChange(() => {
      const url = this.process.baseUrl();
      if (this.process.status().state === 'running' && url) {
        void options.onAddress(url).catch((error: unknown) => {
          options.log.warn(
            { err: error },
            'local runtime: could not point the Ollama provider at it',
          );
        });
      }
    });
  }

  available(): boolean {
    return this.options.available && this.platform !== null;
  }

  private root(): string {
    return path.join(this.options.dataDir, 'runtimes', 'ollama');
  }

  private appDir(): string {
    return path.join(this.root(), 'app');
  }

  modelsDir(): string {
    return path.join(this.root(), 'models');
  }

  private statePath(): string {
    return path.join(this.root(), 'state.json');
  }

  private externalUrl(): string {
    return this.options.externalUrl ?? EXTERNAL_OLLAMA;
  }

  /** True when the hub installed the Ollama it manages. */
  async isManaged(): Promise<boolean> {
    return (await this.managedState()) !== null;
  }

  private async managedState(): Promise<ManagedState | null> {
    try {
      const value = JSON.parse(await readFile(this.statePath(), 'utf8')) as ManagedState;
      return typeof value.version === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  private async saveState(state: ManagedState): Promise<void> {
    await mkdir(this.root(), { recursive: true });
    await writeFile(this.statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  private refuseUnavailable(): void {
    if (!this.available()) {
      throw new HubError('conflict', {
        message: 'local models run only in the desktop app',
        details: { reason: 'local_runtime_unavailable' },
      });
    }
  }

  private async gpuReading(): Promise<GpuReading> {
    this.gpu ??= await detectGpu({
      host: this.options.host,
      platform: (this.options.platform ?? process.platform) as NodeJS.Platform,
      ...(this.options.arch ? { arch: this.options.arch } : {}),
    });
    return this.gpu;
  }

  private async latestRelease(force = false): Promise<OllamaRelease | null> {
    if (!force && this.latest && Date.now() - this.latest.at < LATEST_TTL_MS)
      return this.latest.release;
    try {
      const release = await latestOllamaRelease(this.fetchImpl);
      this.latest = { release, at: Date.now() };
      return release;
    } catch (error) {
      this.options.log.debug({ err: error }, 'local runtime: could not read the newest Ollama');
      return this.latest?.release ?? null;
    }
  }

  private async downloadBytes(release: OllamaRelease, gpu: GpuReading): Promise<number | null> {
    if (!this.platform) return null;
    const key = `${release.tag}:${this.platform}:${gpu.cuda ?? 'none'}`;
    if (this.planned?.key === key) return this.planned.bytes;
    try {
      const plan = await planInstall(this.fetchImpl, release, this.platform, gpu);
      this.planned = { key, bytes: plan.downloadBytes };
      return plan.downloadBytes;
    } catch {
      return null;
    }
  }

  /** Which Ollama is here, and how it is. `fresh` asks GitHub for the newest release now. */
  async view(fresh = false): Promise<LocalRuntimeView> {
    const base: LocalRuntimeView = {
      available: this.available(),
      mode: 'none',
      state: 'stopped',
      error: null,
      version: null,
      latest_version: null,
      update_available: false,
      base_url: null,
      platform: this.platform,
      gpu: null,
      download_bytes: null,
      job_id: this.installJob,
    };
    if (!this.available()) return base;
    const gpu = await this.gpuReading();
    base.gpu = { vendor: gpu.vendor, name: gpu.name, cuda: gpu.cuda };
    const managed = await this.managedState();
    const release = await this.latestRelease(fresh);
    base.latest_version = release?.version ?? null;
    if (managed) {
      const status = this.process.status();
      base.mode = 'managed';
      base.state = status.state;
      base.error = status.error;
      base.version = managed.version;
      base.base_url = this.process.baseUrl();
      base.update_available = !!release && compareVersions(release.version, managed.version) > 0;
      if (base.update_available && release)
        base.download_bytes = await this.downloadBytes(release, gpu);
      return base;
    }
    const external = await ollamaVersion(this.fetchImpl, this.externalUrl());
    if (external) {
      base.mode = 'external';
      base.state = 'running';
      base.version = external;
      base.base_url = this.externalUrl();
      base.update_available = !!release && compareVersions(release.version, external) > 0;
      return base;
    }
    if (release) base.download_bytes = await this.downloadBytes(release, gpu);
    return base;
  }

  /** Where the Ollama the hub talks to answers right now, or null. */
  private async address(): Promise<string | null> {
    if (await this.managedState()) {
      return this.process.status().state === 'running' ? this.process.baseUrl() : null;
    }
    return (await ollamaVersion(this.fetchImpl, this.externalUrl())) ? this.externalUrl() : null;
  }

  private async requireAddress(): Promise<string> {
    const url = await this.address();
    if (!url) {
      throw new HubError('conflict', {
        message: 'Ollama is not running',
        details: { reason: 'local_runtime_stopped' },
      });
    }
    return url;
  }

  /** Boot: a managed Ollama starts with the hub; an external one gets its provider row. */
  async boot(): Promise<void> {
    if (!this.available()) return;
    const managed = await this.managedState();
    if (managed) {
      await this.startManaged(managed).catch((error: unknown) => {
        this.options.log.warn({ err: error }, 'local runtime: Ollama did not start with the hub');
      });
      return;
    }
    if (await ollamaVersion(this.fetchImpl, this.externalUrl())) {
      await this.options.onAddress(this.externalUrl()).catch(() => undefined);
    }
  }

  private async startManaged(state: ManagedState): Promise<void> {
    if (!this.platform) return;
    const binary = await ollamaExecutable(this.appDir(), this.platform);
    if (!binary) throw new Error('the installed Ollama has no program; install it again');
    await this.process.start({
      binary,
      modelsDir: this.modelsDir(),
      pidFile: path.join(this.root(), 'ollama.pid'),
      preferredPort: state.port ?? 11434,
    });
    const port = this.process.status().port;
    if (port !== state.port) await this.saveState({ ...state, port });
  }

  async start(): Promise<LocalRuntimeView> {
    this.refuseUnavailable();
    const state = await this.managedState();
    if (!state) {
      throw new HubError('conflict', {
        message: 'only an Ollama the hub installed can be started from the hub',
        details: { reason: 'local_runtime_not_managed' },
      });
    }
    await this.startManaged(state).catch((error: unknown) => {
      throw new HubError('service_unavailable', {
        message: `Ollama did not start: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    return this.view();
  }

  async stop(): Promise<LocalRuntimeView> {
    this.refuseUnavailable();
    if (!(await this.managedState())) {
      throw new HubError('conflict', {
        message: 'only an Ollama the hub installed can be stopped from the hub',
        details: { reason: 'local_runtime_not_managed' },
      });
    }
    await this.process.stop();
    return this.view();
  }

  /** Installs (or, when installed, updates) the newest Ollama as a job. */
  installOrUpdate(actor: Actor, kind: 'install' | 'update'): JobRow {
    this.refuseUnavailable();
    if (this.installJob) {
      throw new HubError('conflict', {
        message: 'Ollama is already being installed',
        details: { reason: 'local_runtime_busy' },
      });
    }
    const job = this.options.jobs.start(
      {
        kind: `models.${kind}`,
        workspace: actor.workspace,
        ownerId: actor.userId,
        message: kind === 'install' ? 'installing Ollama' : 'updating Ollama',
      },
      async (handle) => {
        try {
          const managed = await this.managedState();
          if (kind === 'install' && managed) {
            throw new HubError('conflict', {
              message: 'Ollama is already installed',
              details: { reason: 'local_runtime_installed' },
            });
          }
          if (kind === 'update' && !managed) {
            throw new HubError('conflict', {
              message: 'Ollama was not installed by the hub',
              details: { reason: 'local_runtime_not_managed' },
            });
          }
          if (kind === 'install' && (await ollamaVersion(this.fetchImpl, this.externalUrl()))) {
            throw new HubError('conflict', {
              message: 'an Ollama is already running on this computer; the hub manages that one',
              details: { reason: 'local_runtime_external' },
            });
          }
          handle.progress(2, 'checking the newest Ollama');
          const release = await this.latestRelease(true);
          if (!release || !this.platform) {
            throw new HubError('service_unavailable', {
              message: 'could not reach Ollama’s releases',
            });
          }
          const gpu = await this.gpuReading();
          const plan = await planInstall(this.fetchImpl, release, this.platform, gpu);
          let last = -1;
          if (managed) await this.process.stop();
          try {
            await installOllama(plan, {
              prefix: this.appDir(),
              fetchImpl: this.fetchImpl,
              host: this.options.host,
              progress: (done, total) => {
                const percent = 5 + Math.floor((Math.min(done, total) / Math.max(total, 1)) * 85);
                if (percent !== last) {
                  last = percent;
                  handle.progress(percent, `downloading Ollama ${release.version}`);
                }
              },
            });
          } catch (error) {
            // An update that failed leaves the old program in place: start it again.
            if (managed) await this.startManaged(managed).catch(() => undefined);
            throw error;
          }
          const state: ManagedState = {
            version: release.version,
            port: managed?.port ?? null,
            cuda: plan.keep,
            installed_at: new Date().toISOString(),
          };
          await this.saveState(state);
          handle.progress(95, 'starting Ollama');
          await this.startManaged(state);
          return { version: release.version };
        } finally {
          this.installJob = null;
        }
      },
    );
    this.installJob = job.id;
    return job;
  }

  /** Removes the managed Ollama; its models too unless `keepModels`. */
  async remove(keepModels: boolean): Promise<void> {
    this.refuseUnavailable();
    if (!(await this.managedState())) {
      throw new HubError('conflict', {
        message: 'only an Ollama the hub installed can be removed from the hub',
        details: { reason: 'local_runtime_not_managed' },
      });
    }
    await this.process.stop();
    await rm(this.appDir(), { recursive: true, force: true });
    await rm(this.statePath(), { force: true });
    if (!keepModels) await rm(this.modelsDir(), { recursive: true, force: true });
  }

  async models(): Promise<LocalModelsView> {
    this.refuseUnavailable();
    const url = await this.requireAddress();
    const [installed, loaded] = await Promise.all([
      listOllamaModels(this.fetchImpl, url),
      loadedOllamaModels(this.fetchImpl, url).catch(() => []),
    ]);
    const memory = os.totalmem();
    const folder = (await this.managedState()) ? this.root() : this.options.dataDir;
    const diskFree = await statfs(folder).then(
      (stats) => stats.bavail * stats.bsize,
      () => null,
    );
    const names = new Set(installed.map((model) => model.name));
    return {
      installed,
      loaded,
      suggested: SUGGESTED_MODELS.map((model) => ({
        ...model,
        installed: names.has(model.name) || names.has(`${model.name}:latest`),
        fits: memory >= model.memory_bytes,
      })),
      memory_bytes: memory,
      disk_free_bytes: diskFree,
      pulls: [...this.pulls.entries()].map(([name, pull]) => ({ name, job_id: pull.jobId })),
    };
  }

  pull(actor: Actor, name: string): JobRow {
    this.refuseUnavailable();
    const model = name.trim();
    if (!/^[\w.\-/:@]{1,200}$/.test(model)) {
      throw new HubError('validation_failed', {
        details: { fields: [{ path: 'name', message: 'not a model name' }] },
      });
    }
    const running = this.pulls.get(model);
    if (running) {
      throw new HubError('conflict', {
        message: `${model} is already downloading`,
        details: { reason: 'local_model_pulling', job_id: running.jobId },
      });
    }
    const abort = new AbortController();
    const job = this.options.jobs.start(
      {
        kind: 'models.install',
        workspace: actor.workspace,
        ownerId: actor.userId,
        input: { model },
        message: `downloading ${model}`,
      },
      async (handle) => {
        const cancel = setInterval(() => {
          if (handle.cancelRequested()) abort.abort();
        }, 500);
        try {
          const url = await this.requireAddress();
          let last = -1;
          await pullOllamaModel(
            this.fetchImpl,
            url,
            model,
            (event) => {
              const percent =
                event.total && event.completed !== null
                  ? Math.min(99, Math.floor((event.completed / event.total) * 100))
                  : null;
              if (percent !== last) {
                last = percent ?? -1;
                handle.progress(percent, event.status || null, {
                  model,
                  completed: event.completed,
                  total: event.total,
                });
              }
            },
            abort.signal,
          );
          this.options.onModelsChanged();
          return { model };
        } finally {
          clearInterval(cancel);
          this.pulls.delete(model);
        }
      },
    );
    this.pulls.set(model, { jobId: job.id, abort });
    return job;
  }

  async deleteModel(name: string): Promise<void> {
    this.refuseUnavailable();
    const url = await this.requireAddress();
    await deleteOllamaModel(this.fetchImpl, url, name);
    this.options.onModelsChanged();
  }

  /** The hub is stopping: a managed Ollama stops with it; pulls are abandoned. */
  async close(): Promise<void> {
    for (const pull of this.pulls.values()) pull.abort.abort();
    await this.process.stop();
  }
}
