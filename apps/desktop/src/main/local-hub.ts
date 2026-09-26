/**
 * Local mode's hub (ADR 0009): `dist/hub` started as a child of the app with Electron's own
 * Node, its data under the OS app-data folder, listening on a free loopback port.
 *
 * The app does not restart a hub that dies — it says so on the first-run screen, where the
 * person can try again or switch mode — and it stops the hub with itself: SIGTERM (the hub
 * closes its database and its Hermes child), then SIGKILL after a grace period.
 */
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppToHub } from '../shared/hub-ipc.js';

export interface LocalHubOptions {
  /** `dist/hub/dist/app/hub.mjs`. */
  entry: string;
  /** The hub's DATA_DIR: its database, keys, and the Hermes home it runs Hermes with. */
  dataDir: string;
  /** The PATH the hub gets (the found Hermes program's folder first). */
  pathEnv: string;
  /** Extra environment for the hub (never secrets from the app). */
  env?: NodeJS.ProcessEnv;
  /** The port used last, asked for again (another one if it is taken; `hub/entry.ts`). */
  preferredPort?: number | null;
  /** What the hub asks the app besides "listening" (`shared/hub-ipc.ts`). */
  onMessage?: (message: unknown) => void;
  /** Lines the hub writes, for the app's log. */
  onLog?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  startTimeoutMs?: number;
  stopGraceMs?: number;
  /** Test seam. */
  forkImpl?: (module: string, args: string[], options: ForkOptions) => ChildProcess;
}

export interface LocalHub {
  readonly origin: string;
  readonly port: number;
  readonly pid: number | undefined;
  /** Tells the hub something (`shared/hub-ipc.ts`); dropped once it is gone. */
  send(message: AppToHub): void;
  stop(): Promise<void>;
}

export class LocalHubError extends Error {
  constructor(
    message: string,
    readonly log: string[],
  ) {
    super(message);
    this.name = 'LocalHubError';
  }
}

const KEEP_LINES = 40;

export function startLocalHub(options: LocalHubOptions): Promise<LocalHub> {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const doFork = options.forkImpl ?? fork;
  const tail: string[] = [];
  const child = doFork(options.entry, [], {
    cwd: path.dirname(options.entry),
    env: {
      ...options.env,
      PATH: options.pathEnv,
      ELECTRON_RUN_AS_NODE: '1',
      DATA_DIR: options.dataDir,
      PORT: '0',
      ...(options.preferredPort ? { COREHUB_DESKTOP_PORT: String(options.preferredPort) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const collect = (chunk: Buffer | string) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > KEEP_LINES) tail.shift();
      options.onLog?.(line);
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let exited = false;
  const exitedPromise = new Promise<void>((resolve) =>
    child.once('exit', (code, signal) => {
      exited = true;
      options.onExit?.(code, signal);
      resolve();
    }),
  );

  const stop = async () => {
    if (exited) return;
    child.kill('SIGTERM');
    const grace = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), options.stopGraceMs ?? 10_000),
    );
    if ((await Promise.race([exitedPromise.then(() => 'exited' as const), grace])) === 'timeout')
      child.kill('SIGKILL');
    await exitedPromise;
  };

  return new Promise<LocalHub>((resolve, reject) => {
    const timer = setTimeout(() => {
      void stop();
      reject(new LocalHubError('The local hub did not start in time', [...tail]));
    }, options.startTimeoutMs ?? 60_000);
    const send = (message: AppToHub) => {
      if (exited || !child.connected) return;
      try {
        child.send(message);
      } catch {
        // Gone between the check and the send: nothing to tell.
      }
    };
    child.on('message', (message) => {
      const m = message as { type?: string; port?: unknown } | null;
      if (m?.type !== 'listening' || typeof m.port !== 'number') {
        options.onMessage?.(message);
        return;
      }
      clearTimeout(timer);
      const port = m.port;
      resolve({ origin: `http://127.0.0.1:${port}`, port, pid: child.pid, send, stop });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new LocalHubError(`The local hub stopped (${signal ?? `exit ${code}`})`, [...tail]));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new LocalHubError(error.message, [...tail]));
    });
  });
}
