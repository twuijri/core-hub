/**
 * The provider adapters, against scripted HTTP.
 *
 * Nothing here reaches the network and nothing here needs a real key: every response is
 * written out below, which is also how the shapes stay reviewable. A live check against
 * a real account is `models-live.test.ts`, gated on `COREHUB_LIVE_PROVIDER`.
 */
import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from './anthropic.js';
import { elevenLabsAdapter } from './elevenlabs.js';
import { googleAdapter } from './google.js';
import { ollamaAdapter } from './ollama.js';
import { openAiAdapter, perMillionMicroUsd } from './openai.js';
import { providerAdapter } from './index.js';
import type { ProviderContext } from './types.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Scripted {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  contentType?: string;
}

/** A `fetch` that answers from a script and records what it was asked. */
function scripted(answers: Scripted[] | Scripted): { fetchImpl: typeof fetch; calls: Call[] } {
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    const answer = queue.length > 1 ? queue.shift()! : (queue[0] ?? {});
    const status = answer.status ?? 200;
    const body =
      answer.bytes ?? (answer.text !== undefined ? answer.text : JSON.stringify(answer.json ?? {}));
    return Promise.resolve(
      new Response(body as BodyInit, {
        status,
        headers: { 'content-type': answer.contentType ?? 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Never refuses to fail: what a provider that is not listening looks like. */
const refused: typeof fetch = () =>
  Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

function context(over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    slug: 'test',
    label: 'Test',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-scripted-key',
    headers: {},
    settings: {},
    fetchImpl: scripted({}).fetchImpl,
    ...over,
  };
}

describe('models adapters: OpenAI-shaped', () => {
  it('tests with one authenticated GET /models and reports ok', async () => {
    const { fetchImpl, calls } = scripted({ json: { data: [] } });
    const result = await openAiAdapter.test(context({ fetchImpl }));

    expect(result).toMatchObject({ ok: true, reason: 'ok', status: 200, detail: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.test/v1/models');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-scripted-key');
  });

  it('says `no_key` without making a request at all', async () => {
    const { fetchImpl, calls } = scripted({ json: { data: [] } });
    const result = await openAiAdapter.test(context({ fetchImpl, apiKey: null }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_key');
    expect(calls).toHaveLength(0);
  });

  it('turns a 401 into `unauthorized` and carries the provider’s own words', async () => {
    const { fetchImpl } = scripted({
      status: 401,
      json: { error: { message: 'Incorrect API key provided' } },
    });
    const result = await openAiAdapter.test(context({ fetchImpl }));
    expect(result).toMatchObject({
      ok: false,
      reason: 'unauthorized',
      status: 401,
      detail: 'Incorrect API key provided',
    });
  });

  it('turns a 429 into `rate_limited` and a refused socket into `unreachable`', async () => {
    const limited = await openAiAdapter.test(
      context({ fetchImpl: scripted({ status: 429, json: {} }).fetchImpl }),
    );
    expect(limited.reason).toBe('rate_limited');

    const down = await openAiAdapter.test(context({ fetchImpl: refused }));
    expect(down).toMatchObject({ ok: false, reason: 'unreachable', status: null });
    expect(down.detail).toContain('ECONNREFUSED');
  });

  it('lists models, and reads context window and pricing when the provider reports them', async () => {
    const { fetchImpl } = scripted({
      json: {
        data: [
          {
            id: 'anthropic/claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            context_length: 200000,
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools', 'reasoning'],
            pricing: { prompt: '0.000003', completion: '0.000015' },
            top_provider: { max_completion_tokens: 64000 },
          },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-1' },
          { id: 'no-id-here', name: 'ignored' },
        ],
      },
    });
    const result = await openAiAdapter.listModels(context({ fetchImpl }));
    expect(result.supported).toBe(true);
    if (!result.supported) return;

    expect(result.models.map((m) => m.key)).toEqual([
      'anthropic/claude-sonnet-4-5',
      'text-embedding-3-small',
      'whisper-1',
      'no-id-here',
    ]);
    const sonnet = result.models[0]!;
    expect(sonnet).toMatchObject({
      label: 'Claude Sonnet 4.5',
      kind: 'chat',
      contextWindow: 200000,
      maxOutputTokens: 64000,
    });
    expect(sonnet.capabilities).toEqual(['vision', 'tools', 'reasoning']);
    // USD/token -> integer micro-USD per million tokens: $3.00 and $15.00.
    expect(sonnet.pricing).toEqual({ inputPerMillion: 3_000_000, outputPerMillion: 15_000_000 });
    // Kinds are read off the id, because that is all these providers give.
    expect(result.models[1]!.kind).toBe('embedding');
    expect(result.models[2]!.kind).toBe('stt');
  });

  it('reports "not supported" rather than an empty catalogue when the call fails', async () => {
    const { fetchImpl } = scripted({ status: 403, json: { error: 'no access to models' } });
    const result = await openAiAdapter.listModels(context({ fetchImpl }));
    expect(result).toEqual({ supported: false, reason: 'no access to models' });
  });

  it('synthesizes speech and refuses honestly with no voice', async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const { fetchImpl, calls } = scripted({ bytes: audio, contentType: 'audio/mpeg' });
    const ctx = context({ fetchImpl, settings: { model: 'gpt-4o-mini-tts', voice: 'alloy' } });

    const spoken = await openAiAdapter.synthesize(ctx, {
      text: 'اكتملت الاختبارات.',
      language: 'ar',
      voice: null,
    });
    expect(spoken).toMatchObject({ supported: true, contentType: 'audio/mpeg' });
    expect(calls[0]!.url).toBe('https://api.example.test/v1/audio/speech');
    expect(calls[0]!.body).toMatchObject({ voice: 'alloy', input: 'اكتملت الاختبارات.' });

    const voiceless = await openAiAdapter.synthesize(context({ fetchImpl, settings: {} }), {
      text: 'x',
      language: null,
      voice: null,
    });
    expect(voiceless).toEqual({ supported: false, reason: 'no_voice' });
  });

  it('asks for the audio format the client can play (DECISIONS §87)', async () => {
    const { fetchImpl, calls } = scripted([
      { bytes: new Uint8Array([1]), contentType: 'audio/aac' },
      { bytes: new Uint8Array([2]), contentType: 'audio/ogg' },
      { bytes: new Uint8Array([3]), contentType: 'audio/mpeg' },
    ]);
    const ctx = context({ fetchImpl, settings: { voice: 'alloy' } });

    // iOS cannot play Ogg: it asks for AAC.
    const aac = await openAiAdapter.synthesize(ctx, {
      text: 'x',
      language: null,
      voice: null,
      format: 'aac',
    });
    expect(aac).toMatchObject({ supported: true, contentType: 'audio/aac' });
    expect(calls[0]!.body).toMatchObject({ response_format: 'aac' });
    expect(calls[0]!.headers.accept).toBe('audio/aac');
    // OpenAI calls Ogg Opus `opus`.
    await openAiAdapter.synthesize(ctx, { text: 'x', language: null, voice: null, format: 'ogg' });
    expect(calls[1]!.body).toMatchObject({ response_format: 'opus' });
    // Nothing asked: MP3, as before.
    await openAiAdapter.synthesize(ctx, { text: 'x', language: null, voice: null });
    expect(calls[2]!.body).toMatchObject({ response_format: 'mp3' });
  });

  it('has no voice list, and says so instead of inventing one', async () => {
    const result = await openAiAdapter.listVoices(context());
    expect(result.supported).toBe(false);
  });

  it('converts prices without floating-point drift', () => {
    expect(perMillionMicroUsd('0.000003')).toBe(3_000_000);
    expect(perMillionMicroUsd('0')).toBe(0);
    expect(perMillionMicroUsd('not a price')).toBeUndefined();
    expect(perMillionMicroUsd(undefined)).toBeUndefined();
  });
});

describe('models adapters: Anthropic', () => {
  it('sends x-api-key with a pinned version header', async () => {
    const { fetchImpl, calls } = scripted({ json: { data: [], has_more: false } });
    const result = await anthropicAdapter.test(
      context({ fetchImpl, baseUrl: 'https://api.anthropic.com' }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-scripted-key');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    // The key never travels in the URL (docs/domain/models.md §Not stored).
    expect(calls[0]!.url).not.toContain('sk-');
  });

  it('follows the after_id pages until has_more is false', async () => {
    const { fetchImpl, calls } = scripted([
      {
        json: {
          data: [{ id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1' }],
          has_more: true,
          last_id: 'claude-opus-4-1',
        },
      },
      {
        json: { data: [{ id: 'claude-haiku-4-5' }], has_more: false },
      },
    ]);
    const result = await anthropicAdapter.listModels(
      context({ fetchImpl, baseUrl: 'https://api.anthropic.com' }),
    );
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.models.map((m) => m.key)).toEqual(['claude-opus-4-1', 'claude-haiku-4-5']);
    expect(result.models[0]!.label).toBe('Claude Opus 4.1');
    // A model with no display name falls back to its id rather than to an empty string.
    expect(result.models[1]!.label).toBe('claude-haiku-4-5');
    expect(calls[1]!.url).toContain('after_id=claude-opus-4-1');
  });

  it('does not pretend to speak', async () => {
    await expect(anthropicAdapter.listVoices(context())).resolves.toMatchObject({
      supported: false,
    });
  });
});

describe('models adapters: Google', () => {
  it('puts the key in a header, never in the query string', async () => {
    const { fetchImpl, calls } = scripted({ json: { models: [] } });
    await googleAdapter.test(context({ fetchImpl }));
    expect(calls[0]!.headers['x-goog-api-key']).toBe('sk-scripted-key');
    expect(calls[0]!.url).not.toContain('key=');
  });

  it('strips the `models/` prefix and pages with nextPageToken', async () => {
    const { fetchImpl, calls } = scripted([
      {
        json: {
          models: [
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
              supportedGenerationMethods: ['generateContent'],
            },
          ],
          nextPageToken: 'page-2',
        },
      },
      {
        json: {
          models: [
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
        },
      },
    ]);
    const result = await googleAdapter.listModels(context({ fetchImpl }));
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.models[0]).toMatchObject({
      key: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      kind: 'chat',
      contextWindow: 1048576,
      maxOutputTokens: 65536,
    });
    expect(result.models[1]).toMatchObject({ key: 'text-embedding-004', kind: 'embedding' });
    expect(calls[1]!.url).toContain('pageToken=page-2');
  });
});

describe('models adapters: Ollama', () => {
  it('needs no key and reports reachability as the whole test', async () => {
    const { fetchImpl, calls } = scripted({ json: { models: [] } });
    const result = await ollamaAdapter.test(
      context({ fetchImpl, apiKey: null, baseUrl: 'http://127.0.0.1:11434' }),
    );
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/tags');
    expect(calls[0]!.headers.authorization).toBeUndefined();

    const down = await ollamaAdapter.test(context({ fetchImpl: refused, apiKey: null }));
    expect(down).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('lists what is pulled on the machine', async () => {
    const { fetchImpl } = scripted({
      json: {
        models: [
          { name: 'llama3.1:70b', model: 'llama3.1:70b', details: { parameter_size: '70.6B' } },
          { model: 'nomic-embed-text' },
        ],
      },
    });
    const result = await ollamaAdapter.listModels(context({ fetchImpl, apiKey: null }));
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.models[0]).toMatchObject({ key: 'llama3.1:70b', label: 'llama3.1:70b (70.6B)' });
    expect(result.models[1]!.kind).toBe('embedding');
  });
});

describe('models adapters: ElevenLabs', () => {
  it('lists voices with their language and gender', async () => {
    const { fetchImpl, calls } = scripted({
      json: {
        voices: [
          { voice_id: '21m00Tcm', name: 'Rachel', labels: { language: 'en-US', gender: 'female' } },
          { voice_id: 'pNInz6ob', name: 'Adam', labels: {} },
          { name: 'no id' },
        ],
      },
    });
    const result = await elevenLabsAdapter.listVoices(
      context({ fetchImpl, baseUrl: 'https://api.elevenlabs.io/v1' }),
    );
    expect(calls[0]!.headers['xi-api-key']).toBe('sk-scripted-key');
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.voices).toEqual([
      { id: '21m00Tcm', name: 'Rachel', language: 'en-US', gender: 'female' },
      { id: 'pNInz6ob', name: 'Adam', language: null, gender: null },
    ]);
  });

  it('synthesizes to the chosen voice and reports a refusal with the provider’s text', async () => {
    const { fetchImpl, calls } = scripted({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    const ctx = context({
      fetchImpl,
      baseUrl: 'https://api.elevenlabs.io/v1',
      settings: { model: 'eleven_multilingual_v2', voice: '21m00Tcm' },
    });
    const spoken = await elevenLabsAdapter.synthesize(ctx, {
      text: 'مرحبا',
      language: 'ar',
      voice: null,
    });
    expect(spoken.supported).toBe(true);
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm');
    expect(calls[0]!.body).toMatchObject({
      model_id: 'eleven_multilingual_v2',
      language_code: 'ar',
    });

    const failing = scripted({ status: 422, text: 'voice_not_found' });
    const refusal = await elevenLabsAdapter.synthesize(
      context({ fetchImpl: failing.fetchImpl, settings: { voice: 'nope' } }),
      { text: 'x', language: null, voice: null },
    );
    expect(refusal).toMatchObject({ supported: false, detail: 'voice_not_found' });
  });

  it('has no model list, because a speech provider is chosen by voice', async () => {
    await expect(elevenLabsAdapter.listModels(context())).resolves.toMatchObject({
      supported: false,
    });
  });
});

describe('models adapters: the registry', () => {
  it('maps every protocol, and treats an unknown one as OpenAI-shaped', () => {
    expect(providerAdapter('anthropic')).toBe(anthropicAdapter);
    expect(providerAdapter('google')).toBe(googleAdapter);
    expect(providerAdapter('ollama')).toBe(ollamaAdapter);
    expect(providerAdapter('elevenlabs')).toBe(elevenLabsAdapter);
    expect(providerAdapter('openai')).toBe(openAiAdapter);
  });
});
