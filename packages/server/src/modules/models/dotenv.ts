/**
 * A `.env` file the hub shares with another program.
 *
 * Hermes keeps its provider keys in `HERMES_HOME/.env` (docs/inspirations/hermes-agent.md).
 * The hub writes the keys it owns into that file and **must not** disturb anything else:
 * a comment the owner left, a variable Hermes uses that we know nothing about, an entry
 * `hermes config set` wrote last week. So this is a merge, not a render:
 *
 * - a key the hub owns and has a value for is replaced **in place**, keeping its line
 *   position, so a diff of the file is one line per change;
 * - a key the hub owns and no longer has is removed, with its immediately preceding
 *   comment line if that comment is the hub's own marker;
 * - a key the hub has never heard of is copied through byte for byte;
 * - new keys are appended under one clearly marked section.
 *
 * Quoting: values are written inside double quotes with `\`, `"`, newlines and `$`
 * escaped, because a provider key can legally contain characters a bare value cannot.
 * Reading accepts bare, single-quoted and double-quoted values, `export ` prefixes and
 * blank lines, which is the subset every `.env` reader agrees on.
 */

import { LEGACY, derived } from '@corehub/contracts';

export const MANAGED_MARKER: string = derived.managedMarker;
/**
 * The marker a hub wrote before the rename (Majlis). It is still the hub's own line: a merge
 * rewrites it to `MANAGED_MARKER` in place, so the file does not keep two markers.
 */
export const LEGACY_MANAGED_MARKER: string = LEGACY.managedMarker;

export interface EnvEntry {
  key: string;
  value: string;
}

/** Parses a `.env` body. Later definitions win, as every dotenv reader does. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry) out.set(entry.key, entry.value);
  }
  return out;
}

function parseLine(line: string): EnvEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
  const eq = withoutExport.indexOf('=');
  if (eq <= 0) return null;
  const key = withoutExport.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return { key, value: unquote(withoutExport.slice(eq + 1).trim()) };
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\(["\\$])/g, '$1');
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  // A bare value ends at an unquoted `#` comment, as dotenv readers agree.
  const hash = raw.indexOf(' #');
  return (hash >= 0 ? raw.slice(0, hash) : raw).trim();
}

/**
 * Quotes only when the value needs it — empty, or containing whitespace, `#` or a quote
 * character. This is Hermes's own rule (`_quote_env_value`), and matching it means the
 * hub's line for `ANTHROPIC_API_KEY` looks exactly like the line `hermes config set`
 * would have written, so a diff of the file shows a changed key and nothing else.
 */
export function quoteValue(value: string): string {
  if (value !== '' && !/[\s#"']/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

export interface MergeResult {
  /** The whole file to write. */
  text: string;
  /** Keys whose value changed (never their values — this is what may be logged). */
  changed: string[];
  /** Keys the hub removed because the provider no longer has a key. */
  removed: string[];
}

/**
 * Merges the hub's variables into an existing `.env` body.
 *
 * `owned` is the complete set of keys the hub manages; a key in `owned` but absent from
 * `values` is removed. Anything outside `owned` is never touched, which is the rule that
 * keeps `hermes config set` and a hand-edited file working next to the hub.
 */
export function mergeEnv(
  existing: string,
  values: Readonly<Record<string, string>>,
  owned: readonly string[],
): MergeResult {
  const ownedSet = new Set(owned);
  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  const written = new Set<string>();
  const changed: string[] = [];
  const removed: string[] = [];
  const out: string[] = [];

  for (const line of lines) {
    if (line === LEGACY_MANAGED_MARKER) {
      out.push(MANAGED_MARKER);
      continue;
    }
    const entry = parseLine(line);
    if (!entry || !ownedSet.has(entry.key)) {
      // Drop a stale marker whose variable is about to disappear; keep every other comment.
      out.push(line);
      continue;
    }
    const next = values[entry.key];
    if (next === undefined) {
      removed.push(entry.key);
      // Also drop the marker line we wrote above it, if it is the one directly above.
      if (out.at(-1) === MANAGED_MARKER) out.pop();
      continue;
    }
    written.add(entry.key);
    const rendered = `${entry.key}=${quoteValue(next)}`;
    if (entry.value !== next) changed.push(entry.key);
    out.push(rendered);
  }

  const additions = Object.keys(values)
    .filter((key) => ownedSet.has(key) && !written.has(key))
    .sort();
  if (additions.length > 0) {
    while (out.length > 0 && out.at(-1)?.trim() === '') out.pop();
    if (out.length > 0) out.push('');
    out.push(MANAGED_MARKER);
    for (const key of additions) {
      out.push(`${key}=${quoteValue(values[key]!)}`);
      changed.push(key);
    }
  }

  while (out.length > 0 && out.at(-1)?.trim() === '') out.pop();
  return { text: out.length > 0 ? `${out.join('\n')}\n` : '', changed, removed };
}
