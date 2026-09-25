/**
 * The composer's commands against **the real Hermes** over its TUI gateway (decision §57):
 * the image's own `python -m tui_gateway.entry`, a scripted OpenAI-compatible model on this
 * machine, no key and no network beyond the loopback. Skipped unless an image is named:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server test
 *
 * It proves the wire, not the model: that every finished turn reports the window Hermes
 * counts, that `/plan` becomes Hermes's own plan prompt, that `/goal` answers with Hermes's
 * own output and no model call, that `session.compress` answers in the shape the adapter
 * reads, and that the compression keys the hub writes are ones Hermes reads back.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeHermesCompression } from '../hermes-compression.js';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';

const image = process.env.COREHUB_HERMES_IMAGE;

/** A model that answers every request with one line, and keeps what it was asked. */
function scriptedModel(prompts: string[]): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw
        ? (JSON.parse(raw) as {
            messages?: Array<{ role: string; content: unknown }>;
            stream?: boolean;
          })
        : {};
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      prompts.push(JSON.stringify(lastUser?.content ?? ''));
      const reply = 'noted';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 5, total_tokens: 905 } })}\n\n`,
        );
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
            { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 5, total_tokens: 905 },
        }),
      );
    });
  });
}

describe.skipIf(!image)(
  'commands over the real Hermes TUI gateway (set COREHUB_HERMES_IMAGE)',
  () => {
    const prompts: string[] = [];
    let model: http.Server;
    let home: string;
    let channel: TuiChannel;

    beforeAll(async () => {
      model = scriptedModel(prompts);
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      const port = (model.address() as AddressInfo).port;
      home = mkdtempSync(path.join(tmpdir(), 'corehub-tui-commands-'));
      writeFileSync(
        path.join(home, 'config.yaml'),
        [
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
        ].join('\n'),
      );
      // What the profile settings write (decision §57), in the file Hermes is about to read.
      writeHermesCompression(home, {
        enabled: true,
        threshold: 0.8,
        targetRatio: 0.25,
        protectFirst: 2,
        protectLast: 10,
        contextLength: 64_000,
      });
      chmodSync(home, 0o777);
      channel = stdioTuiChannel({
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-i',
          '--network',
          'host',
          '-v',
          `${home}:/hh`,
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
    }, 180_000);

    afterAll(async () => {
      await channel?.close();
      model?.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Hermes wrote as the image's user; the OS reclaims the temp directory
      }
    });

    async function turn(session: HermesTuiSession, text: string): Promise<AgentEvent[]> {
      const events: AgentEvent[] = [];
      const reading = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.type === 'run.completed' || event.type === 'run.failed') return;
        }
      })();
      await session.send({ text, blocks: [{ type: 'text', text }] });
      await reading;
      return events;
    }

    it('reports the window Hermes counts — the override the hub wrote — with every turn', async () => {
      const session = await HermesTuiSession.open(channel, null);
      const events = await turn(session, 'hello there');
      expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
      const context = events.find((e) => e.type === 'context');
      expect(context).toMatchObject({ type: 'context', windowTokens: 64_000 });
      expect((context as { usedTokens: number }).usedTokens).toBeGreaterThan(0);
      await session.close();
    }, 180_000);

    it('/plan becomes Hermes’s plan prompt; /goal answers without the model', async () => {
      const session = await HermesTuiSession.open(channel, null);
      const before = prompts.length;
      const planned = await turn(session, '/plan a login page');
      expect(planned.at(-1)).toMatchObject({ type: 'run.completed' });
      const sent = prompts.slice(before).join('\n');
      expect(sent).toContain('/plan');
      expect(sent).toContain('a login page');

      const asked = prompts.length;
      const goal = await turn(session, '/goal');
      expect(goal.at(-1)).toMatchObject({ type: 'run.completed' });
      expect(goal.some((e) => e.type === 'message.delta')).toBe(true);
      expect(prompts.length).toBe(asked);
      await session.close();
    }, 180_000);

    it('compresses between turns, answering in the shape the adapter reads', async () => {
      const session = await HermesTuiSession.open(channel, null);
      await turn(session, 'first message');
      await turn(session, 'second message');
      await turn(session, 'third message');
      const outcome = await session.compress(null);
      expect(['compressed', 'unchanged', 'skipped']).toContain(outcome.status);
      expect(outcome.message).toBeTruthy();
      expect(outcome.beforeMessages).toBeGreaterThanOrEqual(4);
      // Still a conversation afterwards.
      const after = await turn(session, 'and now?');
      expect(after.at(-1)).toMatchObject({ type: 'run.completed' });
      await session.close();
    }, 240_000);
  },
);
