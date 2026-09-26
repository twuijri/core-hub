/**
 * Signing an installed coding agent in to its own vendor account by device code (catalog
 * `signIn`, contract `agents.startSignIn` / `agents.getSignIn`).
 *
 * Some agents keep their own account rather than reading a provider key: Kimi Code
 * (`kimi login`) and Grok Build (`grok login --device-auth`) both run the device-code flow
 * every such sign-in shares — the CLI asks the vendor for a code and a link, prints them,
 * and waits while the person opens the link and approves; then it stores its credential in
 * its own folder under the hub user's home and exits 0. Neither needs a browser on the hub.
 *
 * So the hub runs that command (an argv array from the catalog, never a string), reads the
 * link and code from what it prints, shows them, and answers each poll with how the process
 * stands: still running is `pending`, exit 0 is `approved`, a refusal it reports is `denied`,
 * any other exit is `failed` with its last line, and a code that ran out is `expired` (the
 * process is stopped). No token passes through the hub.
 *
 * Kept in memory, like a provider sign-in: a hub restart forgets it (a poll is then 404),
 * and at most one runs per agent — starting another stops the one before.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { newUlid } from '../../db/ids.js';
import { HubError, notFound } from '../../lib/errors.js';

export type AgentSignInStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'failed';

/** The contract's `ProviderSignIn`, which an agent's sign-in shares. */
export interface AgentSignInView {
  id: string;
  status: AgentSignInStatus;
  user_code: string | null;
  verification_url: string;
  accepts_code: false;
  expires_at: string;
  error: string | null;
}

/** What a CLI printed, read for the link and code. */
export interface DeviceCodePrompt {
  url: string;
  userCode: string | null;
  expiresIn: number | null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * The link and code in a CLI's own words. The first `https` link is the page to open; the
 * code is the link's `user_code` when it carries one (both Kimi and Grok do), else what
 * follows "code:", else a line that is only a code. `expires in N s` gives the lifetime.
 */
export function parseDeviceCode(output: string): DeviceCodePrompt | null {
  const text = output.replace(ANSI, '');
  const link = /https:\/\/[^\s"'<>]+/.exec(text)?.[0];
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.replace(/[.,;)]+$/, ''));
  } catch {
    return null;
  }
  const fromUrl = url.searchParams.get('user_code');
  const fromText =
    /code:\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)/i.exec(text)?.[1] ??
    /^\s*([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\s*$/m.exec(text)?.[1] ??
    null;
  const expires = /expires in (\d+)\s*s/i.exec(text)?.[1];
  return {
    url: url.toString(),
    userCode: fromUrl ?? fromText,
    expiresIn: expires ? Number(expires) : null,
  };
}

/** What the store needs of `child_process.spawn`; tests hand in a scripted child. */
export type SpawnSignIn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface AgentSignInsOptions {
  spawnImpl?: SpawnSignIn;
  now?: () => number;
  /** How long to wait for the CLI to print its link (ms). */
  promptTimeoutMs?: number;
  /** A code's lifetime when the CLI does not say (seconds). */
  defaultExpiresIn?: number;
}

interface Record_ {
  id: string;
  agentId: string;
  child: ChildProcess;
  output: string;
  prompt: DeviceCodePrompt;
  expiresAt: number;
  status: AgentSignInStatus;
  error: string | null;
  timer: NodeJS.Timeout | null;
}

const DENIED = /\b(denied|declined|cancell?ed|rejected)\b/i;

function lastLine(text: string): string | null {
  const lines = text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1)?.slice(0, 300) ?? null;
}

export class AgentSignIns {
  private readonly records = new Map<string, Record_>();
  private readonly spawnImpl: SpawnSignIn;
  private readonly now: () => number;
  private readonly promptTimeoutMs: number;
  private readonly defaultExpiresIn: number;

  constructor(options: AgentSignInsOptions = {}) {
    this.spawnImpl =
      options.spawnImpl ??
      ((command, args, spawnOptions) =>
        nodeSpawn(command, [...args], {
          env: spawnOptions.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
    this.now = options.now ?? Date.now;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 30_000;
    this.defaultExpiresIn = options.defaultExpiresIn ?? 900;
  }

  /** Starts the CLI's sign-in and resolves once it has printed its link and code. */
  async start(
    agentId: string,
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<AgentSignInView> {
    const [command, ...args] = argv;
    if (!command) throw new HubError('internal', { message: 'no sign-in command' });
    for (const [id, record] of this.records) {
      if (record.agentId !== agentId) continue;
      this.stop(record);
      this.records.delete(id);
    }

    const child = this.spawnImpl(command, args, { env });
    let output = '';
    let exited: { code: number | null } | null = null;
    const prompt = await new Promise<DeviceCodePrompt>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new HubError('service_unavailable', {
            message: `the sign-in printed no link within ${this.promptTimeoutMs / 1000}s`,
            details: { reason: 'sign_in_no_prompt', output: lastLine(output) },
          }),
        );
      }, this.promptTimeoutMs);
      const read = (chunk: Buffer | string) => {
        output += String(chunk);
        const found = parseDeviceCode(output);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        }
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new HubError('agent_error', { message: error.message }));
      });
      child.once('exit', (code) => {
        exited = { code };
        clearTimeout(timer);
        reject(
          new HubError('agent_error', {
            message:
              lastLine(output) ?? `the sign-in ended (exit ${String(code)}) before it gave a link`,
            details: { reason: 'sign_in_ended' },
          }),
        );
      });
    });

    const expiresAt = this.now() + (prompt.expiresIn ?? this.defaultExpiresIn) * 1000;
    const record: Record_ = {
      id: newUlid(),
      agentId,
      child,
      output,
      prompt,
      expiresAt,
      status: 'pending',
      error: null,
      timer: null,
    };
    const append = (chunk: Buffer | string) => {
      record.output = (record.output + String(chunk)).slice(-8192);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const settle = (code: number | null) => {
      if (record.timer) clearTimeout(record.timer);
      if (record.status !== 'pending') return;
      if (code === 0) {
        record.status = 'approved';
        return;
      }
      const after = record.output.slice(record.output.indexOf(prompt.url) + prompt.url.length);
      record.status = DENIED.test(after) ? 'denied' : 'failed';
      record.error = lastLine(after) ?? `exit ${String(code)}`;
    };
    if (exited) settle((exited as { code: number | null }).code);
    else child.once('exit', (code) => settle(code));
    record.timer = setTimeout(
      () => {
        if (record.status !== 'pending') return;
        record.status = 'expired';
        child.kill('SIGTERM');
      },
      Math.max(0, expiresAt - this.now()),
    );
    record.timer.unref?.();
    this.records.set(record.id, record);
    return this.view(record);
  }

  /** How one sign-in stands; 404 when the hub no longer holds it. */
  get(agentId: string, id: string): AgentSignInView {
    const record = this.records.get(id);
    if (!record || record.agentId !== agentId) throw notFound({ resource: 'sign_in', id });
    if (record.status === 'pending' && this.now() >= record.expiresAt) {
      record.status = 'expired';
      this.stop(record);
    }
    return this.view(record);
  }

  /** Stops every running sign-in (the hub closing). */
  close(): void {
    for (const record of this.records.values()) this.stop(record);
    this.records.clear();
  }

  private stop(record: Record_): void {
    if (record.timer) clearTimeout(record.timer);
    if (record.child.exitCode === null && !record.child.killed) record.child.kill('SIGTERM');
  }

  private view(record: Record_): AgentSignInView {
    return {
      id: record.id,
      status: record.status,
      user_code: record.prompt.userCode,
      verification_url: record.prompt.url,
      accepts_code: false,
      expires_at: new Date(record.expiresAt).toISOString(),
      error: record.error,
    };
  }
}
