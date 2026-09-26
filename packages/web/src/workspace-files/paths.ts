/**
 * Paths on the Files page: relative to the profile's working folder, `/`-separated, `''`
 * for the folder itself — the contract's form (`WorkspaceFilePath`). The hub decides what
 * is allowed; these only build and split the strings the page shows and sends.
 */
import { intlLocale } from '../i18n/index.js';

/** `a/b` + `c` = `a/b/c`; the root joins to the bare name. */
export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`;
}

/** The folder a path is in; `''` for anything at the top. */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** The last segment. */
export function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? path : path.slice(cut + 1);
}

/** The trail from the root to `path`: one crumb per folder, each with its own path. */
export function crumbsOf(path: string): Array<{ name: string; path: string }> {
  const segments = path.split('/').filter(Boolean);
  return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join('/') }));
}

/** What a person typed as a destination, in the contract's form: no leading `/` or `./`. */
export function normalisePath(typed: string): string {
  return typed
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

/** A size a person reads: bytes, KB, MB, GB, in their language's digits, bidi-isolated. */
export function formatBytes(bytes: number, language: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(intlLocale(language), {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  // Isolated left to right, so «40 B» never reads «B 40» inside an Arabic sentence.
  return `\u2066${number} ${units[unit] ?? 'B'}\u2069`;
}

/** How the page shows a file: a picture, a PDF, text, or nothing it can draw. */
export type PreviewKind = 'image' | 'pdf' | 'text' | 'none';

/**
 * Pictures (never SVG, which is a document that can carry script) and PDFs are drawn from
 * their bytes; text is read as text and never rendered as a page.
 */
export function previewKindOf(entry: { mime: string | null; editable: boolean }): PreviewKind {
  const mime = entry.mime ?? '';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (entry.editable || mime.startsWith('text/')) return 'text';
  return 'none';
}

/** The highlighter's language for a file name; null for plain text. */
export function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const byExtension: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonl: 'json',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    env: 'ini',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    css: 'css',
    scss: 'scss',
    less: 'less',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    c: 'c',
    h: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    pl: 'perl',
    lua: 'lua',
    r: 'r',
    sql: 'sql',
    diff: 'diff',
    patch: 'diff',
  };
  if (lower === 'makefile') return 'makefile';
  return byExtension[extension] ?? null;
}

/**
 * Code reads left to right in any interface language; prose (Markdown, plain text) follows
 * its own first strong letter, so an Arabic note is right to left.
 */
export function textDirectionOf(name: string): 'ltr' | 'auto' {
  const language = languageOf(name);
  return language === null || language === 'markdown' ? 'auto' : 'ltr';
}
