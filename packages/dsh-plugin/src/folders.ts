/**
 * The `files` answers (ADR 0033 §4): the folders the person shares in the plugin's settings,
 * read-only unless marked writable, with the same tools and limits as the desktop app's helper
 * (ADR 0022; ported from `apps/desktop/src/shared/helper.ts` and `src/main/helper.ts`, our own
 * code). The one safety rule: a path is used only if, once every symbolic link is resolved, it
 * is inside a shared folder; for a write, the most specific folder must be writable.
 */
import { execFile } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface SharedFolder {
  /** Absolute, as the person wrote it. */
  path: string;
  /** Read only unless true. */
  write: boolean;
}

export interface FolderConfig {
  folders: SharedFolder[];
  /** Whether files (in shared folders) and web links may be opened on this computer. */
  allowOpen: boolean;
}

export const FOLDER_LIMIT = 20;
export const READ_DEFAULT = 256 * 1024;
export const READ_MAX = 1024 * 1024;
export const WRITE_MAX = 1024 * 1024;
export const LIST_MAX = 500;

/** Cleans what the settings page holds: absolute, unique, at most twenty. */
export function cleanFolders(raw: unknown, api: typeof path = path): SharedFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: SharedFolder[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = (item as { path?: unknown }).path;
    if (typeof p !== 'string' || p.trim() === '' || p.includes('\0')) continue;
    const expanded = expandHome(p.trim());
    if (!api.isAbsolute(expanded)) continue;
    const normal = api.normalize(expanded);
    if (out.some((f) => f.path === normal)) continue;
    out.push({ path: normal, write: (item as { write?: unknown }).write === true });
    if (out.length >= FOLDER_LIMIT) break;
  }
  return out;
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return home ? path.join(home, p.slice(1)) : p;
  }
  return p;
}

/** Whether `child` is `parent` or below it (both already resolved). */
export function isInside(parent: string, child: string, api: typeof path = path): boolean {
  const rel = api.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

export type Resolved =
  | { ok: true; path: string; folder: SharedFolder }
  | { ok: false; reason: 'outside' | 'missing' | 'read_only' };

/**
 * Where a requested path really is, and which shared folder allows it. For a file that does
 * not exist yet (a write), its parent is resolved and the name appended, so a link can never
 * smuggle a write outside.
 */
export function resolveInside(
  folders: readonly SharedFolder[],
  requested: string,
  options: { realpath: (p: string) => string | null; forWrite?: boolean; api?: typeof path },
): Resolved {
  const api = options.api ?? path;
  if (typeof requested !== 'string' || requested.trim() === '' || requested.includes('\0'))
    return { ok: false, reason: 'outside' };
  const absolute = api.resolve(requested);
  let real = options.realpath(absolute);
  if (real === null) {
    if (!options.forWrite) return { ok: false, reason: 'missing' };
    const parent = options.realpath(api.dirname(absolute));
    if (parent === null) return { ok: false, reason: 'missing' };
    real = api.join(parent, api.basename(absolute));
  }
  let best: SharedFolder | null = null;
  for (const folder of folders) {
    const root = options.realpath(folder.path);
    if (root === null || !isInside(root, real, api)) continue;
    // The most specific folder decides (a read-only folder inside a writable one stays read-only).
    if (!best || folder.path.length > best.path.length) best = folder;
  }
  if (!best) return { ok: false, reason: 'outside' };
  if (options.forWrite && !best.write) return { ok: false, reason: 'read_only' };
  return { ok: true, path: real, folder: best };
}

export function defaultRealpath(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** The file tools this configuration offers (the same names as the desktop helper). */
export function fileTools(config: FolderConfig): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: 'list_allowed_folders',
      description:
        'List the folders on this computer that the person shared, and whether each is read-only or writable.',
      inputSchema: obj({}),
    },
    {
      name: 'list_directory',
      description: 'List the files and folders inside a shared folder (or a folder below it).',
      inputSchema: obj({ path: { type: 'string', description: 'Absolute path' } }, ['path']),
    },
    {
      name: 'read_text_file',
      description: 'Read a text file inside a shared folder (up to 1 MB).',
      inputSchema: obj(
        {
          path: { type: 'string', description: 'Absolute path' },
          max_bytes: { type: 'integer', minimum: 1, maximum: READ_MAX },
        },
        ['path'],
      ),
    },
  ];
  if (config.folders.some((f) => f.write))
    tools.push({
      name: 'write_text_file',
      description:
        'Write a text file inside a folder the person shared as writable. Refuses to replace an existing file unless overwrite is true.',
      inputSchema: obj(
        {
          path: { type: 'string', description: 'Absolute path' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        ['path', 'content'],
      ),
    });
  if (config.allowOpen)
    tools.push(
      {
        name: 'open_path',
        description:
          'Open a file or folder inside a shared folder with its default application on this computer.',
        inputSchema: obj({ path: { type: 'string', description: 'Absolute path' } }, ['path']),
      },
      {
        name: 'open_url',
        description: 'Open an http or https link in the default browser on this computer.',
        inputSchema: obj({ url: { type: 'string' } }, ['url']),
      },
    );
  return tools;
}

export class FileToolError extends Error {}

export const REASON: Record<Exclude<Resolved, { ok: true }>['reason'], string> = {
  outside: 'That path is not inside a folder shared with this computer.',
  missing: 'That path does not exist.',
  read_only: 'That folder is shared read-only.',
};

export interface OpenEnv {
  openPath(file: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  realpath?: (p: string) => string | null;
}

/** Runs one file tool against the current configuration. Pure apart from the file system. */
export async function callFileTool(
  config: FolderConfig,
  env: OpenEnv,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; target: string | null }> {
  const realpath = env.realpath ?? defaultRealpath;
  if (!fileTools(config).some((tool) => tool.name === name))
    throw new FileToolError(`This computer does not offer "${name}" now.`);
  const inside = (value: unknown, forWrite = false) => {
    const resolved = resolveInside(config.folders, String(value ?? ''), { realpath, forWrite });
    if (!resolved.ok) throw new FileToolError(REASON[resolved.reason]);
    return resolved.path;
  };
  switch (name) {
    case 'list_allowed_folders':
      return {
        target: null,
        text: JSON.stringify(
          config.folders.map((f) => ({
            path: f.path,
            access: f.write ? 'read-write' : 'read-only',
          })),
          null,
          2,
        ),
      };
    case 'list_directory': {
      const dir = inside(args.path);
      if (!statSync(dir).isDirectory()) throw new FileToolError('That path is not a folder.');
      const rows = readdirSync(dir, { withFileTypes: true })
        .slice(0, LIST_MAX)
        .map((entry) => {
          let size: number | null;
          try {
            size = entry.isFile() ? lstatSync(path.join(dir, entry.name)).size : null;
          } catch {
            size = null;
          }
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'folder' : entry.isSymbolicLink() ? 'link' : 'file',
            size,
          };
        });
      return { target: dir, text: JSON.stringify(rows, null, 2) };
    }
    case 'read_text_file': {
      const file = inside(args.path);
      const limit =
        typeof args.max_bytes === 'number' && args.max_bytes > 0
          ? Math.min(Math.floor(args.max_bytes), READ_MAX)
          : READ_DEFAULT;
      const stat = statSync(file);
      if (!stat.isFile()) throw new FileToolError('That path is not a file.');
      const buffer = readFileSync(file).subarray(0, limit);
      if (buffer.includes(0)) throw new FileToolError('That file is not text.');
      const cut = stat.size > limit ? `\n\n[truncated: ${stat.size} bytes, showing ${limit}]` : '';
      return { target: file, text: `${buffer.toString('utf8')}${cut}` };
    }
    case 'write_text_file': {
      if (typeof args.content !== 'string') throw new FileToolError('content must be text.');
      if (Buffer.byteLength(args.content) > WRITE_MAX)
        throw new FileToolError('content is over 1 MB.');
      const file = inside(args.path, true);
      let exists = false;
      try {
        exists = lstatSync(file).isFile();
        if (!exists) throw new FileToolError('That path is a folder.');
      } catch (error) {
        if (error instanceof FileToolError) throw error;
      }
      if (exists && args.overwrite !== true)
        throw new FileToolError('That file exists; pass overwrite: true to replace it.');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, args.content, 'utf8');
      return { target: file, text: `Wrote ${Buffer.byteLength(args.content)} bytes to ${file}.` };
    }
    case 'open_path': {
      const file = inside(args.path);
      await env.openPath(file);
      return { target: file, text: `Opened ${file}.` };
    }
    case 'open_url': {
      let url: URL;
      try {
        url = new URL(String(args.url ?? ''));
      } catch {
        throw new FileToolError('That is not a link.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new FileToolError('Only http and https links are opened.');
      await env.openUrl(url.toString());
      return { target: url.toString(), text: `Opened ${url.toString()}.` };
    }
    default:
      throw new FileToolError(`Unknown tool "${name}".`);
  }
}

/** The OS's own opener, with an argument array and never a shell. */
export function systemOpener(platform: NodeJS.Platform = process.platform): OpenEnv {
  const run = (file: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile(file, args, { timeout: 15_000, windowsHide: true }, (error) => {
        // explorer.exe answers 1 even when it opened the target.
        const code = (error as { code?: unknown } | null)?.code;
        if (!error || (platform === 'win32' && code === 1)) resolve();
        else reject(new FileToolError(error.message));
      });
    });
  const open = (target: string) =>
    platform === 'darwin'
      ? run('open', [target])
      : platform === 'win32'
        ? run('explorer.exe', [target])
        : run('xdg-open', [target]);
  return { openPath: open, openUrl: open };
}
