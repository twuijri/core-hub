/**
 * The agent tools against **the real Hermes** from the image (ADR 0015): Hermes connects to
 * a tiny stdio MCP server (`tests/fixtures/mcp-stdio-server.mjs`) and lists its two tools — in
 * the default profile and in a named one — and says why when it cannot; a pack the hub
 * installs into a profile's `skills/` is one Hermes itself then lists, front matter intact.
 * Name the image to run it; without one it is skipped:
 *
 *   docker build -f packages/server/Dockerfile -t core-hub:local .
 *   COREHUB_HERMES_IMAGE=corehub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/agent-tools.real.test.ts
 *
 * `COREHUB_REAL_WHATSAPP=1` also starts a real WhatsApp pairing and waits for Hermes's first QR
 * code (it needs the network: Hermes installs its bridge and asks WhatsApp for a code), then
 * cancels it. Nothing is linked.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import type { JobHandle } from '../audit/index.js';
import { HermesDashboard, type DashboardSpawner } from './hermes-dashboard.js';
import type { SpawnedProcess } from './hermes-runtime.js';
import { pairWhatsApp, testMcpServer, type HermesApiCall } from './hermes-tools.js';
import { installPack, planImport } from './skill-import.js';
import { makeZip } from './testing/make-zip.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/mcp-stdio-server.mjs',
);

describe.skipIf(!image)('agent tools (real Hermes; set COREHUB_HERMES_IMAGE to run)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-tools-home-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-tools-data-'));
  chmodSync(home, 0o777);
  const work = path.join(home, 'profiles', 'work');
  mkdirSync(work, { recursive: true });
  copyFileSync(fixture, path.join(home, 'mcp-fixture.mjs'));
  writeFileSync(
    path.join(home, 'config.yaml'),
    [
      '# written by the real-Hermes test',
      'mcp_servers:',
      '  fixture:',
      '    command: node',
      '    args: [/hh/mcp-fixture.mjs]',
      '  broken:',
      '    command: node',
      '    args: [/hh/mcp-fixture.mjs]',
      '    env:',
      '      MCP_FIXTURE_FAIL: "1"',
      '    connect_timeout: 5',
      '  missing:',
      '    command: definitely-not-a-command',
      '    connect_timeout: 5',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(work, 'config.yaml'),
    'mcp_servers:\n  workonly:\n    command: node\n    args: [/hh/mcp-fixture.mjs]\n',
  );
  const containers: string[] = [];
  const { uid, gid } = userInfo();

  /** `hermes serve` in the image, as this user so the files the hub writes are Hermes's too. */
  const spawnImpl: DashboardSpawner = (_command, args, options) => {
    const name = `corehub-tools-real-${process.pid}-${containers.length}`;
    containers.push(name);
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '--network',
        'host',
        '--user',
        `${uid}:${gid}`,
        '-v',
        `${home}:/hh`,
        '-e',
        'HERMES_HOME=/hh',
        '-e',
        'HOME=/tmp',
        '-e',
        'HERMES_DASHBOARD_SESSION_TOKEN',
        '--entrypoint',
        '/opt/hermes/.venv/bin/hermes',
        image!,
        ...args,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HERMES_DASHBOARD_SESSION_TOKEN: options.env.HERMES_DASHBOARD_SESSION_TOKEN,
        },
      },
    );
    return child as unknown as SpawnedProcess;
  };

  const { logger } = capturingLogger();
  const dashboard = new HermesDashboard({
    host: {
      status: () => ({ mode: 'managed', home }),
      executable: () => '/opt/hermes/.venv/bin/hermes',
      cliEnv: () => ({}),
    },
    dataDir,
    log: logger,
    spawnImpl,
    startTimeoutMs: 120_000,
  });
  const api: HermesApiCall = (method, route, body, options) =>
    dashboard.request(method, route, body, options);

  afterAll(async () => {
    await dashboard.close();
    for (const name of containers) {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // already gone with --rm
      }
    }
    for (const dir of [home, dataDir]) rmSync(dir, { recursive: true, force: true });
  });

  it('Hermes connects to a stdio MCP server and lists its tools, per profile', async () => {
    const root = await testMcpServer(api, {
      profile: 'default',
      name: 'fixture',
      config: {},
      language: 'en',
    });
    console.log(
      `MCP test (default profile, first call includes the start): ${root.duration_ms} ms`,
    );
    expect(root).toMatchObject({
      ok: true,
      error: null,
      tools: [
        { name: 'echo', description: 'Repeat the text it is given.' },
        { name: 'add', description: 'Add two numbers.' },
      ],
    });

    const named = await testMcpServer(api, {
      profile: 'work',
      name: 'workonly',
      config: {},
      language: 'en',
    });
    expect(named.ok).toBe(true);
    expect(named.tools.map((tool) => tool.name)).toEqual(['echo', 'add']);

    // The same name in the other profile is not there: Hermes's own sentence.
    await expect(
      testMcpServer(api, { profile: 'default', name: 'workonly', config: {}, language: 'en' }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'hermes_refused', message: "Server 'workonly' not found" },
    });
  }, 300_000);

  it("says why a server fails: Hermes's words, or the hub's when Hermes has none", async () => {
    const missing = await testMcpServer(api, {
      profile: 'default',
      name: 'missing',
      config: { connect_timeout: 5 },
      language: 'en',
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('definitely-not-a-command');

    const broken = await testMcpServer(api, {
      profile: 'default',
      name: 'broken',
      config: { connect_timeout: 5 },
      language: 'en',
    });
    console.log(`MCP test of a server that exits: ${broken.duration_ms} ms, "${broken.error}"`);
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeTruthy();
    expect(broken.duration_ms).toBeLessThan(20_000);
  }, 120_000);

  it('a pack the hub installs is a skill Hermes lists in that profile, front matter intact', async () => {
    const document = [
      '---',
      'name: pdf-notes',
      'description: Summarise a PDF into notes with page references, keeping headings and tables as they are in the source.',
      'license: MIT',
      'metadata:',
      '  hermes:',
      '    tags: [pdf, notes]',
      '---',
      '',
      '# PDF notes',
      '',
      'Read `references/style.md` first.',
      '',
    ].join('\n');
    installPack(
      work,
      planImport(work, [
        {
          name: 'pack.zip',
          data: makeZip([
            { path: 'pdf-notes/SKILL.md', data: document },
            { path: 'pdf-notes/references/style.md', data: 'Keep headings.' },
          ]),
        },
      ]),
    );
    const listed = await api<Array<{ name: string; description: string; enabled: boolean }>>(
      'GET',
      '/api/skills?profile=work',
    );
    expect(listed.find((skill) => skill.name === 'pdf-notes')).toMatchObject({
      description: expect.stringContaining('Summarise a PDF'),
      enabled: true,
    });
    const content = await api<{ content: string }>(
      'GET',
      '/api/skills/content?name=pdf-notes&profile=work',
    );
    expect(content.content).toBe(document);
  }, 120_000);

  it.skipIf(process.env.COREHUB_REAL_WHATSAPP !== '1')(
    'a real WhatsApp pairing reaches its first QR code, and cancelling forgets it',
    async () => {
      const seen: Array<Record<string, unknown> | undefined> = [];
      let cancel = false;
      const handle: JobHandle = {
        id: 'job',
        progress: (_percent, _message, result) => {
          seen.push(result);
          if (typeof result?.qr === 'string') cancel = true;
        },
        cancelRequested: () => cancel,
      };
      const began = Date.now();
      const outcome = await pairWhatsApp(api, handle, {
        profile: 'work',
        language: 'en',
        pollMs: 1000,
      });
      console.log(`WhatsApp: first QR after ${Date.now() - began} ms`);
      expect(outcome).toEqual({ status: 'cancelled' });
      const qr = seen.find((result) => typeof result?.qr === 'string');
      expect(String(qr?.qr)).toMatch(/\S{20,}/);
    },
    300_000,
  );
});
