/**
 * The Hermes Settings page against **the real Hermes** from the image (contract decision §56):
 *
 * - every value the hub writes (`hermes-settings.ts`) into a profile's `config.yaml` and `.env` is
 *   what Hermes's **own loaders** read back — `hermes_cli.config.load_config` with
 *   `resolve_turn_limit`, `hermes_constants.resolve_reasoning_config`, the memory store Hermes
 *   builds from its config, `tools.write_approval.write_approval_enabled`, its approvals-mode
 *   normaliser, `privacy.redact_pii` as the gateway reads it, and the proxy after
 *   `load_hermes_dotenv` as its model client picks it (`agent.proxy_bypass`);
 * - with the two write gates on, Hermes's own memory tool and skill manager **stage** their writes
 *   instead of saving them; the hub lists them, approves one of each through Hermes's own code
 *   (`hermes-pending-writes.ts`, run with the image's Python) so the memory entry and the skill are
 *   really saved, and rejects a third.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   docker build -f packages/server/Dockerfile -t core-hub:local .
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/hermes-settings.real.test.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeHermesSettings } from './hermes-settings.js';
import {
  approvePendingWrite,
  listPendingWrites,
  rejectPendingWrite,
  type HermesPython,
} from './hermes-pending-writes.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const PYTHON = '/opt/hermes/.venv/bin/python';

describe.skipIf(!image)('Hermes settings (real Hermes; set COREHUB_HERMES_IMAGE)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-settings-real-'));
  chmodSync(home, 0o777);
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

  /** Hermes's Python in the image, with the profile's home mounted where it is on the host. */
  const python: HermesPython = (hermesHome, argv) =>
    new Promise((resolve) => {
      const name = `corehub-settings-real-${process.pid}-${containers.length}`;
      containers.push(name);
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'none',
          '--user',
          `${uid}:${gid}`,
          '-v',
          `${hermesHome}:/hh`,
          '-e',
          'HERMES_HOME=/hh',
          '-e',
          'HOME=/tmp',
          '--entrypoint',
          PYTHON,
          image!,
          '-c',
          ...argv,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });

  /** Runs a Python program in the image and returns its last stdout line as JSON. */
  async function hermes(program: string): Promise<Record<string, unknown>> {
    const result = await python(home, [program]);
    const line = result.stdout.trim().split('\n').pop() ?? '';
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`hermes said: ${result.stdout}\n${result.stderr}`);
    }
  }

  it("writes every setting where Hermes's own loaders read it back", async () => {
    writeFileSync(
      path.join(home, 'config.yaml'),
      '# written by a person\nmodel:\n  default: gpt-5 # keep\n',
    );
    writeFileSync(path.join(home, '.env'), '# keys\nOPENAI_API_KEY=sk-test\n');
    writeHermesSettings(home, true, 'agent', {
      max_turns: 60,
      run_budget_seconds: 900,
      tool_use_enforcement: 'on',
      reasoning_effort: 'high',
    });
    writeHermesSettings(home, true, 'memory', { memory_char_limit: 3000, user_char_limit: 1500 });
    writeHermesSettings(home, true, 'approvals', {
      approvals_mode: 'off',
      memory_write_approval: true,
      skills_write_approval: true,
    });
    writeHermesSettings(home, true, 'network', {
      https_proxy: 'http://proxy.corehub.test:3128',
      http_proxy: 'http://plain.corehub.test:3128',
      no_proxy: 'localhost,.internal',
    });
    writeHermesSettings(home, true, 'privacy', { redact_pii: true });
    expect(readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain(
      '# written by a person',
    );

    const read = await hermes(`
import json, os
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli.config import load_config, resolve_turn_limit
from hermes_constants import resolve_reasoning_config
from tools.memory_tool import load_on_disk_store
from tools.write_approval import write_approval_enabled
from tools.approval_context import _normalize_approval_mode
from agent.proxy_bypass import first_proxy_env_value, should_bypass_proxy
cfg = load_config()
agent = cfg["agent"]
store = load_on_disk_store()
print(json.dumps({
  "max_turns": resolve_turn_limit(agent.get("max_turns")),
  "run_budget_seconds": agent.get("run_budget_seconds"),
  "tool_use_enforcement": agent.get("tool_use_enforcement"),
  "reasoning": resolve_reasoning_config(cfg),
  "memory_char_limit": store.memory_char_limit,
  "user_char_limit": store.user_char_limit,
  "approvals_mode": _normalize_approval_mode(cfg["approvals"].get("mode")),
  "memory_write_approval": write_approval_enabled("memory"),
  "skills_write_approval": write_approval_enabled("skills"),
  "redact_pii": bool((cfg.get("privacy") or {}).get("redact_pii", False)),
  "proxy": first_proxy_env_value(),
  "http_proxy": os.environ.get("HTTP_PROXY"),
  "bypass_internal": should_bypass_proxy("api.internal"),
  "bypass_openai": should_bypass_proxy("api.openai.com"),
  "model": cfg["model"],
}))
`);
    expect(read).toEqual({
      max_turns: 60,
      run_budget_seconds: 900,
      tool_use_enforcement: true,
      reasoning: { enabled: true, effort: 'high' },
      memory_char_limit: 3000,
      user_char_limit: 1500,
      approvals_mode: 'off',
      memory_write_approval: true,
      skills_write_approval: true,
      redact_pii: true,
      proxy: 'http://proxy.corehub.test:3128',
      http_proxy: 'http://plain.corehub.test:3128',
      bypass_internal: true,
      bypass_openai: false,
      model: expect.objectContaining({ default: 'gpt-5' }),
    });
  }, 180_000);

  it("puts a value back to Hermes's default, as Hermes sees it", async () => {
    writeHermesSettings(home, true, 'agent', { max_turns: null, reasoning_effort: 'none' });
    writeHermesSettings(home, true, 'network', { https_proxy: null, http_proxy: null });
    const read = await hermes(`
import json
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli.config import load_config
from hermes_constants import resolve_reasoning_config
from agent.proxy_bypass import first_proxy_env_value
cfg = load_config()
print(json.dumps({
  "max_turns": cfg["agent"].get("max_turns"),
  "reasoning": resolve_reasoning_config(cfg),
  "proxy": first_proxy_env_value(),
}))
`);
    expect(read).toEqual({ max_turns: null, reasoning: { enabled: false }, proxy: '' });
  }, 180_000);

  it('with the gates on, Hermes stages its writes; the hub lists, approves and rejects them', async () => {
    const staged = await hermes(`
import json
from tools.memory_tool import memory_tool, load_on_disk_store
from tools.skill_manager_tool import skill_manage
store = load_on_disk_store()
a = json.loads(memory_tool(action="add", target="memory", content="The deploy runs on Fridays.", store=store))
b = json.loads(memory_tool(action="add", target="user", content="Prefers short answers.", store=store))
c = json.loads(skill_manage(action="create", name="deploy-notes", content="---\\nname: deploy-notes\\ndescription: How we deploy.\\n---\\n\\nRun the deploy on Fridays.\\n"))
print(json.dumps({"memory": a, "user": b, "skill": c}))
`);
    // Hermes did not save them: it staged them.
    expect(staged.memory).toMatchObject({ staged: true });
    expect(staged.skill).toMatchObject({ staged: true });
    expect(existsSync(path.join(home, 'skills', 'deploy-notes'))).toBe(false);

    const waiting = listPendingWrites(home);
    expect(waiting).toHaveLength(3);
    const memory = waiting.find((w) => w.kind === 'memory' && w.target === 'memory')!;
    const user = waiting.find((w) => w.kind === 'memory' && w.target === 'user')!;
    const skill = waiting.find((w) => w.kind === 'skills')!;
    expect(memory).toMatchObject({ action: 'add', content: 'The deploy runs on Fridays.' });
    expect(skill).toMatchObject({ action: 'create', name: 'deploy-notes' });
    expect(skill.content).toContain('Run the deploy on Fridays.');

    await approvePendingWrite(python, home, 'memory', memory.id);
    await approvePendingWrite(python, home, 'skills', skill.id);
    rejectPendingWrite(home, 'memory', user.id);

    expect(listPendingWrites(home)).toEqual([]);
    expect(readFileSync(path.join(home, 'memories', 'MEMORY.md'), 'utf8')).toContain(
      'The deploy runs on Fridays.',
    );
    expect(existsSync(path.join(home, 'memories', 'USER.md'))).toBe(false);
    expect(readFileSync(path.join(home, 'skills', 'deploy-notes', 'SKILL.md'), 'utf8')).toContain(
      'Run the deploy on Fridays.',
    );
  }, 240_000);
});
