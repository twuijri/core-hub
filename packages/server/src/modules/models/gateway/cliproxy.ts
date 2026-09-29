/**
 * Supervises CLIProxyAPI, the translator behind the hub's model gateway (ADR 0029) — the way
 * `agents/hermes-runtime.ts` supervises Hermes's gateway: one process the hub starts itself, on a
 * loopback port it picks, restarted with a backoff when it dies, its lines in the hub's log under
 * `cliproxy`, stopped with the hub.
 *
 * The providers change while the hub runs. CLIProxyAPI 8.0.4 does not reliably reload its file, so
 * a change starts a **new** process on a new port with the new file, moves the gateway to it once it
 * answers, and stops the old one when its last request has ended (at most `DRAIN_MAX_MS` later) —
 * an agent in the middle of a stream is never cut off by somebody adding a provider.
 *
 * The hub starts it the first time an agent needs it, not at boot: a hub whose agents never use the
 * gateway never runs it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyBaseLogger } from 'fastify';
import { redactSecrets } from '../../../lib/redact-text.js';
import { cliproxyConfig, type GatewayUpstream } from './cliproxy-config.js';

/** How long a new process may take to answer before the change is given up. */
const READY_TIMEOUT_MS = 20_000;
/** The longest an old process is kept for a request still streaming through it. */
const DRAIN_MAX_MS = 30 * 60_000;
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const STOP_GRACE_MS = 3_000;

export interface CliproxyOptions {
  /** The executable, or null when this hub has none (the gateway then says so). */
  binary: string | null;
  /** The hub's own folder for it: `<DATA_DIR>/gateway`. */
  stateDir: string;
  log: FastifyBaseLogger;
  /** The environment it runs with: the host's, which the hub already stripped of its own. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Tests: a smaller wait. */
  readyTimeoutMs?: number;
}

export type CliproxyState = 'absent' | 'stopped' | 'starting' | 'running' | 'error';

interface Instance {
  child: ChildProcess;
  port: number;
  configPath: string;
  fingerprint: string;
  inflight: number;
  retired: boolean;
  exited: boolean;
}

/** One request's hold on a running process; `done()` exactly once. */
export interface CliproxyLease {
  port: number;
  key: string;
  done(): void;
}

export class CliproxyUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliproxyUnavailable';
  }
}

export class CliproxySupervisor {
  private current: Instance | null = null;
  private readonly draining = new Set<Instance>();
  private readonly key = randomBytes(32).toString('base64url');
  private state: CliproxyState;
  private lastError: string | null = null;
  private generation = 0;
  private pending: Promise<Instance> | null = null;
  private pendingFingerprint: string | null = null;
  private lastUpstreams: readonly GatewayUpstream[] = [];
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly options: CliproxyOptions) {
    this.state = options.binary ? 'stopped' : 'absent';
  }

  status(): { state: CliproxyState; error: string | null; port: number | null } {
    return { state: this.state, error: this.lastError, port: this.current?.port ?? null };
  }

  /**
   * A running process serving exactly `upstreams`: the current one when nothing changed, else a new
   * one (the old one drains). Resolves once it answers; throws `CliproxyUnavailable` otherwise.
   */
  async lease(upstreams: readonly GatewayUpstream[]): Promise<CliproxyLease> {
    const instance = await this.ensure(upstreams);
    instance.inflight += 1;
    let released = false;
    return {
      port: instance.port,
      key: this.key,
      done: () => {
        if (released) return;
        released = true;
        instance.inflight -= 1;
        if (instance.retired && instance.inflight <= 0) this.terminate(instance);
      },
    };
  }

  private async ensure(upstreams: readonly GatewayUpstream[]): Promise<Instance> {
    if (!this.options.binary) {
      throw new CliproxyUnavailable(
        'this hub has no CLIProxyAPI (the model gateway needs it; see docs/guides/any-model-any-agent.md)',
      );
    }
    if (this.stopping) throw new CliproxyUnavailable('the hub is stopping');
    const fingerprint = fingerprintOf(upstreams);
    if (this.current && !this.current.exited && this.current.fingerprint === fingerprint) {
      return this.current;
    }
    if (this.pending && this.pendingFingerprint === fingerprint) return this.pending;
    this.lastUpstreams = upstreams;
    this.pendingFingerprint = fingerprint;
    const starting = this.launch(upstreams, fingerprint);
    this.pending = starting;
    try {
      const instance = await starting;
      const previous = this.current;
      this.current = instance;
      if (previous && previous !== instance) this.retire(previous);
      this.restarts = 0;
      this.setState('running', null);
      return instance;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState('error', message);
      throw new CliproxyUnavailable(`the model gateway's translator did not start: ${message}`);
    } finally {
      if (this.pending === starting) {
        this.pending = null;
        this.pendingFingerprint = null;
      }
    }
  }

  private async launch(upstreams: readonly GatewayUpstream[], fingerprint: string): Promise<Instance> {
    const dir = this.options.stateDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const authDir = path.join(dir, 'cliproxy-auth');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const port = await freePort();
    this.generation += 1;
    const configPath = path.join(dir, `cliproxy-${this.generation}.yaml`);
    // Created 0600 before a byte of it is written: the provider keys are never readable by others.
    writeFileSync(
      configPath,
      cliproxyConfig({ port, internalKey: this.key, authDir, upstreams }),
      { mode: 0o600 },
    );
    chmodSync(configPath, 0o600);
    if (this.state !== 'running') this.setState('starting', this.lastError);
    const child = spawn(this.options.binary!, ['-config', configPath, '-local-model'], {
      cwd: dir,
      env: this.options.env ?? {},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const instance: Instance = {
      child,
      port,
      configPath,
      fingerprint,
      inflight: 0,
      retired: false,
      exited: false,
    };
    this.pipe(child.stdout, 'info');
    this.pipe(child.stderr, 'warn');
    const exited = new Promise<string>((resolve) => {
      child.once('error', (error) => resolve(error.message));
      child.once('exit', (code, signal) => resolve(`exited (${signal ?? `code ${code ?? '?'}`})`));
    });
    void exited.then((reason) => this.onExit(instance, reason));
    this.options.log.info(
      { pid: child.pid, port, upstreams: upstreams.length },
      'gateway: CLIProxyAPI started',
    );
    const ready = await Promise.race([
      this.waitReady(port),
      exited.then((reason) => {
        throw new Error(reason);
      }),
    ]);
    if (!ready) {
      this.terminate(instance);
      throw new Error(`no answer on 127.0.0.1:${port} within ${this.readyTimeout()} ms`);
    }
    return instance;
  }

  private readyTimeout(): number {
    return this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  }

  private async waitReady(port: number): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const deadline = Date.now() + this.readyTimeout();
    while (Date.now() < deadline) {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
          headers: { authorization: `Bearer ${this.key}` },
          signal: AbortSignal.timeout(1_000),
        });
        await response.body?.cancel().catch(() => undefined);
        if (response.ok) return true;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private onExit(instance: Instance, reason: string): void {
    instance.exited = true;
    this.draining.delete(instance);
    rmSync(instance.configPath, { force: true });
    if (instance.retired || this.stopping) return;
    if (this.current !== instance) return;
    this.current = null;
    this.options.log.error({ reason }, 'gateway: CLIProxyAPI stopped; restarting');
    this.setState('error', `CLIProxyAPI ${reason}`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]!;
    this.restarts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.current) return;
      void this.ensure(this.lastUpstreams).catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref?.();
  }

  private retire(instance: Instance): void {
    instance.retired = true;
    if (instance.inflight <= 0) {
      this.terminate(instance);
      return;
    }
    this.draining.add(instance);
    const timer = setTimeout(() => this.terminate(instance), DRAIN_MAX_MS);
    timer.unref?.();
  }

  private terminate(instance: Instance): void {
    if (instance.exited) return;
    const killer = setTimeout(() => {
      if (!instance.exited) instance.child.kill('SIGKILL');
    }, STOP_GRACE_MS);
    killer.unref?.();
    instance.child.kill('SIGTERM');
  }

  private pipe(stream: NodeJS.ReadableStream | null, level: 'info' | 'warn'): void {
    if (!stream) return;
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => {
      const text = line.trimEnd();
      if (!text) return;
      // One line per request is its access log: kept out of the hub's log at `info`.
      const quiet = text.includes('gin_logger.go');
      this.options.log[quiet ? 'debug' : level]({ cliproxy: true }, redactSecrets(text));
    });
  }

  private setState(state: CliproxyState, error: string | null): void {
    this.state = state;
    this.lastError = error;
  }

  /** Stops every process it started and removes their files; the hub is closing. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const all = [...this.draining, ...(this.current ? [this.current] : [])];
    this.current = null;
    await Promise.all(
      all.map(
        (instance) =>
          new Promise<void>((resolve) => {
            if (instance.exited) return resolve();
            instance.child.once('exit', () => resolve());
            this.terminate(instance);
          }),
      ),
    );
    this.draining.clear();
    this.setState(this.options.binary ? 'stopped' : 'absent', null);
  }
}

/** What changes the configuration apart from its port: a new one is needed only when it differs. */
function fingerprintOf(upstreams: readonly GatewayUpstream[]): string {
  return createHash('sha256').update(JSON.stringify(upstreams)).digest('hex');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
