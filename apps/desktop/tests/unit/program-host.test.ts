// A program on this computer, started and asked (ADR 0025): once per session, only for the
// profiles it is on for, a long call answered "running" and followed, every call listed — and
// the hub on this computer reaching it through the helper, as a profile's own tools.
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsentGate, type ConsentAnswer } from '../../src/main/consent.js';
import { PROFILE_HEADER, startHelper, type HelperServer } from '../../src/main/helper.js';
import { ProgramHost, ProgramRefusal, type ProgramActivity } from '../../src/main/programs.js';
import { defaultHelper, type HelperConfig, type ProgramSettings } from '../../src/shared/helper.js';
import type { DiscoveredProgram } from '../../src/shared/programs.js';

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/fake-resolve-mcp.mjs',
);

const program: DiscoveredProgram = {
  id: 'davinci-resolve',
  name: 'DaVinci Resolve',
  source: 'claude_desktop_extension',
  origin: '/ext/manifest.json',
  kind: 'stdio',
  command: process.execPath,
  args: [FAKE],
  env: { RESOLVE_MCP_KEY: '{{field:api_key}}', FAKE_RENDER_MS: '600' },
  cwd: null,
  fields: [
    { key: 'api_key', title: 'API key', description: null, sensitive: true, required: true },
  ],
  description: null,
};

let host: ProgramHost | null = null;
let helper: HelperServer | null = null;
afterEach(async () => {
  await helper?.close();
  helper = null;
  await host?.stopAll();
  host = null;
});

function make(answers: ConsentAnswer[], settings: Record<string, ProgramSettings>) {
  const asked: string[] = [];
  const activity: ProgramActivity[] = [];
  const consent = new ConsentGate(async (question) => {
    asked.push(`${question.programName}:${question.tool}:${question.via}`);
    return answers.shift() ?? 'deny';
  });
  host = new ProgramHost({
    catalogue: () => [program],
    settings: () => settings,
    unseal: (v) => v,
    clientVersion: 'test',
    consent,
    record: (entry) => activity.push(entry),
    onTools: (id, tools) => {
      settings[id] = { ...settings[id]!, tools };
    },
    softDeadlineMs: 200,
  });
  return { host, asked, activity, settings };
}

const shared = (): Record<string, ProgramSettings> => ({
  'davinci-resolve': { profiles: ['default'], values: { api_key: 'k' }, tools: null },
});

describe('a program on this computer', () => {
  it('asks once for the session, keeps the program running, follows a long call to its end', async () => {
    const out = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'corehub-render-')));
    const { host: h, asked, activity, settings } = make(['session'], shared());
    const tools = await h.listTools('davinci-resolve');
    expect(tools.map((t) => t.name)).toEqual([
      'create_project',
      'import_media',
      'create_timeline',
      'render',
      'get_render_status',
    ]);
    expect(settings['davinci-resolve']!.tools?.map((t) => t.name)).toContain('render');
    const call = (tool: string, args: Record<string, unknown> = {}) =>
      h.call({
        programId: 'davinci-resolve',
        tool,
        args,
        profile: 'default',
        via: 'local',
        hub: null,
      });

    expect(await call('create_project', { name: 'A' })).toEqual({
      state: 'done',
      content: [{ type: 'text', text: 'Created project "A".' }],
      isError: false,
    });
    // The program is the same one between calls: its project is still open.
    const imported = await call('import_media', { paths: [FAKE] });
    expect(imported).toMatchObject({ state: 'done', isError: false });
    await call('create_timeline', { name: 'T' });
    const render = await call('render', { output_dir: out, file_name: 'cut.mp4' });
    expect(render.state).toBe('running');
    if (render.state !== 'running') throw new Error('expected running');
    let status = h.status(render.callId);
    for (let i = 0; i < 40 && status.state === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      status = h.status(render.callId);
    }
    expect(status).toMatchObject({ state: 'done', isError: false });
    expect(readFileSync(path.join(out, 'cut.mp4')).subarray(4, 12).toString()).toBe('ftypisom');
    // One question for all of it; every call listed.
    expect(asked).toEqual(['DaVinci Resolve:create_project:local']);
    expect(activity.map((a) => [a.tool, a.ok, a.via])).toEqual([
      ['create_project', true, 'local'],
      ['import_media', true, 'local'],
      ['create_timeline', true, 'local'],
      ['render', true, 'local'],
    ]);
    expect(() => h.status('nope')).toThrow(ProgramRefusal);
  });

  it('asks again after "allow once", refuses on "deny", and serves only its profiles', async () => {
    const { host: h, asked, activity } = make(['once', 'deny'], shared());
    const call = (profile: string | null) =>
      h.call({
        programId: 'davinci-resolve',
        tool: 'get_render_status',
        args: {},
        profile,
        via: 'hub',
        hub: 'https://hub.example',
      });
    await expect(call('default')).resolves.toMatchObject({ state: 'done' });
    await expect(call('default')).rejects.toMatchObject({ code: 'permission_denied' });
    expect(asked).toHaveLength(2);
    await expect(call('work')).rejects.toMatchObject({ code: 'unavailable' });
    expect(asked).toHaveLength(2);
    expect(activity.map((a) => a.ok)).toEqual([true, false, false]);
  });

  it('does not start without its setting', async () => {
    const { host: h } = make(['session'], {
      'davinci-resolve': { profiles: ['default'], values: {}, tools: null },
    });
    await expect(
      h.call({
        programId: 'davinci-resolve',
        tool: 'create_project',
        args: {},
        profile: 'default',
        via: 'local',
        hub: null,
      }),
    ).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('settings') });
  });

  it('reaches the hub on this computer through the helper, as the profile the request names', async () => {
    const settings = shared();
    const { host: h, asked } = make(['session'], settings);
    await h.listTools('davinci-resolve');
    const config: HelperConfig = { ...defaultHelper(() => 'a'.repeat(64)), enabled: true };
    helper = await startHelper({
      config: () => config,
      env: { openPath: async () => '', openUrl: async () => undefined },
      version: 'test',
      preferredPort: null,
      programs: h,
    });
    const rpc = async (body: unknown, profile?: string) => {
      const res = await fetch(helper!.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'a'.repeat(64)}`,
          'content-type': 'application/json',
          ...(profile ? { [PROFILE_HEADER]: profile } : {}),
        },
        body: JSON.stringify(body),
      });
      return (await res.json()) as {
        result: {
          tools?: Array<{ name: string }>;
          content?: Array<{ text: string }>;
          isError?: boolean;
        };
      };
    };
    const noProfile = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(noProfile.result.tools!.map((t) => t.name)).not.toContain('davinci-resolve__render');
    const other = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'work');
    expect(other.result.tools!.map((t) => t.name)).not.toContain('davinci-resolve__render');
    const mine = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'default');
    expect(mine.result.tools!.map((t) => t.name)).toEqual(
      expect.arrayContaining(['davinci-resolve__create_project', 'program_call_status']),
    );
    const called = await rpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'davinci-resolve__create_project', arguments: { name: 'Local' } },
      },
      'default',
    );
    expect(called.result).toMatchObject({
      isError: false,
      content: [{ text: 'Created project "Local".' }],
    });
    // Local mode asks too (unlike the old app).
    expect(asked).toEqual(['DaVinci Resolve:create_project:local']);
  });
});
