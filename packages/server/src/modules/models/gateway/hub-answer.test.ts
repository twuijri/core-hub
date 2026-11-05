// The Chat Completions answer the gateway writes for a model the hub answers itself (Gemini
// Desktop, its tools in text): the stream an agent reads, the one-piece answer, and an error.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTurnEvent } from '../gemini-desktop/agent-turn.js';
import { writeHubAnswer } from './hub-answer.js';

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(events: AgentTurnEvent[], stream: boolean): Promise<Response> {
  server = createServer((_request, response) => {
    void writeHubAnswer(
      response,
      (async function* () {
        yield* events;
      })(),
      { model: 'corehub-main', stream },
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
}

const CALL = { id: 'call_1', name: 'terminal', arguments: '{"command":"ls"}' };

describe('an answer the hub writes', () => {
  it('streams the words, then the calls, then their end', async () => {
    const response = await serve(
      [
        { type: 'delta', text: 'Looking.' },
        { type: 'calls', calls: [CALL] },
        { type: 'done', finish: 'tool_calls' },
      ],
      true,
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const lines = (await response.text())
      .split('\n\n')
      .filter(Boolean)
      .map((line) => line.replace(/^data: /, ''));
    expect(lines.at(-1)).toBe('[DONE]');
    const chunks = lines.slice(0, -1).map((line) => JSON.parse(line));
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks[1].choices[0].delta).toEqual({ content: 'Looking.' });
    expect(chunks[2].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'terminal', arguments: '{"command":"ls"}' },
      },
    ]);
    expect(chunks[3].choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.every((chunk) => chunk.model === 'corehub-main')).toBe(true);
  });

  it('answers in one piece when no stream was asked for', async () => {
    const response = await serve(
      [
        { type: 'delta', text: 'Hi' },
        { type: 'calls', calls: [CALL] },
        { type: 'done', finish: 'tool_calls' },
      ],
      false,
    );
    const body = (await response.json()) as {
      choices: { message: { content: string; tool_calls: unknown[] }; finish_reason: string }[];
    };
    expect(body.choices[0]!.message.content).toBe('Hi');
    expect(body.choices[0]!.message.tool_calls).toHaveLength(1);
    expect(body.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('answers a failure before any word with its status', async () => {
    const response = await serve(
      [{ type: 'failed', status: 429, message: 'Gemini says slow down' }],
      true,
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        message: 'Gemini says slow down',
        type: 'rate_limit_error',
        code: 'rate_limit_error',
      },
    });
  });
});
