/**
 * Screen tasks (ADR 0033 §5): the hub's agent hands this computer a task in words; the plugin
 * asks the person (Allow / Deny, every task), runs a local harness session with Computer Use on
 * a hub model, and answers with a short outcome and one final screenshot. The screen never
 * streams to the hub and the hub never sends clicks.
 *
 * How the session runs — the closest documented route the harness offers a plugin: its one-shot
 * runner (`dsh-headless`, `dsh --profile <p> --json "<task>"`) in a profile the plugin composes
 * for this (`corehub-screen`): dsh-base + dsh-headless + the Computer Use bundle, the PTC tool
 * executor (the `ptc.yml` overlay), the hub as its only model provider, and a consent answerer
 * (`screen-consent.ts`) that grants Computer Use's per-application questions for this run only,
 * limited to the requested app — because the person already allowed the task. The child's
 * newline-delimited JSON events give progress; its `final` event the outcome. The screenshot is
 * taken after the run with macOS's own `screencapture`.
 *
 * Only macOS: elsewhere the device never advertises `screen_task`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { API_BASE, GATEWAY, PROVIDER_ID, SCREEN_PROFILE, TOKEN_ENV } from './names.js';
import { writePrivate } from './store.js';

export const DEFAULT_BUDGET_S = 300;
export const MIN_BUDGET_S = 10;
export const MAX_BUDGET_S = 3600;
export const SOFT_DEADLINE_MS = 20_000;
const KEEP_FINISHED_MS = 60 * 60_000;
const MAX_TASK_CHARS = 4000;

export interface ScreenRequest {
  task: string;
  app: string | null;
  timeBudgetS: number;
  model: string | null;
}

export type ScreenParse = { ok: true; request: ScreenRequest } | { ok: false; message: string };

/** `{ task, app?, time_budget_s?, model? }`, validated. */
export function parseScreenRequest(params: Record<string, unknown>): ScreenParse {
  const task = typeof params.task === 'string' ? params.task.trim() : '';
  if (task === '') return { ok: false, message: 'A screen task needs `task`, in words.' };
  if (task.length > MAX_TASK_CHARS)
    return { ok: false, message: `The task is over ${MAX_TASK_CHARS} characters.` };
  const app = typeof params.app === 'string' && params.app.trim() !== '' ? params.app.trim() : null;
  const raw = params.time_budget_s;
  const budget =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.max(MIN_BUDGET_S, Math.min(Math.floor(raw), MAX_BUDGET_S))
      : DEFAULT_BUDGET_S;
  const model =
    typeof params.model === 'string' && params.model.trim() !== '' ? params.model.trim() : null;
  return {
    ok: true,
    request: { task, app: app?.slice(0, 120) ?? null, timeBudgetS: budget, model },
  };
}

/** What the session is told; the hub's words stay the task, the rest is the frame. */
export function screenPrompt(request: ScreenRequest): string {
  return [
    'You are operating this Mac for its owner with Computer Use, on their explicit permission for this one task.',
    request.app
      ? `Work only in the application "${request.app}". Do not open or touch any other application.`
      : 'Use only the applications the task needs.',
    `Finish within about ${request.timeBudgetS} seconds. Do not ask questions: no one is watching to answer.`,
    'Do not enter passwords, payment details or other secrets, and do not send, buy, delete or publish anything the task does not explicitly ask for.',
    'When you are done (or cannot continue), reply with a short plain outcome: what you did and what is now on the screen.',
    '',
    'Task:',
    request.task,
  ].join('\n');
}

export interface ScreenFold {
  sessionId: string | null;
  steps: number;
  lastText: string | null;
  finalText: string | null;
  reason: string | null;
  error: string | null;
  finished: boolean;
}

export const emptyFold = (): ScreenFold => ({
  sessionId: null,
  steps: 0,
  lastText: null,
  finalText: null,
  reason: null,
  error: null,
  finished: false,
});

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Folds one `--json` event line of the headless runner into the run's state. */
export function foldEvent(state: ScreenFold, line: string): ScreenFold {
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return state;
    event = parsed as Record<string, unknown>;
  } catch {
    return state;
  }
  switch (event.type) {
    case 'session':
      return { ...state, sessionId: str(event.sessionId) ?? state.sessionId };
    case 'tool_call':
      return { ...state, steps: state.steps + 1 };
    case 'text':
      return { ...state, lastText: str(event.text) ?? state.lastText };
    case 'error':
      return {
        ...state,
        error: str(event.message) ?? str(event.code) ?? 'the session failed',
        finished: true,
      };
    case 'final': {
      const reason = event.reason as Record<string, unknown> | null | undefined;
      return {
        ...state,
        sessionId: str(event.sessionId) ?? state.sessionId,
        finalText: str(event.text) ?? str(event.answer) ?? str(event.result) ?? state.lastText,
        reason: reason && typeof reason === 'object' ? (str(reason.kind) ?? 'unknown') : null,
        finished: true,
      };
    }
    default:
      return state;
  }
}

/** The patch of the screen profile: PTC, the hub as model provider, Computer Use, consent. */
export function screenPatch(options: {
  hub: string;
  model: string;
  consentPlugin: string;
  app: string | null;
}): string {
  const q = (v: string) => JSON.stringify(v);
  return [
    '# Written by the Core Hub plugin for screen tasks (ADR 0033 §5). Rewritten before every task.',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${PROVIDER_ID}:`,
    '        displayName: Core Hub',
    '        api: openai-completions',
    `        baseURL: ${q(`${options.hub}${API_BASE}${GATEWAY.openai}`)}`,
    `        apiKeyEnv: ${TOKEN_ENV}`,
    '        defaultInput: [text, image]',
    '        compat:',
    '          supportsDeveloperRole: false',
    '          maxTokensField: max_tokens',
    '        models:',
    `          - id: ${q(options.model)}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${PROVIDER_ID}`,
    `    model: ${q(options.model)}`,
    '- id: tool-executor-native',
    '  disabled: true',
    '- id: tool-executor-ptc',
    '  disabled: false',
    '- id: tool-fs',
    '  config:',
    '    applyPatch: false',
    // Headless composes no preset registry: expose the raw `cua` binding inside run_code.
    '- id: cua-macos',
    "  disabled: !!js process.platform !== 'darwin'",
    '  config:',
    '    agentPreset: false',
    '    screenshotTarget:',
    '      longEdge: 2048',
    '      maxBytes: 2097152',
    '- insert:',
    '    - id: corehub-screen-consent',
    `      name: ${q(options.consentPlugin)}`,
    '      config:',
    `        app: ${options.app === null ? 'null' : q(options.app)}`,
    '',
  ].join('\n');
}

export const SCREEN_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-cua-bundle',
];

export function screenProfileManifest(): string {
  return `${JSON.stringify(
    {
      name: `dsh-profile-${SCREEN_PROFILE}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: SCREEN_BUNDLES } },
    },
    null,
    2,
  )}\n`;
}

/** `$DSH_HOME`, as the harness resolves it (explicit, `$DSH_HOME`, then `~/.dsh`). */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.DSH_HOME?.trim();
  if (set) return path.resolve(set);
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  return path.join(home, '.dsh');
}

/**
 * How to start the harness's own CLI from inside it: the configured command, else the script
 * this process was launched with (the npm `dsh`), run by the same Node (Electron's Node mode on
 * the desktop app), else `dsh` on the PATH.
 */
export function dshCommand(
  configured: readonly string[] | null,
  proc: { execPath: string; argv: readonly string[]; versions: NodeJS.ProcessVersions } = process,
): { file: string; args: string[]; env: Record<string, string> } {
  if (configured && configured.length > 0 && configured[0])
    return { file: configured[0], args: configured.slice(1), env: {} };
  const script = proc.argv[1];
  if (script && /(^|[\\/])(dsh|bin\.js|cli\.js)$/i.test(script))
    return {
      file: proc.execPath,
      args: [script],
      env: proc.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    };
  return { file: process.platform === 'win32' ? 'dsh.cmd' : 'dsh', args: [], env: {} };
}

/** Whether the harness installation ships Computer Use (the bundle the screen profile lists). */
export function computerUseInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('@deepseek-ai/dsh-cua-bundle/package.json');
    return true;
  } catch {
    return false;
  }
}

export type ScreenOutcome =
  | {
      state: 'done';
      outcome: string;
      screenshot_attachment_id: string | null;
      progress: string;
    }
  | { state: 'failed'; outcome: string; progress: string }
  | { state: 'running'; call_id: string; progress: string };

export interface ScreenDeps {
  /** The hub link (for the provider row) and the token the child authenticates with. */
  hub(): { hub: string; token: string } | null;
  /** The model for the session: request → settings → the first the hub's gateway lists. */
  pickModel(requested: string | null): Promise<string | null>;
  /** Uploads the screenshot into the request's profile; its attachment id. */
  upload(profile: string, file: string): Promise<string>;
  command(): { file: string; args: string[]; env: Record<string, string> };
  /** The absolute path of the consent plugin module (this package's `dist/screen-consent.js`). */
  consentPlugin: string;
  workDir: string;
  dshHome: string;
  spawn?: typeof spawn;
  capture?: (file: string) => Promise<boolean>;
  softDeadlineMs?: number;
}

interface Job {
  id: string;
  fold: ScreenFold;
  result: ScreenOutcome | null;
  finishedAt: number | null;
  child: ChildProcess | null;
}

export class ScreenRunner {
  private readonly jobs = new Map<string, Job>();
  private busy: Job | null = null;

  constructor(private readonly deps: ScreenDeps) {}

  /** Runs one (already allowed) task; answers `running` after the soft deadline. */
  async run(request: ScreenRequest, profile: string): Promise<ScreenOutcome> {
    if (this.busy && this.busy.result === null)
      return {
        state: 'failed',
        outcome: 'Another screen task is still running on this computer.',
        progress: '0 steps',
      };
    const link = this.deps.hub();
    if (!link) return failed('This computer is not linked to a hub.');
    const model = await this.deps.pickModel(request.model);
    if (!model)
      return failed('The hub offers no model to this computer (is the gateway entrance on?).');

    this.sweep();
    const job: Job = {
      id: randomBytes(12).toString('hex'),
      fold: emptyFold(),
      result: null,
      finishedAt: null,
      child: null,
    };
    this.jobs.set(job.id, job);
    this.busy = job;
    const work = this.execute(job, request, profile, link, model).then(
      (result) => {
        job.result = result;
        job.finishedAt = Date.now();
        return result;
      },
      (error: unknown) => {
        job.result = failed(error instanceof Error ? error.message : String(error), job.fold);
        job.finishedAt = Date.now();
        return job.result;
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const soon = new Promise<'running'>((resolve) => {
      timer = setTimeout(() => resolve('running'), this.deps.softDeadlineMs ?? SOFT_DEADLINE_MS);
    });
    try {
      const first = await Promise.race([work, soon]);
      return first === 'running'
        ? { state: 'running', call_id: job.id, progress: progressOf(job.fold) }
        : first;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  status(callId: string): ScreenOutcome | null {
    const job = this.jobs.get(callId);
    if (!job) return null;
    return job.result ?? { state: 'running', call_id: job.id, progress: progressOf(job.fold) };
  }

  stopAll(): void {
    for (const job of this.jobs.values()) job.child?.kill('SIGTERM');
  }

  private async execute(
    job: Job,
    request: ScreenRequest,
    profile: string,
    link: { hub: string; token: string },
    model: string,
  ): Promise<ScreenOutcome> {
    const profileDir = path.join(this.deps.dshHome, 'profiles', SCREEN_PROFILE);
    mkdirSync(profileDir, { recursive: true });
    writePrivate(path.join(profileDir, 'package.json'), screenProfileManifest());
    writePrivate(
      path.join(profileDir, 'cordis.patch.yml'),
      screenPatch({
        hub: link.hub,
        model,
        consentPlugin: this.deps.consentPlugin,
        app: request.app,
      }),
    );
    const workspace = path.join(this.deps.workDir, 'screen-workspace');
    mkdirSync(workspace, { recursive: true });

    const command = this.deps.command();
    const args = [
      ...command.args,
      '--profile',
      SCREEN_PROFILE,
      '--json',
      '--approval-policy',
      'never',
      screenPrompt(request),
    ];
    const spawnImpl = this.deps.spawn ?? spawn;
    const child = spawnImpl(command.file, args, {
      cwd: workspace,
      env: { ...process.env, ...command.env, DSH_HOME: this.deps.dshHome, [TOKEN_ENV]: link.token },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    job.child = child;
    // The last run's events and errors, for the person to read or send (the session is a
    // separate process and shows in no chat): `screen-last.log` beside the link, owner-only.
    const logFile = path.join(this.deps.workDir, 'screen-last.log');
    writePrivate(logFile, `# ${new Date().toISOString()} ${request.task.slice(0, 300)}\n`);
    const log = (line: string) => {
      try {
        appendFileSync(logFile, `${line.slice(0, 2000)}\n`);
      } catch {
        // A log that cannot be written never stops the task.
      }
    };
    let buffer = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          log(line);
          job.fold = foldEvent(job.fold, line);
        }
        nl = buffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
      for (const line of chunk.split('\n')) if (line.trim()) log(`[stderr] ${line}`);
    });
    const budget = setTimeout(() => child.kill('SIGTERM'), request.timeBudgetS * 1000 + 15_000);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        stderr = `${stderr}\n${error.message}`;
        resolve(null);
      });
      child.on('close', (c) => resolve(c));
    }).finally(() => clearTimeout(budget));
    job.child = null;
    if (buffer.trim()) job.fold = foldEvent(job.fold, buffer.trim());

    const screenshot = await this.screenshot(profile);
    const fold = job.fold;
    if (code === 0 && fold.reason === 'completed') {
      return {
        state: 'done',
        outcome: (fold.finalText ?? fold.lastText ?? 'Done.').slice(0, 4000),
        screenshot_attachment_id: screenshot,
        progress: progressOf(fold),
      };
    }
    const why =
      fold.error ??
      (fold.reason && fold.reason !== 'completed' ? `the session ended: ${fold.reason}` : null) ??
      lastLine(stderr) ??
      (code === null ? 'the harness could not be started' : `the harness exited with ${code}`);
    return failed(`${fold.finalText ? `${fold.finalText}\n` : ''}(${why})`, fold);
  }

  private async screenshot(profile: string): Promise<string | null> {
    const file = path.join(this.deps.workDir, `screen-${Date.now()}.png`);
    try {
      const capture = this.deps.capture ?? captureScreen;
      if (!(await capture(file)) || !existsSync(file) || readFileSync(file).length === 0)
        return null;
      return await this.deps.upload(profile, file);
    } catch {
      return null;
    } finally {
      rmSync(file, { force: true });
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs)
      if (job.finishedAt !== null && now - job.finishedAt > KEEP_FINISHED_MS) this.jobs.delete(id);
  }
}

/**
 * How far the session got, in words: the hub takes `progress` as text only (DECISIONS §157), and
 * refused the object this used to send, so a finished task never reached it (owner's Mac,
 * 2026-11-22: three tasks ended in `device_timeout` while the harness had done them).
 */
function progressOf(fold: ScreenFold): string {
  const steps = `${fold.steps} ${fold.steps === 1 ? 'step' : 'steps'}`;
  const last = fold.lastText?.trim().slice(0, 500);
  return last ? `${steps} · ${last}` : steps;
}

function failed(outcome: string, fold: ScreenFold = emptyFold()): ScreenOutcome {
  return { state: 'failed', outcome: outcome.slice(0, 4000), progress: progressOf(fold) };
}

function lastLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1)?.slice(0, 500) ?? null;
}

/** The whole screen, silently, with macOS's own tool. */
export function captureScreen(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    const child = spawn('/usr/sbin/screencapture', ['-x', '-t', 'png', file], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
