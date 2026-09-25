/**
 * Subagents with **the real Hermes** (contract decision §47): a turn whose model calls Hermes's
 * own `delegate_task`, so Hermes starts a real child agent. The hub hears the delegation on its
 * own channel — `subagent.start` then `subagent.complete`, with the goal the model gave — and
 * not in the turn. The image's own `python -m tui_gateway.entry` against a scripted
 * OpenAI-compatible model on this machine; no key, no network beyond the loopback. Name the
 * image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server test
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { SubagentSignal } from './subagents.js';
import type { AgentEvent } from './types.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const GOAL = 'CHILD-GOAL: say the word ready';

/**
 * The model. The parent's first request delegates (`delegate_task` with one goal); the child —
 * whose conversation carries the goal — answers at once; the parent, given the child's result,
 * finishes. Anything else (a title) gets a short answer.
 */
function scriptedModel(seen: string[]): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw
        ? (JSON.parse(raw) as {
            messages?: Array<{ role: string; content: unknown }>;
            stream?: boolean;
            tools?: Array<{ function?: { name?: string } }>;
          })
        : {};
      const text = JSON.stringify(body.messages ?? []);
      const hasTool = (body.messages ?? []).some((m) => m.role === 'tool');
      const offersDelegate = (body.tools ?? []).some((t) => t.function?.name === 'delegate_task');
      const isChild = text.includes('CHILD-GOAL') && !offersDelegate;
      let message: Record<string, unknown>;
      let finish = 'stop';
      if (isChild) {
        seen.push('child');
        message = { role: 'assistant', content: 'ready' };
      } else if (offersDelegate && !hasTool && text.includes('please delegate')) {
        seen.push('delegate');
        finish = 'tool_calls';
        message = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_d1',
              type: 'function',
              function: { name: 'delegate_task', arguments: JSON.stringify({ goal: GOAL }) },
            },
          ],
        };
      } else {
        seen.push(hasTool ? 'parent-done' : 'other');
        message = { role: 'assistant', content: hasTool ? 'the child said ready' : 'ok' };
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta =
          finish === 'tool_calls'
            ? {
                role: 'assistant',
                tool_calls: [{ index: 0, ...(message.tool_calls as unknown[])[0]! }],
              }
            : { role: 'assistant', content: message.content };
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
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
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
}

describe.skipIf(!image)('Hermes subagents (real Hermes; set COREHUB_HERMES_IMAGE to run)', () => {
  let model: http.Server;
  let home: string;
  let channel: TuiChannel;
  const seen: string[] = [];

  beforeAll(async () => {
    model = scriptedModel(seen);
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as AddressInfo).port;
    home = mkdtempSync(path.join(tmpdir(), 'corehub-subagents-'));
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

  it("hears Hermes's delegation start and end on the conversation's own channel", async () => {
    const session = await HermesTuiSession.open(channel, null);
    const signals: SubagentSignal[] = [];
    session.subagents.watch((signal) => signals.push(signal));
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'run.completed' || event.type === 'run.failed') return;
      }
    })();
    await session.send({ text: 'please delegate this' });
    await reading;
    // Hermes reports the end of a child as it is torn down, which can be just after the turn.
    for (let i = 0; i < 50 && !signals.some((s) => s.phase === 'completed'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Evidence for the change record, whatever the outcome.
    console.log('model calls:', seen.join(' '));
    console.log('turn:', events.map((e) => e.type).join(' '));
    console.log('subagent signals:', JSON.stringify(signals));

    expect(events.find((e) => e.type === 'tool.started')).toMatchObject({ name: 'delegate_task' });
    const started = signals.find((s) => s.phase === 'started');
    const completed = signals.find((s) => s.phase === 'completed');
    expect(started).toMatchObject({ goal: GOAL, depth: 0 });
    expect(started?.id).toMatch(/^sa-0-/);
    expect(completed).toMatchObject({ id: started?.id, status: 'completed' });
    // Not in the turn: a delegation is the conversation's.
    expect(events.some((e) => (e.type as string).startsWith('subagent'))).toBe(false);
    await session.close();
  }, 240_000);
});
