/**
 * The tool filter the hub writes, against **the real Hermes** from the image (DECISIONS §134):
 * the hub writes `mcp_servers.<name>.tools.include` / `.tools.exclude` (`mcp.ts`
 * `setMcpToolFilter`), and Hermes's own discovery — `tools/mcp_tool_discovery.py`
 * `discover_mcp_tools`, what an agent session runs when it starts — registers only the tools
 * the filter allows, from a real stdio MCP server (`tests/fixtures/mcp-stdio-server.mjs`, two
 * tools: `echo` and `add`). Hermes's test (the probe behind `POST /api/mcp/servers/{name}/test`)
 * still lists every tool, which is what the hub's picker is drawn from.
 *
 * CI runs it on the floor and on the pinned Hermes. Name the image, or a Hermes executable in a
 * venv of the tag (its `python` beside it runs the programs); without either it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run --project unit src/modules/agents/mcp-tool-filter.real.test.ts
 *   COREHUB_HERMES_BIN=/path/to/venv/bin/hermes … (same)
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { setMcpToolFilter } from './mcp.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const bin = process.env.COREHUB_HERMES_BIN;
const PYTHON = '/opt/hermes/.venv/bin/python';
const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/mcp-stdio-server.mjs',
);

/** Hermes's discovery, as a session runs it; prints the tool names it registered. */
const DISCOVER = `
import json, logging, os, sys
logging.disable(logging.CRITICAL)
from tools.mcp_tool_discovery import discover_mcp_tools
names = sorted(discover_mcp_tools())
sys.stdout.write("\\n" + json.dumps({"registered": names}) + "\\n")
sys.stdout.flush()
os._exit(0)
`;

/** Hermes's test probe (the one its dashboard's Test calls); prints the tools it listed. */
const PROBE = `
import json, logging, os, sys
logging.disable(logging.CRITICAL)
from hermes_cli.mcp_config import _get_mcp_servers, _probe_single_server
tools = _probe_single_server("fixture", _get_mcp_servers()["fixture"])
sys.stdout.write("\\n" + json.dumps({"listed": [t[0] for t in tools]}) + "\\n")
sys.stdout.flush()
os._exit(0)
`;

describe.skipIf(!image && !bin)(
  'the tool filter in Hermes (real Hermes; set COREHUB_HERMES_IMAGE or COREHUB_HERMES_BIN)',
  () => {
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-mcp-filter-real-'));
    chmodSync(home, 0o777);
    copyFileSync(fixture, path.join(home, 'mcp-fixture.mjs'));
    const containers: string[] = [];
    const { uid, gid } = userInfo();

    afterAll(() => {
      for (const name of containers) {
        try {
          execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
        } catch {
          // already gone (--rm)
        }
      }
      rmSync(home, { recursive: true, force: true });
    });

    /** Where the fixture's home is, as Hermes sees it: mounted at /hh in the image. */
    const seen = image ? '/hh' : home;

    function python(program: string): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const name = `corehub-mcp-filter-real-${process.pid}-${containers.length}`;
        if (image) containers.push(name);
        const [command, args, env] = image
          ? ['docker', dockerArgs(name, program), process.env]
          : [
              path.join(path.dirname(bin!), 'python'),
              ['-c', program],
              { ...process.env, HERMES_HOME: home, HOME: home },
            ];
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
        child.on('close', () => {
          clearTimeout(timer);
          const line = stdout.trim().split('\n').pop() ?? '';
          try {
            resolve(JSON.parse(line) as Record<string, unknown>);
          } catch {
            reject(new Error(`hermes said: ${stdout}\n${stderr}`));
          }
        });
      });
    }

    function dockerArgs(name: string, program: string): string[] {
      return [
        'run',
        '--rm',
        '--name',
        name,
        '--network',
        'none',
        '--user',
        `${uid}:${gid}`,
        '-v',
        `${home}:/hh`,
        '-e',
        'HERMES_HOME=/hh',
        '-e',
        'HOME=/tmp',
        '--entrypoint',
        PYTHON,
        image!,
        '-c',
        program,
      ];
    }

    const config = (filter = '') =>
      writeFileSync(
        path.join(home, 'config.yaml'),
        `# a person's config\nmcp_servers:\n  fixture:\n    command: node\n    args: [${seen}/mcp-fixture.mjs]\n${filter}`,
      );

    /** Which of the fixture's tools Hermes registered for an agent. */
    async function registered(): Promise<string[]> {
      const names = (await python(DISCOVER)).registered as string[];
      return ['echo', 'add'].filter((tool) =>
        names.some((name) => name === tool || name.endsWith(`_${tool}`)),
      );
    }

    it('registers every tool with no filter, and only the included ones with `tools.include`', async () => {
      config();
      expect(await registered()).toEqual(['echo', 'add']);

      setMcpToolFilter(home, 'fixture', { include: ['echo'], exclude: null });
      expect(await registered()).toEqual(['echo']);

      // Hermes's test still lists every tool: the picker is drawn from the whole list.
      expect((await python(PROBE)).listed).toEqual(['echo', 'add']);
    }, 400_000);

    it('drops the excluded ones with `tools.exclude`, and registers none with `include: []`', async () => {
      config();
      setMcpToolFilter(home, 'fixture', { include: null, exclude: ['echo'] });
      expect(await registered()).toEqual(['add']);

      setMcpToolFilter(home, 'fixture', { include: [], exclude: null });
      expect(await registered()).toEqual([]);

      // A tool the server does not have stays in the list harmlessly; a new one is not let in.
      setMcpToolFilter(home, 'fixture', { include: ['add', 'gone_tool'], exclude: null });
      expect(await registered()).toEqual(['add']);

      setMcpToolFilter(home, 'fixture', { include: null, exclude: null });
      expect(await registered()).toEqual(['echo', 'add']);
    }, 600_000);
  },
);
