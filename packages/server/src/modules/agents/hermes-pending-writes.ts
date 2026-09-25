/**
 * Memory and skill writes waiting for review — Hermes's own approval gate (contract decision §56).
 *
 * With `memory.write_approval` or `skills.write_approval` on in a profile, Hermes does not save
 * what the agent writes to its memory or its skills: it keeps each write as
 * `<profile home>/pending/<memory|skills>/<id>.json` (`tools/write_approval.py` §stage_write, in
 * Hermes's MIT source) — `{id, subsystem, action, summary, origin, created_at, payload}`, where
 * `payload` is exactly what replays the write — until `/memory approve|reject <id>` or
 * `/skills approve|reject <id>` answers it.
 *
 * - **Listing** reads those files: they are Hermes's store, and a record the hub cannot read is
 *   left out rather than guessed at.
 * - **Rejecting** removes the record, which is all Hermes's own reject does (`discard_pending`).
 * - **Approving** is Hermes's to do: the write goes through its memory store (its budgets, its
 *   `§` format) or its skill manager (its checks). So the hub runs Hermes's own functions with
 *   Hermes's interpreter against the profile's home — the same calls its `/memory approve` makes
 *   on a gateway (`gateway/slash_commands.py` §_handle_memory_command): a fresh on-disk memory
 *   store, `apply_memory_pending`, or `apply_skill_pending`; the record is dropped only when Hermes
 *   says it applied.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export type PendingKind = 'memory' | 'skills';
export const PENDING_KINDS: readonly PendingKind[] = ['memory', 'skills'];

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTENT_CAP = 20_000;

export interface PendingWrite {
  id: string;
  kind: PendingKind;
  action: string;
  summary: string;
  origin: string;
  created_at: string | null;
  target: string | null;
  name: string | null;
  content: string | null;
  old_text: string | null;
}

export class PendingWriteError extends Error {
  constructor(
    readonly reason: 'pending_not_found' | 'pending_id_invalid' | 'pending_not_applied',
    readonly hermesMessage: string | null = null,
  ) {
    super(hermesMessage ?? reason);
    this.name = 'PendingWriteError';
  }
}

function folder(home: string, kind: PendingKind): string {
  return path.join(home, 'pending', kind);
}

function recordPath(home: string, kind: PendingKind, id: string): string {
  if (!ID.test(id)) throw new PendingWriteError('pending_id_invalid');
  return path.join(folder(home, kind), `${id}.json`);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.length > CONTENT_CAP ? `${value.slice(0, CONTENT_CAP)}…` : value;
}

/** A memory batch, one line per operation, as a reviewer reads it. */
function batchText(operations: unknown): string | null {
  if (!Array.isArray(operations)) return null;
  const lines = operations.map((raw) => {
    const op = (raw ?? {}) as Record<string, unknown>;
    const action = typeof op.action === 'string' ? op.action : '?';
    const content = typeof op.content === 'string' ? op.content : '';
    const old = typeof op.old_text === 'string' ? op.old_text : '';
    if (action === 'remove') return `- ${old}`;
    if (action === 'replace') return `~ ${old} → ${content}`;
    return `+ ${content}`;
  });
  return text(lines.join('\n'));
}

function toView(kind: PendingKind, record: Record<string, unknown>): PendingWrite | null {
  const id = typeof record.id === 'string' ? record.id : null;
  if (!id || !ID.test(id)) return null;
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const action =
    (typeof record.action === 'string' && record.action) ||
    (typeof payload.action === 'string' ? payload.action : '');
  const created =
    typeof record.created_at === 'number' && Number.isFinite(record.created_at)
      ? new Date(record.created_at * 1000).toISOString()
      : null;
  if (kind === 'memory') {
    return {
      id,
      kind,
      action,
      summary: typeof record.summary === 'string' ? record.summary : '',
      origin: typeof record.origin === 'string' ? record.origin : 'foreground',
      created_at: created,
      target: typeof payload.target === 'string' ? payload.target : 'memory',
      name: null,
      content: action === 'batch' ? batchText(payload.operations) : text(payload.content),
      old_text: text(payload.old_text),
    };
  }
  const skill = typeof payload.name === 'string' ? payload.name : null;
  const file = typeof payload.file_path === 'string' ? payload.file_path : null;
  return {
    id,
    kind,
    action,
    summary: typeof record.summary === 'string' ? record.summary : '',
    origin: typeof record.origin === 'string' ? record.origin : 'foreground',
    created_at: created,
    target: null,
    name: skill && file ? `${skill}/${file}` : skill,
    content:
      text(payload.content) ?? text(payload.file_content) ?? text(payload.new_string) ?? null,
    old_text: text(payload.old_string),
  };
}

function readRecord(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Every write waiting in the profile, oldest first (Hermes's own order). */
export function listPendingWrites(home: string): PendingWrite[] {
  const out: Array<PendingWrite & { at: number }> = [];
  for (const kind of PENDING_KINDS) {
    const dir = folder(home, kind);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const record = readRecord(path.join(dir, entry));
      if (!record) continue;
      const view = toView(kind, record);
      if (!view) continue;
      out.push({ ...view, at: typeof record.created_at === 'number' ? record.created_at : 0 });
    }
  }
  return out
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map(({ at: _at, ...view }) => view);
}

/** Whether `id` waits in the profile's `kind` queue. */
export function pendingWriteExists(home: string, kind: PendingKind, id: string): boolean {
  return existsSync(recordPath(home, kind, id));
}

export function rejectPendingWrite(home: string, kind: PendingKind, id: string): void {
  const file = recordPath(home, kind, id);
  if (!existsSync(file)) throw new PendingWriteError('pending_not_found');
  unlinkSync(file);
}

/**
 * Runs Hermes's Python with `HERMES_HOME` set to the profile's home; `argv` follows `-c`.
 * The whole environment is given (the runtime's `cliEnv()`); nothing is inherited.
 */
export type HermesPython = (
  home: string,
  argv: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function hermesPythonRunner(options: {
  python: string;
  env: () => NodeJS.ProcessEnv;
  timeoutMs?: number;
}): HermesPython {
  return (home, argv) =>
    new Promise((resolve) => {
      const child = spawn(options.python, ['-c', ...argv], {
        env: { ...options.env(), HERMES_HOME: home, NO_COLOR: '1' },
        cwd: home,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 1_000_000) stderr += chunk.toString('utf8');
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
}

/**
 * Hermes's own approve, for one record: the calls `/memory approve <id>` and
 * `/skills approve <id>` make, printed back as one JSON line. The kind and id arrive as
 * arguments, never inside the program text.
 */
export const APPROVE_PROGRAM = `
import json, sys
kind, pending_id = sys.argv[1], sys.argv[2]
from tools import write_approval as wa
record = wa.get_pending(kind, pending_id)
if record is None:
    print(json.dumps({"found": False}))
    sys.exit(0)
payload = record.get("payload", {})
try:
    if kind == "memory":
        from tools.memory_tool import apply_memory_pending, load_on_disk_store
        result = apply_memory_pending(payload, load_on_disk_store())
    else:
        from tools.skill_manager_tool import apply_skill_pending
        result = json.loads(apply_skill_pending(payload))
    ok = bool(result.get("success"))
    error = result.get("error") or ""
except Exception as exc:
    ok, error = False, str(exc)
if ok:
    wa.discard_pending(kind, pending_id)
print(json.dumps({"found": True, "applied": ok, "error": error}))
`;

export async function approvePendingWrite(
  python: HermesPython,
  home: string,
  kind: PendingKind,
  id: string,
): Promise<void> {
  const file = recordPath(home, kind, id);
  if (!existsSync(file)) throw new PendingWriteError('pending_not_found');
  const result = await python(home, [APPROVE_PROGRAM, kind, id]);
  const line = result.stdout.trim().split('\n').pop() ?? '';
  type Answer = { found?: boolean; applied?: boolean; error?: string };
  const answer = ((): Answer | null => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Answer) : null;
    } catch {
      return null;
    }
  })();
  if (!answer) {
    const why =
      result.stderr.trim().split('\n').filter(Boolean).pop() ?? `exit ${String(result.code)}`;
    throw new PendingWriteError('pending_not_applied', why);
  }
  if (answer.found === false) throw new PendingWriteError('pending_not_found');
  if (!answer.applied) {
    throw new PendingWriteError('pending_not_applied', answer.error || 'Hermes did not apply it');
  }
}
