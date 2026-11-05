/**
 * A conversation **beside a running gateway** on the real Hermes — the way the hub always runs it.
 *
 * Every other real test starts `python -m tui_gateway.entry` on a home no gateway serves, which is
 * why none of them saw Hermes v0.22.5 refuse it next to one ("is owned by a running gateway;
 * attach to it instead"): every Hermes conversation of the 1.1.9 image failed on its first
 * message. Here the image's own `hermes gateway run` serves the home first; then the stdio entry
 * is shown refused (on a Hermes that refuses), and the hub's channel attaches to the gateway
 * (`hermes-gateway-channel.ts`, `hermes-gateway-bootstrap.ts`) and carries a turn, an approval
 * and a question through it. An OpenAI-compatible model on this machine answers; no key, no
 * network beyond the loopback. Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server test
 */
import { execFile, execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_BOOTSTRAP_SCRIPT } from '../hermes-gateway-bootstrap.js';
import { gatewayTuiChannel, type GatewayBootstrap } from './hermes-gateway-channel.js';
import { HermesTuiSession, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';

const image = process.env.COREHUB_HERMES_IMAGE;

type Body = { messages?: Array<{ role: string; content: unknown }>; stream?: boolean };

/** The model: a word, a `terminal` call that needs approval, or a `clarify` question. */
function scriptedModel(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1', object: 'model' }] }));
        return;
      }
      const body = (raw ? JSON.parse(raw) : {}) as Body;
      const last = body.messages?.at(-1);
      const said = JSON.stringify(last?.content ?? '');
      let message: Record<string, unknown> = { role: 'assistant', content: 'hello' };
      if (last?.role === 'tool') message = { role: 'assistant', content: 'done' };
      else if (said.includes('please run it')) {
        message = toolCall('terminal', { command: 'rm -rf /tmp/corehub-attach-test' });
      } else if (said.includes('please ask')) {
        message = toolCall('clarify', {
          questions: [{ question: 'Which colour?', choices: ['red', 'blue'] }],
        });
      }
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      if (body.stream) {
        const chunk = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = message.tool_calls
          ? {
              role: 'assistant',
              tool_calls: (message.tool_calls as Array<Record<string, unknown>>).map((c, i) => ({
                index: i,
                ...c,
              })),
            }
          : message;
        res.write(chunk(delta, null));
        res.write(chunk({}, finish));
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
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      );
    });
  });
}

function toolCall(name: string, args: unknown): Record<string, unknown> {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!image)(
  'a conversation beside the running gateway on the real Hermes (set COREHUB_HERMES_IMAGE)',
  () => {
    let model: http.Server;
    let container: string;
    let channel: TuiChannel;
    /** What the first bootstrap said: `unsupported` on a Hermes that predates the refusal. */
    let first: GatewayBootstrap['kind'] = 'unavailable';

    /** Runs Python in the gateway's container, as the gateway's own user. */
    const python = (args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> =>
      new Promise((resolve) => {
        execFile(
          'docker',
          ['exec', '-e', 'HERMES_HOME=/tmp/hh', container, '/opt/hermes/.venv/bin/python', ...args],
          { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) =>
            resolve({
              code: error ? Number((error as { code?: number }).code ?? 1) : 0,
              out: `${stdout}${stderr}`,
            }),
        );
      });

    beforeAll(async () => {
      model = scriptedModel();
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      const port = (model.address() as AddressInfo).port;
      // The home lives in the container, owned by its user and private as the hub's is: Hermes
      // refuses a control socket in a folder anybody else could write (`unsafe_control_path`).
      const config = [
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
      container = execFileSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
          '--network',
          'host',
          '-e',
          'HERMES_HOME=/tmp/hh',
          '-e',
          'COREHUB_FAKE_KEY=fake-key-000000000000',
          '-e',
          `COREHUB_CONFIG=${config}`,
          '--entrypoint',
          'sh',
          image!,
          '-c',
          'mkdir -p /tmp/hh && chmod 700 /tmp/hh && printf "%s" "$COREHUB_CONFIG" > /tmp/hh/config.yaml && exec /opt/hermes/.venv/bin/hermes gateway run',
        ],
        { encoding: 'utf8' },
      ).trim();
      const bootstrap = async (): Promise<GatewayBootstrap> => {
        const { out } = await python(['-c', GATEWAY_BOOTSTRAP_SCRIPT]);
        const line = out.trim().split('\n').pop() ?? '';
        try {
          return JSON.parse(line) as GatewayBootstrap;
        } catch {
          return { kind: 'unavailable', reason: line };
        }
      };
      // The gateway is attachable once it says so; up to two minutes on a cold runner.
      let found: GatewayBootstrap = { kind: 'unavailable', reason: 'not asked' };
      for (let i = 0; i < 60 && found.kind === 'unavailable'; i += 1) {
        found = await bootstrap();
        if (found.kind === 'unavailable') await sleep(2000);
      }
      expect(found.kind, JSON.stringify(found)).not.toBe('unavailable');
      first = found.kind;
      channel = gatewayTuiChannel({
        bootstrap,
        // A Hermes that predates the refusal: nothing here to fall back to.
        fallback: () => {
          throw new Error('this Hermes still has its stdio entry; the stdio real tests cover it');
        },
        readyTimeoutMs: 120_000,
      });
    }, 240_000);

    afterAll(async () => {
      await channel?.close();
      if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
      model?.close();
    });

    it('is refused by the stdio entry, and answered through the gateway', async () => {
      const stdio = await python(['-m', 'tui_gateway.entry'], 60_000);
      // The refusal is Hermes v0.22.2 and later, and the bootstrap reads it from the same source:
      // an older Hermes is spoken to over stdio and has nothing to attach to.
      expect(stdio.out.includes('is owned by a running gateway')).toBe(first === 'attach');
      if (first !== 'attach') return;

      const session = await HermesTuiSession.open(channel, null, {
        model: 'fake-1',
        provider: 'corehub-fake',
      });
      const events: AgentEvent[] = [];
      const reading = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.type === 'approval.requested') void session.respond(event.id, 'once');
          if (event.type === 'question.asked') void session.answer(event.id, 'blue');
        }
      })();

      expect(await session.send({ text: 'hi' })).toEqual({ stopReason: 'completed' });
      expect(
        events
          .filter((e) => e.type === 'message.delta')
          .map((e) => e.text)
          .join(''),
      ).toContain('hello');

      // An approval travels as an event and is answered fenced to the turn.
      expect(await session.send({ text: 'please run it' })).toEqual({ stopReason: 'completed' });
      expect(events.some((e) => e.type === 'approval.requested')).toBe(true);
      expect(events.some((e) => e.type === 'tool.completed')).toBe(true);

      // A question too, and the answer reaches the model.
      expect(await session.send({ text: 'please ask' })).toEqual({ stopReason: 'completed' });
      const asked = events.find((e) => e.type === 'question.asked');
      expect(asked && asked.type === 'question.asked' && asked.question).toBe('Which colour?');

      const stored = session.id;
      await session.close();
      await reading;

      // The same conversation continues from its stored id.
      const again = await HermesTuiSession.open(channel, stored, {
        model: 'fake-1',
        provider: 'corehub-fake',
      });
      expect(again.id).toBe(stored);
      expect(await again.send({ text: 'hi again' })).toEqual({ stopReason: 'completed' });
      await again.close();
    }, 300_000);
  },
);
