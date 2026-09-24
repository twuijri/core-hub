/**
 * The store's own rules, without HTTP: what a name becomes, what the bytes say they
 * are, what is refused, and what is stored once.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createLogger } from '../../lib/logger.js';
import { HubError } from '../../lib/errors.js';
import { newUlid } from '../../db/ids.js';
import { parseRange } from './blobs.js';
import { MAX_UPLOAD_BYTES } from './limits.js';
import { contentDispositionOf, sanitiseFilename, sniffMime, storedKindOf } from './media.js';
import { KnowledgeService, type AttachmentScope } from './service.js';
import { toAttachment } from './serialize.js';
import { UploadRegistry } from './uploads.js';

/** `packages/server/drizzle`: a module may not import `app/`, so the path is spelt out. */
const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 7),
]);

function scratch(): { dir: string; done(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-attach-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The hub's schema on a throwaway SQLite file, with the service over it. */
function service(dir: string): { service: KnowledgeService; scope: AttachmentScope } {
  const sqlite = new Database(path.join(dir, 'hub.sqlite'));
  // The real migrations, so the table carries the indexes the hub runs with: a constraint
  // this file declared by hand once hid a 500 on re-uploading the same bytes.
  migrate(drizzle(sqlite), { migrationsFolder });
  return {
    service: new KnowledgeService({
      db: drizzle(sqlite),
      dataDir: dir,
      log: createLogger({ level: 'silent' }),
    }),
    scope: { workspace: newUlid(), profile: 'default', userId: newUlid() },
  };
}

describe('attachments: the name is sanitised, never used as a path', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Windows\\System32\\evil.dll', 'evil.dll'],
    ['/absolute/report.pdf', 'report.pdf'],
    ['.hidden', 'hidden'],
    ['..', 'file'],
    ['', 'file'],
    ['   ', 'file'],
    ['a\u0000b.txt', 'ab.txt'],
    ['note<>:"|?*.txt', 'note_______.txt'],
    ['trailing.   ', 'trailing'],
    ['CON.txt', '_CON.txt'],
    ['تقرير المشروع.pdf', 'تقرير المشروع.pdf'],
  ])('%j -> %j', (raw, expected) => {
    expect(sanitiseFilename(raw)).toBe(expected);
  });

  it('caps the length and keeps the extension', () => {
    const name = sanitiseFilename(`${'x'.repeat(400)}.png`);
    expect(name.length).toBe(255);
    expect(name.endsWith('.png')).toBe(true);
  });

  it('offers a download under a name, never inline', () => {
    const header = contentDispositionOf('تقرير.pdf');
    expect(header.startsWith('attachment;')).toBe(true);
    expect(header).toContain("filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf");
  });
});

describe('attachments: the bytes decide the media type', () => {
  it.each([
    [png, 'x.bin', 'image/png'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'x.png', 'image/jpeg'],
    [Buffer.from('%PDF-1.7\n'), 'x.txt', 'application/pdf'],
    [Buffer.from('MZ\u0090\u0000'), 'photo.png', 'application/x-msdownload'],
    [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'kitten.jpg', 'application/x-elf'],
  ])('sniffs %#', (head, filename, expected) => {
    expect(sniffMime(head, filename).mime).toBe(expected);
  });

  it('falls back to the extension for text, and says the client was wrong', () => {
    const result = sniffMime(Buffer.from('a,b,c\n1,2,3\n'), 'table.csv', 'application/pdf');
    expect(result.mime).toBe('text/csv; charset=utf-8');
    expect(result.source).toBe('extension');
    expect(result.overrode).toBe(true);
  });

  it('calls unrecognised binary bytes what they are', () => {
    const result = sniffMime(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'thing.xyz', 'image/png');
    expect(result.mime).toBe('application/octet-stream');
    expect(result.overrode).toBe(true);
  });

  it('keeps the two stored kinds the wire folds into `file`', () => {
    expect(storedKindOf('text/x-diff; charset=utf-8', 'change.diff')).toBe('diff');
    expect(storedKindOf('text/plain; charset=utf-8', 'run.log')).toBe('log');
    expect(storedKindOf('image/png', 'shot.png')).toBe('image');
  });
});

describe('attachments: storing, refusing, de-duplicating', () => {
  it('stores a file content-addressed and answers the contract shape', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const row = await knowledge.upload(scope, {
        filename: '../shot.png',
        declaredMime: 'application/pdf',
        purpose: 'message',
        body: Readable.from([png]),
      });
      expect(row.filename).toBe('shot.png');
      // The client said PDF; the bytes said PNG, and the bytes win.
      expect(row.mime).toBe('image/png');
      expect(row.storageKey).toBe(
        path.posix.join(scope.workspace, row.sha256.slice(0, 2), row.sha256),
      );
      expect(readFileSync(knowledge.blobs.pathOf(row.storageKey))).toEqual(png);

      const wire = toAttachment(row, 'default');
      expect(wire).toMatchObject({
        name: 'shot.png',
        mime: 'image/png',
        kind: 'image',
        purpose: 'message',
        size_bytes: png.length,
        url: `/api/v1/attachments/${row.id}/content`,
      });
    } finally {
      done();
    }
  });

  it('refuses a file over the one-shot limit with the documented envelope', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      // A stream that never ends, so nothing has to allocate 25 MB to prove the point.
      let sent = 0;
      const endless = new Readable({
        read() {
          sent += 1 << 20;
          this.push(sent > MAX_UPLOAD_BYTES + (1 << 20) ? null : Buffer.alloc(1 << 20, 1));
        },
      });
      const error = await knowledge
        .upload(scope, {
          filename: 'big.bin',
          declaredMime: null,
          purpose: 'message',
          body: endless,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HubError);
      expect((error as HubError).code).toBe('payload_too_large');
      expect((error as HubError).status).toBe(413);
      expect((error as HubError).details).toEqual({ max_bytes: MAX_UPLOAD_BYTES });
      // Nothing of the refused upload is left behind: no row, and no partial file.
      const temp = path.join(dir, 'attachments', scope.workspace, '.tmp');
      expect(existsSync(temp) ? readdirSync(temp) : []).toEqual([]);
    } finally {
      done();
    }
  });

  it('stores identical bytes once, one row per upload', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const first = await knowledge.upload(scope, {
        filename: 'shot.png',
        declaredMime: 'image/png',
        purpose: 'message',
        body: Readable.from([png]),
      });
      const second = await knowledge.upload(scope, {
        filename: 'shot.png',
        declaredMime: 'image/png',
        purpose: 'message',
        body: Readable.from([png]),
      });
      expect(second.id).not.toBe(first.id);
      expect(second.storageKey).toBe(first.storageKey);
      const blobDir = path.dirname(knowledge.blobs.pathOf(first.storageKey));
      expect(readdirSync(blobDir)).toEqual([first.sha256]);
    } finally {
      done();
    }
  });

  it('takes the same bytes again after a delete, and under another name', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const put = (filename: string) =>
        knowledge.upload(scope, {
          filename,
          declaredMime: 'image/png',
          purpose: 'message',
          body: Readable.from([png]),
        });
      const first = await put('shot.png');
      knowledge.remove(scope, first.id, false);
      expect(knowledge.blobs.exists(first.storageKey)).toBe(false);

      const again = await put('shot.png');
      expect(again.id).not.toBe(first.id);
      expect(readFileSync(knowledge.blobs.pathOf(again.storageKey))).toEqual(png);

      const renamed = await put('another name.png');
      expect(renamed.filename).toBe('another name.png');
      expect(renamed.storageKey).toBe(again.storageKey);
    } finally {
      done();
    }
  });

  it('keeps the bytes while another row still uses them, and removes them with the last', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const put = (filename: string) =>
        knowledge.upload(scope, {
          filename,
          declaredMime: 'image/png',
          purpose: 'message',
          body: Readable.from([png]),
        });
      const a = await put('a.png');
      const b = await put('b.png');
      knowledge.remove(scope, a.id, false);
      expect(knowledge.blobs.exists(b.storageKey)).toBe(true);
      expect(knowledge.require(scope, b.id).id).toBe(b.id);
      knowledge.remove(scope, b.id, false);
      expect(knowledge.blobs.exists(b.storageKey)).toBe(false);
    } finally {
      done();
    }
  });

  it('answers 409, not 500, when the shared bytes vanished before the row was written', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const kept = await put();
      async function put() {
        return knowledge.upload(scope, {
          filename: 'a.png',
          declaredMime: 'image/png',
          purpose: 'message',
          body: Readable.from([png]),
        });
      }
      // The second upload finds the bytes already there…
      const blob = await knowledge.storeStream(scope, Readable.from([png]));
      // …and the only other row is deleted before it registers.
      knowledge.remove(scope, kept.id, false);
      const error = (() => {
        try {
          knowledge.registerBlob(scope, {
            filename: 'a.png',
            declaredMime: 'image/png',
            purpose: 'message',
            blob,
            sourceKind: 'upload',
            sourceId: null,
            expiresAt: null,
            meta: {},
          });
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(HubError);
      expect((error as HubError).status).toBe(409);
      expect((error as HubError).details).toEqual({ reason: 'bytes_removed_during_upload' });
    } finally {
      done();
    }
  });

  it('keeps one workspace out of another', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const row = await knowledge.upload(scope, {
        filename: 'shot.png',
        declaredMime: 'image/png',
        purpose: 'message',
        body: Readable.from([png]),
      });
      const other = { ...scope, workspace: newUlid() };
      expect(() => knowledge.require(other, row.id)).toThrowError(/not_found|NOT_FOUND|not found/i);
      expect(knowledge.require(scope, row.id).id).toBe(row.id);
    } finally {
      done();
    }
  });

  it('refuses to delete a file a message points at, and deletes one nobody does', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const row = await knowledge.upload(scope, {
        filename: 'shot.png',
        declaredMime: 'image/png',
        purpose: 'message',
        body: Readable.from([png]),
      });
      expect(() => knowledge.remove(scope, row.id, true)).toThrowError();
      expect(knowledge.blobs.exists(row.storageKey)).toBe(true);

      knowledge.remove(scope, row.id, false);
      expect(knowledge.blobs.exists(row.storageKey)).toBe(false);
      expect(knowledge.rows.get(scope.workspace, row.id)).toBeUndefined();
      // The row survives so a stale reference renders "removed" (domain §attachment).
      expect(knowledge.rows.getEvenIfDeleted(scope.workspace, row.id)?.deletedAt).toBeInstanceOf(
        Date,
      );
    } finally {
      done();
    }
  });

  it('captures a file an agent wrote, under a name it cannot steer', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const out = path.join(dir, 'out');
      mkdirSync(out, { recursive: true });
      const produced = path.join(out, 'summary.md');
      writeFileSync(produced, '# done\n');
      const row = await knowledge.capture(
        scope,
        { path: produced, relativePath: 'report/summary.md', sizeBytes: 7 },
        newUlid(),
      );
      expect(row.filename).toBe('summary.md');
      expect(row.sourceKind).toBe('agent_output');
      expect(row.meta.producedPath).toBe('report/summary.md');
      expect(row.mime).toBe('text/markdown; charset=utf-8');
    } finally {
      done();
    }
  });
});

describe('attachments: the resumable upload', () => {
  it('appends chunk by chunk and answers the stored file', async () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      const body = Buffer.concat([png, Buffer.alloc(100, 3)]);
      const started = knowledge.startUpload(scope, {
        name: 'big.png',
        mime: 'image/png',
        size_bytes: body.length,
      }) as { id: string; next_offset: number; chunk_bytes: number };
      expect(started.next_offset).toBe(0);
      expect(started.chunk_bytes).toBe(262144);

      const half = Math.floor(body.length / 2);
      const first = (await knowledge.uploadChunk(
        scope,
        started.id,
        0,
        Readable.from([body.subarray(0, half)]),
      )) as { next_offset: number };
      expect(first.next_offset).toBe(half);

      // The wrong offset is a conflict, not a corrupted file.
      await expect(
        knowledge.uploadChunk(scope, started.id, 0, Readable.from([body.subarray(half)])),
      ).rejects.toMatchObject({ code: 'conflict' });
      // Completing early is a conflict too.
      await expect(knowledge.completeUpload(scope, started.id)).rejects.toMatchObject({
        code: 'conflict',
      });

      await knowledge.uploadChunk(scope, started.id, half, Readable.from([body.subarray(half)]));
      const row = await knowledge.completeUpload(scope, started.id);
      expect(row.sizeBytes).toBe(body.length);
      expect(row.mime).toBe('image/png');
      expect(readFileSync(knowledge.blobs.pathOf(row.storageKey))).toEqual(body);
    } finally {
      done();
    }
  });

  it('refuses a declared size above the resumable ceiling', () => {
    const { dir, done } = scratch();
    try {
      const { service: knowledge, scope } = service(dir);
      expect(() =>
        knowledge.startUpload(scope, { name: 'x', mime: 'x', size_bytes: 52_428_801 }),
      ).toThrowError();
    } finally {
      done();
    }
  });

  it('forgets an upload that went quiet', () => {
    let now = 1_000;
    const registry = new UploadRegistry({ now: () => now, idleMs: 100 });
    const upload = registry.start({
      workspace: 'w',
      ownerId: 'u',
      filename: 'a.txt',
      declaredMime: 'text/plain',
      sizeBytes: 10,
      purpose: 'message',
      temp: '/tmp/none',
    });
    expect(registry.find('w', upload.id)).toBeDefined();
    now += 101;
    expect(registry.find('w', upload.id)).toBeUndefined();
  });

  it('never hands an upload to another workspace', () => {
    const registry = new UploadRegistry();
    const upload = registry.start({
      workspace: 'w1',
      ownerId: 'u',
      filename: 'a.txt',
      declaredMime: 'text/plain',
      sizeBytes: 10,
      purpose: 'message',
      temp: '/tmp/none',
    });
    expect(registry.find('w2', upload.id)).toBeUndefined();
  });
});

describe('attachments: ranges', () => {
  it.each([
    ['bytes=0-4', { start: 0, end: 4 }],
    ['bytes=5-', { start: 5, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=0-100', { start: 0, end: 9 }],
  ])('%s', (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected);
  });

  it('ignores a range it cannot satisfy rather than answering an undocumented status', () => {
    expect(parseRange('bytes=20-30', 10)).toBeNull();
    expect(parseRange('bytes=7-3', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(parseRange(undefined, 10)).toBeNull();
  });
});
