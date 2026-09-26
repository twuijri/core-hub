/**
 * The speech providers of DECISIONS §94, each against a fake of its own HTTP surface on a
 * loopback port, reached with the real `fetch`: the hub's requests leave for the providers'
 * real addresses (`https://api.groq.com/…`, `https://westeurope.tts.speech.microsoft.com/…`)
 * and are only redirected to the fake at the last moment, so the paths, headers and bodies
 * checked here are the ones production sends. No real key is used anywhere.
 *
 * - Groq: models from its list, the documented Orpheus voices per model, WAV synthesis split
 *   under 200 characters and joined, Whisper transcription.
 * - OpenAI: the documented voices, narrowed by model.
 * - ElevenLabs: voices from `/v2/voices` page by page, models from `/v1/models`, Scribe.
 * - Deepgram: models and Aura voices from `/v1/models`, `/speak` and `/listen`.
 * - Azure Speech: the region's voice list, SSML synthesis, fast transcription.
 * - One key for a family, reused; and the choice written into Hermes's own voice settings.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { readWav } from './speech/audio.js';

type Hub = TestHub & { token: string };

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** A 16-bit mono WAV of `samples` little-endian values, as Groq answers. */
function wav(samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(value, index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const REAL_HOSTS: Record<string, string> = {
  'https://api.groq.com': '/groq',
  'https://api.openai.com': '/openai',
  'https://api.elevenlabs.io': '/elevenlabs',
  'https://api.deepgram.com': '/deepgram',
  'https://westeurope.tts.speech.microsoft.com': '/azure-tts',
  'https://westeurope.api.cognitive.microsoft.com': '/azure-stt',
};

function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

/** One loopback server playing every provider, keyed by the prefix `REAL_HOSTS` maps to. */
async function fakeProviders() {
  const seen: Seen[] = [];
  let groqSample = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      });
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        // ---------------------------------------------------------------- Groq
        case 'GET /groq/openai/v1/models':
          return json(res, {
            data: [
              { id: 'llama-3.3-70b-versatile' },
              { id: 'whisper-large-v3-turbo' },
              { id: 'canopylabs/orpheus-v1-english' },
              { id: 'canopylabs/orpheus-arabic-saudi' },
            ],
          });
        case 'POST /groq/openai/v1/audio/speech': {
          groqSample += 1;
          res.writeHead(200, { 'content-type': 'audio/wav' });
          return res.end(wav([groqSample, groqSample]));
        }
        case 'POST /groq/openai/v1/audio/transcriptions':
          return json(res, { text: ' مرحبا يا عالم ' });
        // -------------------------------------------------------------- OpenAI
        case 'GET /openai/v1/models':
          return json(res, { data: [{ id: 'gpt-4o-mini-tts' }, { id: 'tts-1' }] });
        // ---------------------------------------------------------- ElevenLabs
        case 'GET /elevenlabs/v1/voices':
          return json(res, { voices: [] });
        case 'GET /elevenlabs/v2/voices':
          return url.searchParams.get('next_page_token') === 'page-2'
            ? json(res, {
                voices: [
                  {
                    voice_id: 'v-arabic',
                    name: 'Salma',
                    labels: { gender: 'female', accent: 'saudi' },
                    verified_languages: [{ language: 'ar', locale: 'ar-SA' }],
                  },
                ],
                has_more: false,
                next_page_token: null,
              })
            : json(res, {
                voices: [
                  {
                    voice_id: 'v-rachel',
                    name: 'Rachel',
                    labels: { gender: 'female', accent: 'american', language: 'en' },
                  },
                ],
                has_more: true,
                next_page_token: 'page-2',
              });
        case 'GET /elevenlabs/v1/models':
          return json(res, [
            {
              model_id: 'eleven_multilingual_v2',
              name: 'Multilingual v2',
              can_do_text_to_speech: true,
            },
            { model_id: 'eleven_english_sts_v2', name: 'STS', can_do_text_to_speech: false },
          ]);
        case 'POST /elevenlabs/v1/speech-to-text':
          return json(res, { text: 'hello there', language_code: 'en', audio_duration_secs: 1.5 });
        // ------------------------------------------------------------ Deepgram
        case 'GET /deepgram/v1/projects':
          return json(res, { projects: [] });
        case 'GET /deepgram/v1/models':
          return json(res, {
            stt: [
              { name: 'nova-3', canonical_name: 'nova-3', languages: ['en', 'ar'] },
              { name: 'nova-3', canonical_name: 'nova-3', languages: ['es'] },
            ],
            tts: [
              {
                name: 'thalia',
                canonical_name: 'aura-2-thalia-en',
                architecture: 'aura-2',
                languages: ['en', 'en-US'],
                metadata: { accent: 'American', tags: ['feminine', 'clear'] },
              },
              {
                name: 'celeste',
                canonical_name: 'aura-2-celeste-es',
                architecture: 'aura-2',
                languages: ['es', 'es-CO'],
                metadata: { accent: 'Colombian', tags: ['feminine'] },
              },
              {
                name: 'orion',
                canonical_name: 'aura-orion-en',
                architecture: 'aura',
                languages: ['en', 'en-US'],
                metadata: { accent: 'American', tags: ['masculine'] },
              },
            ],
          });
        case 'POST /deepgram/v1/speak':
          res.writeHead(200, { 'content-type': 'audio/mpeg' });
          return res.end(Buffer.from('ID3-deepgram'));
        case 'POST /deepgram/v1/listen':
          return json(res, {
            metadata: { duration: 2.25 },
            results: {
              channels: [
                { detected_language: 'ar', alternatives: [{ transcript: 'السلام عليكم' }] },
              ],
            },
          });
        // --------------------------------------------------------------- Azure
        case 'GET /azure-tts/cognitiveservices/voices/list':
          return json(res, [
            {
              ShortName: 'ar-SA-HamedNeural',
              DisplayName: 'Hamed',
              LocalName: 'حامد',
              Gender: 'Male',
              Locale: 'ar-SA',
              LocaleName: 'Arabic (Saudi Arabia)',
            },
            {
              ShortName: 'en-US-JennyNeural',
              DisplayName: 'Jenny',
              LocalName: 'Jenny',
              Gender: 'Female',
              Locale: 'en-US',
              LocaleName: 'English (United States)',
            },
          ]);
        case 'POST /azure-tts/cognitiveservices/v1':
          res.writeHead(200, { 'content-type': 'audio/mpeg' });
          return res.end(Buffer.from('ID3-azure'));
        case 'POST /azure-stt/speechtotext/transcriptions:transcribe':
          return json(res, {
            durationMilliseconds: 1800,
            combinedPhrases: [{ text: 'مرحبا' }],
            phrases: [{ text: 'مرحبا', locale: 'ar-SA' }],
          });
        default:
          return json(res, { error: { message: `no fake for ${route}` } }, 404);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    let url = input instanceof Request ? input.url : String(input);
    for (const [real, prefix] of Object.entries(REAL_HOSTS)) {
      if (url.startsWith(real)) url = `${base}${prefix}${url.slice(real.length)}`;
    }
    return fetch(url, init);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const hubs: Hub[] = [];
const servers: Server[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function hubWith(fetchImpl: typeof fetch, home?: string): Promise<Hub> {
  const hub = await signedInHub(
    {},
    {
      models: {
        fetchImpl,
        restartDelayMs: 0,
        ...(home
          ? {
              hermes: {
                home: () => home,
                profileHomes: () => [],
                restart: () => Promise.resolve(true),
                applyEnvironment: () => true,
              },
            }
          : {}),
      },
    },
  );
  hubs.push(hub);
  return hub;
}

async function addPreset(hub: Hub, preset: string, extra: Record<string, unknown> = {}) {
  const response = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: { preset, label: '', kind: 'llm', api_key: `test-key-${preset}`, ...extra },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string; slug: string };
}

interface SpeechRow {
  id: string;
  slug: string;
  configured: boolean;
}

async function speech(hub: Hub) {
  const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/speech' });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    stt: { providers: SpeechRow[]; ready: boolean };
    tts: { providers: SpeechRow[]; ready: boolean };
  };
}

async function rowOf(hub: Hub, side: 'stt' | 'tts', slug: string): Promise<SpeechRow> {
  const row = (await speech(hub))[side].providers.find((item) => item.slug === slug);
  expect(row, `${slug} on the ${side} tab`).toBeDefined();
  return row!;
}

async function voices(hub: Hub, providerId: string, model?: string) {
  const query = new URLSearchParams({ provider_id: providerId, ...(model ? { model } : {}) });
  const response = await authed(hub, hub.token, {
    method: 'GET',
    url: `/api/v1/models/speech/voices?${query.toString()}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    source: string;
    items: {
      id: string;
      name: string;
      language: string | null;
      gender: string | null;
      description?: string | null;
      models?: string[] | null;
    }[];
  };
}

async function modelsOf(hub: Hub, providerId: string, kind: string) {
  const response = await authed(hub, hub.token, {
    method: 'GET',
    url: `/api/v1/models?provider_id=${providerId}&kind=${kind}&limit=200`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { items: { model: string }[] }).items.map((item) => item.model);
}

async function speak(hub: Hub, body: Record<string, unknown>) {
  return authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/speech/speech',
    payload: body,
  });
}

async function transcribe(hub: Hub, fields: Record<string, string>) {
  const form = new FormData();
  form.append(
    'audio',
    new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
    'take.webm',
  );
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const request = new Request('http://local.test/', { method: 'POST', body: form });
  return authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/speech/transcriptions',
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
  });
}

const ARABIC_REPLY =
  'مرحبًا بك في كور هب. هذا ردّ طويل يُقرأ بصوت سعودي واضح، ويتجاوز الحدّ الذي يقبله مزوّد الصوت في الطلب الواحد. ' +
  'لذلك يُقسَّم عند نهايات الجمل ثم الكلمات، ويُطلب كل جزء وحده، ثم تُضمّ الأصوات بالترتيب في ملف واحد. ' +
  'وهذه جملة ثالثة تضمن أن النص أطول من مئتي حرف بكثير حتى نرى ثلاثة أجزاء على الأقل؟ نعم! ' +
  'وجملة رابعة أخيرة، فيها فواصل كثيرة، وكلمات تكفي لأن يمتدّ النص إلى ما بعد أربعمئة حرف بقليل.';

describe('Groq speech (§94)', () => {
  it('adds with the chat key, lists its own models per tab and its documented voices per model', async () => {
    const fake = await fakeProviders();
    const hub = await hubWith(fake.fetchImpl);
    await addPreset(hub, 'groq');
    await drainJobs(hub.app);
    const stt = await rowOf(hub, 'stt', 'groq-stt');
    const tts = await rowOf(hub, 'tts', 'groq-tts');
    expect(stt.configured).toBe(true);
    expect(tts.configured).toBe(true);

    // Each speech row keeps only the models of its own kind from Groq's one list.
    expect(await modelsOf(hub, stt.id, 'stt')).toEqual(['whisper-large-v3-turbo']);
    expect((await modelsOf(hub, tts.id, 'tts')).sort()).toEqual([
      'canopylabs/orpheus-arabic-saudi',
      'canopylabs/orpheus-v1-english',
    ]);
    expect(await modelsOf(hub, tts.id, 'chat')).toEqual([]);

    const all = await voices(hub, tts.id);
    expect(all.source).toBe('documented');
    expect(all.items).toHaveLength(12);
    const arabic = await voices(hub, tts.id, 'canopylabs/orpheus-arabic-saudi');
    expect(arabic.items.map((voice) => voice.id)).toEqual([
      'abdullah',
      'fahad',
      'sultan',
      'lulwa',
      'noura',
      'aisha',
    ]);
    expect(arabic.items.find((voice) => voice.id === 'noura')).toMatchObject({
      name: 'Noura',
      language: 'ar-SA',
      gender: 'female',
      description: 'Saudi dialect',
    });
    const english = await voices(hub, tts.id, 'canopylabs/orpheus-v1-english');
    expect(english.items.map((voice) => voice.id)).toEqual([
      'autumn',
      'diana',
      'hannah',
      'austin',
      'daniel',
      'troy',
    ]);
  });

  it('reads a long reply in parts under 200 characters and joins the WAVs in order', async () => {
    const fake = await fakeProviders();
    const hub = await hubWith(fake.fetchImpl);
    await addPreset(hub, 'groq');
    const tts = await rowOf(hub, 'tts', 'groq-tts');
    expect(ARABIC_REPLY.length).toBeGreaterThan(350);

    const response = await speak(hub, {
      text: ARABIC_REPLY,
      provider_id: tts.id,
      model: 'canopylabs/orpheus-arabic-saudi',
      voice: 'noura',
      language: 'ar',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('audio/wav');
    expect(response.headers['x-speech-provider']).toBe('groq-tts');

    const asked = fake.seen.filter((item) => item.path === '/groq/openai/v1/audio/speech');
    expect(asked.length).toBeGreaterThanOrEqual(2);
    const inputs = asked.map(
      (item) => JSON.parse(item.body.toString('utf8')) as Record<string, string>,
    );
    for (const [index, body] of inputs.entries()) {
      expect(body.input!.length, `part ${index + 1}`).toBeLessThanOrEqual(200);
      expect(body).toMatchObject({
        model: 'canopylabs/orpheus-arabic-saudi',
        voice: 'noura',
        response_format: 'wav',
      });
      expect(asked[index]!.headers.authorization).toBe('Bearer test-key-groq');
    }
    // Nothing lost, nothing reordered: the parts are the reply's words in order.
    expect(
      inputs
        .map((body) => body.input)
        .join(' ')
        .replace(/\s+/g, ' '),
    ).toBe(ARABIC_REPLY.replace(/\s+/g, ' '));
    // Cut at sentence ends where it could be.
    expect(inputs[0]!.input!.endsWith('.')).toBe(true);

    // One WAV, whose samples are every part's samples in order (part n answers [n, n]).
    const joined = readWav(new Uint8Array(response.rawPayload));
    expect(joined).not.toBeNull();
    const samples: number[] = [];
    const data = Buffer.from(joined!.data);
    for (let at = 0; at < data.length; at += 2) samples.push(data.readInt16LE(at));
    expect(samples).toEqual(asked.flatMap((_, index) => [index + 1, index + 1]));
  });

  it('says a voice must be chosen, and transcribes with Whisper', async () => {
    const fake = await fakeProviders();
    const hub = await hubWith(fake.fetchImpl);
    await addPreset(hub, 'groq');
    const tts = await rowOf(hub, 'tts', 'groq-tts');
    const stt = await rowOf(hub, 'stt', 'groq-stt');

    const unchosen = await speak(hub, {
      text: 'hello',
      provider_id: tts.id,
      model: 'canopylabs/orpheus-v1-english',
    });
    expect(unchosen.statusCode).toBe(422);
    expect(unchosen.json()).toMatchObject({ details: { reason: 'no_voice' } });

    await authed(hub, hub.token, {
      method: 'PATCH',
      url: '/api/v1/models/speech',
      payload: { stt_provider_id: stt.id },
    });
    const heard = await transcribe(hub, { language: 'ar-SA' });
    expect(heard.statusCode, heard.body).toBe(200);
    expect(heard.json()).toMatchObject({ text: 'مرحبا يا عالم', model: 'whisper-large-v3-turbo' });
    const upload = fake.seen.find((item) => item.path === '/groq/openai/v1/audio/transcriptions');
    const text = upload!.body.toString('utf8');
    expect(text).toContain('whisper-large-v3-turbo');
    expect(text).toContain('name="language"\r\n\r\nar');
  });
});

describe('OpenAI voices (§94)', () => {
  it('answers the documented voices, narrowed to the model that speaks them', async () => {
    const fake = await fakeProviders();
    const hub = await hubWith(fake.fetchImpl);
    await addPreset(hub, 'openai');
    const tts = await rowOf(hub, 'tts', 'openai-tts');
    const all = await voices(hub, tts.id);
    expect(all.source).toBe('documented');
    expect(all.items.map((voice) => voice.id)).toContain('marin');
    const older = await voices(hub, tts.id, 'tts-1');
    expect(older.items.map((voice) => voice.id)).not.toContain('marin');
    expect(older.items.map((voice) => voice.id)).toContain('alloy');
  });
});

describe('ElevenLabs (§94)', () => {
  it("pages through the account's voices, lists its TTS models, and transcribes with Scribe", async () => {
    const fake = await fakeProviders();
    const hub = await hubWith(fake.fetchImpl);
    await addPreset(hub, 'elevenlabs');
    await drainJobs(hub.app);
    const tts = await rowOf(hub, 'tts', 'elevenlabs');
    const stt = await rowOf(hub, 'stt', 'elevenlabs-stt');
    expect(stt.configured).toBe(true);

    const listed = await voices(hub, tts.id);
    expect(listed.source).toBe('provider');
    expect(listed.items).toEqual([
      expect.objectContaining({ id: 'v-rachel', language: 'en', gender: 'female' }),
      expect.objectContaining({
        id: 'v-arabic',
        name: 'Salma',
        language: 'ar-SA',
        description: 'saudi',
      }),
    ]);
    const pages = fake.seen.filter((item) => item.path === '/elevenlabs/v2/voices');
    expect(pages).toHaveLength(2);
    expect(pages[0]!.headers['xi-api-key']).toBe('test-key-elevenlabs');

    expect(await modelsOf(hub, tts.id, 'tts')).toEqual(['eleven_multilingual_v2']);
    // Scribe has no list endpoint: its documented model, and the catalogue says so.
    expect(await modelsOf(hub, stt.id, 'stt')).toEqual(['scribe_v2']);
    const cards = await authed(hub, hub.token, {
      method: 'GET',
      url: '/api/v1/models/providers?kind=stt',
    });
    const card = (cards.json() as { items: { id: string }[] }).items.find(
      (item) => item.id === stt.id,
    );
    expect(card).toMatchObject({ catalogue: { source: 'fallback' } });

    const heard = await transcribe(hub, { provider_id: stt.id, language: 'en-GB' });
    expect(heard.statusCode, heard.body).toBe(200);
    expect(heard.json()).toMatchObject({ text: 'hello there', language: 'en', duration_ms: 1500 });
    const upload = fake.seen.find((item) => item.path === '/elevenlabs/v1/speech-to-text')!;
    expect(upload.headers['xi-api-key']).toBe('test-key-elevenlabs');
    const text = upload.body.toString('utf8');
    expect(text).toContain('name="model_id"\r\n\r\nscribe_v2');
    expect(text).toContain('name="language_code"\r\n\r\nen');
  });
});

describe('Deepgram (§94)', () => {
  it('lists models and Aura voices from its own list, speaks and transcribes', async () => {
    const fake = await fakeProviders();
    const hub = await hubWith(fake.fetchImpl);
    await addPreset(hub, 'deepgram-stt');
    await drainJobs(hub.app);
    const stt = await rowOf(hub, 'stt', 'deepgram-stt');
    const tts = await rowOf(hub, 'tts', 'deepgram-tts');
    expect(tts.configured).toBe(true);
    expect(await modelsOf(hub, stt.id, 'stt')).toEqual(['nova-3']);
    expect((await modelsOf(hub, tts.id, 'tts')).sort()).toEqual(['aura', 'aura-2']);

    const aura2 = await voices(hub, tts.id, 'aura-2');
    expect(aura2.source).toBe('provider');
    expect(aura2.items).toEqual([
      expect.objectContaining({
        id: 'aura-2-thalia-en',
        name: 'Thalia',
        language: 'en-US',
        gender: 'female',
      }),
      expect.objectContaining({
        id: 'aura-2-celeste-es',
        language: 'es-CO',
        description: 'Colombian',
      }),
    ]);

    const spoken = await speak(hub, {
      text: 'Hello',
      provider_id: tts.id,
      voice: 'aura-2-thalia-en',
    });
    expect(spoken.statusCode, spoken.body).toBe(200);
    const said = fake.seen.find((item) => item.path === '/deepgram/v1/speak')!;
    expect(said.query.get('model')).toBe('aura-2-thalia-en');
    expect(said.headers.authorization).toBe('Token test-key-deepgram-stt');
    expect(JSON.parse(said.body.toString('utf8'))).toEqual({ text: 'Hello' });
    // A phone that asks for a format it can play (§91) gets Deepgram's encoding for it.
    await speak(hub, { text: 'Hi', provider_id: tts.id, voice: 'aura-2-thalia-en', format: 'wav' });
    const wavAsked = fake.seen.filter((item) => item.path === '/deepgram/v1/speak').at(-1)!;
    expect(wavAsked.query.get('encoding')).toBe('linear16');
    expect(wavAsked.query.get('container')).toBe('wav');

    const heard = await transcribe(hub, { provider_id: stt.id });
    expect(heard.statusCode, heard.body).toBe(200);
    expect(heard.json()).toMatchObject({ text: 'السلام عليكم', language: 'ar', duration_ms: 2250 });
    const listen = fake.seen.find((item) => item.path === '/deepgram/v1/listen')!;
    expect(listen.query.get('model')).toBe('nova-3');
    expect(listen.query.get('detect_language')).toBe('true');
    expect(listen.headers['content-type']).toBe('audio/webm');
    expect([...listen.body]).toEqual([1, 2, 3, 4]);
  });
});

describe('Azure Speech (§94)', () => {
  it("asks the region's voice list, speaks SSML and transcribes with a locale", async () => {
    const fake = await fakeProviders();
    const hub = await hubWith(fake.fetchImpl);
    const presets = await authed(hub, hub.token, {
      method: 'GET',
      url: '/api/v1/models/provider-presets?kind=tts',
    });
    expect(presets.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'azure-tts',
          base_url: null,
          base_url_required: true,
          base_url_example: 'https://<region>.api.cognitive.microsoft.com',
        }),
      ]) as unknown,
    });
    await addPreset(hub, 'azure-tts', {
      base_url: 'https://westeurope.api.cognitive.microsoft.com',
    });
    const tts = await rowOf(hub, 'tts', 'azure-tts');
    const stt = await rowOf(hub, 'stt', 'azure-stt');

    const listed = await voices(hub, tts.id);
    expect(listed.source).toBe('provider');
    expect(listed.items[0]).toMatchObject({
      id: 'ar-SA-HamedNeural',
      name: 'Hamed (حامد)',
      language: 'ar-SA',
      gender: 'male',
      description: 'Arabic (Saudi Arabia)',
    });
    const list = fake.seen.find(
      (item) => item.path === '/azure-tts/cognitiveservices/voices/list',
    )!;
    expect(list.headers['ocp-apim-subscription-key']).toBe('test-key-azure-tts');

    const spoken = await speak(hub, {
      text: 'أهلًا <وسهلًا>',
      provider_id: tts.id,
      voice: 'ar-SA-HamedNeural',
    });
    expect(spoken.statusCode, spoken.body).toBe(200);
    const said = fake.seen.find((item) => item.path === '/azure-tts/cognitiveservices/v1')!;
    expect(said.headers['content-type']).toBe('application/ssml+xml');
    expect(said.headers['x-microsoft-outputformat']).toBe('audio-24khz-48kbitrate-mono-mp3');
    const ssml = said.body.toString('utf8');
    expect(ssml).toContain('xml:lang="ar-SA"');
    expect(ssml).toContain('<voice name="ar-SA-HamedNeural">أهلًا &lt;وسهلًا&gt;</voice>');
    await speak(hub, {
      text: 'أهلًا',
      provider_id: tts.id,
      voice: 'ar-SA-HamedNeural',
      format: 'ogg',
    });
    const ogg = fake.seen.filter((item) => item.path === '/azure-tts/cognitiveservices/v1').at(-1)!;
    expect(ogg.headers['x-microsoft-outputformat']).toBe('ogg-24khz-16bit-mono-opus');

    const heard = await transcribe(hub, { provider_id: stt.id, language: 'ar' });
    expect(heard.statusCode, heard.body).toBe(200);
    expect(heard.json()).toMatchObject({ text: 'مرحبا', language: 'ar-SA', duration_ms: 1800 });
    const upload = fake.seen.find((item) =>
      item.path.startsWith('/azure-stt/speechtotext/transcriptions:transcribe'),
    )!;
    expect(upload.query.get('api-version')).toBe('2025-10-15');
    expect(upload.body.toString('utf8')).toContain('{"locales":["ar-SA"]}');

    // No language: the service detects it.
    await transcribe(hub, { provider_id: stt.id });
    const detect = fake.seen
      .filter((item) => item.path.includes('transcriptions:transcribe'))
      .at(-1)!;
    expect(detect.body.toString('utf8')).toContain('name="definition"\r\n\r\n{}');
  });
});

describe('one key per family, and Hermes hears the choice (§94)', () => {
  it('adds a speech row of a family that holds a key without asking for it again', async () => {
    const fake = await fakeProviders();
    const hub = await hubWith(fake.fetchImpl);
    await addPreset(hub, 'elevenlabs');
    const stt = await rowOf(hub, 'stt', 'elevenlabs-stt');
    const removed = await authed(hub, hub.token, {
      method: 'DELETE',
      url: `/api/v1/models/providers/${stt.id}`,
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const presets = await authed(hub, hub.token, {
      method: 'GET',
      url: '/api/v1/models/provider-presets?kind=stt',
    });
    const preset = (
      presets.json() as { items: { id: string; key_on_file: string[] }[] }
    ).items.find((item) => item.id === 'elevenlabs-stt');
    expect(preset?.key_on_file).toEqual(['all']);

    const again = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'elevenlabs-stt', label: '', kind: 'stt' },
    });
    expect(again.statusCode, again.body).toBe(201);
    expect((await rowOf(hub, 'stt', 'elevenlabs-stt')).configured).toBe(true);

    // A family with no key on file still needs one.
    const refused = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'deepgram-tts', label: '', kind: 'tts' },
    });
    expect(refused.statusCode).toBe(400);
  });

  it("writes the chosen provider, model, voice and language into Hermes's voice settings", async () => {
    const fake = await fakeProviders();
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-voice-'));
    homes.push(home);
    // Somebody's own voice settings, which the hub keeps where it does not own them.
    writeFileSync(
      path.join(home, 'config.yaml'),
      'stt:\n  enabled: true\n  local:\n    model: base\ntts:\n  provider: edge\n  edge:\n    voice: ar-SA-ZariyahNeural\n',
    );
    const hub = await hubWith(fake.fetchImpl, home);
    await addPreset(hub, 'groq');
    await addPreset(hub, 'openai');
    const config = () =>
      YAML.parse(readFileSync(path.join(home, 'config.yaml'), 'utf8')) as {
        stt: Record<string, unknown>;
        tts: Record<string, unknown>;
      };
    const groqStt = await rowOf(hub, 'stt', 'groq-stt');
    const openaiTts = await rowOf(hub, 'tts', 'openai-tts');
    const groqTts = await rowOf(hub, 'tts', 'groq-tts');

    // Nothing chosen: Hermes's own voice is left as it was.
    expect(config().tts).toMatchObject({ provider: 'edge' });

    const chosen = await authed(hub, hub.token, {
      method: 'PATCH',
      url: '/api/v1/models/speech',
      payload: {
        stt_provider_id: groqStt.id,
        tts_provider_id: openaiTts.id,
        providers: [
          { id: groqStt.id, settings: { language: 'ar' } },
          { id: openaiTts.id, settings: { voice: 'coral', model: 'gpt-4o-mini-tts' } },
        ],
      },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(config().stt).toEqual({
      enabled: true,
      local: { model: 'base' },
      provider: 'groq',
      groq: { model: 'whisper-large-v3-turbo', language: 'ar' },
    });
    expect(config().tts).toMatchObject({
      provider: 'openai',
      openai: { model: 'gpt-4o-mini-tts', voice: 'coral' },
      edge: { voice: 'ar-SA-ZariyahNeural' },
    });

    // The language taken away: Hermes detects it again.
    await authed(hub, hub.token, {
      method: 'PATCH',
      url: '/api/v1/models/speech',
      payload: { providers: [{ id: groqStt.id, settings: { language: null } }] },
    });
    expect(config().stt.groq).toEqual({ model: 'whisper-large-v3-turbo' });

    // Groq's voices are not something Hermes can speak with: its TTS stays as it was.
    await authed(hub, hub.token, {
      method: 'PATCH',
      url: '/api/v1/models/speech',
      payload: { tts_provider_id: groqTts.id },
    });
    expect(config().tts).toMatchObject({ provider: 'openai' });
  });
});
