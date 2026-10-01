#!/usr/bin/env node
// A stand-in for CLIProxyAPI in the gateway's unit tests (`gateway.test.ts`): it reads the file
// the hub wrote, listens where it says, accepts only its client key, serves only the models it
// lists, and answers each wire with a short stream carrying usage. It echoes what it was sent in
// `x-fake-*` headers so a test can see the model and credential the gateway forwarded.
//
//   FAKE_CLIPROXY_EXIT_AFTER_MS  exit (code 3) this long after starting — a crash
//
// A model whose id ends in `spent` answers as CLIProxyAPI does once a provider said its quota is
// spent (429, its own name for the model in the words); one ending in `per-minute` is refused the
// first time with Google's per-minute `RetryInfo` and served after; one ending in `per-day` is
// refused with Google's per-day `QuotaFailure`. `GET /fake/calls` counts the calls each model was
// sent.
//
// Its management API and ChatGPT device sign-in (the subscriptions signed in to through the
// gateway, DECISIONS §143) are in `fake-cliproxy-accounts.mjs`.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parse } from 'yaml';
import { accountModels, codexDeviceLogin, managementApi } from './fake-cliproxy-accounts.mjs';

const configPath = process.argv[process.argv.indexOf('-config') + 1];
const config = parse(readFileSync(configPath, 'utf8'));
if (process.argv.includes('-codex-device-login')) {
  await codexDeviceLogin(config.oauth['auth-dir']);
  process.exit(0);
}
const key = config.access['api-keys'][0];
const authDir = config.oauth?.['auth-dir'] ?? '';
const management = managementApi(config);
const served = new Set();
for (const groups of Object.values(config['api-keys'] ?? {})) {
  for (const group of groups) {
    for (const model of group.models) served.add(`${group.prefix}/${model.alias}`);
  }
}

const calls = {};

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
    const url = new URL(request.url, 'http://x');
    if (management(request, response, url, raw)) return;
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":"Missing API key"}');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/fake/calls') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(calls));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            ...[...served].map((id) => ({ id })),
            ...accountModels(authDir).map((model) => ({
              id: model.id,
              object: 'model',
              owned_by: model.vendor,
              context_length: model.context_length,
            })),
          ],
        }),
      );
      return;
    }
    const body = JSON.parse(raw || '{}');
    // The Gemini wire names its model in the path: `/v1beta/models/<model>:<method>`.
    const gemini =
      /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/.exec(
        url.pathname,
      );
    if (gemini) body.model = gemini[1];
    if (
      !served.has(body.model) &&
      !accountModels(authDir).some((model) => model.id === body.model)
    ) {
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
    calls[body.model] = (calls[body.model] ?? 0) + 1;
    const google = (details) =>
      JSON.stringify({
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
          details,
        },
      });
    if (body.model.endsWith('per-minute') && calls[body.model] === 1) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        google([
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateContentInputTokensPerModelPerMinute' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.05s' },
        ]),
      );
      return;
    }
    if (body.model.endsWith('per-day')) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        google([
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }],
          },
        ]),
      );
      return;
    }
    response.setHeader('x-fake-thinking', body.thinking ? 'yes' : 'no');
    response.setHeader('x-fake-effort', String(body.output_config?.effort ?? ''));
    response.setHeader(
      'x-fake-tool-descriptions',
      JSON.stringify(body.tools ?? []).includes('"description"') ? 'yes' : 'no',
    );
    const refusedShape =
      (/thinks$/.test(body.model) && body.thinking) ||
      (/high-effort$/.test(body.model) && body.output_config?.effort === 'high') ||
      (/big-tools$/.test(body.model) && JSON.stringify(body.tools ?? []).length > 2000);
    if (refusedShape) {
      // A model refused only when asked to think as the agent asks (as CLIProxyAPI answers it:
      // the message alone on the Anthropic route).
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Resource has been exhausted (e.g. check quota).',
          },
        }),
      );
      return;
    }
    if (body.model.endsWith('busy')) {
      // As CLIProxyAPI answers an Antigravity "no capacity" refusal: the message alone on the
      // Anthropic route, the provider's whole answer on the Chat route.
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        url.pathname === '/v1/chat/completions'
          ? JSON.stringify({
              error: {
                code: 429,
                message: `No capacity available for model ${body.model} on the server`,
                status: 'RESOURCE_EXHAUSTED',
                details: [
                  {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'MODEL_CAPACITY_EXHAUSTED',
                    domain: 'cloudcode-pa.googleapis.com',
                  },
                ],
              },
            })
          : JSON.stringify({
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: 'Resource has been exhausted (e.g. check quota).',
              },
            }),
      );
      return;
    }
    if (body.model.endsWith('spent')) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `All credentials for model ${body.model} are cooling down (last error: {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}})`,
          },
        }),
      );
      return;
    }
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
