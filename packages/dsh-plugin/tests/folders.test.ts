import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  callFileTool,
  cleanFolders,
  fileTools,
  isInside,
  resolveInside,
  defaultRealpath,
  type FolderConfig,
} from '../src/folders.js';

let root: string;
const noOpen = { openPath: async () => undefined, openUrl: async () => undefined };

beforeEach(() => {
  root = defaultRealpath(mkdtempSync(path.join(os.tmpdir(), 'corehub-dsh-folders-')))!;
  mkdirSync(path.join(root, 'shared/inner'), { recursive: true });
  mkdirSync(path.join(root, 'private'), { recursive: true });
  writeFileSync(path.join(root, 'shared/a.txt'), 'hello');
  writeFileSync(path.join(root, 'private/secret.txt'), 'secret');
  symlinkSync(path.join(root, 'private'), path.join(root, 'shared/escape'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = (write = false): FolderConfig => ({
  folders: [{ path: path.join(root, 'shared'), write }],
  allowOpen: false,
});

describe('folder confinement', () => {
  it('allows a path inside a shared folder', () => {
    const r = resolveInside(config().folders, path.join(root, 'shared/a.txt'), {
      realpath: defaultRealpath,
    });
    expect(r).toMatchObject({ ok: true, path: path.join(root, 'shared/a.txt') });
  });

  it('refuses a path outside, and one that escapes through a link', () => {
    for (const p of [
      path.join(root, 'private/secret.txt'),
      path.join(root, 'shared/../private/secret.txt'),
      path.join(root, 'shared/escape/secret.txt'),
    ])
      expect(resolveInside(config().folders, p, { realpath: defaultRealpath })).toEqual({
        ok: false,
        reason: 'outside',
      });
  });

  it('refuses a write into a read-only folder, and into a link that leaves the folder', () => {
    expect(
      resolveInside(config(false).folders, path.join(root, 'shared/new.txt'), {
        realpath: defaultRealpath,
        forWrite: true,
      }),
    ).toEqual({ ok: false, reason: 'read_only' });
    expect(
      resolveInside(config(true).folders, path.join(root, 'shared/escape/new.txt'), {
        realpath: defaultRealpath,
        forWrite: true,
      }),
    ).toEqual({ ok: false, reason: 'outside' });
  });

  it('lets the most specific folder decide', () => {
    const folders = [
      { path: path.join(root, 'shared'), write: true },
      { path: path.join(root, 'shared/inner'), write: false },
    ];
    expect(
      resolveInside(folders, path.join(root, 'shared/inner/x.txt'), {
        realpath: defaultRealpath,
        forWrite: true,
      }),
    ).toEqual({ ok: false, reason: 'read_only' });
  });

  it('isInside is not fooled by a common prefix', () => {
    expect(isInside('/a/shared', '/a/shared-other/x')).toBe(false);
    expect(isInside('/a/shared', '/a/shared')).toBe(true);
  });
});

describe('file tools', () => {
  it('offers writing and opening only when allowed', () => {
    expect(fileTools(config(false)).map((t) => t.name)).toEqual([
      'list_allowed_folders',
      'list_directory',
      'read_text_file',
    ]);
    expect(fileTools({ ...config(true), allowOpen: true }).map((t) => t.name)).toContain(
      'open_url',
    );
  });

  it('reads, lists and writes inside the folder', async () => {
    const read = await callFileTool(config(), noOpen, 'read_text_file', {
      path: path.join(root, 'shared/a.txt'),
    });
    expect(read.text).toBe('hello');
    const list = await callFileTool(config(), noOpen, 'list_directory', {
      path: path.join(root, 'shared'),
    });
    expect(
      JSON.parse(list.text)
        .map((e: { name: string }) => e.name)
        .sort(),
    ).toEqual(['a.txt', 'escape', 'inner']);
    await callFileTool(config(true), noOpen, 'write_text_file', {
      path: path.join(root, 'shared/b.txt'),
      content: 'x',
    });
    expect(readFileSync(path.join(root, 'shared/b.txt'), 'utf8')).toBe('x');
    await expect(
      callFileTool(config(true), noOpen, 'write_text_file', {
        path: path.join(root, 'shared/b.txt'),
        content: 'y',
      }),
    ).rejects.toThrow(/overwrite/);
  });

  it('refuses a tool that is not offered, and links that are not web links', async () => {
    await expect(
      callFileTool(config(false), noOpen, 'write_text_file', {
        path: path.join(root, 'shared/c.txt'),
        content: 'x',
      }),
    ).rejects.toThrow(/does not offer/);
    await expect(
      callFileTool({ ...config(), allowOpen: true }, noOpen, 'open_url', {
        url: 'file:///etc/passwd',
      }),
    ).rejects.toThrow(/http/);
  });

  it('cleans what the settings page holds', () => {
    expect(
      cleanFolders([
        { path: '/abs', write: true },
        { path: '/abs' },
        { path: 'relative' },
        { path: 3 },
        null,
      ]),
    ).toEqual([{ path: '/abs', write: true }]);
  });
});
