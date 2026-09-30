/**
 * ChatGPT's device-code sign-in through CLIProxyAPI (DECISIONS §143).
 *
 * CLIProxyAPI 8.0.4 signs in to ChatGPT by a short code only from its command line
 * (`-codex-device-login`); its management API offers ChatGPT a browser redirect alone. A code is
 * what works from a phone and from a server with no browser, so the hub runs that command the way
 * it runs an agent's own device-code sign-in (§106): an argv array, never a string; the link and
 * code read from what it prints; the process stopped when the code runs out. The account it adds is
 * written into the same store the running CLIProxyAPI reads, which picks it up by itself.
 *
 * CLIProxyAPI exits 0 whether or not the sign-in worked, so the outcome is read from its words:
 * "Codex device authentication successful" is the only success.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** What a running device sign-in has printed so far. */
export interface CodexDevicePrompt {
  url: string;
  userCode: string;
}

/** Reads CLIProxyAPI's `Codex device URL:` and `Codex device code:` lines. */
export function parseCodexDevicePrompt(output: string): CodexDevicePrompt | null {
  const text = output.replace(ANSI, '');
  const url = /Codex device URL:\s*(https:\/\/\S+)/i.exec(text)?.[1];
  const userCode = /Codex device code:\s*([A-Za-z0-9-]+)/i.exec(text)?.[1];
  if (!url || !userCode) return null;
  return { url: url.replace(/[.,;)]+$/, ''), userCode };
}

export type CodexDeviceOutcome =
  | { status: 'pending' }
  | { status: 'approved' }
  | { status: 'failed'; error: string };

/** How a finished run's words say it went. */
export function codexDeviceOutcome(output: string, exited: boolean): CodexDeviceOutcome {
  const text = output.replace(ANSI, '');
  if (/Codex device authentication successful/i.test(text)) return { status: 'approved' };
  if (!exited) return { status: 'pending' };
  const failed = /Codex device authentication failed:?\s*(.*)$/im.exec(text)?.[1]?.trim();
  const last = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return {
    status: 'failed',
    error: (failed || last || 'the sign-in ended without an account').slice(0, 300),
  };
}

export type SpawnLogin = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
) => ChildProcess;

export interface CodexDeviceLoginOptions {
  binary: string;
  /** The hub's gateway folder: the login's own small config is written there. */
  stateDir: string;
  /** CLIProxyAPI's account store, shared with the running process. */
  authDir: string;
  env: NodeJS.ProcessEnv;
  spawnImpl?: SpawnLogin;
  /** How long to wait for the link and code. */
  promptTimeoutMs?: number;
}

/** One running `-codex-device-login`. */
export class CodexDeviceLogin {
  private output = '';
  private exited = false;
  private child: ChildProcess | null = null;

  constructor(private readonly options: CodexDeviceLoginOptions) {}

  /** Starts it and resolves with the link and code once printed. */
  async start(): Promise<CodexDevicePrompt> {
    const dir = this.options.stateDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The login needs only where to keep the account; nothing secret is in this file.
    const configPath = path.join(dir, 'cliproxy-login.yaml');
    writeFileSync(
      configPath,
      `# Written by Core Hub for a ChatGPT device sign-in (DECISIONS §143).\n${stringify({
        'config-version': 8,
        oauth: { 'auth-dir': this.options.authDir },
        management: { 'allow-remote': false, 'secret-key': '', 'disable-control-panel': true },
        observability: { logs: { debug: false, 'logging-to-file': false, 'request-log': false } },
        plugins: { enabled: false },
      })}`,
      { mode: 0o600 },
    );
    chmodSync(configPath, 0o600);
    const spawn =
      this.options.spawnImpl ??
      ((command, args, spawnOptions) =>
        nodeSpawn(command, [...args], {
          env: spawnOptions.env,
          cwd: spawnOptions.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
    const child = spawn(
      this.options.binary,
      ['-config', configPath, '-codex-device-login', '-no-browser', '-local-model'],
      { env: this.options.env, cwd: dir },
    );
    this.child = child;
    const read = (chunk: Buffer | string) => {
      this.output = (this.output + String(chunk)).slice(-16_384);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('exit', () => {
      this.exited = true;
    });
    const timeoutMs = this.options.promptTimeoutMs ?? 45_000;
    return new Promise<CodexDevicePrompt>((resolve, reject) => {
      const done = (error: Error | null, prompt?: CodexDevicePrompt) => {
        clearTimeout(timer);
        clearInterval(poll);
        if (error) {
          this.stop();
          reject(error);
        } else resolve(prompt!);
      };
      const timer = setTimeout(
        () =>
          done(
            new Error(
              `ChatGPT's sign-in printed no code within ${Math.round(timeoutMs / 1000)} s`,
            ),
          ),
        timeoutMs,
      );
      const poll = setInterval(() => {
        const prompt = parseCodexDevicePrompt(this.output);
        if (prompt) return done(null, prompt);
        if (this.exited) {
          const outcome = codexDeviceOutcome(this.output, true);
          done(new Error(outcome.status === 'failed' ? outcome.error : 'the sign-in ended'));
        }
      }, 50);
      child.once('error', (error) => done(error));
    });
  }

  /** How it stands now. */
  outcome(): CodexDeviceOutcome {
    return codexDeviceOutcome(this.output, this.exited);
  }

  stop(): void {
    const child = this.child;
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
}
