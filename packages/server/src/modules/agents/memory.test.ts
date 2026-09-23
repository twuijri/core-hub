/**
 * Memory is three documents Hermes reads about itself and about you — not a folder.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteMemory, getMemory, listMemory, putMemory } from './memory.js';

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-memory-'));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(dir: string): void {
  writeFileSync(path.join(dir, 'SOUL.md'), 'You are Hermes.\n', 'utf8');
  writeFileSync(path.join(dir, 'USER.md'), 'يفضّل الردود القصيرة.\n', 'utf8');
}

describe('reading memory', () => {
  it('is always the same three documents, in the order a person meets them', () => {
    expect(listMemory(home()).map((item) => item.id)).toEqual(['soul', 'memory', 'user']);
  });

  it('lists a document that does not exist yet rather than hiding it', () => {
    // "The agent has written nothing about you yet" is an answer. A page with two rows
    // on one hub and three on another would read as a bug.
    const dir = home();
    seed(dir);
    const memory = listMemory(dir).find((item) => item.id === 'memory');
    expect(memory?.exists).toBe(false);
    expect(memory?.content).toBe('');
  });

  it('reads the words that are there, in whatever language they are in', () => {
    const dir = home();
    seed(dir);
    expect(getMemory(dir, 'user')?.content).toBe('يفضّل الردود القصيرة.\n');
    expect(getMemory(dir, 'soul')?.exists).toBe(true);
  });

  it('searches the words as well as the names', () => {
    const dir = home();
    seed(dir);
    expect(listMemory(dir, 'القصيرة').map((item) => item.id)).toEqual(['user']);
    expect(listMemory(dir, 'soul').map((item) => item.id)).toEqual(['soul']);
  });

  it('knows nothing of a key that is not one of the three', () => {
    expect(getMemory(home(), 'notes')).toBeNull();
    expect(getMemory(home(), '../SOUL.md')).toBeNull();
  });
});

describe('writing memory', () => {
  it('writes the document the key names', () => {
    const dir = home();
    putMemory(dir, 'soul', 'You are terse.\n');
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toBe('You are terse.\n');
    expect(getMemory(dir, 'soul')?.exists).toBe(true);
  });

  it('creates a document the agent had not written yet', () => {
    const dir = home();
    putMemory(dir, 'user', 'يعمل على مجلس.');
    expect(existsSync(path.join(dir, 'USER.md'))).toBe(true);
  });

  it('refuses a key it does not know, rather than writing a file nothing reads', () => {
    expect(() => putMemory(home(), 'notes', 'x')).toThrow(/document_unknown/);
  });
});

describe('removing memory', () => {
  it('refuses: a document is emptied by editing, not deleted', () => {
    // Removing SOUL.md does not leave an agent with no persona — it leaves it with an
    // unpredictable one.
    const dir = home();
    seed(dir);
    expect(() => deleteMemory(dir, 'soul')).toThrow(/document_protected/);
    expect(existsSync(path.join(dir, 'SOUL.md'))).toBe(true);
  });
});
