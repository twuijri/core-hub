/**
 * Which of a server's tools the agent gets, worked out without React (DECISIONS §134).
 *
 * The filter is Hermes's own: `tools.include` (an allow-list, which wins) or `tools.exclude` (a
 * block-list), entries exact names or globs (`*`, `?`, `[…]`) matched case-sensitively, as
 * Hermes matches them. The picker is a set of allowed names; saving turns it back into a filter:
 *
 * - every tool allowed and no pattern to keep → no filter at all (a tool the server adds later
 *   is allowed, as it is today);
 * - a filter that was a block-list stays one (the unticked tools), so it keeps letting new
 *   tools in;
 * - otherwise an allow-list of the ticked tools — a tool the server adds later stays off until
 *   it is ticked, and `[]` allows none.
 *
 * A pattern someone wrote by hand is kept, and a tool it decides is shown as decided by it
 * (`lockedBy`): unticking one that `read_*` allows would mean dropping the pattern, which is the
 * config file's business, not a checkbox's. An entry for a tool the server no longer lists stays
 * in the list, harmless.
 */
import type { McpTestedTool, McpToolFilter } from './skills.js';

export const NO_FILTER: McpToolFilter = { include: null, exclude: null };

export function isPattern(entry: string): boolean {
  return /[*?[]/.test(entry);
}

/** Python's `fnmatch.fnmatchcase`: `*`, `?`, `[seq]`, `[!seq]`; everything else literal. */
export function globMatch(name: string, pattern: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, end);
      const negate = body.startsWith('!');
      if (negate) body = body.slice(1);
      source += `[${negate ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\^/g, '\\^')}]`;
      i = end;
    } else source += char.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try {
    return new RegExp(`^${source}$`, 's').test(name);
  } catch {
    return false;
  }
}

export function matches(name: string, entries: readonly string[]): boolean {
  return entries.some((entry) => entry === name || (isPattern(entry) && globMatch(name, entry)));
}

export function hasFilter(filter: McpToolFilter | undefined): boolean {
  return !!filter && (filter.include !== null || filter.exclude !== null);
}

/** Whether Hermes gives the agent `name` under `filter` (include wins over exclude). */
export function allowedBy(filter: McpToolFilter | undefined, name: string): boolean {
  if (filter?.include) return matches(name, filter.include);
  if (filter?.exclude) return !matches(name, filter.exclude);
  return true;
}

/** The list the filter works by, and its hand-written patterns. */
function patternsOf(filter: McpToolFilter | undefined): string[] {
  const list = filter?.include ?? filter?.exclude ?? [];
  return list.filter(isPattern);
}

/** The pattern that decides `name` (and so its box cannot change it), or null. */
export function lockedBy(filter: McpToolFilter | undefined, name: string): string | null {
  const list = filter?.include ?? filter?.exclude ?? [];
  if (list.includes(name)) return null;
  return patternsOf(filter).find((pattern) => globMatch(name, pattern)) ?? null;
}

/** What the picker starts from: the tools the filter allows now. */
export function initialAllowed(
  filter: McpToolFilter | undefined,
  tools: readonly Pick<McpTestedTool, 'name'>[],
): Set<string> {
  return new Set(tools.filter((tool) => allowedBy(filter, tool.name)).map((tool) => tool.name));
}

/** The picker's choice as the filter to write. */
export function filterToSave(
  current: McpToolFilter | undefined,
  tools: readonly Pick<McpTestedTool, 'name'>[],
  allowed: ReadonlySet<string>,
): McpToolFilter {
  const names = tools.map((tool) => tool.name);
  const patterns = patternsOf(current);
  const byPattern = (name: string) => patterns.some((pattern) => globMatch(name, pattern));
  // Literal entries for tools this server no longer lists: kept, harmless.
  const vanished = (list: string[] | null) =>
    (list ?? []).filter((entry) => !isPattern(entry) && !names.includes(entry));

  if (current && current.include === null && current.exclude !== null) {
    const exclude = [
      ...patterns,
      ...vanished(current.exclude),
      ...names.filter((name) => !allowed.has(name) && !byPattern(name)),
    ];
    return exclude.length > 0 ? { include: null, exclude } : NO_FILTER;
  }
  if (patterns.length === 0 && names.every((name) => allowed.has(name))) return NO_FILTER;
  return {
    include: [
      ...patterns,
      ...vanished(current?.include ?? null),
      ...names.filter((name) => allowed.has(name) && !byPattern(name)),
    ],
    exclude: null,
  };
}

export function sameFilter(a: McpToolFilter | undefined, b: McpToolFilter | undefined): boolean {
  const same = (x: string[] | null | undefined, y: string[] | null | undefined) =>
    (x ?? null) === null
      ? (y ?? null) === null
      : !!y && x!.length === y.length && x!.every((entry, i) => entry === y[i]);
  return same(a?.include, b?.include) && same(a?.exclude, b?.exclude);
}

/** The three bulk choices: every tool, none, or the ones read as read-only. */
export function preset(
  kind: 'all' | 'none' | 'read',
  tools: readonly Pick<McpTestedTool, 'name' | 'access'>[],
): Set<string> {
  if (kind === 'all') return new Set(tools.map((tool) => tool.name));
  if (kind === 'none') return new Set();
  return new Set(tools.filter((tool) => tool.access === 'read').map((tool) => tool.name));
}

/** A locked tool keeps what its pattern says, whatever a bulk choice or a click wants. */
export function withLocks(
  filter: McpToolFilter | undefined,
  tools: readonly Pick<McpTestedTool, 'name'>[],
  allowed: ReadonlySet<string>,
): Set<string> {
  const out = new Set(allowed);
  for (const tool of tools) {
    if (!lockedBy(filter, tool.name)) continue;
    if (allowedBy(filter, tool.name)) out.add(tool.name);
    else out.delete(tool.name);
  }
  return out;
}
