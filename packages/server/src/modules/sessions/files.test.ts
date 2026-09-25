/**
 * A conversation's files (decision §47): the read stays inside the working folder — no
 * traversal, no symbolic link on the way, only regular files — the kind and type come from
 * the name, the folder is read bounded, and tool calls name their files.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubError } from '../../lib/errors.js';
import { acpToolInput } from '../agents/adapters/acp.js';
import {
  PREVIEW_MAX_BYTES,
  SCAN_MAX_DEPTH,
  fileRefsOf,
  fileTypeOf,
  listSessionFiles,
  openInside,
  resolveInside,
  scanFolder,
  type ToolCallLike,
} from './files.js';

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'corehub-files-'));
  root = path.join(base, 'work');
  outside = path.join(base, 'secret');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'passwd'), 'root:x:0:0');
  writeFileSync(path.join(root, 'report.html'), '<h1>تقرير</h1>');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function refusal(run: () => unknown): { code: string; reason?: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof HubError) {
      return { code: error.code, reason: (error.details as { reason?: unknown })?.reason };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('resolveInside', () => {
  it('answers a file inside the folder, relative or absolute', () => {
    expect(resolveInside(root, 'report.html').relative).toBe('report.html');
    expect(resolveInside(root, path.join(root, 'report.html')).relative).toBe('report.html');
    mkdirSync(path.join(root, 'out'));
    writeFileSync(path.join(root, 'out', 'data.csv'), 'a,b');
    expect(resolveInside(root, './out/../out/data.csv').relative).toBe('out/data.csv');
  });

  it('refuses a path that leaves the folder', () => {
    expect(refusal(() => resolveInside(root, '../secret/passwd'))).toEqual({
      code: 'validation_failed',
      reason: 'outside_root',
    });
    expect(refusal(() => resolveInside(root, path.join(outside, 'passwd'))).reason).toBe(
      'outside_root',
    );
    expect(refusal(() => resolveInside(root, '/etc/passwd')).reason).toBe('outside_root');
    expect(refusal(() => resolveInside(root, '.')).reason).toBe('outside_root');
    expect(refusal(() => resolveInside(root, 'a\0b')).reason).toBe('invalid');
  });

  it('refuses a symbolic link, to a file or on the way', () => {
    symlinkSync(path.join(outside, 'passwd'), path.join(root, 'link.txt'));
    symlinkSync(outside, path.join(root, 'dir'));
    symlinkSync(path.join(root, 'report.html'), path.join(root, 'inner.html'));
    expect(refusal(() => resolveInside(root, 'link.txt')).reason).toBe('symlink');
    expect(refusal(() => resolveInside(root, 'dir/passwd')).reason).toBe('symlink');
    // Even a link that stays inside is refused: nothing is followed.
    expect(refusal(() => resolveInside(root, 'inner.html')).reason).toBe('symlink');
  });

  it('refuses a folder and answers 404 for a missing file', () => {
    mkdirSync(path.join(root, 'sub'));
    expect(refusal(() => resolveInside(root, 'sub')).reason).toBe('not_a_file');
    expect(refusal(() => resolveInside(root, 'nope.md')).code).toBe('not_found');
    expect(refusal(() => resolveInside(path.join(base, 'gone'), 'x.md')).code).toBe('not_found');
  });
});

describe('openInside', () => {
  it('applies the cap of the file kind', () => {
    writeFileSync(path.join(root, 'big.md'), 'x'.repeat(64));
    const opened = openInside(root, 'report.html', () => 1024);
    expect(opened).toMatchObject({ size: 19, relative: 'report.html' });
    expect(opened.type.contentType).toBe('text/html; charset=utf-8');
    expect(refusal(() => openInside(root, 'big.md', () => 10)).code).toBe('payload_too_large');
  });
});

describe('fileTypeOf', () => {
  it('chooses kind and type from the name and sends code as plain text', () => {
    expect(fileTypeOf('a/report.HTML')).toMatchObject({ kind: 'html', mime: 'text/html' });
    expect(fileTypeOf('notes.md').kind).toBe('markdown');
    expect(fileTypeOf('data.csv').contentType).toBe('text/csv; charset=utf-8');
    expect(fileTypeOf('book.xlsx').kind).toBe('xlsx');
    expect(fileTypeOf('letter.docx').kind).toBe('docx');
    expect(fileTypeOf('deck.pptx').kind).toBe('pptx');
    expect(fileTypeOf('scan.pdf').contentType).toBe('application/pdf');
    expect(fileTypeOf('logo.svg')).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
    expect(fileTypeOf('app.js')).toMatchObject({
      kind: 'code',
      contentType: 'text/plain; charset=utf-8',
    });
    expect(fileTypeOf('Dockerfile').kind).toBe('code');
    expect(fileTypeOf('archive.zip')).toMatchObject({
      kind: 'none',
      mime: 'application/octet-stream',
    });
    expect(PREVIEW_MAX_BYTES.none).toBe(0);
  });
});

describe('scanFolder', () => {
  it('lists newest first, skips hidden folders, node_modules and links', () => {
    writeFileSync(path.join(root, 'old.txt'), 'old');
    utimesSync(path.join(root, 'old.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref');
    mkdirSync(path.join(root, '.corehub', 'runs', 'r', 'in'), { recursive: true });
    writeFileSync(path.join(root, '.corehub', 'runs', 'r', 'in', 'a.png'), 'x');
    mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'x');
    writeFileSync(path.join(root, '.env'), 'KEY=1');
    symlinkSync(path.join(outside, 'passwd'), path.join(root, 'link.txt'));
    const { files, truncated } = scanFolder(root);
    expect(files.map((f) => f.relative)).toEqual(['report.html', 'old.txt']);
    expect(truncated).toBe(false);
  });

  it('stops at the depth cap and says so', () => {
    let dir = root;
    for (let level = 0; level < SCAN_MAX_DEPTH + 1; level += 1) {
      dir = path.join(dir, `d${level}`);
      mkdirSync(dir);
      writeFileSync(path.join(dir, `f${level}.txt`), 'x');
    }
    const { files, truncated } = scanFolder(root);
    // The folder itself is the first level: files down to level SCAN_MAX_DEPTH are read.
    expect(files.map((f) => f.relative.split('/').length).sort()).toEqual(
      Array.from({ length: SCAN_MAX_DEPTH }, (_, i) => i + 1),
    );
    expect(truncated).toBe(true);
  });
});

describe('fileRefsOf', () => {
  const call = (over: Partial<ToolCallLike>): ToolCallLike => ({
    id: 'c1',
    runId: 'r1',
    name: 'write_file',
    kind: null,
    title: null,
    input: {},
    ...over,
  });

  it('reads the argument names agents use, and ACP locations', () => {
    const refs = fileRefsOf([
      call({ id: 'a', input: { path: 'report.html', content: '<p>' } }),
      call({ id: 'b', name: 'Write', input: { file_path: '/w/notes.md' } }),
      call({ id: 'c', name: 'edit', input: { locations: [{ path: 'src/a.ts' }, 'b.ts'] } }),
      call({ id: 'd', name: 'shell', input: { command: 'ls' } }),
      call({ id: 'e', name: 'web', input: { path: 'https://example.com/a.html' } }),
    ]);
    expect(refs.map((r) => [r.toolCallId, r.path])).toEqual([
      ['a', 'report.html'],
      ['b', '/w/notes.md'],
      ['c', 'src/a.ts'],
      ['c', 'b.ts'],
    ]);
  });

  it("takes the file from a file tool's one-line preview (Hermes)", () => {
    const refs = fileRefsOf([
      call({ id: 'h', name: 'write_file', input: { preview: 'reports/q3.html' } }),
      call({ id: 'i', name: 'patch', title: 'Edit /data/w/data.csv' }),
      call({ id: 'j', name: 'terminal', title: 'cat notes.md' }),
    ]);
    expect(refs.map((r) => [r.toolCallId, r.path])).toEqual([
      ['h', 'reports/q3.html'],
      ['i', '/data/w/data.csv'],
    ]);
  });
});

describe('acpToolInput', () => {
  it("keeps the agent's rawInput and adds the paths it touches as locations", () => {
    expect(
      acpToolInput({
        rawInput: { file_path: '/w/a.md', content: 'x' },
        locations: [{ path: '/w/a.md', line: 1 }],
        content: [{ type: 'diff', path: '/w/b.md', oldText: '', newText: 'x' }],
      }),
    ).toEqual({ file_path: '/w/a.md', content: 'x', locations: ['/w/a.md', '/w/b.md'] });
    expect(acpToolInput({ title: 'Run tests' })).toEqual({});
  });
});

describe('listSessionFiles', () => {
  it('lists tool files, folder files and attachments once each, newest first', () => {
    writeFileSync(path.join(root, 'notes.md'), '# ملاحظات');
    utimesSync(path.join(root, 'notes.md'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    utimesSync(path.join(root, 'report.html'), new Date(2026, 0, 3), new Date(2026, 0, 3));
    const list = listSessionFiles({
      workingDir: root,
      toolCalls: [
        { id: 'T1', runId: 'R', name: 'write_file', kind: null, title: null, input: { path: 'report.html' } },
        { id: 'T2', runId: 'R', name: 'read_file', kind: null, title: null, input: { path: '../secret/passwd' } },
        { id: 'T3', runId: 'R', name: 'write_file', kind: null, title: null, input: { path: 'deleted.txt' } },
      ],
      attachments: [
        {
          id: 'A1',
          messageId: 'M1',
          at: new Date(2026, 0, 2).getTime(),
          name: 'budget.xlsx',
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          sizeBytes: 900,
        },
      ],
    });
    expect(list.working_dir).toBe(root);
    expect(list.items.map((f) => [f.key, f.sources, f.tool_call_ids, f.preview])).toEqual([
      ['path:report.html', ['tool', 'working_dir'], ['T1'], 'html'],
      ['attachment:A1', ['attachment'], [], 'xlsx'],
      ['path:notes.md', ['working_dir'], [], 'markdown'],
    ]);
    expect(list.items[0]).toMatchObject({
      name: 'report.html',
      path: 'report.html',
      attachment_id: null,
      size_bytes: 19,
      preview_max_bytes: PREVIEW_MAX_BYTES.html,
    });
  });

  it('lists only attachments when the session has no folder', () => {
    const list = listSessionFiles({
      workingDir: null,
      toolCalls: [],
      attachments: [
        { id: 'A1', messageId: 'M1', at: 1, name: 'image', mime: 'image/png', sizeBytes: 4 },
      ],
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.preview).toBe('image');
  });
});
