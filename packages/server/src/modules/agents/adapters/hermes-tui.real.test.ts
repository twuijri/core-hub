/**
 * A conversation with **the real Hermes** over its TUI gateway, clarify question included.
 *
 * It runs the image's own `python -m tui_gateway.entry` (so the Hermes is exactly the one a
 * release ships) against a scripted OpenAI-compatible model on this machine: the model's
 * first answer calls Hermes's `clarify` tool, its second repeats what it was told. No key,
 * no network beyond the loopback. Name the image to run it; without one it is skipped:
 *
 *   docker pull ghcr.io/twuijri/core-hub:latest
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server test
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';

const image = process.env.COREHUB_HERMES_IMAGE;

/** The model: turn one asks, turn two answers with what the tool returned. */
function scriptedModel(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw
        ? (JSON.parse(raw) as {
            messages?: Array<{ role: string; content: unknown }>;
            stream?: boolean;
            tools?: unknown;
          })
        : {};
      const tool = [...(body.messages ?? [])].reverse().find((m) => m.role === 'tool');
      const ask = !tool && JSON.stringify(body.tools ?? []).includes('clarify');
      // "batch" in the prompt: the shape Hermes's clarify tool advertises to a model
      // (`questions`), two of them; otherwise the single shape it also accepts.
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const batch = JSON.stringify(lastUser?.content ?? '').includes('batch');
      const result = tool
        ? (JSON.parse(String(tool.content)) as {
            user_response?: string;
            responses?: Array<{ user_response: string }>;
          })
        : null;
      const reply = result
        ? `answer=${result.user_response ?? (result.responses ?? []).map((r) => r.user_response).join('|')}`
        : 'hello';
      const message = ask
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'clarify',
                  arguments: JSON.stringify(
                    batch
                      ? {
                          questions: [
                            { question: 'Which device?', choices: ['Mac', 'Windows', 'Linux'] },
                            { question: 'Which shell?', choices: ['zsh', 'bash'] },
                          ],
                        }
                      : { question: 'Which device?', choices: ['Mac', 'Windows', 'Linux'] },
                  ),
                },
              },
            ],
          }
        : { role: 'assistant', content: reply };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = ask
          ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls![0] }] }
          : { role: 'assistant', content: reply };
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: ask ? 'tool_calls' : 'stop' }] })}\n\n`,
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
          choices: [{ index: 0, message, finish_reason: ask ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
}

describe.skipIf(!image)('Hermes TUI gateway (real Hermes; set COREHUB_HERMES_IMAGE to run)', () => {
  let model: http.Server;
  let home: string;
  let channel: TuiChannel;

  beforeAll(async () => {
    model = scriptedModel();
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as AddressInfo).port;
    home = mkdtempSync(path.join(tmpdir(), 'corehub-tui-'));
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
        'agent:',
        '  clarify_timeout: 300',
        '',
      ].join('\n'),
    );
    // The container's user is not ours; the throwaway home must be writable by it.
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
    // Hermes, running as the image's user, wrote files the test's user may not remove.
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // a temp directory; the OS reclaims it
    }
  });

  async function turn(
    session: HermesTuiSession,
    prompt: string,
    onQuestion: (event: Extract<AgentEvent, { type: 'question.asked' }>) => Promise<void>,
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'question.asked') await onQuestion(event);
        if (event.type === 'run.completed' || event.type === 'run.failed') return;
      }
    })();
    await session.send({ text: prompt });
    await reading;
    return events;
  }

  it('asks the question Hermes asks, and gives Hermes the answer chosen', async () => {
    const session = await HermesTuiSession.open(channel, null);
    expect(session.id).toBeTruthy();
    const events = await turn(session, 'ask me', async (question) => {
      expect(question.question).toBe('Which device?');
      expect(question.choices).toEqual(['Mac (Recommended)', 'Windows', 'Linux']);
      await session.answer(question.id, 'Mac (Recommended)');
    });
    const tool = events.find((e) => e.type === 'tool.started');
    expect(tool).toMatchObject({ name: 'clarify', input: { question: 'Which device?' } });
    const done = events.find((e) => e.type === 'tool.completed');
    // The mark Hermes added to its suggestion is gone from the answer it receives.
    expect(done && 'output' in done ? done.output : '').toContain('"user_response":"Mac"');
    const said = events
      .filter(
        (e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta',
      )
      .map((e) => e.text)
      .join('');
    expect(said).toContain('answer=Mac');
    expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
    await session.close();
  }, 180_000);

  it('asks a batch — the shape Hermes offers the model — and gives Hermes every answer', async () => {
    const session = await HermesTuiSession.open(channel, null);
    const questions: string[] = [];
    const events = await turn(session, 'ask me a batch', async (question) => {
      questions.push(question.question);
      await session.answer(question.id, questions.length === 1 ? 'Linux' : 'zsh');
    });
    expect(questions).toEqual(['Which device?', 'Which shell?']);
    const said = events
      .filter(
        (e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta',
      )
      .map((e) => e.text)
      .join('');
    expect(said).toContain('answer=Linux|zsh');
    await session.close();
  }, 180_000);

  it('skips a question when the person skips it', async () => {
    const session = await HermesTuiSession.open(channel, null);
    const events = await turn(session, 'ask me again', async (question) => {
      await session.answer(question.id, null);
    });
    const said = events
      .filter(
        (e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta',
      )
      .map((e) => e.text)
      .join('');
    expect(said).toContain('answer=');
    expect(said).not.toContain('answer=Mac');
    await session.close();
  }, 180_000);

  it('takes a turn on the model the turn names, on this session only', async () => {
    const session = await HermesTuiSession.open(channel, null);
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'question.asked') await session.answer(event.id, 'Windows');
        if (event.type === 'run.completed' || event.type === 'run.failed') return;
      }
    })();
    await session.send({ text: 'ask me', model: 'fake-2', modelProvider: 'corehub-fake' });
    await reading;
    expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ modelLabel: 'fake-2' });
    await session.close();
  }, 180_000);

  it('continues the same conversation by its stored id', async () => {
    const first = await HermesTuiSession.open(channel, null);
    await turn(first, 'remember me', async (q) => first.answer(q.id, 'Linux'));
    const stored = first.id;
    await first.close();
    const again = await HermesTuiSession.open(channel, stored);
    expect(again.id).toBe(stored);
    await again.close();
  }, 180_000);
});
