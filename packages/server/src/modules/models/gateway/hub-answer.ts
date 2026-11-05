/**
 * A Chat Completions answer the hub writes itself, for a model CLIProxyAPI does not serve
 * (Gemini Desktop with its tools in text, `gemini-desktop/agent-turn.ts`): streamed as
 * `chat.completion.chunk` events when the agent asked for a stream, else one `chat.completion`.
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { AgentTurnEvent } from '../gemini-desktop/agent-turn.js';

function errorBody(status: number, message: string): string {
  const type =
    status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error';
  return JSON.stringify({ error: { message, type, code: type } });
}

export async function writeHubAnswer(
  response: ServerResponse,
  events: AsyncIterable<AgentTurnEvent>,
  options: { model: string; stream: boolean },
): Promise<void> {
  const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: options.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(chunk({ role: 'assistant', content: '' }, null));
  };
  let text = '';
  const calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] =
    [];
  for await (const event of events) {
    if (response.destroyed) return;
    if (event.type === 'failed') {
      if (options.stream && started) {
        response.write(`data: ${errorBody(event.status, event.message)}\n\n`);
        response.end();
      } else {
        response.writeHead(event.status, { 'content-type': 'application/json' });
        response.end(errorBody(event.status, event.message));
      }
      return;
    }
    if (event.type === 'delta') {
      text += event.text;
      if (options.stream) {
        start();
        response.write(chunk({ content: event.text }, null));
      }
    } else if (event.type === 'calls') {
      for (const call of event.calls) {
        calls.push({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        });
      }
      if (options.stream) {
        start();
        response.write(
          chunk({ tool_calls: calls.map((call, index) => ({ index, ...call })) }, null),
        );
      }
    } else if (options.stream) {
      start();
      response.write(chunk({}, event.finish));
      response.end('data: [DONE]\n\n');
      return;
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model: options.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: text || null,
                ...(calls.length > 0 ? { tool_calls: calls } : {}),
              },
              finish_reason: event.finish,
            },
          ],
        }),
      );
      return;
    }
  }
  // The turn ended without a word of its end: close what was opened.
  if (!response.headersSent) {
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(errorBody(502, 'Gemini Desktop ended the answer early'));
  } else if (!response.writableEnded) {
    response.end('data: [DONE]\n\n');
  }
}
