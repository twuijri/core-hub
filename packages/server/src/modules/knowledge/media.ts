/**
 * What the hub is willing to believe about a file.
 *
 * Nothing the client says about a file is trusted:
 *
 * - **the name** is sanitised (`sanitiseFilename`): no directory separators, no `..`,
 *   no NUL, no control characters, no leading dot, no Windows-reserved stem, length
 *   capped. The sanitised name is what is stored and what a download offers; the bytes
 *   are never addressed by it (`storage_key` is the content hash).
 * - **the media type** is sniffed from the first bytes (`sniffMime`) and the sniffed
 *   answer wins whenever it disagrees with the client's. When nothing is recognised the
 *   hub falls back to the extension's type, and to `application/octet-stream` — never to
 *   the client's string, because a `.exe` announced as `image/png` is exactly the lie
 *   this function exists to stop.
 *
 * Both are pure functions over a `Buffer` prefix, so the unit tests read like a table.
 */
import path from 'node:path';
import { MAX_FILENAME_LENGTH } from './limits.js';
import type { ATTACHMENT_KINDS } from './schema.js';

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Enough bytes for every signature below. */
export const SNIFF_BYTES = 64;

const RESERVED_STEMS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * A safe, human-recognisable file name, or `file` when nothing survives.
 *
 * Only the basename is considered: `../../etc/passwd` and `C:\Windows\x.dll` both
 * become `passwd` / `x.dll`. A name that is entirely separators, dots or control
 * characters has no basename to keep, so it becomes `file`.
 */
export function sanitiseFilename(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  // Both separators, whatever the client's platform, then the basename only.
  const base = text.split(/[\\/]/).pop() ?? '';
  let name = base
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is stripped.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    // A trailing dot or space is dropped by Windows on write; drop it here instead.
    .replace(/[. ]+$/, '');
  while (name.startsWith('.')) name = name.slice(1);
  if (name === '' || name === '..') return 'file';
  if (name.length > MAX_FILENAME_LENGTH) {
    const extension = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
  }
  const stem = name.slice(0, name.length - path.extname(name).length).toLowerCase();
  if (RESERVED_STEMS.has(stem)) name = `_${name}`;
  return name;
}

interface Signature {
  mime: string;
  /** Byte pattern; `null` in the array matches any byte. */
  magic: readonly (number | null)[];
  offset?: number;
  /** A second window that must also match (RIFF/ftyp containers). */
  also?: { offset: number; magic: readonly (number | null)[] };
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const SIGNATURES: readonly Signature[] = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', magic: ascii('GIF8') },
  { mime: 'image/bmp', magic: ascii('BM') },
  {
    mime: 'image/webp',
    magic: ascii('RIFF'),
    also: { offset: 8, magic: ascii('WEBP') },
  },
  {
    mime: 'audio/wav',
    magic: ascii('RIFF'),
    also: { offset: 8, magic: ascii('WAVE') },
  },
  { mime: 'image/tiff', magic: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', magic: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: 'application/pdf', magic: ascii('%PDF-') },
  { mime: 'application/gzip', magic: [0x1f, 0x8b] },
  { mime: 'application/zip', magic: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/zip', magic: [0x50, 0x4b, 0x05, 0x06] },
  { mime: 'application/x-7z-compressed', magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: 'application/x-tar', magic: ascii('ustar'), offset: 257 },
  { mime: 'audio/mpeg', magic: ascii('ID3') },
  { mime: 'audio/mpeg', magic: [0xff, 0xfb] },
  { mime: 'audio/ogg', magic: ascii('OggS') },
  { mime: 'audio/flac', magic: ascii('fLaC') },
  { mime: 'video/x-matroska', magic: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'video/mp4', magic: ascii('ftypisom'), offset: 4 },
  { mime: 'video/mp4', magic: ascii('ftypmp4'), offset: 4 },
  { mime: 'video/quicktime', magic: ascii('ftypqt'), offset: 4 },
  { mime: 'audio/mp4', magic: ascii('ftypM4A'), offset: 4 },
  // Executables: recognised precisely so they are never dressed up as something else.
  { mime: 'application/x-msdownload', magic: ascii('MZ') },
  { mime: 'application/x-elf', magic: [0x7f, 0x45, 0x4c, 0x46] },
  { mime: 'application/java-archive', magic: [0xca, 0xfe, 0xba, 0xbe] },
];

/** Extensions the hub is prepared to name when the bytes carry no signature. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.sql': 'application/sql',
  '.log': 'text/plain; charset=utf-8',
  '.diff': 'text/x-diff; charset=utf-8',
  '.patch': 'text/x-diff; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function matches(head: Buffer, pattern: readonly (number | null)[], offset: number): boolean {
  if (head.length < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i];
    if (expected !== null && expected !== undefined && head[offset + i] !== expected) return false;
  }
  return true;
}

/** The signature the bytes actually carry, or `null` when none is recognised. */
export function sniffSignature(head: Buffer): string | null {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (!matches(head, signature.magic, offset)) continue;
    if (signature.also && !matches(head, signature.also.magic, signature.also.offset)) continue;
    return signature.mime;
  }
  return null;
}

/** True when the prefix is valid, printable-ish UTF-8: a text file with no signature. */
export function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(head);
  if (decoded.includes('\ufffd')) return false;
  let control = 0;
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) control += 1;
  }
  return control * 20 <= decoded.length;
}

export interface SniffResult {
  mime: string;
  /** How the answer was reached; the logs and the tests both read it. */
  source: 'magic' | 'extension' | 'text' | 'fallback';
  /** True when the client announced something else. */
  overrode: boolean;
}

/**
 * The media type the hub will store, from the bytes first and the name second.
 * `declared` is only ever used to report that it was overridden.
 */
export function sniffMime(head: Buffer, filename: string, declared?: string | null): SniffResult {
  const extension = path.extname(filename).toLowerCase();
  const magic = sniffSignature(head);
  // An SVG is XML: it has no signature, so the extension decides — and it is served
  // as a download, never inline (see `contentDispositionOf`).
  const byExtension = BY_EXTENSION[extension];
  const answer =
    magic ??
    (byExtension && (looksLikeText(head) || byExtension === 'image/svg+xml')
      ? byExtension
      : looksLikeText(head)
        ? 'text/plain; charset=utf-8'
        : 'application/octet-stream');
  const source: SniffResult['source'] = magic
    ? 'magic'
    : answer === byExtension
      ? 'extension'
      : answer.startsWith('text/plain')
        ? 'text'
        : 'fallback';
  const normalisedDeclared = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return {
    mime: answer,
    source,
    overrode: normalisedDeclared !== '' && normalisedDeclared !== answer.split(';')[0],
  };
}

/** The contract's `Attachment.kind` — four values — from the stored media type. */
export function wireKindOf(mime: string): 'image' | 'audio' | 'video' | 'file' {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('audio/')) return 'audio';
  if (base.startsWith('video/')) return 'video';
  return 'file';
}

/** The stored `attachments.kind`, which has two more values than the wire. */
export function storedKindOf(mime: string, filename: string): AttachmentKind {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.diff' || extension === '.patch') return 'diff';
  if (extension === '.log') return 'log';
  return wireKindOf(mime);
}

/**
 * `Content-Disposition` for a download.
 *
 * Always `attachment`: the hub serves files people and agents produced, and an HTML or
 * SVG rendered inline would run in the hub's own origin. The name is sent twice — a
 * quoted ASCII fallback and RFC 5987 UTF-8 — so an Arabic filename survives.
 */
export function contentDispositionOf(filename: string): string {
  const ascii7 = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii7}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
