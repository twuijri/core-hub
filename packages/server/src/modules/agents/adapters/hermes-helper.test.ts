/**
 * The Hermes helper (ADR 0031) against a scripted model gateway, a fake Hermes and a fake
 * command runner: the level question, which tools each level offers, approvals before every
 * change, secrets kept out of what the model reads, members refused, and the no-gateway path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirectChatEvent, DirectChatMessage } from '../ports.js';
import type { DirectModelsPort } from './direct.js';
import {
  HermesHelperSession,
  levelOfAnswer,
  readChatStream,
  redactSecrets,
  type HelperUser,
  type HermesHelperHost,
} from './hermes-helper.js';
import type { CommandResult } from './host.js';
import type { AgentEvent, AgentTarget } from './types.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'corehub-helper-'));
  mkdirSync(path.join(home, 'logs'));
  writeFileSync(
    path.join(home, 'logs', 'errors.log'),
    'line 1\nERROR telegram: 401 Unauthorized token=123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll\n',
  );
  writeFileSync(
    path.join(home, '.env'),
    'OPENROUTER_API_KEY=sk-or-v1-abcdefabcdefabcdefabcdef\nEMPTY=\n',
  );
  writeFileSync(
    path.join(home, 'config.yaml'),
    'model:\n  default: gpt-5\n  api_key: sk-secretsecretsecretsecret\n',
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// ------------------------------------------------------------------ the scripted gateway

type Reply = { text?: string; calls?: { name: string; args: Record<string, unknown> }[] };

function sse(reply: Reply): string {
  const frames: unknown[] = [];
  if (reply.text) frames.push({ choices: [{ delta: { content: reply.text } }] });
  (reply.calls ?? []).forEach((call, index) => {
    const args = JSON.stringify(call.args);
    // Split the arguments across two frames, as providers do.
    frames.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: `call_${index}_${call.name}`,
                function: { name: call.name, arguments: args.slice(0, 3) },
              },
            ],
          },
        },
      ],
    });
    frames.push({
      choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(3) } }] } }],
    });
  });
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
}

interface Gateway {
  fetch: typeof fetch;
  bodies: {
    model: string;
    messages: { role: string; content: string | null }[];
    tools: { function: { name: string } }[];
  }[];
}

function gateway(replies: Reply[]): Gateway {
  const bodies: Gateway['bodies'] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Gateway['bodies'][number]);
    const reply = replies.shift() ?? { text: 'done' };
    return new Response(sse(reply), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, bodies };
}

// ----------------------------------------------------------------------- the fake hub

function host(
  role: HelperUser['role'] = 'owner',
  locale: HelperUser['locale'] = 'ar',
): HermesHelperHost & {
  restarts: number;
} {
  const fake = {
    restarts: 0,
    user: () => ({ role, locale }),
    status: () => ({ mode: 'managed', state: 'error', lastError: 'exited with code 1' }),
    home: () => home,
    executable: () => '/opt/hermes/bin/hermes',
    cliEnv: () => ({ HERMES_HOME: home }),
    canRestart: () => true,
    restart: async () => {
      fake.restarts += 1;
    },
    canUpdate: () => false,
    update: async () => undefined,
    hubFacts: () => ({ version: '1.1.10', platform: 'linux' }),
  };
  return fake;
}

function runner() {
  const calls: { argv: readonly string[]; cwd?: string }[] = [];
  const run = async (
    argv: readonly string[],
    options: { cwd?: string } = {},
  ): Promise<CommandResult> => {
    calls.push({ argv, ...(options.cwd ? { cwd: options.cwd } : {}) });
    return {
      ok: true,
      stdout: `ran ${argv.slice(1).join(' ')}\nANTHROPIC_API_KEY=sk-ant-api03-zzzzzzzzzzzzzzzzzzzz`,
      stderr: '',
      error: null,
    };
  };
  return { run, calls };
}

const TARGET: AgentTarget = {
  slug: 'hermes-helper',
  name: 'Hermes helper',
  command: [],
  executablePath: null,
  endpoint: null,
  workspace: 'ws-1',
  userId: 'u-1',
  env: {
    COREHUB_GATEWAY_URL: 'http://127.0.0.1:9/gateway/openai/v1',
    COREHUB_GATEWAY_TOKEN: 'chgw_test',
    COREHUB_GATEWAY_MODEL: 'corehub-main',
  },
};

/** Collects events; answers the level question and approvals as `script` says. */
function drive(
  session: HermesHelperSession,
  script: { level?: string | null; approve?: boolean } = {},
): AgentEvent[] {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of session.stream()) {
      events.push(event);
      if (event.type === 'question.asked') {
        const pick =
          script.level === undefined
            ? null
            : script.level === null
              ? null
              : (event.choices.find((choice) => choice.startsWith(script.level!)) ?? script.level);
        void session.answer(event.id, pick);
      }
      if (event.type === 'approval.requested') {
        void session.respond(event.id, script.approve ? 'once' : 'deny');
      }
    }
  })();
  return events;
}

const names = (body: Gateway['bodies'][number]) => body.tools.map((tool) => tool.function.name);

// ------------------------------------------------------------------------------ tests

describe('the Hermes helper', () => {
  it('asks the owner for a level with three choices, green first and red last', async () => {
    const gw = gateway([{ text: 'تمام' }]);
    const session = new HermesHelperSession(TARGET, {
      host: () => host(),
      models: () => null,
      fetch: gw.fetch,
    });
    const events = drive(session, { level: null });
    await session.send({ text: 'Hermes ما يرد' });
    const question = events.find((event) => event.type === 'question.asked');
    expect(
      question && question.type === 'question.asked' && question.choices.map((c) => c.slice(0, 2)),
    ).toEqual(['🟢', '🟡', '🔴']);
    // Skipped: green. Only looking tools, and the way to ask for more.
    expect(names(gw.bodies[0]!)).toEqual([
      'hermes_status',
      'hermes_doctor',
      'list_hermes_files',
      'read_hermes_file',
      'request_more_access',
    ]);
    expect(events.at(-1)).toEqual({ type: 'run.completed', stopReason: 'end_turn' });
  });

  it('offers an admin no red, and never lets an answer climb above it', async () => {
    const gw = gateway([{ text: 'ok' }]);
    const session = new HermesHelperSession(TARGET, {
      host: () => host('admin', 'en'),
      models: () => null,
      fetch: gw.fetch,
    });
    const events = drive(session, { level: 'full access please' });
    await session.send({ text: 'help' });
    const question = events.find((event) => event.type === 'question.asked');
    expect(question && question.type === 'question.asked' && question.choices).toHaveLength(2);
    expect(names(gw.bodies[0]!)).toContain('run_hermes');
    expect(names(gw.bodies[0]!)).not.toContain('run_command');
  });

  it('refuses a member before anything runs', async () => {
    const gw = gateway([]);
    const session = new HermesHelperSession(TARGET, {
      host: () => host('member', 'ar'),
      models: () => null,
      fetch: gw.fetch,
    });
    const events = drive(session);
    await session.send({ text: 'help' });
    expect(events).toEqual([expect.objectContaining({ type: 'run.failed', code: 'forbidden' })]);
    expect(gw.bodies).toHaveLength(0);
  });

  it('runs a check by itself and keeps secrets out of what the model reads', async () => {
    const gw = gateway([
      { calls: [{ name: 'hermes_doctor', args: {} }] },
      { text: 'المفتاح منتهي' },
    ]);
    const { run, calls } = runner();
    const session = new HermesHelperSession(TARGET, {
      host: () => host(),
      models: () => null,
      fetch: gw.fetch,
      run,
    });
    const events = drive(session, { level: '🟢' });
    await session.send({ text: 'ليش ما يرد؟' });
    expect(calls).toEqual([{ argv: ['/opt/hermes/bin/hermes', 'doctor'], cwd: home }]);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    const toolMessage = gw.bodies[1]!.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('ANTHROPIC_API_KEY=[hidden]');
    expect(toolMessage?.content).not.toContain('zzzz');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool.completed', title: 'hermes doctor' }),
    );
  });

  it('asks before a fix and does not run it when the person says no', async () => {
    const gw = gateway([
      { calls: [{ name: 'hermes_doctor_fix', args: { why: 'يصلح الإعدادات' } }] },
      { text: 'طيب' },
    ]);
    const { run, calls } = runner();
    const session = new HermesHelperSession(TARGET, {
      host: () => host(),
      models: () => null,
      fetch: gw.fetch,
      run,
    });
    const events = drive(session, { level: '🟡', approve: false });
    await session.send({ text: 'صلحه' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval.requested',
        title: 'hermes doctor --fix',
        command: 'hermes doctor --fix',
        description: 'يصلح الإعدادات',
      }),
    );
    expect(calls).toHaveLength(0);
    expect(gw.bodies[1]!.messages.at(-1)?.content).toMatch(/^DECLINED/);
  });

  it('runs a fix the person approved', async () => {
    const gw = gateway([
      {
        calls: [
          { name: 'restart_hermes', args: { why: 'r' } },
          { name: 'run_hermes', args: { args: ['gateway', 'status'], why: 'w' } },
        ],
      },
      { text: 'رجع' },
    ]);
    const { run, calls } = runner();
    const fake = host();
    const session = new HermesHelperSession(TARGET, {
      host: () => fake,
      models: () => null,
      fetch: gw.fetch,
      run,
    });
    drive(session, { level: '🟡', approve: true });
    await session.send({ text: 'صلحه' });
    expect(fake.restarts).toBe(1);
    expect(calls.map((call) => call.argv)).toEqual([
      ['/opt/hermes/bin/hermes', 'gateway', 'status'],
    ]);
  });

  it('refuses a fix at green and lets the person raise the level', async () => {
    const gw = gateway([
      { calls: [{ name: 'run_hermes', args: { args: ['doctor', '--fix'], why: 'x' } }] },
      { calls: [{ name: 'request_more_access', args: { why: 'x' } }] },
      { text: 'جاهز' },
    ]);
    const answers: (string | null)[] = ['🟢', '🟡'];
    const session = new HermesHelperSession(TARGET, {
      host: () => host(),
      models: () => null,
      fetch: gw.fetch,
    });
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'question.asked') {
          const want = answers.shift()!;
          void session.answer(
            event.id,
            event.choices.find((choice) => choice.startsWith(want!)) ?? null,
          );
        }
      }
    })();
    await session.send({ text: 'x' });
    expect(gw.bodies[1]!.messages.at(-1)?.content).toMatch(
      /Not available at this conversation’s level/,
    );
    const raise = events.filter((event) => event.type === 'question.asked')[1];
    // Raising offers only what is above green.
    expect(
      raise && raise.type === 'question.asked' && raise.choices.map((c) => c.slice(0, 2)),
    ).toEqual(['🟡', '🔴']);
    expect(names(gw.bodies[2]!)).toContain('run_hermes');
  });

  it('reads only inside Hermes’s home, and a .env as names only', async () => {
    const gw = gateway([
      {
        calls: [
          { name: 'read_hermes_file', args: { path: '../../etc/passwd' } },
          { name: 'read_hermes_file', args: { path: '.env' } },
          { name: 'read_hermes_file', args: { path: 'config.yaml' } },
        ],
      },
      { text: 'ok' },
    ]);
    const session = new HermesHelperSession(TARGET, {
      host: () => host(),
      models: () => null,
      fetch: gw.fetch,
    });
    drive(session, { level: '🟢' });
    await session.send({ text: 'x' });
    const tools = gw.bodies[1]!.messages.filter((message) => message.role === 'tool');
    expect(tools[0]!.content).toMatch(/not inside Hermes’s home/);
    expect(tools[1]!.content).toBe('OPENROUTER_API_KEY=[set]\nEMPTY=[empty]');
    expect(tools[2]!.content).toContain('api_key: [hidden]');
    expect(tools[2]!.content).toContain('default: gpt-5');
  });

  it('answers without tools from a snapshot when the hub has no gateway', async () => {
    const turns: DirectChatMessage[][] = [];
    const models: DirectModelsPort = {
      modelFacts: () => null,
      async *directChat(_workspace, request) {
        turns.push(request.messages.map((message) => ({ ...message })));
        yield { type: 'delta', text: 'جرّب تعيد التشغيل' } satisfies DirectChatEvent;
        yield { type: 'completed' } satisfies DirectChatEvent;
      },
    };
    const { run } = runner();
    const { env: _env, ...noGateway } = TARGET;
    const session = new HermesHelperSession(
      { ...noGateway, model: 'gpt-5', modelProviderId: 'p-1' },
      { host: () => host(), models: () => models, run },
    );
    const events = drive(session);
    await session.send({ text: 'Hermes واقف' });
    expect(events.some((event) => event.type === 'question.asked')).toBe(false);
    const first = turns[0]!;
    expect(first[0]!.role).toBe('system');
    expect(first[1]!.text).toContain('## hermes doctor');
    expect(first[1]!.text).toContain('[hidden]');
    expect(first[1]!.text).not.toContain('AAAbbbCCC');
    expect(first[1]!.text.endsWith('Hermes واقف')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'run.completed', stopReason: 'end_turn' });
  });
});

describe('the helper’s pieces', () => {
  it('hides secrets and keeps the names', () => {
    expect(redactSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv\nMODEL=gpt-5')).toBe(
      'OPENAI_API_KEY=[hidden]\nMODEL=gpt-5',
    );
    expect(redactSecrets('Authorization: Bearer abcdefgh12345678')).toContain('[hidden]');
    expect(redactSecrets('{"api_key": "abcdef123456"}')).toBe('{"api_key": "[hidden]"}');
    expect(redactSecrets('bot 123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll failed')).toBe(
      'bot [hidden] failed',
    );
  });

  it('reads a level from the choice or from plain words', () => {
    const wording = {
      check: '🟢 a',
      fix: '🟡 b',
      full: '🔴 c',
    } as Parameters<typeof levelOfAnswer>[1];
    expect(levelOfAnswer('🔴 c', wording)).toBe('full');
    expect(levelOfAnswer('خله يصلح', wording)).toBe('fix');
    expect(levelOfAnswer(null, wording)).toBeNull();
    expect(levelOfAnswer('ما أدري', wording)).toBeNull();
  });

  it('puts a tool call split across frames back together', async () => {
    const body = new Response(
      sse({ text: 'hi', calls: [{ name: 'hermes_status', args: { a: 1 } }] }),
    ).body!;
    const deltas: string[] = [];
    const result = await readChatStream(body, {
      text: (d) => deltas.push(d),
      reasoning: () => undefined,
    });
    expect(deltas).toEqual(['hi']);
    expect(result.calls).toEqual([
      {
        id: 'call_0_hermes_status',
        type: 'function',
        function: { name: 'hermes_status', arguments: '{"a":1}' },
      },
    ]);
  });
});
