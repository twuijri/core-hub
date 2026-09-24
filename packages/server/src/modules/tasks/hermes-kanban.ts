/**
 * The bridge to Hermes's own kanban.
 *
 * Hermes keeps a board of its own — the one its dispatcher hands work out from — in a
 * SQLite file it owns. The owner's decision (2026-09-23) is that the hub's board is the
 * one page for everything, that it **reflects** Hermes's board, and that **Hermes wins**
 * any disagreement, because Hermes is the one doing the work.
 *
 * So this file never touches that SQLite file. Every read and every move goes through
 * `hermes kanban … --json`, Hermes's own command (the writes the command has no verb for —
 * a card's words, deletion, comments, reassignment — go through Hermes's own server instead,
 * `hermes-api.ts`, never the file either):
 *
 * - the file's schema is Hermes's internal business and changes between releases; the
 *   command's JSON is what Hermes itself serialises, so it survives an upgrade;
 * - Hermes enforces its own state machine inside those commands — a card that cannot be
 *   blocked from `todo` is refused *by Hermes*, and the hub relays the refusal instead of
 *   keeping a second copy of the rules that would drift the day Hermes changes them.
 *
 * Everything below was checked against the real CLI of the pinned release
 * (`v2026.9.14`), run from its source, not against a fake that agrees with us.
 */

import { execFile } from 'node:child_process';

/** A card as `hermes kanban list --json` and `create --json` return it (the part we use). */
export interface HermesTask {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: string;
  priority: number;
  created_at: number;
  /** Epoch seconds, set when the card reached `done`. */
  completed_at?: number | null;
  result: string | null;
}

/** Hermes's nine statuses — the same nine as the contract's `TaskStatus`, by design. */
export const HERMES_STATUSES = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
  'archived',
] as const;

/** One run of `hermes kanban <argv>`: exit code and both streams. */
export interface KanbanResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type KanbanRunner = (argv: readonly string[]) => Promise<KanbanResult>;

/** Hermes said no. `message` is Hermes's own sentence, relayed as it wrote it. */
export class HermesRefusal extends Error {
  constructor(
    readonly verb: string,
    message: string,
  ) {
    super(message);
    this.name = 'HermesRefusal';
  }
}

/**
 * The line worth showing from a failed command.
 *
 * Hermes also writes operational warnings to stderr — on this host, one about SQLite's
 * WAL bug on every run — so the useful sentence is the last line that is not one of
 * those. Without this, a person asking why a card would not move would be told about the
 * database journal.
 */
export function refusalOf(result: KanbanResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/WAL-reset|journal_mode|hermes doctor/i.test(line));
  return lines.at(-1) ?? `hermes kanban exited with ${result.code}`;
}

/** Parse Hermes's JSON from stdout only; anything on stderr is not part of the answer. */
function json<T>(result: KanbanResult, verb: string): T {
  if (result.code !== 0) throw new HermesRefusal(verb, refusalOf(result));
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new HermesRefusal(verb, `hermes kanban ${verb} did not answer JSON`);
  }
}

/**
 * The verb that moves a Hermes card from one status to another, or `null` when there
 * is none to try.
 *
 * Checked move by move against the real CLI. Where Hermes lands somewhere other than
 * where our board aimed, the comment says so — and the board is fine with it, because
 * the two statuses share a column:
 *
 *   blocked | scheduled → todo    `unblock`        Hermes lands on `ready` (same column)
 *   review → todo                 `reopen-review`  Hermes lands on `ready` (same column)
 *   triage → todo                 `specify`        runs a model to write the spec; fails
 *                                                  without one, and says so
 *   todo → blocked                `block`          Hermes refuses: it blocks from ready
 *                                                  and running only. Tried anyway, so the
 *                                                  refusal is Hermes's own words
 *
 * `running` is never a target: a card runs when Hermes's worker claims it.
 */
export function verbFor(
  from: string,
  to: string,
  id: string,
  reason?: string | null,
): string[] | null {
  if (to === 'running' || from === to) return null;
  const because = reason?.trim() || '—';
  switch (to) {
    case 'todo':
      if (from === 'triage') return ['specify', id];
      if (from === 'review') return ['reopen-review', id];
      if (from === 'blocked' || from === 'scheduled') return ['unblock', id];
      return null;
    case 'ready':
      if (from === 'todo') return ['promote', id];
      if (from === 'review') return ['reopen-review', id];
      if (from === 'blocked' || from === 'scheduled') return ['unblock', id];
      return null;
    case 'scheduled':
      return ['schedule', id, because];
    case 'blocked':
      return ['block', id, because];
    case 'review':
      return ['request-review', id];
    case 'done':
      return ['complete', id];
    case 'archived':
      return ['archive', id];
    default:
      return null;
  }
}

export interface HermesKanban {
  /** Every card on the board, archived ones excluded (Hermes's default). */
  list(): Promise<HermesTask[]>;
  /** One card, or `null` when Hermes does not know it. */
  show(id: string): Promise<HermesTask | null>;
  create(input: {
    title: string;
    body?: string | null;
    /** Our id, so a retried create returns the card it already made. */
    idempotencyKey: string;
    triage?: boolean;
    /** The Hermes profile that works the card (a workspace is a profile, ADR 0014). */
    assignee?: string | null;
    /** Hermes's integer priority (`0` is its default; higher is claimed first). */
    priority?: number;
  }): Promise<HermesTask>;
  /** Archive finished cards, several in one call (`hermes kanban archive <ids…>`). */
  archive(ids: readonly string[]): Promise<void>;
  /** Ask Hermes to move a card. Throws `HermesRefusal` with Hermes's words when it won't. */
  move(id: string, from: string, to: string, reason?: string | null): Promise<void>;
}

export function createHermesKanban(run: KanbanRunner): HermesKanban {
  return {
    async list() {
      return json<HermesTask[]>(await run(['list', '--json']), 'list');
    },
    async show(id) {
      const result = await run(['show', id, '--json']);
      if (result.code !== 0) return null;
      const body = JSON.parse(result.stdout) as { task?: HermesTask } & HermesTask;
      return body.task ?? body;
    },
    async create(input) {
      const argv = ['create', input.title];
      if (input.body) argv.push('--body', input.body);
      if (input.triage) argv.push('--triage');
      if (input.assignee) argv.push('--assignee', input.assignee);
      if (input.priority !== undefined) argv.push('--priority', String(input.priority));
      argv.push('--idempotency-key', input.idempotencyKey, '--json');
      return json<HermesTask>(await run(argv), 'create');
    },
    async archive(ids) {
      if (ids.length === 0) return;
      const result = await run(['archive', ...ids]);
      if (result.code !== 0) throw new HermesRefusal('archive', refusalOf(result));
    },
    async move(id, from, to, reason) {
      const argv = verbFor(from, to, id, reason);
      if (!argv) {
        throw new HermesRefusal('move', `Hermes has no move from ${from} to ${to}`);
      }
      const result = await run(argv);
      if (result.code !== 0) throw new HermesRefusal(argv[0] ?? 'move', refusalOf(result));
    },
  };
}

/**
 * Run `hermes kanban …` as a child process.
 *
 * An argument array, never a shell string (AGENTS.md): a card title is typed by a person
 * and may contain anything, and a title is not a command. `HERMES_HOME` points the CLI at
 * the same home the supervised gateway uses, so both see one board.
 *
 * `command` is the hermes executable; `prefix` exists so a test can run the pinned source
 * as `python3 <shim>` instead, through the very same code path.
 */
export function processRunner(options: {
  command: string;
  prefix?: readonly string[];
  home: string;
  /** The whole environment: nothing is inherited from the hub's own process. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): KanbanRunner {
  return (argv) =>
    new Promise((resolve) => {
      execFile(
        options.command,
        [...(options.prefix ?? ['kanban']), ...argv],
        {
          env: { ...options.env, HERMES_HOME: options.home },
          timeout: options.timeoutMs ?? 30_000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}
