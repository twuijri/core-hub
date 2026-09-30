#!/usr/bin/env node
// A stand-in for CLIProxyAPI in the gateway's unit tests (`gateway.test.ts`): it reads the file
// the hub wrote, listens where it says, accepts only its client key, serves only the models it
// lists, and answers each wire with a short stream carrying usage. It echoes what it was sent in
// `x-fake-*` headers so a test can see the model and credential the gateway forwarded.
//
//   FAKE_CLIPROXY_EXIT_AFTER_MS  exit (code 3) this long after starting — a crash
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parse } from 'yaml';

const configPath = process.argv[process.argv.indexOf('-config') + 1];
const config = parse(readFileSync(configPath, 'utf8'));
const key = config.access['api-keys'][0];
const served = new Set();
for (const groups of Object.values(config['api-keys'] ?? {})) {
  for (const group of groups) {
    for (const model of group.models) served.add(`${group.prefix}/${model.alias}`);
  }
}

const sse = (response, events) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'x-fake-served': 'yes' });
  for (const [name, data] of events) {
    response.write(
      `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    );
  }
  response.end();
};

createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":"Missing API key"}');
      return;
    }
    const url = new URL(request.url, 'http://x');
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [...served].map((id) => ({ id })) }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    // The Gemini wire names its model in the path: `/v1beta/models/<model>:<method>`.
    const gemini =
      /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/.exec(
        url.pathname,
      );
    if (gemini) body.model = gemini[1];
    if (!served.has(body.model)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `unknown provider for model ${body.model}`,
          },
        }),
      );
      return;
    }
    response.setHeader('x-fake-model', body.model);
    response.setHeader('x-fake-authorization', request.headers.authorization);
    response.setHeader('x-fake-path', request.url);
    response.setHeader('x-fake-x-api-key', String(request.headers['x-api-key'] ?? ''));
    response.setHeader('x-fake-beta', String(request.headers['anthropic-beta'] ?? ''));
    response.setHeader('x-fake-body-model', String(JSON.parse(raw || '{}').model ?? ''));
    if (body.model.endsWith('/broken')) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
        }),
      );
      return;
    }
    if (url.pathname === '/v1/messages') {
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'm',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
        );
        return;
      }
      sse(response, [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'm',
              usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 5 },
            },
          },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { input_tokens: 11, output_tokens: 4 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ]);
      return;
    }
    if (url.pathname === '/v1/messages/count_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"input_tokens":4}');
      return;
    }
    if (url.pathname === '/v1/responses') {
      sse(response, [
        ['response.created', { type: 'response.created', response: { id: 'r' } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'hello' }],
        [
          'response.completed',
          {
            type: 'response.completed',
            response: {
              id: 'r',
              usage: {
                input_tokens: 20,
                output_tokens: 6,
                input_tokens_details: { cached_tokens: 2 },
                output_tokens_details: { reasoning_tokens: 1 },
              },
            },
          },
        ],
      ]);
      return;
    }
    if (gemini && gemini[2] === 'countTokens') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"totalTokens":4}');
      return;
    }
    if (gemini && gemini[2] === 'generateContent') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] } }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 },
        }),
      );
      return;
    }
    if (gemini) {
      sse(response, [
        [null, { candidates: [{ content: { role: 'model', parts: [{ text: 'hel' }] } }] }],
        [
          null,
          {
            candidates: [
              { content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' },
            ],
            usageMetadata: {
              promptTokenCount: 40,
              candidatesTokenCount: 5,
              thoughtsTokenCount: 3,
              cachedContentTokenCount: 10,
              totalTokenCount: 48,
            },
          },
        ],
      ]);
      return;
    }
    if (url.pathname === '/v1/chat/completions') {
      sse(response, [
        [null, { choices: [{ index: 0, delta: { content: 'hello' } }] }],
        [null, { choices: [], usage: { prompt_tokens: 30, completion_tokens: 8 } }],
        [null, '[DONE]'],
      ]);
      return;
    }
    response.writeHead(404);
    response.end();
  });
}).listen(config.server.port, config.server.host);

const exitAfter = Number(process.env.FAKE_CLIPROXY_EXIT_AFTER_MS);
if (exitAfter > 0) setTimeout(() => process.exit(3), exitAfter);
