// Text and JSON output. Everything a script reads goes to stdout; prompts and notices go to
// stderr so `--json` output stays parseable.
import type { Writable } from 'node:stream';

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

const ESC = '\u001b[';
const wrap = (open: number, close: number) => (text: string) =>
  `${ESC}${open}m${text}${ESC}${close}m`;
export const ANSI: Style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};
const identity = (text: string) => text;
export const PLAIN: Style = {
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  cyan: identity,
};

export interface Column {
  key: string;
  label: string;
  align?: 'start' | 'end';
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

const isCombining = (code: number): boolean =>
  (code >= 0x0300 && code <= 0x036f) ||
  (code >= 0x064b && code <= 0x065f) ||
  code === 0x0670 ||
  (code >= 0x200b && code <= 0x200f) ||
  code === 0xfeff;

const isWide = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x20000 && code <= 0x3fffd);

/** Display width: combining marks (Arabic tashkeel and friends) take no cell; wide CJK takes two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (isCombining(code)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number, align: 'start' | 'end'): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return align === 'end' ? fill + text : text + fill;
}

export class Printer {
  readonly style: Style;

  constructor(
    private readonly stdout: Writable,
    private readonly stderr: Writable,
    options: { color: boolean },
  ) {
    this.style = options.color ? ANSI : PLAIN;
  }

  line(text = ''): void {
    this.stdout.write(`${text}\n`);
  }

  write(text: string): void {
    this.stdout.write(text);
  }

  /** Pretty JSON for one document. */
  json(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** One JSON document per line (streams). */
  jsonLine(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  notice(text: string): void {
    this.stderr.write(`${text}\n`);
  }

  error(text: string): void {
    this.stderr.write(`${this.style.red(text)}\n`);
  }

  kv(rows: ReadonlyArray<readonly [string, string]>): void {
    const width = Math.max(0, ...rows.map(([label]) => displayWidth(label)));
    for (const [label, value] of rows)
      this.line(`${this.style.dim(pad(label, width, 'start'))}  ${value}`);
  }

  table(columns: readonly Column[], rows: ReadonlyArray<Record<string, string>>): void {
    const widths = columns.map((column) =>
      Math.max(
        displayWidth(column.label),
        ...rows.map((row) => displayWidth(row[column.key] ?? '')),
      ),
    );
    const render = (cells: string[], style: (s: string) => string) =>
      cells
        .map((cell, i) => pad(cell, widths[i] ?? 0, columns[i]?.align ?? 'start'))
        .map(style)
        .join('  ')
        .trimEnd();
    this.line(
      render(
        columns.map((c) => c.label),
        this.style.dim,
      ),
    );
    for (const row of rows)
      this.line(
        render(
          columns.map((c) => row[c.key] ?? ''),
          identity,
        ),
      );
  }
}

export function detectColor(
  env: NodeJS.ProcessEnv,
  stream: { isTTY?: boolean },
  noColorFlag: boolean,
): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0')
    return true;
  return stream.isTTY === true;
}
