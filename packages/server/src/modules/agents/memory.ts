/**
 * An agent's memory: the three documents Hermes reads about itself and about you.
 *
 *   soul   → `SOUL.md`    who the agent is; read at the start of every conversation
 *   memory → `MEMORY.md`  what it has learned and chose to keep
 *   user   → `USER.md`    what it knows about the person it is talking to
 *
 * Three, not a folder of files — the contract's `item_id` says so, and so does Hermes.
 * A hub that offered arbitrary filenames here would be offering a place Hermes never
 * reads, which is worse than offering nothing.
 *
 * **A document that does not exist yet is still a document.** It is listed with no
 * content rather than hidden, because "the agent has written nothing about you yet" is
 * an answer, and a page with two rows on one hub and three on another would read as a
 * bug.
 *
 * **They are emptied, not deleted.** Removing `SOUL.md` does not give an agent no
 * persona; it gives it an unpredictable one. So the file stays and its contents are
 * what a person changes.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The contract's document keys, in the order a person meets them. */
export const DOCUMENTS = {
  soul: 'SOUL.md',
  memory: 'MEMORY.md',
  user: 'USER.md',
} as const;
export type DocumentKey = keyof typeof DOCUMENTS;
export const DOCUMENT_KEYS = Object.keys(DOCUMENTS) as DocumentKey[];

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
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'MemoryError';
  }
}

export function isDocumentKey(id: string): id is DocumentKey {
  return Object.prototype.hasOwnProperty.call(DOCUMENTS, id);
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
  return isDocumentKey(id) ? read(home, id) : null;
}

export function putMemory(home: string, id: string, content: string): MemoryDocument {
  if (!isDocumentKey(id)) throw new MemoryError('memory_document_unknown');
  writeFileSync(path.join(home, DOCUMENTS[id]), content, 'utf8');
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
