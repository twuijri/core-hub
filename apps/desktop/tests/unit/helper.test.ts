// The local helper: the folder rule (links included), the tools, and the MCP door.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultHelper,
  parseHelper,
  resolveInside,
  type HelperConfig,
} from '../../src/shared/helper.js';
import { callTool, startHelper, toolsFor, type HelperServer } from '../../src/main/helper.js';

let root: string;
let shared: string;
let readOnly: string;
let outside: string;
const opened: string[] = [];
const env = {
  openPath: async (file: string) => {
    opened.push(file);
    return '';
  },
  openUrl: async (url: string) => {
    opened.push(url);
  },
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'corehub-helper-')));
  shared = path.join(root, 'shared');
  readOnly = path.join(shared, 'archive');
  outside = path.join(root, 'private');
  mkdirSync(readOnly, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(shared, 'notes.txt'), 'hello');
  writeFileSync(path.join(outside, 'secret.txt'), 'do not read');
  writeFileSync(path.join(shared, 'image.bin'), Buffer.from([1, 0, 2]));
  // A link inside the shared folder that points outside it.
  symlinkSync(outside, path.join(shared, 'escape'));
  opened.length = 0;
});

const config = (over: Partial<HelperConfig> = {}): HelperConfig => ({
  ...defaultHelper(() => 'f'.repeat(64)),
  enabled: true,
  folders: [
    { path: shared, write: true },
    { path: readOnly, write: false },
  ],
  ...over,
});

const realpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

describe('the folder rule', () => {
  it('allows what is inside a shared folder, and nothing else', () => {
    const folders = config().folders;
    expect(resolveInside(folders, path.join(shared, 'notes.txt'), { realpath })).toMatchObject({
      ok: true,
    });
    expect(resolveInside(folders, path.join(outside, 'secret.txt'), { realpath })).toEqual({
      ok: false,
      reason: 'outside',
    });
    expect(
      resolveInside(folders, path.join(shared, '..', 'private', 'secret.txt'), { realpath }),
    ).toEqual({
      ok: false,
      reason: 'outside',
    });
  });

  it('follows links: a link out of a shared folder leads nowhere', () => {
    const folders = config().folders;
    expect(resolveInside(folders, path.join(shared, 'escape', 'secret.txt'), { realpath })).toEqual(
      {
        ok: false,
        reason: 'outside',
      },
    );
    expect(
      resolveInside(folders, path.join(shared, 'escape', 'new.txt'), { realpath, forWrite: true }),
    ).toEqual({ ok: false, reason: 'outside' });
  });

  it('the most specific folder decides whether writing is allowed', () => {
    const folders = config().folders;
    expect(
      resolveInside(folders, path.join(readOnly, 'x.txt'), { realpath, forWrite: true }),
    ).toEqual({ ok: false, reason: 'read_only' });
    expect(
      resolveInside(folders, path.join(shared, 'new.txt'), { realpath, forWrite: true }),
    ).toMatchObject({ ok: true, path: path.join(shared, 'new.txt') });
  });

  it('keeps only absolute, distinct folders from the settings file', () => {
    const parsed = parseHelper(
      {
        enabled: true,
        folders: [{ path: 'relative' }, { path: '/a', write: true }, { path: '/a' }],
        token: 'bad',
      },
      () => '0'.repeat(64),
    );
    expect(parsed.folders).toEqual([{ path: '/a', write: true }]);
    expect(parsed.token).toBe('0'.repeat(64));
    expect(parseHelper(null, () => '1'.repeat(64)).enabled).toBe(false);
  });
});

describe('tools', () => {
  it('offers writing and opening only when something allows them', () => {
    const names = (c: HelperConfig) => toolsFor(c).map((t) => t.name);
    expect(names(config({ folders: [{ path: shared, write: false }] }))).toEqual([
      'list_allowed_folders',
      'list_directory',
      'read_text_file',
    ]);
    expect(names(config({ allowOpen: true }))).toEqual([
      'list_allowed_folders',
      'list_directory',
      'read_text_file',
      'write_text_file',
      'open_path',
      'open_url',
    ]);
  });

  it('lists, reads, and refuses binary files and files outside', async () => {
    const list = await callTool(config(), env, 'list_directory', { path: shared });
    expect(
      JSON.parse(list.text)
        .map((e: { name: string }) => e.name)
        .sort(),
    ).toEqual(['archive', 'escape', 'image.bin', 'notes.txt']);
    expect(
      (await callTool(config(), env, 'read_text_file', { path: path.join(shared, 'notes.txt') }))
        .text,
    ).toBe('hello');
    await expect(
      callTool(config(), env, 'read_text_file', { path: path.join(shared, 'image.bin') }),
    ).rejects.toThrow('not text');
    await expect(
      callTool(config(), env, 'read_text_file', { path: path.join(outside, 'secret.txt') }),
    ).rejects.toThrow('not inside a folder shared');
  });

  it('writes a new file, and replaces one only when asked', async () => {
    const file = path.join(shared, 'out', 'plan.md');
    mkdirSync(path.dirname(file));
    await callTool(config(), env, 'write_text_file', { path: file, content: '# plan' });
    expect(readFileSync(file, 'utf8')).toBe('# plan');
    await expect(
      callTool(config(), env, 'write_text_file', { path: file, content: 'again' }),
    ).rejects.toThrow('exists');
    await callTool(config(), env, 'write_text_file', {
      path: file,
      content: 'again',
      overwrite: true,
    });
    expect(readFileSync(file, 'utf8')).toBe('again');
    await expect(
      callTool(config({ folders: [{ path: shared, write: false }] }), env, 'write_text_file', {
        path: path.join(shared, 'x.txt'),
        content: 'x',
      }),
    ).rejects.toThrow('does not offer');
  });

  it('opens files inside and http(s) links only, and only when allowed', async () => {
    await expect(
      callTool(config(), env, 'open_url', { url: 'https://example.com' }),
    ).rejects.toThrow('does not offer');
    const allowed = config({ allowOpen: true });
    await callTool(allowed, env, 'open_url', { url: 'https://example.com/a' });
    await callTool(allowed, env, 'open_path', { path: path.join(shared, 'notes.txt') });
    await expect(callTool(allowed, env, 'open_url', { url: 'file:///etc/passwd' })).rejects.toThrow(
      'Only http',
    );
    await expect(
      callTool(allowed, env, 'open_path', { path: path.join(outside, 'secret.txt') }),
    ).rejects.toThrow('not inside');
    expect(opened).toEqual(['https://example.com/a', path.join(shared, 'notes.txt')]);
  });
});

describe('the MCP door', () => {
  let server: HelperServer;
  let current: HelperConfig;
  const TOKEN = 'f'.repeat(64);
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    current = config();
    server = await startHelper({
      config: () => current,
      env,
      version: '1.0.0',
      preferredPort: null,
    });
  });
  afterEach(async () => {
    await server.close();
  });

  it('listens on the loopback address only', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('wants the key, and refuses anything a web page could send', async () => {
    expect(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer nope' }))
        .status,
    ).toBe(401);
    expect(
      (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    expect(
      (await fetch(server.url, { headers: { authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(405);
  });

  it('speaks MCP: initialize, tools/list, tools/call, notifications, batches', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    expect(init.headers.get('mcp-session-id')).toMatch(/^[0-9a-f]{32}$/);
    expect(await init.json()).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'corehub-desktop' },
      },
    });
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((t) => t.name)).toContain('read_text_file');
    const call = await (
      await rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_text_file', arguments: { path: path.join(shared, 'notes.txt') } },
      })
    ).json();
    expect(call).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: 'hello' }], isError: false },
    });
    const refused = (await (
      await rpc({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_text_file', arguments: { path: path.join(outside, 'secret.txt') } },
      })
    ).json()) as { result: { isError: boolean } };
    expect(refused.result.isError).toBe(true);
    expect(server.activity().map((a) => [a.tool, a.ok])).toEqual([
      ['read_text_file', false],
      ['read_text_file', true],
    ]);
    const batch = (await (
      await rpc([
        { jsonrpc: '2.0', id: 5, method: 'ping' },
        { jsonrpc: '2.0', id: 6, method: 'nope' },
      ])
    ).json()) as Array<{ id: number; error?: { code: number } }>;
    expect(batch.map((b) => b.id)).toEqual([5, 6]);
    expect(batch[1]?.error?.code).toBe(-32601);
  });

  it('follows the settings live: turning writing off removes the tool at once', async () => {
    const before = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(before.result.tools.map((t) => t.name)).toContain('write_text_file');
    current = config({ folders: [{ path: shared, write: false }] });
    const after = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(after.result.tools.map((t) => t.name)).not.toContain('write_text_file');
  });
});
