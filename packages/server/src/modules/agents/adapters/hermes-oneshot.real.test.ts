/**
 * Naming a conversation against **the real Hermes** (decision §26): the question reaches the
 * model with no tools and leaves no session in Hermes's history.
 *
 * It runs the image's own `python -m tui_gateway.entry` against an OpenAI-compatible model on
 * this machine that records every request it is sent. A turn of a conversation is sent too,
 * as the contrast: that one carries the profile's tools and is stored, the one-shot is
 * neither. No key, no network beyond the loopback. Name the image to run it; without one it
 * is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server test
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHermesAdapter } from './hermes.js';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent, AgentTarget } from './types.js';

const image = process.env.COREHUB_HERMES_IMAGE;

interface Recorded {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  tool_choice?: unknown;
}

/** The model: answers everything in words, and keeps what it was sent. */
function recordingModel(requests: Recorded[]): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Recorded & { stream?: boolean };
      requests.push(body);
      const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const reply = /Name this conversation/.test(JSON.stringify(last?.content ?? ''))
        ? 'Streaming explained'
        : 'hello';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
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
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      );
    });
  });
}

describe.skipIf(!image)(
  'naming a conversation on the real Hermes (set COREHUB_HERMES_IMAGE)',
  () => {
    const requests: Recorded[] = [];
    let model: http.Server;
    let home: string;
    let channel: TuiChannel;

    beforeAll(async () => {
      model = recordingModel(requests);
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      const port = (model.address() as AddressInfo).port;
      home = mkdtempSync(path.join(tmpdir(), 'corehub-oneshot-'));
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
        // a temp directory; the OS reclaims it
      }
    });

    const stored = async (): Promise<string[]> => {
      const result = await channel.request('session.list', { include_hidden: true });
      const rows = Array.isArray(result.sessions)
        ? (result.sessions as Array<{ id?: string }>)
        : [];
      return rows.map((row) => String(row.id));
    };

    it('asks the model with no tools, and stores no session', async () => {
      const adapter = createHermesAdapter({ host: { env: {} } as never, tui: () => channel });
      const target = {
        slug: 'hermes',
        name: 'Hermes',
        command: ['hermes'],
        executablePath: null,
        endpoint: null,
        profile: null,
        model: 'fake-1',
        modelProvider: 'corehub-fake',
      } as AgentTarget;
      const before = await stored();
      const answer = await adapter.oneshot!(target, {
        prompt: 'Name this conversation.\n\nUser: how does streaming work?\nAssistant: in chunks.',
        maxTokens: 512,
        timeoutMs: 90_000,
      });
      expect(answer).toBe('Streaming explained');

      const asked = requests.filter((r) =>
        /Name this conversation/.test(JSON.stringify(r.messages)),
      );
      expect(asked).toHaveLength(1);
      expect(asked[0]!.tools ?? []).toEqual([]);
      // Nothing of a conversation came with it: the question alone.
      expect(asked[0]!.messages.filter((m) => m.role !== 'system')).toHaveLength(1);
      expect(await stored()).toEqual(before);
    }, 180_000);

    it('the contrast: a turn of a conversation carries the tools and is stored', async () => {
      const session = await HermesTuiSession.open(channel, null, {
        model: 'fake-1',
        provider: 'corehub-fake',
      });
      const events: AgentEvent[] = [];
      const reading = (async () => {
        for await (const event of session.stream()) {
          events.push(event);
          if (event.type === 'run.completed' || event.type === 'run.failed') return;
        }
      })();
      const seen = requests.length;
      await session.send({ text: 'hi there' });
      await reading;
      expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
      // The turn's own requests (Hermes also names its session with a tool-free call of its own,
      // `agent/title_generator.py`, which is not what is measured here).
      const turn = requests
        .slice(seen)
        .filter((r) => /You are Hermes/.test(JSON.stringify(r.messages?.[0]?.content ?? '')));
      expect(turn.length).toBeGreaterThan(0);
      expect(Math.max(...turn.map((r) => (r.tools ?? []).length))).toBeGreaterThan(0);
      expect(await stored()).toContain(session.id);

      // And the open conversation lends its model to a one-shot without a turn of its own.
      const count = requests.length;
      await expect(
        session.oneshot({ prompt: 'Name this conversation.', maxTokens: 512, timeoutMs: 60_000 }),
      ).resolves.toBe('Streaming explained');
      const lent = requests
        .slice(count)
        .filter((r) => /Name this conversation/.test(JSON.stringify(r.messages)));
      expect(lent).toHaveLength(1);
      expect(lent[0]!.tools ?? []).toEqual([]);
      // Lent, not continued: the conversation Hermes stored still holds only the person's turn.
      expect(lent[0]!.messages.filter((m) => m.role !== 'system')).toHaveLength(1);
      await session.close();
    }, 180_000);
  },
);
