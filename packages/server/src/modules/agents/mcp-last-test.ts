/**
 * What Hermes found the last time each MCP server was tested, kept by the hub (DECISIONS §134).
 *
 * Before this, a test's answer lived only in the browser that asked, so the MCP page showed no
 * tools until someone pressed Test again. The hub now keeps the last answer per profile — the
 * profile's Hermes home is the key, the server's name the entry — in one small JSON file of its
 * own state (`<data>/mcp-last-tests.json`), never in Hermes's home: it is the hub's memory of a
 * measurement, not Hermes's configuration. Losing the file costs a test, nothing else.
 *
 * With each answer the hub keeps the hash of the server's connection settings at the time
 * (`mcp.ts` `connectionFingerprint`), so a server edited since reads as `stale` instead of
 * showing tools that may no longer be there.
 *
 * **Read-only or not.** Every tool is read as `read`, `write` or `unknown`: a server's own MCP
 * annotation when Hermes recorded one — Hermes keeps `readOnlyHint: true` in the profile's
 * `cache/mcp_schema_cache.json` for the tools it registered (read from Hermes's MIT source,
 * `tools/mcp_schema_cache.py` and `tools/mcp_tool_registration.py`, v2026.9.14 and v2026.9.24);
 * Hermes's test answer carries no annotations, and Hermes keeps no `destructiveHint` — and
 * otherwise the verbs in the tool's name. It is a suggestion for a "read-only" preset; the
 * person decides.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpTestResult } from './hermes-tools.js';

export interface StoredMcpTest {
  ok: boolean;
  tools: Array<{ name: string; description: string | null }>;
  error: string | null;
  tested_at: string;
  duration_ms: number;
  fingerprint: string;
}

interface StoreFile {
  version: 1;
  homes: Record<string, Record<string, StoredMcpTest>>;
}

export type ToolAccess = 'read' | 'write' | 'unknown';

export interface McpLastTestView {
  ok: boolean;
  tools: Array<{
    name: string;
    description: string | null;
    access: ToolAccess;
    access_source: 'annotation' | 'name';
  }>;
  tool_count: number;
  error: string | null;
  tested_at: string;
  duration_ms: number;
  stale: boolean;
}

const FILE = 'mcp-last-tests.json';

/** One file, read and written whole: a profile has a handful of servers, not thousands. */
export class McpTestStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, FILE);
  }

  private read(): StoreFile {
    try {
      if (!existsSync(this.file)) return { version: 1, homes: {} };
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoreFile>;
      const homes = parsed && typeof parsed.homes === 'object' && parsed.homes ? parsed.homes : {};
      return { version: 1, homes };
    } catch {
      // A file we cannot read is a memory we do not have: the next test writes a new one.
      return { version: 1, homes: {} };
    }
  }

  private write(data: StoreFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.file);
  }

  get(home: string, name: string): StoredMcpTest | null {
    return this.read().homes[home]?.[name] ?? null;
  }

  put(
    home: string,
    name: string,
    result: McpTestResult,
    fingerprint: string,
    now: Date = new Date(),
  ): void {
    const data = this.read();
    const entries = (data.homes[home] ??= {});
    entries[name] = {
      ok: result.ok,
      tools: result.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      error: result.error,
      tested_at: now.toISOString(),
      duration_ms: Math.max(0, Math.round(result.duration_ms)),
      fingerprint,
    };
    this.write(data);
  }

  /** A server deleted from the profile takes its test with it; a new one of that name starts clean. */
  forget(home: string, name: string): void {
    const data = this.read();
    if (!data.homes[home]?.[name]) return;
    delete data.homes[home][name];
    if (Object.keys(data.homes[home]).length === 0) delete data.homes[home];
    this.write(data);
  }
}

// ------------------------------------------------------------------ read or write

/** Verbs whose tool only looks. Matched as whole words of the name (`get_issue`, `listFiles`). */
const READ_VERBS = new Set([
  'get',
  'list',
  'search',
  'find',
  'read',
  'fetch',
  'query',
  'describe',
  'show',
  'view',
  'lookup',
  'count',
  'check',
  'inspect',
  'browse',
  'download',
  'export',
  'retrieve',
  'status',
  'info',
  'stat',
  'stats',
  'head',
  'preview',
  'summarize',
  'summarise',
  'explain',
  'validate',
  'diff',
  'compare',
  'grep',
  'tree',
  'whoami',
  'ping',
  'echo',
  'analyze',
  'analyse',
  'scan',
  'poll',
  'history',
  'log',
  'logs',
]);

/**
 * Verbs whose tool changes something, anywhere in the name: one is enough to say `write`. Nouns
 * that often follow `get_` (message, comment, link…) are left out; a word read as `write` by
 * mistake only keeps a harmless tool out of the read-only preset, the safe side to err on.
 */
const WRITE_VERBS = new Set([
  'create',
  'update',
  'delete',
  'remove',
  'move',
  'merge',
  'add',
  'send',
  'upload',
  'start',
  'stop',
  'execute',
  'exec',
  'run',
  'write',
  'edit',
  'set',
  'put',
  'patch',
  'insert',
  'upsert',
  'replace',
  'rename',
  'copy',
  'clone',
  'fork',
  'push',
  'publish',
  'deploy',
  'install',
  'uninstall',
  'enable',
  'disable',
  'archive',
  'unarchive',
  'close',
  'reopen',
  'approve',
  'reject',
  'assign',
  'unassign',
  'invite',
  'kick',
  'ban',
  'block',
  'unblock',
  'lock',
  'unlock',
  'cancel',
  'restart',
  'kill',
  'terminate',
  'reset',
  'clear',
  'purge',
  'drop',
  'truncate',
  'destroy',
  'revoke',
  'grant',
  'share',
  'unshare',
  'transfer',
  'pay',
  'charge',
  'refund',
  'reply',
  'react',
  'tweet',
  'notify',
  'trigger',
  'invoke',
  'call',
  'submit',
  'commit',
  'mark',
  'save',
  'import',
  'sync',
  'apply',
  'generate',
  'make',
  'new',
  'modify',
  'change',
  'toggle',
  'attach',
  'detach',
  'unlink',
  'subscribe',
  'unsubscribe',
  'follow',
  'unfollow',
  'like',
  'star',
  'pin',
  'unpin',
  'mute',
  'unmute',
  'complete',
  'finish',
  'fill',
  'click',
  'press',
  'navigate',
  'drag',
  'hover',
  'evaluate',
  'eval',
]);

/** `getIssue`, `list-files`, `repo.search` → `get issue`, `list files`, `repo search`. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * What a tool's name says it does. Any changing verb makes it `write` (`get_or_create_x` is not
 * harmless); otherwise a looking verb makes it `read`; otherwise `unknown`.
 */
export function accessByName(name: string): ToolAccess {
  const words = nameWords(name);
  if (words.some((word) => WRITE_VERBS.has(word))) return 'write';
  if (words.some((word) => READ_VERBS.has(word))) return 'read';
  return 'unknown';
}

/**
 * The tools of `server` Hermes recorded as `readOnlyHint: true`, from the profile's own schema
 * cache. Anything missing, unreadable or shaped otherwise is simply no hint.
 */
export function readOnlyHints(home: string, server: string): Set<string> {
  const out = new Set<string>();
  try {
    const file = path.join(home, 'cache', 'mcp_schema_cache.json');
    if (!existsSync(file)) return out;
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const entry = data?.[server] as { tools?: unknown } | undefined;
    if (!entry || !Array.isArray(entry.tools)) return out;
    for (const tool of entry.tools as Array<Record<string, unknown>>) {
      const annotations = tool?.annotations as Record<string, unknown> | undefined;
      if (typeof tool?.name === 'string' && annotations?.readOnlyHint === true) out.add(tool.name);
    }
  } catch {
    // Hermes's cache is a courtesy here, never a reason to fail the page.
  }
  return out;
}

/** The contract's `McpLastTest` for one kept test, classified and checked against `fingerprint`. */
export function viewOfTest(
  stored: StoredMcpTest,
  fingerprint: string,
  hints: ReadonlySet<string>,
): McpLastTestView {
  return {
    ok: stored.ok,
    tools: stored.tools.map((tool) => {
      const hinted = hints.has(tool.name);
      return {
        name: tool.name,
        description: tool.description,
        access: hinted ? 'read' : accessByName(tool.name),
        access_source: hinted ? 'annotation' : 'name',
      };
    }),
    tool_count: stored.tools.length,
    error: stored.error,
    tested_at: stored.tested_at,
    duration_ms: stored.duration_ms,
    stale: stored.fingerprint !== fingerprint,
  };
}
