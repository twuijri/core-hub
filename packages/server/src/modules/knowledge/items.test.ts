/**
 * `knowledge.listItems`: three tables read as one list. The rule under test is the one
 * that makes a single cursor enough — every id is a ULID, so "newest first" is "id
 * descending", whichever table the row came from.
 */
import { describe, expect, it } from 'vitest';
import { memoryDb } from '../../../tests/unit/helpers.js';
import { KnowledgeItems } from './items.js';
import { attachments, journalEntries, knowledgeNotes } from './schema.js';

const OWNER = '01J8QK3ZR2W7M5N4P6T8V9X0HM';
const WORKSPACE = '01J8QK3ZR2W7M5N4P6T8V9X0PF';
const OTHER = '01J8QK3ZR2W7M5N4P6T8V9X0PG';

/** Ids that sort the way ULIDs do, so the test can say what "newest" means. */
const id = (n: number) => `01J8QK3ZR2W7M5N4P6T8V9X${String(n).padStart(3, '0')}`;

function seed(db: ReturnType<typeof memoryDb>) {
  db.insert(journalEntries)
    .values({
      id: id(1),
      ownerId: OWNER,
      workspace: WORKSPACE,
      date: '2026-09-20',
      body: 'اليوم أنهينا العقد',
      mood: 'good',
      highlights: ['contract'],
    })
    .run();
  db.insert(knowledgeNotes)
    .values({
      id: id(2),
      ownerId: OWNER,
      workspace: WORKSPACE,
      title: 'Deploy notes',
      body: 'run the migration first',
      tags: ['ops'],
    })
    .run();
  db.insert(attachments)
    .values({
      id: id(3),
      ownerId: OWNER,
      workspace: WORKSPACE,
      filename: 'plan.md',
      mime: 'text/markdown',
      kind: 'file',
      sizeBytes: 12,
      sha256: 'a'.repeat(64),
      storageKey: 'k',
      sourceKind: 'upload',
    })
    .run();
}

const query = { workspace: WORKSPACE, profile: 'default', limit: 50 };

describe('the knowledge list', () => {
  it('is empty on a fresh workspace, and says so with a page and not an error', () => {
    const page = new KnowledgeItems(memoryDb()).list(query);
    expect(page.items).toEqual([]);
    expect(page.lastId).toBeNull();
  });

  it('merges the three kinds into one list, newest first', () => {
    const db = memoryDb();
    seed(db);
    const page = new KnowledgeItems(db).list(query);
    expect(page.items.map((item) => item.kind)).toEqual(['file', 'note', 'journal']);
  });

  it('names each kind the way that kind is named', () => {
    const db = memoryDb();
    seed(db);
    const [file, note, journal] = new KnowledgeItems(db).list(query).items;
    // A journal entry has no title of its own: its day is its name.
    expect(journal).toMatchObject({ title: '2026-09-20', date: '2026-09-20', mood: 'good' });
    expect(note).toMatchObject({ title: 'Deploy notes', date: null, tags: ['ops'] });
    // A file's bytes are not its content: downloading is a different operation.
    expect(file).toMatchObject({ title: 'plan.md', content: null, attachment_ids: [id(3)] });
  });

  it('shows one kind when one kind is asked for', () => {
    const db = memoryDb();
    seed(db);
    const page = new KnowledgeItems(db).list({ ...query, kind: 'note' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.kind).toBe('note');
  });

  it('searches each kind where its words are', () => {
    const db = memoryDb();
    seed(db);
    expect(new KnowledgeItems(db).list({ ...query, q: 'migration' }).items).toHaveLength(1);
    expect(new KnowledgeItems(db).list({ ...query, q: 'العقد' }).items).toHaveLength(1);
    expect(new KnowledgeItems(db).list({ ...query, q: 'plan' }).items).toHaveLength(1);
    expect(new KnowledgeItems(db).list({ ...query, q: 'nothing here' }).items).toEqual([]);
  });

  it('never shows another workspace’s knowledge', () => {
    const db = memoryDb();
    seed(db);
    const page = new KnowledgeItems(db).list({ ...query, workspace: OTHER });
    expect(page.items).toEqual([]);
  });

  it('pages across the three tables with one cursor', () => {
    const db = memoryDb();
    seed(db);
    const first = new KnowledgeItems(db).list({ ...query, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([id(3), id(2)]);
    expect(first.lastId).toBe(id(2));
    const second = new KnowledgeItems(db).list({ ...query, limit: 2, cursor: first.lastId });
    expect(second.items.map((item) => item.id)).toEqual([id(1)]);
    // A last page that did not fill says so by having no cursor to continue from.
    expect(second.lastId).toBeNull();
  });
});
