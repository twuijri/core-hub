/**
 * The Ollama the hub installed, run as the hub's own child (ADR 0032 §5): it starts with the
 * hub, stops with it, and is started again if it dies (at most three times in a minute, so a
 * broken install does not spin). An Ollama that was on the computer before is never started or
 * stopped here — it belongs to the person.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import type { FastifyBaseLogger } from 'fastify';
import { redactSecrets } from '../../../lib/redact-text.js';
import { runCommand } from '../../agents/adapters/host.js';
import { ollamaVersion } from './ollama-api.js';

export type OllamaProcessState = 'stopped' | 'starting' | 'running' | 'error';

export interface OllamaProcessOptions {
  log: FastifyBaseLogger;
  /** What the child inherits (PATH, the Windows system folders); the hub adds Ollama's own. */
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readyTimeoutMs?: number;
}

export interface OllamaLaunch {
  binary: string;
  modelsDir: string;
  /**
   * Where the running Ollama's process id is kept: a hub that crashed (no chance to stop it)
   * finds the one it left and stops it before starting another.
   */
  pidFile: string;
  /** The port used last, tried first so the provider's address stays the same. */
  preferredPort: number | null;
}

const RESTARTS_PER_MINUTE = 3;

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function anyFreePort(): Promise<number> {
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

/** The command line of process `pid`, or null when there is none (or it cannot be read). */
async function commandOf(pid: number): Promise<string | null> {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      return null;
    }
  }
  const result =
    process.platform === 'win32'
      ? await runCommand(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          timeoutMs: 5_000,
        })
      : await runCommand(['ps', '-o', 'command=', '-p', String(pid)], { timeoutMs: 5_000 });
  return result.ok ? result.stdout : null;
}

/** Stops an Ollama a crashed hub left running, only if `pid` is still an Ollama. */
async function stopLeftover(pidFile: string): Promise<void> {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
  } catch {
    return;
  }
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 0) return;
  const command = await commandOf(pid);
  if (!command || !/ollama/i.test(command)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone between the check and the kill.
  }
}

export class OllamaProcess {
  private child: ChildProcess | null = null;
  private state: OllamaProcessState = 'stopped';
  private lastError: string | null = null;
  private port: number | null = null;
  private launchSpec: OllamaLaunch | null = null;
  private restarts: number[] = [];
  private stopping = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: OllamaProcessOptions) {}

  status(): { state: OllamaProcessState; error: string | null; port: number | null } {
    return { state: this.state, error: this.lastError, port: this.port };
  }

  baseUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: OllamaProcessState, error: string | null): void {
    this.state = state;
    this.lastError = error;
    for (const listener of this.listeners) listener();
  }

  /** Starts it (a no-op when it already runs); resolves once it answers. */
  async start(spec: OllamaLaunch): Promise<void> {
    if (this.child && this.state === 'running') return;
    this.stopping = false;
    this.launchSpec = spec;
    await stopLeftover(spec.pidFile);
    const port =
      spec.preferredPort && (await portFree(spec.preferredPort))
        ? spec.preferredPort
        : await anyFreePort();
    mkdirSync(spec.modelsDir, { recursive: true });
    this.setState('starting', null);
    const child = spawn(spec.binary, ['serve'], {
      env: {
        ...this.options.env,
        OLLAMA_HOST: `127.0.0.1:${port}`,
        OLLAMA_MODELS: spec.modelsDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.port = port;
    if (child.pid) writeFileSync(spec.pidFile, String(child.pid), { mode: 0o600 });
    // However the hub ends (an exception, `process.exit`), its Ollama does not outlive it.
    const onHubExit = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    process.once('exit', onHubExit);
    child.once('exit', () => {
      process.removeListener('exit', onHubExit);
      if (this.child === child || this.child === null) rmSync(spec.pidFile, { force: true });
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', (line) => this.options.log.debug({ line: redactSecrets(line) }, 'ollama'));
    }
    const exited = new Promise<string>((resolve) => {
      child.once('error', (error) => resolve(error.message));
      child.once('exit', (code, signal) => resolve(`exited (${signal ?? `code ${code ?? '?'}`})`));
    });
    void exited.then((reason) => this.onExit(child, reason));
    this.options.log.info({ pid: child.pid, port }, 'local runtime: Ollama started');
    const ready = await Promise.race([this.waitReady(port), exited.then(() => false)]);
    if (!ready) {
      const reason = this.lastError ?? `Ollama did not answer on 127.0.0.1:${port}`;
      this.kill(child);
      this.setState('error', reason);
      throw new Error(reason);
    }
    this.setState('running', null);
  }

  private async waitReady(port: number): Promise<boolean> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) return false;
      if (await ollamaVersion(fetchImpl, `http://127.0.0.1:${port}`, 1_000)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  private onExit(child: ChildProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopping) {
      this.setState('stopped', null);
      return;
    }
    this.options.log.warn({ reason }, 'local runtime: Ollama stopped on its own');
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < 60_000);
    if (this.restarts.length >= RESTARTS_PER_MINUTE || !this.launchSpec) {
      this.setState('error', reason);
      return;
    }
    this.restarts.push(now);
    this.setState('error', reason);
    const spec = { ...this.launchSpec, preferredPort: this.port };
    setTimeout(() => {
      if (this.stopping || this.child) return;
      this.start(spec).catch(() => undefined);
    }, 2_000).unref();
  }

  private kill(child: ChildProcess): void {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5_000);
    force.unref();
  }

  /** Stops it and waits until it is gone (or 6 s). */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.setState('stopped', null);
      return;
    }
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.kill(child);
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 6_000))]);
    this.child = null;
    this.setState('stopped', null);
  }
}
