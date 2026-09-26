/**
 * `cloudflared` as the app's child (DECISIONS §95): started with the person's tunnel token in
 * `TUNNEL_TOKEN` (never on the command line, never in a log), watched through its own readiness
 * endpoint on a loopback port (`/ready` answers 200 once the tunnel holds a connection to
 * Cloudflare), and read for the routes the dashboard gives the tunnel. It stops with the app,
 * and when it dies on its own it is started again after a growing pause — except for a token
 * Cloudflare refuses, which no retry fixes.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:net';
import {
  cloudflaredArgs,
  parseCloudflaredLine,
  redact,
  type RelayErrorCode,
} from '../shared/relay.js';

export type SpawnImpl = (program: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface TunnelOptions {
  program: string;
  token: string;
  /** Something changed that the page shows. */
  onChange: () => void;
  spawnImpl?: SpawnImpl;
  fetchImpl?: typeof fetch;
  /** How often the readiness endpoint is asked. */
  pollMs?: number;
  /** Pauses before each restart; the last one repeats. */
  restartDelaysMs?: number[];
  stopGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** A free port on the loopback, for `--metrics`. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const DEFAULT_RESTARTS = [2_000, 5_000, 15_000, 30_000, 60_000];

export class Tunnel {
  connected = false;
  connectedAt: string | null = null;
  routes: Array<{ hostname: string; service: string }> = [];
  error: { code: RelayErrorCode; detail: string | null } | null = null;
  private child: ChildProcess | null = null;
  private metricsPort = 0;
  private poll: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restarts = 0;
  private stopped = false;
  private lastError: string | null = null;

  constructor(private readonly options: TunnelOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.launch();
  }

  private async launch(): Promise<void> {
    if (this.stopped) return;
    this.metricsPort = await freeLoopbackPort();
    const spawnImpl = this.options.spawnImpl ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnImpl(this.options.program, cloudflaredArgs(this.metricsPort), {
        env: {
          ...(this.options.env ?? process.env),
          TUNNEL_TOKEN: this.options.token,
          TUNNEL_LOG_OUTPUT: 'json',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.fail('start_failed', error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    const read = (chunk: Buffer | string) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        const event = parseCloudflaredLine(line);
        if (event.kind === 'ingress') {
          this.routes = event.routes;
          this.options.onChange();
        } else if (event.kind === 'error') {
          this.lastError = redact(event.message, this.options.token);
        }
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.fail('start_failed', error.message);
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.setConnected(false);
      this.stopPolling();
      if (this.stopped) return;
      const said = this.lastError ?? `exit ${signal ?? code ?? '?'}`;
      if (/token/i.test(said) && /(not valid|invalid|unauthori[sz]ed)/i.test(said)) {
        this.fail('token_invalid', said);
        return;
      }
      this.error = { code: 'tunnel_exited', detail: said };
      this.options.onChange();
      const delays = this.options.restartDelaysMs ?? DEFAULT_RESTARTS;
      const delay = delays[Math.min(this.restarts, delays.length - 1)] ?? 60_000;
      this.restarts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.launch();
      }, delay);
    });
    this.poll = setInterval(() => void this.checkReady(), this.options.pollMs ?? 2_000);
    void this.checkReady();
  }

  private async checkReady(): Promise<void> {
    if (!this.child) return;
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `http://127.0.0.1:${this.metricsPort}/ready`,
        { signal: AbortSignal.timeout(1_500) },
      );
      const ready = response.status === 200;
      if (ready) {
        this.restarts = 0;
        if (this.error?.code === 'tunnel_exited') this.error = null;
      }
      this.setConnected(ready);
    } catch {
      this.setConnected(false);
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    if (value && !this.connectedAt) this.connectedAt = new Date().toISOString();
    if (!value) this.connectedAt = null;
    this.options.onChange();
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private fail(code: RelayErrorCode, detail: string): void {
    this.error = { code, detail: redact(detail, this.options.token) };
    this.stopped = true;
    this.stopPolling();
    this.options.onChange();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopPolling();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    this.connected = false;
    this.connectedAt = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const grace = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), this.options.stopGraceMs ?? 5_000).unref(),
    );
    if ((await Promise.race([exited.then(() => 'exited' as const), grace])) === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
  }
}
