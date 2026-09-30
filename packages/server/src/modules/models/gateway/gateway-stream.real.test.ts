/**
 * What an answer looks like after the hub's gateway and the real CLIProxyAPI (8.0.4, the pinned
 * release) have carried it: every character, in order, and the stream's end — whatever the
 * provider's bytes looked like on the way in (owner, 2026-09-30: an Arabic greeting arrived with
 * letters missing and the turn never ended; the cause was the runner, `runner-stream.test.ts`,
 * and these pin down that the wire itself was never it).
 *
 * - An OpenAI Chat provider streaming an Arabic greeting a token a chunk, its bytes cut at every
 *   size from 1 to 7 — inside the letters' two-byte sequences — and with reasoning between tokens;
 * - the owner's own chain: the provider is itself a CLIProxyAPI (his "CLI Proxy") serving a
 *   `gpt-*` model from a Codex Responses upstream that reasons first, so the answer crosses
 *   Responses → Chat → Anthropic Messages.
 *
 * Skipped unless `COREHUB_REAL_GATEWAY=1` (it needs `pnpm cliproxy:fetch`); CI's
 * `model-gateway-real` job runs it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliproxySupervisor } from './cliproxy.js';
import { GATEWAY_MAIN_MODEL, ModelGateway, type GatewayGrant } from './gateway.js';
import { devCliproxyPath } from './locate.js';

const enabled = process.env.COREHUB_REAL_GATEWAY === '1';
const binary = process.env.COREHUB_CLIPROXY_BIN
  ? path.resolve(process.env.COREHUB_CLIPROXY_BIN)
  : devCliproxyPath();
const CHAT_ROW = '01KGATEWAYSTREAMCHATROW001';
const CHAIN_ROW = '01KGATEWAYSTREAMCHAINROW01';
const CHAT_MODEL = 'fake-arabic';
const CHAIN_MODEL = 'gpt-6-sol';
const CREATED = 1_790_000_000;
const TOKENS = ['ه', 'لا', '!', ' كيف', ' أ', 'قدر', ' أ', 'ساعد', '؟'];
const GREETING = TOKENS.join('');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How the Chat provider shapes the next answer. */
let shape: { cut: number; reasoning: boolean } = { cut: 0, reasoning: false };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

function chatProvider(): Server {
  return createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model?: string };
      const event = (delta: Record<string, unknown>, finish: string | null, extra = {}) =>
        `data: ${JSON.stringify({
          id: 'chat_ar',
          object: 'chat.completion.chunk',
          created: CREATED,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`;
      let text = event({ role: 'assistant', content: '' }, null);
      for (const token of TOKENS) {
        if (shape.reasoning) text += event({ reasoning_content: 'thinking ' }, null);
        text += event({ content: token }, null);
      }
      text += event({}, 'stop');
      text += event({}, null, {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 },
      });
      text += 'data: [DONE]\n\n';
      const bytes = Buffer.from(text, 'utf8');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      void (async () => {
        const step = shape.cut || bytes.length;
        for (let at = 0; at < bytes.length; at += step) {
          response.write(bytes.subarray(at, at + step));
          await sleep(1);
        }
        response.end();
      })();
    });
  });
}

/** A Codex Responses upstream that reasons, then answers a token an event. */
function responsesUpstream(): Server {
  return createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let sequence = 0;
      const send = (type: string, data: Record<string, unknown>) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
        );
      const base = {
        id: 'resp_1',
        object: 'response',
        created_at: CREATED,
        status: 'in_progress',
        model: CHAIN_MODEL,
        output: [],
      };
      void (async () => {
        send('response.created', { response: base });
        send('response.output_item.added', {
          output_index: 0,
          item: { id: 'rs_1', type: 'reasoning', summary: [] },
        });
        for (const delta of ['**Greeting**', ' the user']) {
          send('response.reasoning_summary_text.delta', {
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 0,
            delta,
          });
          await sleep(1);
        }
        send('response.output_item.done', {
          output_index: 0,
          item: { id: 'rs_1', type: 'reasoning', summary: [] },
        });
        send('response.output_item.added', {
          output_index: 1,
          item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
        });
        for (const delta of TOKENS) {
          send('response.output_text.delta', {
            item_id: 'msg_1',
            output_index: 1,
            content_index: 0,
            delta,
          });
          await sleep(1);
        }
        send('response.output_item.done', {
          output_index: 1,
          item: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: GREETING, annotations: [] }],
          },
        });
        send('response.completed', {
          response: {
            ...base,
            status: 'completed',
            usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
          },
        });
        response.end();
      })();
    });
  });
}

/** The text an Anthropic Messages stream said, and whether it ended. */
function readAnthropic(sse: string): { said: string; stopped: boolean } {
  const events = sse
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)) as { type?: string; delta?: Record<string, unknown> });
  return {
    said: events
      .filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
      .map((e) => String(e.delta?.text ?? ''))
      .join(''),
    stopped: events.at(-1)?.type === 'message_stop',
  };
}

describe.skipIf(!enabled)('answers through the gateway, for real (COREHUB_REAL_GATEWAY=1)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-gateway-stream-'));
  const servers: Server[] = [];
  let owner: ChildProcess | null = null;
  let gateway: ModelGateway;
  let grant: GatewayGrant;
  let chatPort = 0;
  let ownerPort = 0;

  beforeAll(async () => {
    const chat = chatProvider();
    const upstream = responsesUpstream();
    servers.push(chat, upstream);
    chatPort = await listen(chat);
    const upstreamPort = await listen(upstream);
    // The owner's own CLIProxyAPI, in front of a Codex Responses upstream.
    const probe = createServer();
    ownerPort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    writeFileSync(
      path.join(dir, 'owner.yaml'),
      [
        'config-version: 8',
        'server:',
        '  host: 127.0.0.1',
        `  port: ${ownerPort}`,
        'management:',
        "  secret-key: ''",
        'access:',
        "  api-keys: ['owner-key']",
        'oauth:',
        `  auth-dir: ${path.join(dir, 'owner-auth')}`,
        'api-keys:',
        '  codex:',
        '    - name: upstream',
        `      base-url: http://127.0.0.1:${upstreamPort}/backend-api/codex`,
        '      keys:',
        '        - api-key: sk-upstream',
        '      models:',
        `        - name: ${CHAIN_MODEL}`,
        '',
      ].join('\n'),
    );
    owner = spawn(binary, ['-config', path.join(dir, 'owner.yaml')], {
      stdio: 'ignore',
      env: { PATH: process.env.PATH ?? '', HOME: dir },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const up = await fetch(`http://127.0.0.1:${ownerPort}/v1/models`, {
        headers: { authorization: 'Bearer owner-key' },
      }).catch(() => null);
      if (up?.ok) break;
      await sleep(100);
    }
    const log = pino({ level: 'silent' });
    gateway = new ModelGateway({
      cliproxy: new CliproxySupervisor({
        binary,
        stateDir: path.join(dir, 'hub'),
        log: log as never,
        env: { PATH: process.env.PATH ?? '', HOME: dir },
      }),
      source: {
        upstreams: () => [
          {
            providerId: CHAT_ROW,
            kind: 'openai-compatibility',
            baseUrl: `http://127.0.0.1:${chatPort}/v1`,
            apiKey: 'sk-chat',
            headers: {},
            models: [{ id: CHAT_MODEL, contextWindow: 100_000 }],
          },
          {
            providerId: CHAIN_ROW,
            kind: 'openai-compatibility',
            baseUrl: `http://127.0.0.1:${ownerPort}/v1`,
            apiKey: 'owner-key',
            headers: {},
            models: [{ id: CHAIN_MODEL, contextWindow: 200_000 }],
          },
        ],
        resolveKey: () => null,
        target: (_workspace, providerId, model) => ({
          providerId,
          model,
          modelLabel: model,
          price: () => ({ costSource: 'unknown' }),
        }),
        modelKeys: () => [],
        recordLate: () => {},
      },
      log: log as never,
      enabled: true,
    });
    grant = await gateway.open({
      workspace: 'w',
      agentId: 'a',
      agentSlug: 'claude-code',
      sessionId: 's',
      userId: null,
      alive: () => true,
    });
  }, 60_000);

  afterAll(async () => {
    grant?.revoke();
    await gateway?.close();
    owner?.kill();
    for (const server of servers) server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = async (providerId: string, model: string) => {
    grant.setTurn({ runId: `run-${model}`, providerId, model, report: () => {} });
    const answer = await fetch(`${grant.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({
        model: GATEWAY_MAIN_MODEL,
        max_tokens: 1000,
        stream: true,
        messages: [{ role: 'user', content: 'هلا' }],
      }),
    });
    expect(answer.status).toBe(200);
    return readAnthropic(await answer.text());
  };

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    'an Arabic answer cut every %i bytes arrives whole, and ends',
    async (cut) => {
      shape = { cut, reasoning: false };
      expect(await ask(CHAT_ROW, CHAT_MODEL)).toEqual({ said: GREETING, stopped: true });
    },
  );

  it('with reasoning between the tokens, the text is whole and ends', async () => {
    shape = { cut: 3, reasoning: true };
    expect(await ask(CHAT_ROW, CHAT_MODEL)).toEqual({ said: GREETING, stopped: true });
  });

  it('through the owner’s chain (Responses → his CLIProxyAPI → Chat → ours → Messages)', async () => {
    expect(await ask(CHAIN_ROW, CHAIN_MODEL)).toEqual({ said: GREETING, stopped: true });
  });
});
