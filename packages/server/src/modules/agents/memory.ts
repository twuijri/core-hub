/**
 * An agent's memory: the three documents Hermes reads about itself and about you, where
 * Hermes itself reads and writes them in the selected profile's home (`profile-home.ts`).
 *
 *   soul   → `SOUL.md`             who the agent is; read when a conversation starts
 *   memory → `memories/MEMORY.md`  what it has learned and chose to keep
 *   user   → `memories/USER.md`    what it knows about the person it is talking to
 *
 * What Hermes does with them (read in its MIT source, `tools/memory_tool.py`,
 * `tools/memory_tool_store.py`, `agent/prompt_builder.py` §load_soul_md; specified here in our
 * words — docs/changes/2026-09-24-twuijri-memory-page-paths.md):
 *
 * - `SOUL.md` sits at the profile home's root; `MEMORY.md` and `USER.md` sit in its
 *   `memories/` folder. The default profile's home is Hermes's root home; a named profile's is
 *   `<root>/profiles/<name>`. A `MEMORY.md` at the home's root is read by nobody.
 * - The two memory files are **lists of entries**, separated by a line holding only `§`
 *   (`"\n§\n"` exactly). Hermes trims each entry, drops empty ones, and writes the list back
 *   joined by that separator, with no trailing newline.
 * - Each has a **budget in characters** over the joined text: `memory.memory_char_limit`
 *   (2200) and `memory.user_char_limit` (1375) in the profile's `config.yaml`. Hermes loads a
 *   file over budget without cutting it, but then refuses every new entry the agent tries to
 *   add; and when one entry alone is over budget it refuses to change the file at all.
 * - All three are read **when a conversation starts** and frozen for it: a change here reaches
 *   the next conversation, not one already open.
 *
 * So the hub writes what Hermes can round-trip: the separator made exact, entries trimmed,
 * and a document that would grow past its budget is refused with the budget — shrinking an
 * already over-budget document is always allowed.
 *
 * **A document that does not exist yet is still a document.** It is listed with no
 * content rather than hidden, because "the agent has written nothing about you yet" is
 * an answer, and a page with two rows on one hub and three on another would read as a
 * bug.
 *
 * **They are emptied, not deleted.** Removing `SOUL.md` does not give an agent no
 * persona; it gives it an unpredictable one. So the file stays and its contents are
 * what a person changes.
 *
 * **Earlier hubs wrote `MEMORY.md` and `USER.md` at the home's root**, where Hermes never
 * looks. `migrateLegacyMemory` moves such a file once into `memories/`; see there.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** The contract's document keys, in the order a person meets them, and where Hermes keeps each. */
export const DOCUMENTS = {
  soul: 'SOUL.md',
  memory: 'memories/MEMORY.md',
  user: 'memories/USER.md',
} as const;
export type DocumentKey = keyof typeof DOCUMENTS;
export const DOCUMENT_KEYS = Object.keys(DOCUMENTS) as DocumentKey[];

/** Where earlier hubs wrote the two memory files — a place Hermes never reads. */
export const LEGACY_DOCUMENTS = {
  memory: 'MEMORY.md',
  user: 'USER.md',
} as const;
type ListKey = keyof typeof LEGACY_DOCUMENTS;

/** Hermes's entry separator: a line holding only `§`. */
export const ENTRY_SEPARATOR = '\n§\n';

/** Hermes's budgets when the profile's `config.yaml` names none. */
export const DEFAULT_LIMITS: Record<ListKey, number> = { memory: 2200, user: 1375 };
const LIMIT_KEYS: Record<ListKey, string> = {
  memory: 'memory_char_limit',
  user: 'user_char_limit',
};

/** What a hub-written entry carries when it joins entries Hermes already kept (migration). */
export const LEGACY_MARKER = "Written on the hub's Memory page (moved here from the profile root):";

export interface MemoryDocument {
  id: DocumentKey;
  title: string;
  /** Empty string when the file is not there yet — not null, because it is writable. */
  content: string;
  updatedAt: Date | null;
  /** True once the agent or a person has actually written it. */
  exists: boolean;
}

export class MemoryError extends Error {
  constructor(
    readonly reason: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = 'MemoryError';
  }
}

export function isDocumentKey(id: string): id is DocumentKey {
  return Object.prototype.hasOwnProperty.call(DOCUMENTS, id);
}

function isListKey(id: DocumentKey): id is ListKey {
  return id !== 'soul';
}

/** The entries Hermes would see: split on the separator (a `§` line), trimmed, empties dropped. */
export function entriesOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*§[ \t]*\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** The text Hermes writes for a list of entries — and reads back unchanged. */
export function joinEntries(entries: readonly string[]): string {
  return entries.join(ENTRY_SEPARATOR);
}

/** Hermes counts characters (code points) of the joined text, not UTF-16 units. */
function lengthOf(text: string): number {
  return [...text].length;
}

/** The profile's budget for a list, from its `config.yaml` (`memory.*_char_limit`). */
export function memoryLimit(home: string, id: ListKey): number {
  try {
    const config = parseYaml(readFileSync(path.join(home, 'config.yaml'), 'utf8')) as unknown;
    const section = (config as { memory?: unknown } | null)?.memory;
    const value =
      section && typeof section === 'object'
        ? (section as Record<string, unknown>)[LIMIT_KEYS[id]]
        : undefined;
    const limit = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0) return limit;
  } catch {
    // no config, or not YAML Hermes could read either — Hermes then uses its defaults too
  }
  return DEFAULT_LIMITS[id];
}

/** Replaces a file in one step, so Hermes never reads half of it. */
function writeAtomically(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.majlis-${path.basename(file)}.${randomBytes(6).toString('hex')}`,
  );
  writeFileSync(temporary, content, 'utf8');
  try {
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // nothing left to clean
    }
    throw error;
  }
}

function readIfFile(file: string): string | null {
  try {
    return statSync(file).isFile() ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

export type LegacyOutcome =
  /** Hermes's file was missing or empty: ours became it. */
  | 'moved'
  /** Both had words: Hermes's entries kept first, ours appended as marked entries. */
  | 'merged'
  /** Ours was already in Hermes's file (an earlier move that stopped before cleaning up). */
  | 'already_there'
  /** Ours held nothing but whitespace. */
  | 'removed_empty';

export interface LegacyMigration {
  id: ListKey;
  outcome: LegacyOutcome;
}

/**
 * Moves what earlier hubs wrote at the home's root (`MEMORY.md`, `USER.md`) into the files
 * Hermes reads (`memories/…`), once. No word is dropped:
 *
 * - Hermes's file missing or empty → ours becomes it (entries made Hermes-exact).
 * - Both have words → Hermes's entries stay as they are and first; ours follow as entries of
 *   their own, the first one opened by `LEGACY_MARKER` so a person and the agent can tell
 *   where they came from. Nothing is shortened to fit the budget: over it, Hermes keeps
 *   everything and the page shows it, so a person decides what goes.
 * - The root file is removed only after Hermes's file holds its words. If the move stopped
 *   between the two, the next call sees the words already there and only cleans up.
 *
 * Runs at boot for every profile and before every memory read or write, so it costs two
 * `stat`s when there is nothing to move. A file it cannot read is left where it is.
 */
export function migrateLegacyMemory(home: string): LegacyMigration[] {
  const done: LegacyMigration[] = [];
  for (const id of Object.keys(LEGACY_DOCUMENTS) as ListKey[]) {
    const legacyFile = path.join(home, LEGACY_DOCUMENTS[id]);
    const legacy = readIfFile(legacyFile);
    if (legacy === null) continue;
    const ours = entriesOf(legacy);
    const realFile = path.join(home, DOCUMENTS[id]);
    const real = readIfFile(realFile);
    if (real === null && existsSync(realFile)) continue; // there but unreadable: touch nothing
    const theirs = entriesOf(real ?? '');

    let outcome: LegacyOutcome;
    if (ours.length === 0) {
      outcome = 'removed_empty';
    } else if (theirs.length === 0) {
      writeAtomically(realFile, joinEntries(ours));
      outcome = 'moved';
    } else if (ours.every((entry) => (real ?? '').includes(entry))) {
      outcome = 'already_there';
    } else {
      const [first, ...rest] = ours;
      writeAtomically(realFile, joinEntries([...theirs, `${LEGACY_MARKER}\n${first}`, ...rest]));
      outcome = 'merged';
    }
    unlinkSync(legacyFile);
    done.push({ id, outcome });
  }
  return done;
}

function read(home: string, id: DocumentKey): MemoryDocument {
  const file = path.join(home, DOCUMENTS[id]);
  if (!existsSync(file)) {
    return { id, title: DOCUMENTS[id], content: '', updatedAt: null, exists: false };
  }
  return {
    id,
    title: DOCUMENTS[id],
    content: readFileSync(file, 'utf8'),
    updatedAt: statSync(file).mtime,
    exists: true,
  };
}

/** All three, with their words. A search filters them; it does not hide the set. */
export function listMemory(home: string, search?: string): MemoryDocument[] {
  migrateLegacyMemory(home);
  const all = DOCUMENT_KEYS.map((id) => read(home, id));
  const needle = (search ?? '').trim().toLowerCase();
  if (needle === '') return all;
  return all.filter(
    (item) =>
      item.id.includes(needle) ||
      item.title.toLowerCase().includes(needle) ||
      item.content.toLowerCase().includes(needle),
  );
}

export function getMemory(home: string, id: string): MemoryDocument | null {
  if (!isDocumentKey(id)) return null;
  migrateLegacyMemory(home);
  return read(home, id);
}

export function putMemory(home: string, id: string, content: string): MemoryDocument {
  if (!isDocumentKey(id)) throw new MemoryError('memory_document_unknown');
  migrateLegacyMemory(home);
  const file = path.join(home, DOCUMENTS[id]);
  if (!isListKey(id)) {
    writeAtomically(file, content);
    return read(home, id);
  }
  const text = joinEntries(entriesOf(content));
  const limit = memoryLimit(home, id);
  const length = lengthOf(text);
  if (length > limit) {
    // Growing past the budget would leave the agent unable to add anything; shrinking a
    // document that is already over it (an editor, an older hub) is always allowed.
    const current = lengthOf(joinEntries(entriesOf(readIfFile(file) ?? '')));
    if (length > current) throw new MemoryError('memory_too_long', { limit, length });
  }
  writeAtomically(file, text);
  return read(home, id);
}

/**
 * There is nothing to delete.
 *
 * Removing `SOUL.md` does not leave an agent with no persona — it leaves it with an
 * unpredictable one. Emptying it is the operation that means what a person intends, and
 * it is an edit.
 */
export function deleteMemory(_home: string, id: string): never {
  throw new MemoryError(
    isDocumentKey(id) ? 'memory_document_protected' : 'memory_document_unknown',
  );
}
