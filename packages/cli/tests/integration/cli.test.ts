/**
 * The reference client against the real server, in one process: the hub is built the way
 * `packages/server/tests/unit/helpers.ts` builds it, the agent is the scripted fake runner
 * from `packages/server/src/modules/sessions/testing/`, and every CLI call is `main()` with
 * piped streams. `--strict` is on for every chat, so each envelope the server sends is
 * validated against its JSON Schema in packages/contracts/events before it is rendered.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../server/src/app/config.js';
import { buildServer } from '../../../server/src/app/server.js';
import { createLogger } from '../../../server/src/lib/logger.js';
import { modules as defaultModules } from '../../../server/src/modules/index.js';
import { overrideModels } from '../../../server/src/modules/models/index.js';
import { createSessionsModule } from '../../../server/src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type ScriptStep,
} from '../../../server/src/modules/sessions/testing/fake-runner.js';
import { main } from '../../src/main.js';
import { EnvelopeValidator } from '../../src/realtime.js';

const PASSWORD = 'cli-test-password';
const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let runner: FakeAgentRunner;
const temps: string[] = [];
const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), `majlis-cli-${name}-`));
  temps.push(dir);
  return dir;
};
let env: NodeJS.ProcessEnv;
let deviceEnv: NodeJS.ProcessEnv;

interface Running {
  done: Promise<number>;
  stdout(): string;
  stderr(): string;
}

function start(args: string[], input: string[] = [], variables: NodeJS.ProcessEnv = env): Running {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  for (const line of input) stdin.write(`${line}\n`);
  stdin.end();
  return {
    done: main(args, { stdin, stdout, stderr, env: variables }),
    stdout: () => out,
    stderr: () => err,
  };
}

async function cli(args: string[], input: string[] = [], variables: NodeJS.ProcessEnv = env) {
  const running = start(args, input, variables);
  const code = await running.done;
  return { code, stdout: running.stdout(), stderr: running.stderr() };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ndjson = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/**
 * The only provider this suite talks to. `providers test` and the catalogue refresh make
 * real HTTP calls by design (ADR 0010: a test that does not reach the provider proves
 * nothing), so the hub is built with a scripted `fetch` and never leaves the process.
 */
const LOCAL_SERVER = 'http://127.0.0.1:4321/v1';
const scriptedProviders: typeof fetch = (input) => {
  const url = String(input);
  // A local, keyless model server — the case the owner cares about most.
  if (url === `${LOCAL_SERVER}/models`) {
    return Promise.resolve(
      new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder-7b-instruct' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  const body = url.startsWith('https://api.anthropic.com/v1/models')
    ? { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }], has_more: false }
    : { error: { message: 'this provider is not part of the test' } };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: url.startsWith('https://api.anthropic.com') ? 200 : 502,
      headers: { 'content-type': 'application/json' },
    }),
  );
};

beforeAll(async () => {
  runner = new FakeAgentRunner();
  overrideModels({ fetchImpl: scriptedProviders });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner,
    agentTimeoutMs: 20_000,
  });
  const config = loadConfig({ DATA_DIR: temp('data'), PORT: '0', HUB_ADMIN_PASSWORD: PASSWORD });
  app = await buildServer({
    config,
    logger: createLogger({ level: 'silent' }),
    modules: defaultModules.map((module) => (module.name === 'sessions' ? sessions : module)),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  env = { XDG_CONFIG_HOME: temp('config'), NO_COLOR: '1', LANG: 'en_US.UTF-8' };
  deviceEnv = { ...env, XDG_CONFIG_HOME: temp('device') };
});

afterAll(async () => {
  await app.close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

let sessionId = '';

describe('the reference client against the hub', () => {
  it('refuses to work before signing in (exit 3) and rejects a wrong password (exit 3)', async () => {
    const before = await cli(['whoami']);
    expect(before.code).toBe(3);
    expect(before.stderr).toContain('majlis login --server URL');
    const wrong = await cli(['login', '--server', baseUrl, '--username', 'admin'], ['not-it']);
    expect(wrong.code).toBe(3);
    expect(wrong.stderr).toMatch(/\[unauthorized, HTTP 401\]/);
  });

  it('signs in with a prompted password and stores the token 0600', async () => {
    const result = await cli(['login', '--server', baseUrl, '--username', 'admin'], [PASSWORD]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Signed in as admin (owner). Workspace: default.');
    expect(result.stderr).toContain('Password: ');
    const file = path.join(env.XDG_CONFIG_HOME!, 'majlis', 'config.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { session: { token_kind: string } };
    expect(stored.session.token_kind).toBe('session');
  });

  it('answers whoami in text, JSON and Arabic', async () => {
    const text = await cli(['whoami']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('admin');
    const json = await cli(['whoami', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({
      server: baseUrl,
      profile: 'default',
      token_kind: 'session',
      user: { username: 'admin', role: 'owner' },
    });
    const arabic = await cli(['whoami', '--lang', 'ar']);
    expect(arabic.stdout).toContain('المستخدم');
  });

  it('lists the curated catalog with hermes bundled', async () => {
    const result = await cli(['agents', 'list', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const items = (JSON.parse(result.stdout) as { items: { id: string; slug: string }[] }).items;
    const hermes = items.find((a) => a.slug === 'hermes');
    expect(hermes, 'hermes is bundled in the catalog').toBeDefined();
    const table = await cli(['agents', 'list']);
    expect(table.code, table.stderr).toBe(0);
    expect(table.stdout).toContain('hermes');
    const shown = await cli(['agents', 'get', hermes!.id, '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    expect((JSON.parse(shown.stdout) as { slug: string }).slug).toBe('hermes');
    const missing = await cli(['agents', 'get', '01J8QK3ZR2W7M5N4P6T8V9X0ZZ']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('not_found');
  });

  it('adds a provider from a preset, with the key from a prompt, and lists its models', async () => {
    // Nothing is configured until somebody adds it (contract decision §26).
    const before = await cli(['providers', 'list', '--json']);
    expect(before.code, before.stderr).toBe(0);
    expect((JSON.parse(before.stdout) as { items: unknown[] }).items).toEqual([]);

    // What *can* be added is its own list, and it carries the local servers.
    const presets = await cli(['providers', 'presets', '--json']);
    expect(presets.code, presets.stderr).toBe(0);
    const offered = (
      JSON.parse(presets.stdout) as {
        items: { id: string; key: string; base_url: string | null }[];
      }
    ).items;
    expect(offered.map((item) => item.id)).toEqual(
      expect.arrayContaining(['anthropic', 'lmstudio', 'litellm', 'openai-compatible', 'ollama']),
    );
    expect(offered.find((item) => item.id === 'lmstudio')).toMatchObject({
      key: 'optional',
      base_url: 'http://127.0.0.1:1234/v1',
    });

    // The key is never an argument: it is asked for, hidden, or piped in.
    const added = await cli(['providers', 'add', 'anthropic'], ['sk-ant-from-the-cli']);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain('Provider anthropic added');
    expect(added.stdout).not.toContain('sk-ant-from-the-cli');
    expect(added.stderr).toContain('Every agent uses this key');

    const listed = await cli(['providers', 'list']);
    expect(listed.stdout).toMatch(/anthropic.*stored/);
    // Not even the masked table leaks the value.
    expect(listed.stdout).not.toContain('sk-ant');

    const tested = await cli(['providers', 'test', 'anthropic']);
    expect(tested.code, tested.stderr).toBe(0);
    expect(tested.stdout).toContain('The provider answered.');

    // The catalogue refresh is a job the key triggered; wait for the model to show up.
    await waitUntil(async () => {
      const models = await cli(['models', 'list', '--json']);
      return models.stdout.includes('claude-sonnet-4-5');
    });

    const chosen = await cli(['models', 'default', 'anthropic/claude-sonnet-4-5']);
    expect(chosen.code, chosen.stderr).toBe(0);
    const shown = await cli(['models', 'default', '--json']);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      default: { model: 'claude-sonnet-4-5' },
    });

    const unknown = await cli(['providers', 'test', 'no-such-provider']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No provider "no-such-provider"');
  });

  it('adds a local model server with a base URL and no key, then takes a key for it', async () => {
    const added = await cli([
      'providers',
      'add',
      'lmstudio',
      '--base-url',
      LOCAL_SERVER,
      '--no-key',
    ]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain(`Provider lmstudio added at ${LOCAL_SERVER}`);

    // No key, and nothing anywhere calls that a problem.
    const listed = await cli(['providers', 'list']);
    expect(listed.stdout).toMatch(/lmstudio.*optional/);
    expect(listed.stdout).not.toContain('missing');

    const tested = await cli(['providers', 'test', 'lmstudio']);
    expect(tested.code, tested.stderr).toBe(0);
    expect(tested.stdout).toContain('The provider answered.');
    expect(tested.stdout).not.toContain('No API key');

    await waitUntil(async () => {
      const models = await cli(['models', 'list', '--json', '--provider', 'lmstudio']);
      return models.stdout.includes('qwen2.5-coder-7b-instruct');
    });

    // And a key can still be given to it — "optional" never means "refused".
    const keyed = await cli(['providers', 'add', 'lmstudio'], ['lm-studio-master-key']);
    expect(keyed.code, keyed.stderr).toBe(0);
    expect(keyed.stdout).toContain('Key stored for lmstudio.');
    expect(keyed.stdout).not.toContain('lm-studio-master-key');
    const after = await cli(['providers', 'list', '--json']);
    const row = (
      JSON.parse(after.stdout) as {
        items: { slug: string; api_key: string | null; auth: { kind: string } }[];
      }
    ).items.find((item) => item.slug === 'lmstudio');
    expect(row?.api_key).toBe('[stored]');
    // Storing one does not turn it into a provider that demands one.
    expect(row?.auth.kind).toBe('none');

    // Clearing the credentials keeps the provider; removing it takes the row away.
    const cleared = await cli(['providers', 'remove', 'lmstudio', '--clear-key']);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain('Key removed from lmstudio.');
    const removed = await cli(['providers', 'remove', 'lmstudio']);
    expect(removed.code, removed.stderr).toBe(0);
    const left = await cli(['providers', 'list', '--json']);
    expect(
      (JSON.parse(left.stdout) as { items: { slug: string }[] }).items.map((item) => item.slug),
    ).not.toContain('lmstudio');
  });

  it('creates, lists and shows a session', async () => {
    const created = await cli(['sessions', 'new', '--agent', AGENT_ID, '--json']);
    expect(created.code, created.stderr).toBe(0);
    sessionId = (JSON.parse(created.stdout) as { id: string }).id;
    expect(sessionId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const listed = await cli(['sessions', 'list', '--json']);
    expect(
      (JSON.parse(listed.stdout) as { items: { id: string }[] }).items.map((s) => s.id),
    ).toContain(sessionId);
    const table = await cli(['sessions', 'list']);
    expect(table.stdout).toContain(sessionId);
    expect(table.stdout).toContain('(new chat)');
    const shown = await cli(['sessions', 'show', sessionId]);
    expect(shown.stdout).toContain(sessionId);
    const missing = await cli(['sessions', 'show', '01J8QK3ZR2W7M5N4P6T8V9X0ZZ']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('not_found');
  });

  it('streams a whole run to the terminal, validating every envelope (--strict)', async () => {
    runner.play([
      { type: 'reasoning_delta', text: 'The user wants the tests run.' },
      { type: 'message_delta', text: 'سأشغّل ' },
      { type: 'message_delta', text: 'الاختبارات الآن.' },
      {
        type: 'tool_started',
        ref: 't1',
        name: 'shell',
        kind: 'shell',
        input: { command: 'pnpm test' },
      },
      { type: 'tool_completed', ref: 't1', output: '30 passed', exitCode: 0 },
      { type: 'message_delta', text: ' نجحت.' },
      {
        type: 'usage',
        modelLabel: 'hermes-4',
        inputTokens: 2300,
        outputTokens: 410,
        costMicroUsd: 13_100,
        costSource: 'provider',
      },
      { type: 'context', usedTokens: 45_000, windowTokens: 256_000 },
      { type: 'completed' },
    ]);
    const result = await cli([
      'chat',
      sessionId,
      '--message',
      'شغّل اختبارات الخادم',
      '--once',
      '--strict',
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Hermes: سأشغّل الاختبارات الآن.\n');
    expect(result.stdout).toContain('  * tool shell\n');
    expect(result.stdout).not.toContain('you:');
    expect(result.stdout).not.toContain('queued');
    expect(result.stdout).toContain('  = tool shell finished');
    expect(result.stdout).toContain('    30 passed\n');
    expect(result.stdout).toContain(' نجحت.\n');
    expect(result.stdout).toContain('2300 in · 410 out · 0.013100 USD');
    expect(result.stderr).toBe('');
  });

  it('emits the raw envelopes as NDJSON with --json, every one schema-valid', async () => {
    runner.play([{ type: 'message_delta', text: 'ok' }, { type: 'completed' }]);
    const result = await cli([
      'chat',
      sessionId,
      '--message',
      'hi',
      '--once',
      '--json',
      '--strict',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const lines = ndjson(result.stdout);
    const accepted = lines.find((line) => 'accepted' in line) as { accepted: { run_id: string } };
    expect(accepted.accepted.run_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const events = lines.filter((line) => 'event' in line);
    expect(events.map((e) => e.event)).toEqual([
      'message.created',
      'run.queued',
      'message.created',
      'run.started',
      'session.updated',
      'message.delta',
      'run.completed',
      'session.updated',
    ]);
    const validator = new EnvelopeValidator();
    for (const envelope of events)
      expect(validator.problems(envelope), String(envelope.event)).toEqual([]);
  });

  it('answers approvals automatically with --approve, and denies without a terminal', async () => {
    const script: ScriptStep[] = [
      {
        type: 'tool_started',
        ref: 't1',
        name: 'shell',
        kind: 'shell',
        input: { command: 'rm -rf build' },
      },
      {
        type: 'approval_requested',
        ref: 'a1',
        kind: 'tool_call',
        title: 'تنفيذ أمر',
        command: 'rm -rf build',
        toolRef: 't1',
        allowAlways: true,
      },
      { type: 'await_input' },
      { type: 'tool_completed', ref: 't1', output: '', exitCode: 0 },
      { type: 'message_delta', text: 'حذفت المجلد.' },
      { type: 'completed' },
    ];
    runner.play(script);
    const approved = await cli([
      'chat',
      sessionId,
      '--message',
      'نظّف',
      '--once',
      '--strict',
      '--approve',
      'session',
    ]);
    expect(approved.code, approved.stderr).toBe(0);
    expect(approved.stderr).toContain('approval answered automatically: approve_session');
    expect(approved.stdout).toContain('حذفت المجلد.');
    expect(runner.inputs.at(-1)?.input).toEqual({
      approvalRef: 'a1',
      decision: 'approve_session',
      answer: null,
    });

    runner.play(script);
    const denied = await cli(['chat', sessionId, '--message', 'نظّف', '--once', '--strict']);
    expect(denied.code, denied.stderr).toBe(0);
    expect(runner.inputs.at(-1)?.input).toEqual({
      approvalRef: 'a1',
      decision: 'deny',
      answer: null,
    });
  });

  it('reports a failed run with its error envelope and exits 1', async () => {
    runner.play([
      { type: 'message_delta', text: 'half' },
      { type: 'failed', message: 'boom', code: 'agent_error' },
    ]);
    const result = await cli(['chat', sessionId, '--message', 'x', '--once', '--strict']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('half\n');
    expect(result.stdout).toMatch(/run failed: .+ \[agent_error\]/);
  });

  it('resumes with after_seq after the socket drops mid-run', async () => {
    runner.play([
      { type: 'message_delta', text: 'one ' },
      { type: 'await_input' },
      { type: 'message_delta', text: 'two ' },
      { type: 'message_delta', text: 'three' },
      { type: 'completed' },
    ]);
    const chat = start(['chat', sessionId, '--message', 'count', '--once', '--strict'], [], {
      ...env,
      MAJLIS_DEBUG: '1',
    });
    await waitUntil(() => chat.stdout().includes('one '));
    // The connection is lost; the agent keeps talking while nobody listens.
    app.hub.io.of('/rt/sessions').disconnectSockets(true);
    const runId = runner.started.at(-1)?.runId ?? '';
    await runner.send(runId, { approvalRef: 'none', decision: null, answer: null });
    const code = await Promise.race([
      chat.done,
      new Promise<number>((_, reject) =>
        setTimeout(
          () => reject(new Error(`no exit\nstderr: ${chat.stderr()}\nstdout: ${chat.stdout()}`)),
          20_000,
        ),
      ),
    ]);
    expect(code, chat.stderr()).toBe(0);
    expect(chat.stdout()).toContain('Hermes: one two three\n');
    expect(chat.stderr()).toContain('Connection lost');
    expect(chat.stderr()).toMatch(/Reconnected; [1-9]\d* missed event\(s\) replayed/);
  });

  it('gives up on --timeout while the run stays on the hub', async () => {
    runner.play([
      { type: 'message_delta', text: 'slow' },
      { type: 'await_input' },
      { type: 'completed' },
    ]);
    const result = await cli(['chat', sessionId, '--message', 'wait', '--once', '--timeout', '1']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Timed out after 1 s.');
    await runner.interrupt(runner.started.at(-1)?.runId ?? '');
  });

  it('pairs a second computer: `pair` waits for pairing.claimed, `pair claim` stores an app token', async () => {
    const pairing = start(['pair', '--json', '--ttl', '60']);
    await waitUntil(() => pairing.stdout().includes('\n'));
    const created = ndjson(pairing.stdout())[0] as { id: string; code: string; qr_payload: string };
    expect(created.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(JSON.parse(created.qr_payload)).toMatchObject({
      type: 'majlis.pairing',
      pairing_id: created.id,
      hub_url: baseUrl,
    });

    const claim = await cli(
      ['pair', 'claim', created.qr_payload, '--json', '--name', 'laptop'],
      [],
      deviceEnv,
    );
    expect(claim.code, claim.stderr).toBe(0);
    const claimed = JSON.parse(claim.stdout) as Record<string, unknown>;
    expect(claimed).not.toHaveProperty('app_token');
    expect(claimed).toMatchObject({
      hub_url: baseUrl,
      device: { name: 'laptop', kind: 'computer', this_device: true },
    });

    expect(await pairing.done).toBe(0);
    const final = ndjson(pairing.stdout())[1] as {
      pairing: { status: string };
      device: { name: string } | null;
    };
    expect(final.pairing.status).toBe('claimed');
    expect(final.device?.name).toBe('laptop');

    const who = await cli(['whoami', '--json'], [], deviceEnv);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({
      token_kind: 'app',
      user: { username: 'admin' },
    });
    const out = await cli(['logout'], [], deviceEnv);
    expect(out.code).toBe(0);
  });

  it('fails a claim with a code but no pairing id (exit 2), and on an unknown pairing (exit 1)', async () => {
    const usage = await cli(['pair', 'claim', 'AAAA-BBBB', '--server', baseUrl], [], deviceEnv);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('--pairing-id');
    const unknown = await cli(
      [
        'pair',
        'claim',
        'AAAA-BBBB',
        '--server',
        baseUrl,
        '--pairing-id',
        '01J8QK3ZR2W7M5N4P6T8V9X0ZZ',
      ],
      [],
      deviceEnv,
    );
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('not_found');
  });

  it('deletes the session, signs out, and is then refused again', async () => {
    const deleted = await cli(['sessions', 'delete', sessionId]);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain(`Session ${sessionId} deleted.`);
    const gone = await cli(['sessions', 'show', sessionId]);
    expect(gone.code).toBe(1);
    const out = await cli(['logout']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`Signed out of ${baseUrl}.`);
    const after = await cli(['whoami']);
    expect(after.code).toBe(3);
  });
});
