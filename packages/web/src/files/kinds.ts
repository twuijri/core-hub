/**
 * The small rules the file preview shares: which highlighter language a name is, how a size
 * reads, and which of a conversation's files a tool call or a word in a reply points at.
 * Pure — the panel and the links draw from these.
 */
import type { SessionFile } from '../types.js';

/** Extension → the highlighter's language (rehype-highlight's common set). */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  rb: 'ruby',
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
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  graphql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  md: 'markdown',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

export function extensionOf(name: string): string {
  const base = name.split('/').at(-1)?.toLowerCase() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : base;
}

export function languageOf(name: string): string {
  return LANGUAGES[extensionOf(name)] ?? '';
}

/** 1536 → "1.5 KB". Units stay Latin in both languages, as the rest of the client does. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The file can be shown here rather than only downloaded. */
export function previewable(file: SessionFile): boolean {
  return file.preview !== 'none' && file.size_bytes <= file.preview_max_bytes;
}

/** The files a tool call named (`SessionFile.tool_call_ids`). */
export function filesOfToolCall(files: readonly SessionFile[], toolCallId: string): SessionFile[] {
  return files.filter((file) => file.tool_call_ids.includes(toolCallId));
}

/**
 * The file a word in a reply names — `report.html`, `./out/report.html`, or the whole
 * path the agent printed — or `null`. Only a word that ends in a listed file's own path (or
 * is its bare name, when one file has that name) counts: prose is never guessed at.
 */
export function fileForMention(files: readonly SessionFile[], mention: string): SessionFile | null {
  const word = mention.trim().replace(/^\.\//, '');
  if (word === '' || word.length > 4096 || /\s/.test(word)) return null;
  const onDisk = files.filter((file) => file.path !== null);
  const exact = onDisk.find((file) => file.path === word || word.endsWith(`/${file.path}`));
  if (exact) return exact;
  const named = files.filter((file) => file.name === word);
  return named.length === 1 ? (named[0] ?? null) : null;
}

/**
 * What the Files list is read again on: a message joining (it may carry attachments), a
 * tool call ending (it may have written a file), a run changing state. Cheap to compute from
 * the transcript the chat already holds; it never changes while a reply only streams text.
 */
export function filesRevisionOf(
  messages: ReadonlyArray<{ id: string; tool_calls?: ReadonlyArray<{ status: string }> | null }>,
  runs: Readonly<Record<string, { status: string }>>,
): string {
  let ended = 0;
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.status !== 'running' && call.status !== 'awaiting_approval') ended += 1;
    }
  }
  const states = Object.entries(runs)
    .map(([id, run]) => `${id}:${run.status}`)
    .sort()
    .join(',');
  return `${messages.length}|${ended}|${states}`;
}
