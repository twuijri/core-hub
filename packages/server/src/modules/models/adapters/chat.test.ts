/**
 * The `chat` verb of the provider adapters, against a scripted endpoint.
 *
 * No network: every request is answered by a `fetch` written here, exactly as the rest
 * of `adapters.test.ts` does. What is being asserted is the two halves of honesty this
 * path promises — the text arrives in order, and a refusal is named with the provider's
 * own sentence rather than a shrug.
 */
import { describe, expect, it } from 'vitest';
import { anthropicChat } from './anthropic.js';
import { googleChat } from './google.js';
import { openAiChat } from './openai.js';
import { ollamaAdapter } from './ollama.js';
import type { ChatEvent, ProviderContext } from './types.js';

// --------------------------------------------------------------------- the endpoint

interface Scripted {
  status?: number;
  /** SSE `data:` payloads, in order. Each is sent as its own frame. */
  frames?: unknown[];
  /** A non-2xx body, as the provider would write it. */
  json?: unknown;
  /** Delay between frames, so a test can cancel in the middle of one. */
  gapMs?: number;
  /** Reject the request outright, like a port with nothing behind it. */
  refuse?: boolean;
}

interface Recorder {
  fetchImpl: typeof fetch;
  calls: { url: string; headers: Record<string, string>; body: unknown }[];
}

function scriptedStream(answer: (url: string) => Scripted): Recorder {
  const calls: Recorder['calls'] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const body: unknown = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), headers, body });
    const scripted = answer(String(url));
    if (scripted.refuse) {
      return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'X' }));
    }
    if (scripted.status && scripted.status >= 400) {
      return Promise.resolve(
        new Response(JSON.stringify(scripted.json ?? {}), {
          status: scripted.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const frames = scripted.frames ?? [];
    const signal = init.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) {
          if (signal?.aborted) break;
          if (scripted.gapMs) await new Promise((resolve) => setTimeout(resolve, scripted.gapMs));
          if (signal?.aborted) break;
          const payload = typeof frame === 'string' ? frame : JSON.stringify(frame);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function context(fetchImpl: typeof fetch, over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    slug: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-test',
    requiresKey: true,
    headers: {},
    settings: {},
    fetchImpl,
    ...over,
  };
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The frames an OpenAI-compatible server sends for "Hello there" plus its usage. */
const HELLO_FRAMES = [
  { choices: [{ delta: { content: 'Hello' } }] },
  { choices: [{ delta: { content: ' there' } }] },
  {
    choices: [{ delta: {} }],
    usage: { prompt_tokens: 11, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
  },
];

// --------------------------------------------------------------------------- tests

describe('the OpenAI-compatible chat stream', () => {
  it('streams the deltas in order, then the usage, then completes', async () => {
    const { fetchImpl, calls } = scriptedStream(() => ({ frames: HELLO_FRAMES }));
    const events = await collect(
      openAiChat(context(fetchImpl), {
        model: 'gpt-test',
        messages: [{ role: 'user', text: 'hi' }],
      }),
    );

    expect(events.map((event) => event.type)).toEqual(['delta', 'delta', 'usage', 'completed']);
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('Hello there');
    // The 4 cached tokens are counted once, as cache reads, not also as input.
    expect(events[2]).toMatchObject({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 4 });

    // The request itself: the right endpoint, the key in the header, streaming asked for.
    expect(calls[0]?.url).toBe('https://api.example.test/v1/chat/completions');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test');
    expect(calls[0]?.body).toMatchObject({
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('reports reasoning deltas separately from the answer', async () => {
    const { fetchImpl } = scriptedStream(() => ({
      frames: [
        { choices: [{ delta: { reasoning: 'thinking…' } }] },
        { choices: [{ delta: { content: 'done' } }] },
      ],
    }));
    const events = await collect(
      openAiChat(context(fetchImpl), { model: 'm', messages: [{ role: 'user', text: 'hi' }] }),
    );
    expect(events).toEqual([
      { type: 'reasoning', text: 'thinking…' },
      { type: 'delta', text: 'done' },
      { type: 'completed' },
    ]);
  });

  it('sends an image as a multimodal part and plain text otherwise', async () => {
    const { fetchImpl, calls } = scriptedStream(() => ({ frames: [] }));
    await collect(
      openAiChat(context(fetchImpl), {
        model: 'm',
        messages: [
          { role: 'system', text: 'be brief' },
          {
            role: 'user',
            text: 'what is this?',
            images: [{ mime: 'image/png', dataBase64: 'AAAA', name: 'shot.png' }],
          },
        ],
      }),
    );
    const body = calls[0]?.body as { messages: { role: string; content: unknown }[] };
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
  });

  it('stops mid-stream when the caller cancels, and says it was cancelled', async () => {
    const { fetchImpl } = scriptedStream(() => ({
      frames: Array.from({ length: 50 }, (_, index) => ({
        choices: [{ delta: { content: `${index} ` } }],
      })),
      gapMs: 5,
    }));
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    for await (const event of openAiChat(context(fetchImpl), {
      model: 'm',
      messages: [{ role: 'user', text: 'count' }],
      signal: controller.signal,
    })) {
      events.push(event);
      if (events.length === 3) controller.abort();
    }
    // Some text arrived, the rest did not, and the turn ends as cancelled — not as a
    // completed answer the person never got, and not as a transport failure.
    expect(events.filter((event) => event.type === 'delta').length).toBeLessThan(50);
    expect(events.at(-1)).toEqual({
      type: 'failed',
      reason: 'cancelled',
      detail: null,
      status: null,
    });
  });

  describe('every refusal keeps the provider’s own words', () => {
    const cases: Array<[string, Scripted, ChatEvent]> = [
      [
        'a rejected key',
        { status: 401, json: { error: { message: 'Incorrect API key provided: sk-…xyz' } } },
        {
          type: 'failed',
          reason: 'unauthorized',
          detail: '{"error":{"message":"Incorrect API key provided: sk-…xyz"}}',
          status: 401,
        },
      ],
      [
        'a rate limit',
        { status: 429, json: { error: { message: 'Rate limit reached for gpt-test' } } },
        {
          type: 'failed',
          reason: 'rate_limited',
          detail: '{"error":{"message":"Rate limit reached for gpt-test"}}',
          status: 429,
        },
      ],
      [
        'a model the provider has never heard of (404)',
        { status: 404, json: { error: { message: 'The model `nope` does not exist' } } },
        {
          type: 'failed',
          reason: 'model_not_found',
          detail: '{"error":{"message":"The model `nope` does not exist"}}',
          status: 404,
        },
      ],
      [
        'a model the provider rejects with a 400',
        { status: 400, json: { error: { code: 'model_not_found', message: 'unknown model' } } },
        {
          type: 'failed',
          reason: 'model_not_found',
          detail: '{"error":{"code":"model_not_found","message":"unknown model"}}',
          status: 400,
        },
      ],
      [
        'anything else',
        { status: 500, json: { error: { message: 'internal' } } },
        {
          type: 'failed',
          reason: 'http_error',
          detail: '{"error":{"message":"internal"}}',
          status: 500,
        },
      ],
    ];

    for (const [name, scripted, expected] of cases) {
      it(name, async () => {
        const { fetchImpl } = scriptedStream(() => scripted);
        const events = await collect(
          openAiChat(context(fetchImpl), { model: 'm', messages: [{ role: 'user', text: 'x' }] }),
        );
        expect(events).toEqual([expected]);
      });
    }

    it('an endpoint that is not listening', async () => {
      const { fetchImpl } = scriptedStream(() => ({ refuse: true }));
      const events = await collect(
        openAiChat(context(fetchImpl), { model: 'm', messages: [{ role: 'user', text: 'x' }] }),
      );
      expect(events).toEqual([
        { type: 'failed', reason: 'unreachable', detail: 'connect ECONNREFUSED', status: null },
      ]);
    });

    it('a provider that wants a key when none is stored — without asking it first', async () => {
      const { fetchImpl, calls } = scriptedStream(() => ({ frames: HELLO_FRAMES }));
      const events = await collect(
        openAiChat(context(fetchImpl, { apiKey: null }), {
          model: 'm',
          messages: [{ role: 'user', text: 'x' }],
        }),
      );
      expect(events).toEqual([{ type: 'failed', reason: 'no_key', detail: null, status: null }]);
      expect(calls).toEqual([]);
    });

    it('a local endpoint that demands no key is asked anyway', async () => {
      const { fetchImpl, calls } = scriptedStream(() => ({ frames: HELLO_FRAMES }));
      const events = await collect(
        openAiChat(context(fetchImpl, { apiKey: null, requiresKey: false }), {
          model: 'm',
          messages: [{ role: 'user', text: 'x' }],
        }),
      );
      expect(events.at(-1)).toEqual({ type: 'completed' });
      expect(calls[0]?.headers.authorization).toBeUndefined();
    });

    it('a gateway that reports the failure inside the stream rather than as a status', async () => {
      const { fetchImpl } = scriptedStream(() => ({
        frames: [
          { choices: [{ delta: { content: 'par' } }] },
          { error: { message: 'upstream provider returned 502' } },
        ],
      }));
      const events = await collect(
        openAiChat(context(fetchImpl), { model: 'm', messages: [{ role: 'user', text: 'x' }] }),
      );
      expect(events).toEqual([
        { type: 'delta', text: 'par' },
        {
          type: 'failed',
          reason: 'http_error',
          detail: 'upstream provider returned 502',
          status: null,
        },
      ]);
    });
  });
});

describe('Ollama', () => {
  it('runs a turn on its OpenAI-compatible surface under /v1 (ADR 0012)', async () => {
    const { fetchImpl, calls } = scriptedStream(() => ({ frames: HELLO_FRAMES }));
    const events = await collect(
      ollamaAdapter.chat(
        context(fetchImpl, {
          slug: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          apiKey: null,
          requiresKey: false,
        }),
        { model: 'qwen3', messages: [{ role: 'user', text: 'hi' }] },
      ),
    );
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(events.at(-1)).toEqual({ type: 'completed' });
  });
});

describe('Anthropic', () => {
  it('lifts the system prompt out of the turns and folds both usage frames', async () => {
    const { fetchImpl, calls } = scriptedStream(() => ({
      frames: [
        { type: 'message_start', message: { usage: { input_tokens: 9 } } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_delta', usage: { output_tokens: 3 } },
      ],
    }));
    const events = await collect(
      anthropicChat(
        context(fetchImpl, { slug: 'anthropic', baseUrl: 'https://api.anthropic.test' }),
        {
          model: 'claude-test',
          messages: [
            { role: 'system', text: 'be brief' },
            { role: 'user', text: 'hello' },
          ],
        },
      ),
    );
    expect(calls[0]?.url).toBe('https://api.anthropic.test/v1/messages');
    expect(calls[0]?.body).toMatchObject({
      system: 'be brief',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(events).toEqual([
      { type: 'usage', inputTokens: 9 },
      { type: 'reasoning', text: 'hmm' },
      { type: 'delta', text: 'Hi' },
      { type: 'usage', outputTokens: 3 },
      { type: 'completed' },
    ]);
  });
});

describe('Google', () => {
  it('counts cached prompt tokens once, as cache reads', async () => {
    const { fetchImpl } = scriptedStream(() => ({
      frames: [
        { candidates: [{ content: { parts: [{ text: 'Yes' }] } }] },
        {
          usageMetadata: {
            promptTokenCount: 50,
            cachedContentTokenCount: 40,
            candidatesTokenCount: 1,
          },
        },
      ],
    }));
    const events = await collect(
      googleChat(
        context(fetchImpl, {
          slug: 'google',
          baseUrl: 'https://generativelanguage.test/v1beta',
          apiKey: 'goog-key',
        }),
        { model: 'gemini-test', messages: [{ role: 'user', text: 'ok?' }] },
      ),
    );
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 40,
    });
  });

  it('asks for SSE explicitly and separates a thought from the answer', async () => {
    const { fetchImpl, calls } = scriptedStream(() => ({
      frames: [
        { candidates: [{ content: { parts: [{ text: 'weighing', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Yes' }] } }] },
        { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
      ],
    }));
    const events = await collect(
      googleChat(
        context(fetchImpl, {
          slug: 'google',
          baseUrl: 'https://generativelanguage.test/v1beta',
          apiKey: 'goog-key',
        }),
        { model: 'gemini-test', messages: [{ role: 'user', text: 'ok?' }] },
      ),
    );
    // Without `alt=sse` the endpoint answers with a streamed JSON array instead.
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
    );
    expect(calls[0]?.headers['x-goog-api-key']).toBe('goog-key');
    expect(events).toEqual([
      { type: 'reasoning', text: 'weighing' },
      { type: 'delta', text: 'Yes' },
      { type: 'usage', inputTokens: 5, outputTokens: 1 },
      { type: 'completed' },
    ]);
  });
});
