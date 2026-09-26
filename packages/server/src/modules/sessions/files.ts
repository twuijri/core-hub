/**
 * A conversation's files, for preview (contract `sessions.listFiles` / `sessions.readFile`,
 * decision §48).
 *
 * Three places a file of a conversation comes from, and one rule over all of them: the hub
 * reads only inside the session's own working folder, never follows a symbolic link, and
 * never writes.
 *
 * - **Tool calls** name files in their arguments (`path`, `file_path`, ACP's `locations`…):
 *   `fileRefsOf` finds those names, per call and per run — which is also what a later
 *   "files changed in this run" answer is built from (it filters the same refs by run).
 * - **The working folder** is read to a bounded depth and count (`scanFolder`), newest
 *   first; hidden entries and `node_modules` are skipped — a tool call that named a file
 *   inside one still lists it.
 * - **Attachments** are `knowledge`'s; the service lists them from the messages and the
 *   client reads their bytes through `sessions.downloadAttachment`.
 *
 * Every function here is synchronous and bounded: a listing is asked for again each time a
 * tool call finishes, and must never walk a whole disk to answer.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { HubError, notFound } from '../../lib/errors.js';

export type PreviewKind =
  | 'html'
  | 'pdf'
  | 'image'
  | 'markdown'
  | 'code'
  | 'text'
  | 'csv'
  | 'xlsx'
  | 'docx'
  | 'pptx'
  | 'video'
  | 'audio'
  | 'none';

const MiB = 1024 * 1024;
/**
 * A video or a sound is played from a stream address, a range at a time (decision §92): nothing
 * holds the whole file, so its size is not what stops it. The cap only keeps the number honest.
 */
export const MEDIA_MAX_BYTES = 64 * 1024 * MiB;

/**
 * The largest file of each kind sent for preview. Text is small because a client renders
 * all of it at once; a PDF or a picture is handed to the browser's own viewer.
 */
export const PREVIEW_MAX_BYTES: Record<PreviewKind, number> = {
  html: 5 * MiB,
  pdf: 30 * MiB,
  image: 20 * MiB,
  markdown: 2 * MiB,
  code: 2 * MiB,
  text: 2 * MiB,
  csv: 5 * MiB,
  xlsx: 15 * MiB,
  docx: 15 * MiB,
  pptx: 15 * MiB,
  video: MEDIA_MAX_BYTES,
  audio: MEDIA_MAX_BYTES,
  none: 0,
};

/** The largest file `download=true` sends. */
export const DOWNLOAD_MAX_BYTES = 100 * MiB;

/** How deep and how wide the working folder is read for one listing. */
export const SCAN_MAX_DEPTH = 4;
export const SCAN_MAX_ENTRIES = 2000;
export const LIST_MAX_FILES = 200;

const OOXML = 'application/vnd.openxmlformats-officedocument';

/** Extension → kind and type. The type is chosen from the name, never sniffed. */
const BY_EXTENSION: Record<string, { kind: PreviewKind; mime: string }> = {
  html: { kind: 'html', mime: 'text/html' },
  htm: { kind: 'html', mime: 'text/html' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  md: { kind: 'markdown', mime: 'text/markdown' },
  markdown: { kind: 'markdown', mime: 'text/markdown' },
  csv: { kind: 'csv', mime: 'text/csv' },
  tsv: { kind: 'csv', mime: 'text/tab-separated-values' },
  xlsx: { kind: 'xlsx', mime: `${OOXML}.spreadsheetml.sheet` },
  docx: { kind: 'docx', mime: `${OOXML}.wordprocessingml.document` },
  pptx: { kind: 'pptx', mime: `${OOXML}.presentationml.presentation` },
  json: { kind: 'code', mime: 'application/json' },
  txt: { kind: 'text', mime: 'text/plain' },
  log: { kind: 'text', mime: 'text/plain' },
  text: { kind: 'text', mime: 'text/plain' },
  rst: { kind: 'text', mime: 'text/plain' },
  // Played by the client's own player; whether it can decode the format is its call (§92).
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  weba: { kind: 'audio', mime: 'audio/webm' },
};

/** Source code: shown highlighted, sent as plain text so a browser never runs it. */
const CODE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'xml', 'css', 'scss', 'less', 'sql', 'vue', 'svelte', 'lua', 'r', 'dart',
  'scala', 'pl', 'ex', 'exs', 'erl', 'hs', 'ml', 'tf', 'graphql', 'proto', 'diff', 'patch',
]); // prettier-ignore
const CODE_NAMES = new Set(['dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile']);

export interface FileType {
  kind: PreviewKind;
  /** The type the file is described with. */
  mime: string;
  /** The `Content-Type` it is sent with: code and text as UTF-8 plain text. */
  contentType: string;
}

export function fileTypeOf(name: string): FileType {
  const base = path.basename(name).toLowerCase();
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1) : '';
  const known = BY_EXTENSION[extension];
  if (known) {
    const textual = known.mime.startsWith('text/') || known.mime === 'application/json';
    return {
      ...known,
      contentType: textual ? `${known.mime}; charset=utf-8` : known.mime,
    };
  }
  if (CODE.has(extension) || CODE_NAMES.has(base)) {
    return { kind: 'code', mime: 'text/plain', contentType: 'text/plain; charset=utf-8' };
  }
  return {
    kind: 'none',
    mime: 'application/octet-stream',
    contentType: 'application/octet-stream',
  };
}

function refuse(reason: string, details: Record<string, unknown> = {}): never {
  throw new HubError('validation_failed', { details: { field: 'path', reason, ...details } });
}

/**
 * The file `requested` names inside `root`, checked, as a relative `/`-separated path and
 * its real absolute path — or a refusal. Every segment from the root down is `lstat`ed: a
 * symbolic link anywhere on the way is refused rather than followed, so a link an agent
 * planted cannot lead a read out of the folder.
 *
 * Throws `validation_failed` (outside the folder, a link, not a regular file) or
 * `not_found` (nothing there).
 */
export function resolveInside(
  root: string,
  requested: string,
): { relative: string; absolute: string; stats: Stats } {
  const raw = requested.trim();
  if (raw === '' || raw.includes('\0')) refuse('invalid');
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw notFound({ resource: 'file', id: raw });
  }
  const target = path.resolve(realRoot, raw);
  if (!target.startsWith(realRoot + path.sep)) refuse('outside_root');
  const relative = path.relative(realRoot, target);
  let walked = realRoot;
  let stats: Stats | undefined;
  for (const segment of relative.split(path.sep)) {
    walked = path.join(walked, segment);
    try {
      stats = lstatSync(walked);
    } catch {
      throw notFound({ resource: 'file', id: raw });
    }
    if (stats.isSymbolicLink()) refuse('symlink');
  }
  if (!stats?.isFile()) refuse('not_a_file');
  return { relative: relative.split(path.sep).join('/'), absolute: target, stats };
}

export interface OpenedFile {
  fd: number;
  size: number;
  relative: string;
  type: FileType;
}

/**
 * Open one file for reading, after `resolveInside`. `O_NOFOLLOW` closes the gap between the
 * check and the open: a link swapped in at the last moment fails the open instead of being
 * read, and `fstat` on the open descriptor decides the size that is checked against `cap`.
 */
export function openInside(root: string, requested: string, cap: (type: FileType) => number) {
  const { relative, absolute } = resolveInside(root, requested);
  let fd: number;
  try {
    fd = openSync(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') refuse('symlink');
    throw notFound({ resource: 'file', id: requested });
  }
  const stats = fstatSync(fd);
  if (!stats.isFile()) {
    closeSync(fd);
    refuse('not_a_file');
  }
  const type = fileTypeOf(relative);
  const max = cap(type);
  if (stats.size > max) {
    closeSync(fd);
    throw new HubError('payload_too_large', {
      details: { max_bytes: max, size_bytes: stats.size, preview: type.kind },
    });
  }
  return { fd, size: stats.size, relative, type } satisfies OpenedFile;
}

export interface FolderFile {
  relative: string;
  sizeBytes: number;
  modifiedMs: number;
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__']);

/**
 * The files of a working folder, newest first, bounded: at most `SCAN_MAX_DEPTH` levels and
 * `SCAN_MAX_ENTRIES` entries looked at, at most `LIST_MAX_FILES` answered. Hidden entries
 * (`.git`, `.env`, the hub's own `.corehub` run folders) and `node_modules` are skipped, and
 * links are never followed.
 */
export function scanFolder(root: string): { files: FolderFile[]; truncated: boolean } {
  const files: FolderFile[] = [];
  let seen = 0;
  let truncated = false;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { files, truncated };
  }
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= SCAN_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      seen += 1;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (depth >= SCAN_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        walk(full, relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = lstatSync(full);
        files.push({ relative, sizeBytes: stats.size, modifiedMs: stats.mtimeMs });
      } catch {
        // Gone between the two reads: not a file of this folder any more.
      }
    }
  };
  walk(realRoot, '', 1);
  files.sort((a, b) => b.modifiedMs - a.modifiedMs || a.relative.localeCompare(b.relative));
  if (files.length > LIST_MAX_FILES) truncated = true;
  return { files: files.slice(0, LIST_MAX_FILES), truncated };
}

/** The argument names agents put a file's path under (Hermes, the ACP agents, our own). */
const PATH_KEYS = [
  'path',
  'file_path',
  'filepath',
  'filename',
  'file',
  'target_file',
  'notebook_path',
  'output_path',
  'output_file',
  'destination',
  'dest',
  'new_path',
];
const PATH_LIST_KEYS = ['paths', 'files', 'locations'];

/** A tool whose one-line preview is the file it works on. */
const FILE_TOOL = /write|edit|patch|create|save|file|notebook|read|view|open/i;
/** The last word of a preview line when it looks like a file name (has an extension). */
const PATH_IN_PREVIEW = /(?:^|\s)((?:~|\.{1,2})?\/?[^\s"'`<>|]*\.[A-Za-z0-9]{1,10})$/;

function pathLike(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > 4096 || /[\n\r\0]/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null; // a URL, not a file
  return text;
}

export interface ToolCallLike {
  id: string;
  runId: string;
  name: string;
  kind: string | null;
  title: string | null;
  input: Record<string, unknown> | null;
}

export interface FileRef {
  toolCallId: string;
  runId: string;
  /** As the agent wrote it: absolute, or relative to the working folder. */
  path: string;
}

/**
 * The files each tool call names, in call order. A later "files changed in this run" answer
 * is these refs filtered by `runId`.
 */
export function fileRefsOf(calls: readonly ToolCallLike[]): FileRef[] {
  const refs: FileRef[] = [];
  for (const call of calls) {
    const found = new Set<string>();
    const input = call.input ?? {};
    for (const key of PATH_KEYS) {
      const value = pathLike(input[key]);
      if (value) found.add(value);
    }
    for (const key of PATH_LIST_KEYS) {
      const list = input[key];
      if (!Array.isArray(list)) continue;
      for (const item of list.slice(0, 50)) {
        const value = pathLike(
          item && typeof item === 'object' ? (item as { path?: unknown }).path : item,
        );
        if (value) found.add(value);
      }
    }
    if (found.size === 0 && FILE_TOOL.test(`${call.name} ${call.kind ?? ''}`)) {
      // Hermes's run stream carries a one-line preview, not the arguments.
      const line = pathLike(
        typeof input.preview === 'string' ? input.preview : (call.title ?? null),
      );
      const match = line ? PATH_IN_PREVIEW.exec(line) : null;
      if (match?.[1]) found.add(match[1]);
    }
    for (const value of found) refs.push({ toolCallId: call.id, runId: call.runId, path: value });
  }
  return refs;
}

export interface AttachmentOnMessage {
  id: string;
  messageId: string;
  at: number;
  name: string;
  mime: string;
  sizeBytes: number;
}

/** The contract's `SessionFile`. */
export interface SessionFileEntry {
  key: string;
  name: string;
  path: string | null;
  attachment_id: string | null;
  message_id: string | null;
  mime: string;
  preview: PreviewKind;
  size_bytes: number;
  preview_max_bytes: number;
  modified_at: string | null;
  sources: Array<'tool' | 'working_dir' | 'attachment'>;
  tool_call_ids: string[];
}

/**
 * The contract's `SessionFileList`: the files tool calls named that are still there, the
 * folder's own files, and the attachments, one entry per file, newest first.
 */
export function listSessionFiles(input: {
  workingDir: string | null;
  toolCalls: readonly ToolCallLike[];
  attachments: readonly AttachmentOnMessage[];
}): { working_dir: string | null; truncated: boolean; items: SessionFileEntry[] } {
  const entries = new Map<string, SessionFileEntry & { at: number }>();
  let truncated = false;
  const onDisk = (relative: string, sizeBytes: number, modifiedMs: number) => {
    const key = `path:${relative}`;
    const existing = entries.get(key);
    if (existing) return existing;
    const type = fileTypeOf(relative);
    const entry = {
      key,
      name: relative.split('/').at(-1) ?? relative,
      path: relative,
      attachment_id: null,
      message_id: null,
      mime: type.mime,
      preview: type.kind,
      size_bytes: sizeBytes,
      preview_max_bytes: PREVIEW_MAX_BYTES[type.kind],
      modified_at: new Date(modifiedMs).toISOString(),
      sources: [],
      tool_call_ids: [],
      at: modifiedMs,
    } satisfies SessionFileEntry & { at: number };
    entries.set(key, entry);
    return entry;
  };

  if (input.workingDir) {
    for (const ref of fileRefsOf(input.toolCalls)) {
      let resolved;
      try {
        resolved = resolveInside(input.workingDir, ref.path);
      } catch {
        continue; // Outside the folder, a link, or gone: not a file this list may offer.
      }
      const entry = onDisk(resolved.relative, resolved.stats.size, resolved.stats.mtimeMs);
      if (!entry.sources.includes('tool')) entry.sources.push('tool');
      if (!entry.tool_call_ids.includes(ref.toolCallId)) entry.tool_call_ids.push(ref.toolCallId);
    }
    const scan = scanFolder(input.workingDir);
    truncated = scan.truncated;
    for (const file of scan.files) {
      const entry = onDisk(file.relative, file.sizeBytes, file.modifiedMs);
      entry.sources.push('working_dir');
    }
  }
  for (const attachment of input.attachments) {
    const key = `attachment:${attachment.id}`;
    if (entries.has(key)) continue;
    const type = fileTypeOf(attachment.name);
    // The stored type wins when the name says nothing (a pasted picture named `image`, a
    // recording named `voice`).
    const kind: PreviewKind =
      type.kind !== 'none'
        ? type.kind
        : attachment.mime.startsWith('image/')
          ? 'image'
          : attachment.mime.startsWith('video/')
            ? 'video'
            : attachment.mime.startsWith('audio/')
              ? 'audio'
              : 'none';
    entries.set(key, {
      key,
      name: attachment.name,
      path: null,
      attachment_id: attachment.id,
      message_id: attachment.messageId,
      mime: attachment.mime || type.mime,
      preview: kind,
      size_bytes: attachment.sizeBytes,
      preview_max_bytes: PREVIEW_MAX_BYTES[kind],
      modified_at: null,
      sources: ['attachment'],
      tool_call_ids: [],
      at: attachment.at,
    });
  }
  const items = [...entries.values()]
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
    .map(({ at: _at, ...entry }) => entry);
  return { working_dir: input.workingDir, truncated, items };
}
