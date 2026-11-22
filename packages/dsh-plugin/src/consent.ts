/**
 * Asking the person on this computer (ADR 0033 §4, §5; ADR 0025 decision 8):
 *
 * - **Programs** (`apps`): once per session per program — Allow once, Allow for this session,
 *   or Deny. "This session" lasts until the harness quits or the program's settings change.
 * - **Screen tasks**: every task — Allow or Deny.
 *
 * Where the question is shown: the harness's own question service when it has an answerer for
 * a question that belongs to no chat (the harness routes its Web answerer only to a live
 * agent's questions, and a hub's request belongs to none), otherwise the operating system's own
 * dialog — `osascript` on macOS, Windows PowerShell's message box, `zenity` or `kdialog` on
 * Linux. Without any of them the answer is Deny, with a reason the hub shows its agent.
 *
 * One question at a time: a second one waits for the person's answer to the first.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type ConsentAnswer = 'once' | 'session' | 'deny';

export interface ConsentQuestion {
  /** What is asking: a program's id, or `screen` for a screen task. */
  key: string;
  /** The dialog's title. */
  title: string;
  /** The dialog's text. */
  message: string;
  /** Labels in the person's language. */
  labels: { once: string; session: string | null; deny: string };
}

export type Asker = (question: ConsentQuestion) => Promise<ConsentAnswer>;

export class ConsentGate {
  private readonly allowed = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly ask: Asker) {}

  /** Whether this call may go ahead; asks when this session has no answer for the key yet. */
  check(question: ConsentQuestion, options: { everyTime?: boolean } = {}): Promise<boolean> {
    const next = this.chain.then(async () => {
      if (!options.everyTime && this.allowed.has(question.key)) return true;
      let answer: ConsentAnswer;
      try {
        answer = await this.ask(question);
      } catch {
        answer = 'deny';
      }
      if (answer === 'session' && !options.everyTime) this.allowed.add(question.key);
      return answer !== 'deny';
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  allowedForSession(key: string): boolean {
    return this.allowed.has(key);
  }

  /** Settings changed: the next use asks again. */
  forget(key?: string): void {
    if (key === undefined) this.allowed.clear();
    else this.allowed.delete(key);
  }
}

export interface ExecResult {
  code: number | null;
  stdout: string;
}

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

export const realExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: false, encoding: 'utf8' },
      (error, stdout) => {
        const raw = error ? (error as { code?: unknown }).code : 0;
        resolve({ code: typeof raw === 'number' ? raw : null, stdout: String(stdout ?? '') });
      },
    );
  });

/** How long the person has to answer before the question counts as Deny. */
export const DIALOG_TIMEOUT_MS = 2 * 60_000;

/** An AppleScript string literal. */
const asString = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** A PowerShell single-quoted literal. */
const psQuote = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** The command that shows the question on this OS, or null when there is none. */
export function dialogCommand(
  question: ConsentQuestion,
  env: {
    platform: NodeJS.Platform;
    vars: NodeJS.ProcessEnv;
    exists: (file: string) => boolean;
  },
): { file: string; args: string[]; read: (r: ExecResult) => ConsentAnswer } | null {
  const { labels } = question;
  if (env.platform === 'darwin') {
    const buttons = [labels.deny, labels.once, ...(labels.session ? [labels.session] : [])];
    const script = [
      `set r to display dialog ${asString(question.message)} with title ${asString(question.title)}`,
      `buttons {${buttons.map(asString).join(', ')}} default button ${asString(labels.once)}`,
      `cancel button ${asString(labels.deny)} with icon caution giving up after ${Math.floor(DIALOG_TIMEOUT_MS / 1000) - 5}`,
    ].join(' ');
    return {
      file: '/usr/bin/osascript',
      args: ['-e', `${script}`, '-e', 'return button returned of r'],
      read: (r) => {
        const out = r.stdout.trim();
        if (r.code !== 0 || out === '') return 'deny';
        if (labels.session && out === labels.session) return 'session';
        return out === labels.once ? 'once' : 'deny';
      },
    };
  }
  if (env.platform === 'win32') {
    const root = env.vars.SystemRoot || env.vars.SYSTEMROOT || 'C:\\Windows';
    const ps = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Yes = for this session, No = once, Cancel = deny (said in the text, which lists them).
    const text = labels.session
      ? `${question.message}\n\n[Yes] ${labels.session}\n[No] ${labels.once}\n[Cancel] ${labels.deny}`
      : `${question.message}\n\n[OK] ${labels.once}\n[Cancel] ${labels.deny}`;
    const kind = labels.session ? 'YesNoCancel' : 'OKCancel';
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `$r = [System.Windows.Forms.MessageBox]::Show(${psQuote(text)}, ${psQuote(question.title)}, '${kind}', 'Warning')`,
      'Write-Output $r',
    ].join('; ');
    return {
      file: ps,
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
      read: (r) => {
        const out = r.stdout.trim();
        if (out === 'Yes') return 'session';
        if (out === 'No' || out === 'OK') return 'once';
        return 'deny';
      },
    };
  }
  if (!(env.vars.DISPLAY || env.vars.WAYLAND_DISPLAY)) return null;
  const zenity = ['/usr/bin/zenity', '/bin/zenity'].find(env.exists);
  if (zenity) {
    return {
      file: zenity,
      args: [
        '--question',
        `--title=${question.title}`,
        `--text=${question.message}`,
        `--ok-label=${labels.once}`,
        `--cancel-label=${labels.deny}`,
        ...(labels.session ? [`--extra-button=${labels.session}`] : []),
        '--no-markup',
      ],
      read: (r) => {
        if (r.code === 0) return 'once';
        if (labels.session && r.stdout.trim() === labels.session) return 'session';
        return 'deny';
      },
    };
  }
  const kdialog = ['/usr/bin/kdialog', '/bin/kdialog'].find(env.exists);
  if (kdialog) {
    return labels.session
      ? {
          file: kdialog,
          args: [
            '--title',
            question.title,
            '--yesnocancel',
            question.message,
            '--yes-label',
            labels.session,
            '--no-label',
            labels.once,
            '--cancel-label',
            labels.deny,
          ],
          read: (r) => (r.code === 0 ? 'session' : r.code === 1 ? 'once' : 'deny'),
        }
      : {
          file: kdialog,
          args: [
            '--title',
            question.title,
            '--yesno',
            question.message,
            '--yes-label',
            labels.once,
            '--no-label',
            labels.deny,
          ],
          read: (r) => (r.code === 0 ? 'once' : 'deny'),
        };
  }
  return null;
}

/** The OS dialog as an {@link Asker}; Deny when this computer has no way to show one. */
export function systemAsker(
  options: {
    platform?: NodeJS.Platform;
    vars?: NodeJS.ProcessEnv;
    exists?: (file: string) => boolean;
    exec?: Exec;
  } = {},
): Asker {
  const exec = options.exec ?? realExec;
  return async (question) => {
    const command = dialogCommand(question, {
      platform: options.platform ?? process.platform,
      vars: options.vars ?? process.env,
      exists: options.exists ?? existsSync,
    });
    if (!command) return 'deny';
    const result = await exec(command.file, command.args, DIALOG_TIMEOUT_MS);
    return command.read(result);
  };
}
