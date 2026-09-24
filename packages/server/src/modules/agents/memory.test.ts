/**
 * Memory is three documents Hermes reads about itself and about you — not a folder — in the
 * places Hermes itself reads them: `SOUL.md` at the profile home, `MEMORY.md` and `USER.md`
 * in its `memories/` folder (the real Hermes proves it in `memory.real.test.ts`).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateMemoryOfEveryProfile } from './index.js';
import {
  LEGACY_MARKER,
  deleteMemory,
  entriesOf,
  getMemory,
  listMemory,
  memoryLimit,
  migrateLegacyMemory,
  putMemory,
} from './memory.js';

const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-memory-'));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes a file the way Hermes lays out a profile home. */
function put(dir: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text, 'utf8');
}

function seed(dir: string): void {
  put(dir, 'SOUL.md', 'You are Hermes.\n');
  put(dir, 'memories/USER.md', 'يفضّل الردود القصيرة.');
}

describe('reading memory', () => {
  it('is always the same three documents, in the order a person meets them', () => {
    expect(listMemory(home()).map((item) => item.id)).toEqual(['soul', 'memory', 'user']);
  });

  it('names each by where Hermes keeps it in the profile home', () => {
    expect(listMemory(home()).map((item) => item.title)).toEqual([
      'SOUL.md',
      'memories/MEMORY.md',
      'memories/USER.md',
    ]);
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
    expect(getMemory(dir, 'user')?.content).toBe('يفضّل الردود القصيرة.');
    expect(getMemory(dir, 'soul')?.exists).toBe(true);
  });

  it('shows what Hermes kept in memories/, entries and separators as Hermes wrote them', () => {
    const dir = home();
    put(dir, 'memories/MEMORY.md', 'The deploy runs on Fridays.\n§\nUse pnpm, not npm.');
    expect(getMemory(dir, 'memory')).toMatchObject({
      exists: true,
      content: 'The deploy runs on Fridays.\n§\nUse pnpm, not npm.',
    });
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
  it('writes the persona at the profile home, as it is', () => {
    const dir = home();
    putMemory(dir, 'soul', 'You are terse.\n');
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toBe('You are terse.\n');
    expect(getMemory(dir, 'soul')?.exists).toBe(true);
  });

  it('writes MEMORY.md and USER.md into memories/, where Hermes reads them — not at the root', () => {
    const dir = home();
    putMemory(dir, 'memory', 'The deploy runs on Fridays.');
    putMemory(dir, 'user', 'يعمل على كور هب.');
    expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe(
      'The deploy runs on Fridays.',
    );
    expect(readFileSync(path.join(dir, 'memories', 'USER.md'), 'utf8')).toBe('يعمل على كور هب.');
    expect(existsSync(path.join(dir, 'MEMORY.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'USER.md'))).toBe(false);
  });

  it("writes entries the way Hermes writes them, so Hermes's own edits keep working", () => {
    // Hermes refuses to change a file that does not round-trip through its entry list —
    // stray spaces round a `§`, Windows line ends, blank entries, a trailing newline.
    const dir = home();
    putMemory(dir, 'memory', '  first fact \r\n § \r\n\r\nsecond fact\n§\n\n§\nthird\n');
    expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe(
      'first fact\n§\nsecond fact\n§\nthird',
    );
  });

  it('empties a document by writing nothing, and keeps the file', () => {
    const dir = home();
    put(dir, 'memories/USER.md', 'old');
    putMemory(dir, 'user', '   ');
    expect(readFileSync(path.join(dir, 'memories', 'USER.md'), 'utf8')).toBe('');
  });

  it('leaves no temporary file behind', () => {
    const dir = home();
    putMemory(dir, 'memory', 'a');
    putMemory(dir, 'memory', 'b');
    expect(readdirSync(path.join(dir, 'memories'))).toEqual(['MEMORY.md']);
  });

  it("refuses to grow a list past the profile's budget, and says the budget", () => {
    const dir = home();
    put(dir, 'config.yaml', 'memory:\n  memory_char_limit: 20\n  user_char_limit: 10\n');
    expect(memoryLimit(dir, 'memory')).toBe(20);
    expect(memoryLimit(dir, 'user')).toBe(10);
    // 20 characters exactly, counted as Hermes counts them (code points).
    expect(() => putMemory(dir, 'memory', 'ذاكرة'.repeat(4))).not.toThrow();
    try {
      putMemory(dir, 'user', 'eleven char');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        reason: 'memory_too_long',
        details: { limit: 10, length: 11 },
      });
    }
    expect(existsSync(path.join(dir, 'memories', 'USER.md'))).toBe(false);
  });

  it("uses Hermes's own budgets when the profile names none", () => {
    const dir = home();
    expect(memoryLimit(dir, 'memory')).toBe(2200);
    expect(memoryLimit(dir, 'user')).toBe(1375);
    expect(() => putMemory(dir, 'user', 'x'.repeat(1376))).toThrow(/memory_too_long/);
  });

  it('lets a person shorten a list that is already over budget', () => {
    const dir = home();
    put(dir, 'config.yaml', 'memory:\n  user_char_limit: 10\n');
    put(dir, 'memories/USER.md', 'x'.repeat(30));
    expect(() => putMemory(dir, 'user', 'x'.repeat(25))).not.toThrow();
    expect(() => putMemory(dir, 'user', 'x'.repeat(26))).toThrow(/memory_too_long/);
  });

  it('refuses a key it does not know, rather than writing a file nothing reads', () => {
    expect(() => putMemory(home(), 'notes', 'x')).toThrow(/document_unknown/);
  });
});

describe('moving what earlier hubs wrote at the profile root', () => {
  it('moves it into memories/ when Hermes has kept nothing there', () => {
    const dir = home();
    put(dir, 'MEMORY.md', 'written on the old page\n');
    put(dir, 'memories/USER.md', '  \n');
    put(dir, 'USER.md', 'يحب القهوة.');
    expect(migrateLegacyMemory(dir)).toEqual([
      { id: 'memory', outcome: 'moved' },
      { id: 'user', outcome: 'moved' },
    ]);
    expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe(
      'written on the old page',
    );
    expect(readFileSync(path.join(dir, 'memories', 'USER.md'), 'utf8')).toBe('يحب القهوة.');
    expect(existsSync(path.join(dir, 'MEMORY.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'USER.md'))).toBe(false);
  });

  it("keeps Hermes's entries first and adds ours after them, marked, when both have words", () => {
    const dir = home();
    put(dir, 'memories/MEMORY.md', 'hermes one\n§\nhermes two');
    put(dir, 'MEMORY.md', 'ours one\n§\nours two\n');
    expect(migrateLegacyMemory(dir)).toEqual([{ id: 'memory', outcome: 'merged' }]);
    const text = readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8');
    expect(entriesOf(text)).toEqual([
      'hermes one',
      'hermes two',
      `${LEGACY_MARKER}\nours one`,
      'ours two',
    ]);
    expect(text).toBe(`hermes one\n§\nhermes two\n§\n${LEGACY_MARKER}\nours one\n§\nours two`);
    expect(existsSync(path.join(dir, 'MEMORY.md'))).toBe(false);
  });

  it('happens once: a second pass finds nothing to move', () => {
    const dir = home();
    put(dir, 'memories/MEMORY.md', 'hermes');
    put(dir, 'MEMORY.md', 'ours');
    migrateLegacyMemory(dir);
    const after = readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8');
    expect(migrateLegacyMemory(dir)).toEqual([]);
    expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe(after);
  });

  it('only cleans up when a move stopped after writing — no second copy', () => {
    const dir = home();
    put(dir, 'memories/MEMORY.md', `hermes\n§\n${LEGACY_MARKER}\nours`);
    put(dir, 'MEMORY.md', 'ours');
    expect(migrateLegacyMemory(dir)).toEqual([{ id: 'memory', outcome: 'already_there' }]);
    expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe(
      `hermes\n§\n${LEGACY_MARKER}\nours`,
    );
    expect(existsSync(path.join(dir, 'MEMORY.md'))).toBe(false);
  });

  it('removes a root file that held only whitespace, and touches nothing else', () => {
    const dir = home();
    put(dir, 'memories/MEMORY.md', 'hermes');
    put(dir, 'MEMORY.md', '\n  \n');
    expect(migrateLegacyMemory(dir)).toEqual([{ id: 'memory', outcome: 'removed_empty' }]);
    expect(readFileSync(path.join(dir, 'memories', 'MEMORY.md'), 'utf8')).toBe('hermes');
  });

  it('never moves the persona: SOUL.md at the root is where Hermes reads it', () => {
    const dir = home();
    put(dir, 'SOUL.md', 'persona');
    expect(migrateLegacyMemory(dir)).toEqual([]);
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toBe('persona');
  });

  it('moves before a read, so the page shows the words where Hermes reads them', () => {
    const dir = home();
    put(dir, 'USER.md', 'from the old page');
    expect(getMemory(dir, 'user')).toMatchObject({
      title: 'memories/USER.md',
      content: 'from the old page',
    });
    expect(existsSync(path.join(dir, 'USER.md'))).toBe(false);
  });

  it('moves every profile at boot: the default home and each named profile', () => {
    const root = home();
    put(root, 'MEMORY.md', 'default fact');
    put(root, 'profiles/b/SOUL.md', 'b');
    put(root, 'profiles/b/USER.md', 'b fact');
    const lines: unknown[] = [];
    migrateMemoryOfEveryProfile(root, {
      info: (data: unknown) => lines.push(data),
      warn: (data: unknown) => lines.push(data),
    } as never);
    expect(readFileSync(path.join(root, 'memories', 'MEMORY.md'), 'utf8')).toBe('default fact');
    expect(readFileSync(path.join(root, 'profiles', 'b', 'memories', 'USER.md'), 'utf8')).toBe(
      'b fact',
    );
    expect(lines).toEqual([
      { profile: 'default', moved: [{ id: 'memory', outcome: 'moved' }] },
      { profile: 'b', moved: [{ id: 'user', outcome: 'moved' }] },
    ]);
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
