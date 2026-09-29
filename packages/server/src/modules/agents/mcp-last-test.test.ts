/**
 * The last test of each MCP server, kept by the hub (DECISIONS §134): the store, the stale
 * check, and the read-or-write reading of a tool that a "read-only" preset is built on.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpTestStore,
  accessByName,
  nameWords,
  readOnlyHints,
  viewOfTest,
} from './mcp-last-test.js';

const dirs: string[] = [];
const dir = () => {
  const made = mkdtempSync(path.join(tmpdir(), 'corehub-mcp-tests-'));
  dirs.push(made);
  return made;
};
afterEach(() => {
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
});

const OK = {
  ok: true,
  tools: [
    { name: 'get_issue', description: 'Read one issue.' },
    { name: 'create_issue', description: null },
  ],
  error: null,
  duration_ms: 812.4,
};

describe('keeping the last test', () => {
  it('keeps one answer per profile home and server, and forgets it with the server', () => {
    const store = new McpTestStore(dir());
    const at = new Date('2026-09-29T10:00:00Z');
    store.put('/h/default', 'github', OK, 'fp1', at);
    store.put('/h/work', 'github', { ...OK, ok: false, tools: [], error: 'down' }, 'fp1', at);
    expect(store.get('/h/default', 'github')).toEqual({
      ok: true,
      tools: OK.tools,
      error: null,
      tested_at: '2026-09-29T10:00:00.000Z',
      duration_ms: 812,
      fingerprint: 'fp1',
    });
    expect(store.get('/h/work', 'github')).toMatchObject({ ok: false, error: 'down' });
    expect(store.get('/h/default', 'other')).toBeNull();

    // A second store on the same folder reads what the first wrote: it survives a restart.
    const again = new McpTestStore(dirs[0]!);
    again.forget('/h/default', 'github');
    expect(again.get('/h/default', 'github')).toBeNull();
    expect(again.get('/h/work', 'github')).not.toBeNull();
  });

  it('treats a file it cannot read as no memory, and writes a good one on the next test', () => {
    const data = dir();
    writeFileSync(path.join(data, 'mcp-last-tests.json'), '{not json');
    const store = new McpTestStore(data);
    expect(store.get('/h', 'github')).toBeNull();
    store.put('/h', 'github', OK, 'fp');
    expect(store.get('/h', 'github')?.ok).toBe(true);
  });

  it('says stale when the connection settings changed since the test', () => {
    const stored = { ...OK, tested_at: '2026-09-29T10:00:00Z', duration_ms: 812, fingerprint: 'a' };
    expect(viewOfTest(stored, 'a', new Set()).stale).toBe(false);
    const view = viewOfTest(stored, 'b', new Set());
    expect(view).toMatchObject({ stale: true, tool_count: 2, ok: true });
    expect(view.tools).toEqual([
      { name: 'get_issue', description: 'Read one issue.', access: 'read', access_source: 'name' },
      { name: 'create_issue', description: null, access: 'write', access_source: 'name' },
    ]);
  });
});

describe('read or write', () => {
  it('splits a name into words however it is written', () => {
    expect(nameWords('getIssueComments')).toEqual(['get', 'issue', 'comments']);
    expect(nameWords('list-files')).toEqual(['list', 'files']);
    expect(nameWords('repo.search_code')).toEqual(['repo', 'search', 'code']);
    expect(nameWords('HTTPGetURL')).toEqual(['http', 'get', 'url']);
  });

  it('reads looking verbs as read, changing verbs as write (one is enough), others as unknown', () => {
    for (const name of ['get_issue', 'list_repos', 'searchCode', 'read_file', 'fetch', 'query_db'])
      expect(accessByName(name), name).toBe('read');
    for (const name of [
      'create_task',
      'update_task',
      'delete_file',
      'move_card',
      'merge_pull_request',
      'add_comment',
      'remove_label',
      'send_message',
      'upload_file',
      'start_workflow',
      'stop_container',
      'execute_sql',
      'get_or_create_user',
    ])
      expect(accessByName(name), name).toBe('write');
    for (const name of ['hierarchy', 'workspace_members', 'think']) {
      expect(accessByName(name), name).toBe('unknown');
    }
  });

  it("prefers the server's own readOnlyHint, as Hermes recorded it in the profile", () => {
    const home = dir();
    mkdirSync(path.join(home, 'cache'));
    writeFileSync(
      path.join(home, 'cache', 'mcp_schema_cache.json'),
      JSON.stringify({
        github: {
          fingerprint: 'x',
          tools: [
            { name: 'create_preview', annotations: { readOnlyHint: true } },
            { name: 'get_issue', annotations: { readOnlyHint: false } },
            { name: 'odd', annotations: 'no' },
          ],
        },
      }),
    );
    const hints = readOnlyHints(home, 'github');
    expect([...hints]).toEqual(['create_preview']);
    expect(readOnlyHints(home, 'other').size).toBe(0);
    expect(readOnlyHints(dir(), 'github').size).toBe(0);

    const view = viewOfTest(
      {
        ok: true,
        tools: [
          { name: 'create_preview', description: null },
          { name: 'get_issue', description: null },
        ],
        error: null,
        tested_at: '2026-09-29T10:00:00Z',
        duration_ms: 1,
        fingerprint: 'f',
      },
      'f',
      hints,
    );
    expect(view.tools.map((tool) => [tool.name, tool.access, tool.access_source])).toEqual([
      ['create_preview', 'read', 'annotation'],
      ['get_issue', 'read', 'name'],
    ]);
  });
});
