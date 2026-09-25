/**
 * A Hermes profile's `.env` — where Hermes keeps a profile's secrets and reads a channel's
 * credentials first — and the error the channel files raise. Shared by the channel listing,
 * the link flows and the settings engine, none of which may import the others in a circle.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class ChannelError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ChannelError';
  }
}

/**
 * The profile's `.env`, read the way python-dotenv reads it for the lines Hermes writes:
 * `KEY=value`, an optional `export `, quotes stripped. Comments and blank lines skipped.
 */
export function readEnv(home: string): Record<string, string> {
  const file = path.join(home, '.env');
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      // python-dotenv's double quotes: `\"` and `\\` are escapes (what `quoteEnv` writes).
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

/**
 * A value as Hermes writes it (`hermes_cli/config.py` §_quote_env_value): line breaks dropped, and
 * double-quoted with `\` and `"` escaped when it holds a `#`, a quote or white space — a password
 * with a space or a `#` would otherwise be cut short by python-dotenv.
 */
export function quoteEnv(raw: string): string {
  const value = raw.replace(/[\r\n]/g, '');
  if (value === '' || !/[#"'\s]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Sets one variable of the profile's `.env` (or removes it, for `null`), every other line
 * as it was. Written to a temporary file and renamed, mode 0600, the way Hermes writes it.
 */
export function writeEnvValue(home: string, key: string, value: string | null): void {
  const file = path.join(home, '.env');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n');
  let found = false;
  const next: string[] = [];
  for (const line of lines) {
    if (!pattern.test(line)) {
      next.push(line);
      continue;
    }
    if (found || value === null) continue;
    found = true;
    next.push(`${key}=${quoteEnv(value)}`);
  }
  if (!found && value !== null) next.push(`${key}=${quoteEnv(value)}`);
  const text = next.length > 0 ? `${next.join('\n')}\n` : '';
  if (text === existing) return;
  mkdirSync(home, { recursive: true });
  const temp = `${file}.corehub-${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
