/**
 * The Memory page against **the real Hermes** from the image: what a person writes through the
 * hub's memory routes reaches the agent's next conversation in that profile and no other, and
 * what the agent itself keeps with Hermes's `memory` tool shows through the same routes.
 *
 * The hub's Hermes home (`<DATA_DIR>/hermes`) is mounted as the container's `HERMES_HOME`, so
 * the hub and Hermes share files exactly as in the image. One `python -m tui_gateway.entry`
 * serves the default profile and a profile `b` that Hermes itself created. A scripted
 * OpenAI-compatible model on this machine reports which facts reached it, and — asked to
 * remember something — calls Hermes's `memory` tool the way a model does. No key, no network
 * beyond the loopback. Name the image to run it; without one it is skipped:
 *
 *   docker build -f packages/server/Dockerfile -t core-hub:local .
 *   COREHUB_HERMES_IMAGE=corehub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/memory.real.test.ts
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './adapters/hermes-tui.js';
import type { AgentEvent } from './adapters/types.js';
import { createHermesProfiles, type ProfileRunner } from './hermes-profiles.js';

const image = process.env.COREHUB_HERMES_IMAGE;

const FACTS = {
  /** Written by a person on the Memory page, in profile b. */
  pageB: 'lantern-page-4417',
  /** Written by a person on the Memory page (the "about you" list), in profile b. */
  pageUserB: 'saffron-user-2290',
  /** Kept by the agent itself, with Hermes's memory tool, in a conversation in b. */
  keptB: 'granite-kept-8831',
  /** Written at the profile root by an earlier hub, in the default profile. */
  legacyDefault: 'willow-legacy-6604',
} as const;

const REMEMBER = 'REMEMBER:';

interface ChatBody {
  stream?: boolean;
  messages?: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
}

/**
 * The model. Asked to remember something (and offered Hermes's `memory` tool), it calls the
 * tool; once the tool has answered, it says so. Otherwise it answers with the facts Hermes
 * put in front of it, and nothing else.
 */
function scriptedModel(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as ChatBody;
      const last = body.messages?.at(-1);
      const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      const offersMemory = body.tools?.some((tool) => tool.function?.name === 'memory');
      let message: Record<string, unknown>;
      let call: Record<string, unknown> | null = null;
      if (last?.role === 'user' && offersMemory && text.includes(REMEMBER)) {
        const fact = text.slice(text.indexOf(REMEMBER) + REMEMBER.length).trim();
        call = {
          id: 'call_memory_1',
          type: 'function',
          function: {
            name: 'memory',
            arguments: JSON.stringify({ action: 'add', target: 'memory', content: fact }),
          },
        };
        message = { role: 'assistant', content: null };
      } else if (last?.role === 'tool') {
        message = { role: 'assistant', content: 'kept' };
      } else {
        const seen = Object.values(FACTS).filter((fact) => raw.includes(fact));
        message = { role: 'assistant', content: `saw=${seen.length ? seen.join(',') : 'none'}` };
      }
      const finish = call ? 'tool_calls' : 'stop';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const first = call ? { ...message, tool_calls: [{ index: 0, ...call }] } : message;
        for (const [delta, reason] of [
          [first, null],
          [{}, finish],
        ] as const) {
          res.write(
            `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
          );
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'fake-1',
          choices: [
            {
              index: 0,
              message: call ? { ...message, tool_calls: [call] } : message,
              finish_reason: finish,
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
}

/** What the hub's provider propagation writes into every profile: the route, never the key. */
function configFor(port: number): string {
  return [
    'providers:',
    '  corehub-fake:',
    '    name: corehub-fake',
    `    base_url: http://127.0.0.1:${port}/v1`,
    '    key_env: COREHUB_FAKE_KEY',
    '    api_mode: chat_completions',
    'model:',
    '  default: fake-1',
    '  provider: corehub-fake',
    '',
  ].join('\n');
}

describe.skipIf(!image)('the Memory page and the real Hermes (set COREHUB_HERMES_IMAGE)', () => {
  let model: http.Server;
  let hub: TestHub & { token: string };
  let agent: string;
  let root: string;
  let channel: TuiChannel;
  const { uid, gid } = userInfo();
  /** As this user, so the files Hermes writes are the hub's too — as in the image. */
  const asMe = ['--user', `${uid}:${gid}`, '-e', 'HOME=/tmp'];

  const hermes: ProfileRunner = (argv) =>
    new Promise((resolve) => {
      execFile(
        'docker',
        [
          'run',
          '--rm',
          ...asMe,
          '-v',
          `${root}:/hh`,
          '-e',
          'HERMES_HOME=/hh',
          '--entrypoint',
          '/opt/hermes/.venv/bin/hermes',
          image!,
          ...argv,
        ],
        { timeout: 120_000 },
        (error, stdout, stderr) =>
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });

  /** The hub's own memory routes, in the profile named. */
  async function memoryOf(profile: string): Promise<Record<string, string>> {
    const res = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/memory`,
      profile,
    });
    expect(res.statusCode, res.body).toBe(200);
    return Object.fromEntries(
      (res.json() as { items: Array<{ id: string; content: string | null }> }).items.map((i) => [
        i.id,
        i.content ?? '',
      ]),
    );
  }

  async function write(profile: string, id: string, content: string): Promise<void> {
    const res = await authed(hub, hub.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/memory/${id}`,
      payload: { content },
      profile,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function say(profile: string, text: string): Promise<string> {
    const session = await HermesTuiSession.open(channel, null, { profile });
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'run.completed' || event.type === 'run.failed') return;
      }
    })();
    await session.send({ text });
    await reading;
    await session.close();
    expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: 'run.completed' });
    return events
      .filter(
        (e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta',
      )
      .map((e) => e.text)
      .join('');
  }

  beforeAll(async () => {
    model = scriptedModel();
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as AddressInfo).port;

    // A gateway health probe that answers, so the hub's runtime is `external` with a home.
    const healthy: typeof fetch = async () =>
      new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    hub = await signedInHub({}, { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } });
    const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
    agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
      (row) => row.kind === 'hermes',
    )!.id;
    root = path.join(hub.dataDir, 'hermes');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'config.yaml'), configFor(port));
    writeFileSync(path.join(root, 'SOUL.md'), 'You are the default agent.\n');

    // Profile b, made by Hermes the way the hub makes one, with the provider route; and the
    // hub's workspace of the same slug, so the routes can name it.
    await createHermesProfiles({ home: root, run: hermes }).create('b', { kind: 'blank' });
    writeFileSync(path.join(root, 'profiles', 'b', 'config.yaml'), configFor(port));
    const made = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'b', name: 'B' },
    });
    expect(made.statusCode, made.body).toBe(201);

    channel = stdioTuiChannel({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        ...asMe,
        '-v',
        `${root}:/hh`,
        '-e',
        'HERMES_HOME=/hh',
        '-e',
        'COREHUB_FAKE_KEY=fake-key-000000000000',
        '--entrypoint',
        '/opt/hermes/.venv/bin/python',
        image!,
        '-m',
        'tui_gateway.entry',
      ],
      env: process.env,
      readyTimeoutMs: 120_000,
    });
  }, 400_000);

  afterAll(async () => {
    await channel?.close();
    model?.close();
    await hub?.close();
  });

  it('what a person writes on the page in b reaches the next conversation in b, and not default', async () => {
    await write('b', 'memory', `The release word is ${FACTS.pageB}.`);
    await write('b', 'user', `The person's code name is ${FACTS.pageUserB}.`);

    const inB = await say('b', 'what do you know?');
    expect(inB).toContain(FACTS.pageB);
    expect(inB).toContain(FACTS.pageUserB);

    const inDefault = await say('default', 'what do you know?');
    expect(inDefault).not.toContain(FACTS.pageB);
    expect(inDefault).not.toContain(FACTS.pageUserB);
  }, 300_000);

  it('what the agent keeps with its own memory tool in b shows on the page in b, and not default', async () => {
    expect(await say('b', `${REMEMBER} The backup host is ${FACTS.keptB}.`)).toContain('kept');

    const b = await memoryOf('b');
    expect(b.memory).toContain(FACTS.keptB);
    // Hermes added to the list the page wrote — the page's entry round-tripped, not refused.
    expect(b.memory).toContain(FACTS.pageB);
    expect(b.memory).toBe(
      `The release word is ${FACTS.pageB}.\n§\nThe backup host is ${FACTS.keptB}.`,
    );
    expect((await memoryOf('default')).memory).not.toContain(FACTS.keptB);

    // And the next conversation in b has it.
    expect(await say('b', 'and now?')).toContain(FACTS.keptB);
  }, 300_000);

  it('what an earlier hub wrote at the profile root is moved to where Hermes reads it', async () => {
    writeFileSync(path.join(root, 'MEMORY.md'), `Old page: ${FACTS.legacyDefault}\n`);
    expect(await say('default', 'what do you know?')).not.toContain(FACTS.legacyDefault);

    expect((await memoryOf('default')).memory).toBe(`Old page: ${FACTS.legacyDefault}`);
    expect(await say('default', 'and now?')).toContain(FACTS.legacyDefault);
  }, 300_000);
});
