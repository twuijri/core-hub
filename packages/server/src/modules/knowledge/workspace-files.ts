/**
 * The profile's working files: `${DATA_DIR}/workspaces/<profile>`, and nothing else.
 *
 * Agents work in folders under that root (one per conversation, one per task). This is the
 * file manager over it — list, read, write, upload, make folders, move, copy, delete, zip —
 * and never a shell: nothing here runs a program. Contract decision §65.
 *
 * One rule decides every path, before any byte moves:
 *
 * 1. The client sends a path relative to the root, `/`-separated. An absolute path, a NUL
 *    byte or a `..` that climbs above the root is refused (`400 validation_failed`,
 *    `details.reason` `absolute` / `invalid` / `outside_root`).
 * 2. Every existing folder on the way is resolved with `realpath`, and the result must still
 *    be the root or inside it. A symlink planted under the root that leads to `/data/keys`,
 *    Hermes's home or another profile therefore fails here (`symlink_outside`), whatever
 *    the lexical path looked like.
 * 3. Work happens at the *real* path: the real parent plus the entry's own name. An entry
 *    that is itself a link is deleted or moved as a link and never written through; it is
 *    read through only when its target is inside the root.
 * 4. A file is opened with `O_NOFOLLOW`, and where `/proc/self/fd` exists the opened
 *    descriptor's path is checked once more, so a folder swapped for a link between the
 *    check and the open cannot lead a read or a write outside.
 *
 * Caps (`WORKSPACE_FILE_LIMITS`): an upload is the one-shot attachment ceiling, an edit is
 * 1 MiB of UTF-8, and a zip or a folder copy stops at 200 MiB of file bytes or 20 000
 * entries before it starts.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
  createReadStream,
  type ReadStream,
} from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HubError, notFound } from '../../lib/errors.js';
import { rangeReply } from '../../lib/byte-range.js';
import { MAX_UPLOAD_BYTES } from './limits.js';
import type { ZipItem } from './zip.js';

export const WORKSPACE_FILE_LIMITS = {
  /** One upload, and one file made into an attachment: the one-shot attachment ceiling. */
  maxUploadBytes: MAX_UPLOAD_BYTES,
  /** The largest file the editor opens or saves. */
  maxEditBytes: 1024 * 1024,
  /** File bytes in one zip, or in one folder copy. */
  maxArchiveBytes: 200 * 1024 * 1024,
  /** Entries in one zip, or in one folder copy. */
  maxArchiveEntries: 20_000,
} as const;

/** A folder with more entries than this is listed in part (`truncated`). */
export const MAX_LIST_ENTRIES = 5000;

/** The longest name one entry may take (most filesystems stop at 255 bytes). */
const MAX_NAME_BYTES = 255;

export type EntryKind = 'file' | 'directory' | 'link';

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  link: boolean;
  size_bytes: number | null;
  modified_at: string | null;
  mime: string | null;
  editable: boolean;
}

export interface WorkspaceText {
  path: string;
  content: string;
  etag: string;
  size_bytes: number;
  modified_at: string;
}

export interface OpenedFile {
  stream: ReadStream;
  name: string;
  size: number;
  /** `206` when one byte range of it was asked for (decision §97). */
  status: 200 | 206;
  /** `Accept-Ranges`, `Content-Length` and, for a range, `Content-Range`. */
  lengthHeaders: Record<string, string>;
  mime: string;
  etag: string;
  modifiedAt: Date;
}

// --------------------------------------------------------------- media types

const TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.toml': 'application/toml',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
};

/** Names the editor opens: text by name, not by guesswork on the bytes. */
const TEXT_EXTENSIONS = new Set([
  ...Object.entries(TYPES)
    .filter(
      ([, mime]) =>
        mime.startsWith('text/') ||
        ['application/json', 'application/x-ndjson', 'application/yaml'].includes(mime) ||
        ['application/xml', 'application/toml', 'application/sql'].includes(mime),
    )
    .map(([extension]) => extension),
  '.txt',
  '.log',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.pl',
  '.lua',
  '.r',
  '.scss',
  '.less',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.properties',
  '.gradle',
  '.dockerfile',
  '.gitignore',
  '.editorconfig',
  '.lock',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.tex',
  '.rst',
  '.adoc',
  '.svg',
]);
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'license', 'readme', 'procfile', 'gemfile']);

/** A media type from the name; `application/octet-stream` when the name says nothing. */
export function mimeOf(name: string): string {
  return TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Whether the editor should offer to open this name. */
export function isTextName(name: string): boolean {
  const lower = name.toLowerCase();
  const extension = path.extname(lower);
  if (extension === '') return TEXT_NAMES.has(lower) || lower.startsWith('.');
  return TEXT_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(lower);
}

// ------------------------------------------------------------------ refusals

/** The sentence each refusal is shown with; the rest keep the generic validation text. */
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  root: 'knowledge.workspace_root',
  into_itself: 'knowledge.workspace_into_itself',
  symlink: 'knowledge.workspace_symlink',
  invalid_name: 'knowledge.workspace_invalid_name',
  absolute: 'knowledge.workspace_outside',
  outside_root: 'knowledge.workspace_outside',
  symlink_outside: 'knowledge.workspace_outside',
  invalid: 'knowledge.workspace_outside',
};

function refuse(reason: string, extra: Record<string, unknown> = {}): never {
  const messageKey = REFUSAL_MESSAGES[reason];
  throw new HubError('validation_failed', {
    details: { field: 'path', reason, ...extra },
    ...(messageKey ? { messageKey } : {}),
  });
}

function missing(rel: string): never {
  throw notFound({ resource: 'workspace_file', path: rel });
}

function exists(rel: string): never {
  throw new HubError('conflict', {
    details: { reason: 'exists', path: rel },
    messageKey: 'knowledge.workspace_exists',
  });
}

function tooLarge(maxBytes: number, extra: Record<string, unknown> = {}): HubError {
  return new HubError('payload_too_large', { details: { max_bytes: maxBytes, ...extra } });
}

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ||
  (error as NodeJS.ErrnoException | null)?.code === 'ENOTDIR';

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** A one-segment name a person gave a new file or folder. */
export function checkName(raw: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused.
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    Buffer.byteLength(name) > MAX_NAME_BYTES
  ) {
    refuse('invalid_name', { name: raw });
  }
  return name;
}

// ----------------------------------------------------------------- the files

interface Located {
  /** Relative to the root, `/`-separated; `''` is the root. */
  rel: string;
  /** The real path of the parent joined with the entry's own name (the root for `''`). */
  abs: string;
}

export class WorkspaceFiles {
  private cachedRoot: string | null = null;

  constructor(private readonly root: string) {}

  /** The root's real path, made on first use: an empty profile has an empty folder. */
  realRoot(): string {
    if (this.cachedRoot) return this.cachedRoot;
    mkdirSync(this.root, { recursive: true });
    this.cachedRoot = realpathSync(this.root);
    return this.cachedRoot;
  }

  private inside(real: string): boolean {
    const root = this.realRoot();
    return real === root || real.startsWith(root + path.sep);
  }

  private relOf(abs: string): string {
    return path.relative(this.realRoot(), abs).split(path.sep).join('/');
  }

  /** Rule 1: the lexical path, normalised, or a refusal. */
  private lexical(raw: string | undefined | null): { rel: string; target: string } {
    const text = (raw ?? '').trim();
    if (text.includes('\0')) refuse('invalid');
    if (text.startsWith('/') || text.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(text)) {
      refuse('absolute');
    }
    const root = this.realRoot();
    const target = path.resolve(root, text === '' ? '.' : text);
    if (!this.inside(target)) refuse('outside_root');
    return { rel: this.relOf(target), target };
  }

  /**
   * Rule 2: the real path of an existing folder, which must be inside the root. `rel`
   * names it for messages.
   */
  private realFolder(folder: string, rel: string): string {
    let real: string;
    try {
      real = realpathSync(folder);
    } catch (error) {
      if (isMissing(error)) missing(rel);
      throw error;
    }
    if (!this.inside(real)) refuse('symlink_outside');
    return real;
  }

  /** Where an entry is, without following the entry itself if it is a link. */
  private locate(raw: string | undefined | null): Located {
    const { rel, target } = this.lexical(raw);
    if (rel === '') return { rel, abs: this.realRoot() };
    const parentRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const parent = this.realFolder(path.dirname(target), parentRel);
    return { rel, abs: path.join(parent, path.basename(target)) };
  }

  /** An existing entry, followed when it is a link inside the root. */
  private existing(raw: string | undefined | null): Located & { real: string; stats: Stats } {
    const located = this.locate(raw);
    const own = lstatOrNull(located.abs);
    if (!own) missing(located.rel);
    if (!own.isSymbolicLink()) return { ...located, real: located.abs, stats: own };
    let real: string;
    try {
      real = realpathSync(located.abs);
    } catch (error) {
      if (isMissing(error)) missing(located.rel);
      throw error;
    }
    if (!this.inside(real)) refuse('symlink_outside');
    return { ...located, real, stats: statSync(real) };
  }

  /** A place for a new entry: its folder must exist (inside the root), the name must not. */
  private fresh(raw: string | undefined | null): Located {
    const located = this.locate(raw);
    if (located.rel === '') refuse('root');
    checkName(path.posix.basename(located.rel));
    if (lstatOrNull(located.abs)) exists(located.rel);
    return located;
  }

  /** Rule 4: open with `O_NOFOLLOW` and check where the descriptor really points. */
  private openInside(real: string, flags: number): number {
    const fd = openSync(real, flags | constants.O_NOFOLLOW);
    try {
      const actual = readlinkSync(`/proc/self/fd/${String(fd)}`);
      if (!this.inside(actual)) refuse('symlink_outside');
    } catch (error) {
      if (error instanceof HubError) {
        closeSync(fd);
        throw error;
      }
      // No /proc (not Linux): rules 2 and 3 already held a moment ago.
    }
    return fd;
  }

  private entryOf(abs: string, own: Stats): WorkspaceFileEntry {
    const name = path.basename(abs);
    const rel = this.relOf(abs);
    let stats: Stats | null = own;
    let link = false;
    if (own.isSymbolicLink()) {
      link = true;
      stats = null;
      try {
        const real = realpathSync(abs);
        if (this.inside(real)) stats = statSync(real);
      } catch {
        stats = null;
      }
    }
    if (!stats || (!stats.isFile() && !stats.isDirectory())) {
      return {
        name,
        path: rel,
        kind: 'link',
        link,
        size_bytes: null,
        modified_at: null,
        mime: null,
        editable: false,
      };
    }
    const file = stats.isFile();
    return {
      name,
      path: rel,
      kind: file ? 'file' : 'directory',
      link,
      size_bytes: file ? stats.size : null,
      modified_at: stats.mtime.toISOString(),
      mime: file ? mimeOf(name) : null,
      editable: file && stats.size <= WORKSPACE_FILE_LIMITS.maxEditBytes && isTextName(name),
    };
  }

  /** The entry at a path, as a list would show it. */
  describe(raw: string): WorkspaceFileEntry {
    const located = this.locate(raw);
    const own = lstatOrNull(located.abs);
    if (!own) missing(located.rel);
    return this.entryOf(located.abs, own);
  }

  // ------------------------------------------------------------------- reads

  list(raw: string | undefined): {
    path: string;
    entries: WorkspaceFileEntry[];
    truncated: boolean;
  } {
    const folder = this.existing(raw);
    if (!folder.stats.isDirectory()) refuse('not_a_directory', { path: folder.rel });
    const dirents = readdirSync(folder.real, { withFileTypes: true });
    const entries: WorkspaceFileEntry[] = [];
    for (const dirent of dirents) {
      const abs = path.join(folder.real, dirent.name);
      const own = lstatOrNull(abs);
      if (!own) continue; // Gone between the listing and the look: an agent is working.
      entries.push(this.entryOf(abs, own));
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name),
    );
    return {
      path: folder.rel,
      entries: entries.slice(0, MAX_LIST_ENTRIES),
      truncated: entries.length > MAX_LIST_ENTRIES,
    };
  }

  /**
   * A file to stream out; the caller sends it and the stream closes the descriptor. With a
   * `Range` header, only that range (decision §97); one past the end throws the `416`.
   */
  open(raw: string, rangeHeader?: unknown): OpenedFile {
    const file = this.existing(raw);
    if (!file.stats.isFile()) refuse('not_a_file', { path: file.rel });
    const fd = this.openInside(file.real, constants.O_RDONLY);
    const stats = fstatSync(fd);
    let window: ReturnType<typeof rangeReply>;
    try {
      window = rangeReply(rangeHeader, stats.size);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return {
      stream: createReadStream('', { fd, autoClose: true, start: window.start, end: window.end }),
      name: path.basename(file.abs),
      size: stats.size,
      status: window.status,
      lengthHeaders: window.headers,
      mime: mimeOf(file.abs),
      etag: `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
      modifiedAt: stats.mtime,
    };
  }

  readText(raw: string): WorkspaceText {
    const file = this.existing(raw);
    if (!file.stats.isFile()) refuse('not_a_file', { path: file.rel });
    if (file.stats.size > WORKSPACE_FILE_LIMITS.maxEditBytes) {
      throw tooLarge(WORKSPACE_FILE_LIMITS.maxEditBytes);
    }
    const fd = this.openInside(file.real, constants.O_RDONLY);
    let bytes: Buffer;
    let stats: Stats;
    try {
      stats = fstatSync(fd);
      if (stats.size > WORKSPACE_FILE_LIMITS.maxEditBytes) {
        throw tooLarge(WORKSPACE_FILE_LIMITS.maxEditBytes);
      }
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    return {
      path: file.rel,
      content: textOf(bytes),
      etag: etagOf(bytes),
      size_bytes: bytes.length,
      modified_at: stats.mtime.toISOString(),
    };
  }

  // ------------------------------------------------------------------ writes

  /**
   * Save text. `etag` is what the editor read (null for a new file): a file that changed
   * since is `409 conflict` with the current etag, and nothing is written.
   */
  writeText(raw: string, content: string, etag: string | null): WorkspaceText {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > WORKSPACE_FILE_LIMITS.maxEditBytes) {
      throw tooLarge(WORKSPACE_FILE_LIMITS.maxEditBytes);
    }
    const located = this.locate(raw);
    if (located.rel === '') refuse('not_a_file');
    checkName(path.posix.basename(located.rel));
    const own = lstatOrNull(located.abs);
    if (own?.isSymbolicLink()) refuse('symlink', { path: located.rel });
    if (own && !own.isFile()) refuse('not_a_file', { path: located.rel });
    if (!own && etag !== null) {
      throw new HubError('conflict', {
        details: { reason: 'changed', etag: null, path: located.rel },
        messageKey: 'knowledge.workspace_changed',
      });
    }
    if (own) {
      if (etag === null) exists(located.rel);
      const current = this.currentEtag(located.abs);
      if (current !== etag) {
        throw new HubError('conflict', {
          details: { reason: 'changed', etag: current, path: located.rel },
          messageKey: 'knowledge.workspace_changed',
        });
      }
    }
    this.replaceWith(located.abs, (temp) => writeFileSync(temp, bytes, { flag: 'wx' }), own);
    const stats = lstatSync(located.abs);
    return {
      path: located.rel,
      content,
      etag: etagOf(bytes),
      size_bytes: bytes.length,
      modified_at: stats.mtime.toISOString(),
    };
  }

  private currentEtag(abs: string): string {
    const fd = this.openInside(abs, constants.O_RDONLY);
    try {
      return etagOf(readFileSync(fd));
    } finally {
      closeSync(fd);
    }
  }

  /** Write to a temporary sibling, then rename over: a reader never sees half a file. */
  private replaceWith(abs: string, write: (temp: string) => void, previous: Stats | null): void {
    const temp = path.join(
      path.dirname(abs),
      `.${path.basename(abs).slice(0, 64)}.corehub-${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      write(temp);
      if (previous) {
        try {
          // Keep the file's permissions: a script an agent made executable stays so.
          chmodSync(temp, previous.mode & 0o7777);
        } catch {
          // Best effort.
        }
      }
      renameSync(temp, abs);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  /** One uploaded file into an existing folder. */
  async upload(
    folderRaw: string,
    filename: string,
    body: Readable,
    overwrite: boolean,
  ): Promise<WorkspaceFileEntry> {
    const folder = this.existing(folderRaw);
    if (!folder.stats.isDirectory()) refuse('not_a_directory', { path: folder.rel });
    const name = checkName(path.basename(filename.replaceAll('\\', '/')));
    const abs = path.join(folder.real, name);
    const rel = this.relOf(abs);
    const own = lstatOrNull(abs);
    if (own && (!own.isFile() || own.isSymbolicLink() || !overwrite)) exists(rel);

    const temp = path.join(
      folder.real,
      `.${name.slice(0, 64)}.corehub-${randomBytes(6).toString('hex')}.tmp`,
    );
    const max = WORKSPACE_FILE_LIMITS.maxUploadBytes;
    let seen = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        seen += chunk.length;
        if (seen > max) done(tooLarge(max));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(temp, { flags: 'wx' }));
      // The multipart reader truncates at its own limit and flags it rather than failing.
      if ((body as Readable & { truncated?: boolean }).truncated) throw tooLarge(max);
      renameSync(temp, abs);
    } catch (error) {
      rmSync(temp, { force: true });
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(max);
      throw error;
    }
    return this.entryOf(abs, lstatSync(abs));
  }

  /** A new folder; the folders above it are made too, each checked on the way down. */
  mkdir(raw: string): WorkspaceFileEntry {
    const { rel } = this.lexical(raw);
    if (rel === '') exists(rel);
    let current = this.realRoot();
    const segments = rel.split('/');
    segments.forEach((segment, index) => {
      checkName(segment);
      const next = path.join(current, segment);
      const own = lstatOrNull(next);
      const last = index === segments.length - 1;
      if (!own) {
        mkdirSync(next);
        current = next;
        return;
      }
      if (last) exists(rel);
      current = this.realFolder(next, segments.slice(0, index + 1).join('/'));
      if (!statSync(current).isDirectory()) refuse('not_a_directory', { path: rel });
    });
    return this.entryOf(current, lstatSync(current));
  }

  /** Rename or move. A link moves as a link; a folder cannot go into itself. */
  move(fromRaw: string, toRaw: string): WorkspaceFileEntry {
    const from = this.locate(fromRaw);
    if (from.rel === '') refuse('root');
    const own = lstatOrNull(from.abs);
    if (!own) missing(from.rel);
    const to = this.fresh(toRaw);
    if (own.isDirectory() && !own.isSymbolicLink() && within(from.abs, to.abs)) {
      refuse('into_itself');
    }
    renameSync(from.abs, to.abs);
    return this.entryOf(to.abs, lstatSync(to.abs));
  }

  /** Copy a file or a folder (links left out), capped like a zip; never half a copy. */
  copy(fromRaw: string, toRaw: string): WorkspaceFileEntry {
    const from = this.existing(fromRaw);
    const to = this.fresh(toRaw);
    if (from.stats.isFile()) {
      if (from.stats.size > WORKSPACE_FILE_LIMITS.maxArchiveBytes) {
        throw tooLarge(WORKSPACE_FILE_LIMITS.maxArchiveBytes);
      }
      copyFileSync(from.real, to.abs, constants.COPYFILE_EXCL);
      return this.entryOf(to.abs, lstatSync(to.abs));
    }
    if (within(from.real, to.abs)) refuse('into_itself');
    const tree = this.walk(from.real, '');
    const temp = path.join(
      path.dirname(to.abs),
      `.${path.basename(to.abs).slice(0, 64)}.corehub-${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      mkdirSync(temp);
      for (const item of tree) {
        const target = path.join(temp, ...item.name.split('/').filter(Boolean));
        if (item.source === undefined) mkdirSync(target, { recursive: true });
        else copyFileSync(item.source, target, constants.COPYFILE_EXCL);
      }
      renameSync(temp, to.abs);
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
    return this.entryOf(to.abs, lstatSync(to.abs));
  }

  /** Delete a file, a link (as a link) or a folder with everything in it. */
  remove(raw: string): void {
    const located = this.locate(raw);
    if (located.rel === '') refuse('root');
    if (!lstatOrNull(located.abs)) missing(located.rel);
    // `rm` never follows a link: a link is unlinked, a folder's links are unlinked too.
    rmSync(located.abs, { recursive: true, force: false });
  }

  // -------------------------------------------------------------------- zips

  /** What a zip of this folder holds, checked against the caps before a byte is sent. */
  archive(raw: string): { name: string; items: ZipItem[] } {
    const folder = this.existing(raw);
    if (!folder.stats.isDirectory()) refuse('not_a_directory', { path: folder.rel });
    const base = folder.rel === '' ? '' : path.basename(folder.abs);
    return { name: base, items: this.walk(folder.real, '') };
  }

  /**
   * Every folder and file under `start` (links left out, never followed), as zip items
   * named relative to it. Throws `413` as soon as a cap is passed.
   */
  private walk(start: string, prefix: string): ZipItem[] {
    const items: ZipItem[] = [];
    let bytes = 0;
    const visit = (folder: string, name: string) => {
      for (const dirent of readdirSync(folder, { withFileTypes: true })) {
        const abs = path.join(folder, dirent.name);
        const own = lstatOrNull(abs);
        if (!own || own.isSymbolicLink()) continue;
        const itemName = `${name}${dirent.name}`;
        if (own.isDirectory()) {
          items.push({ name: `${itemName}/`, modifiedAt: own.mtime });
          count();
          visit(abs, `${itemName}/`);
        } else if (own.isFile()) {
          bytes += own.size;
          if (bytes > WORKSPACE_FILE_LIMITS.maxArchiveBytes) {
            throw tooLarge(WORKSPACE_FILE_LIMITS.maxArchiveBytes, {
              max_entries: WORKSPACE_FILE_LIMITS.maxArchiveEntries,
            });
          }
          items.push({ name: itemName, source: abs, modifiedAt: own.mtime });
          count();
        }
      }
    };
    const count = () => {
      if (items.length > WORKSPACE_FILE_LIMITS.maxArchiveEntries) {
        throw tooLarge(WORKSPACE_FILE_LIMITS.maxArchiveBytes, {
          max_entries: WORKSPACE_FILE_LIMITS.maxArchiveEntries,
        });
      }
    };
    visit(start, prefix);
    return items;
  }
}

// ----------------------------------------------------------------- internals

/** Whether `candidate` is `folder` or somewhere under it. */
function within(folder: string, candidate: string): boolean {
  return candidate === folder || candidate.startsWith(folder + path.sep);
}

/** A strong validator of the bytes: a save conflict must not hide behind an equal mtime. */
export function etagOf(bytes: Buffer): string {
  return `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
}

/** UTF-8 text, or `415`: a NUL byte or an invalid sequence means this is not for the editor. */
function textOf(bytes: Buffer): string {
  if (bytes.includes(0)) {
    throw new HubError('unsupported_media_type', {
      details: { reason: 'binary' },
      messageKey: 'knowledge.workspace_not_text',
    });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HubError('unsupported_media_type', {
      details: { reason: 'not_utf8' },
      messageKey: 'knowledge.workspace_not_text',
    });
  }
}
