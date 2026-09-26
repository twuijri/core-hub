/**
 * Speech over HTTP (contract decision §63): a recording in, its words out, through the
 * profile's chosen speech-to-text provider — and a reply read aloud through its
 * text-to-speech provider. Two kinds of provider are exercised:
 *
 * - OpenAI's own rows (`openai-stt` / `openai-tts`) against a scripted `fetch`, which
 *   checks what the hub actually sends: the `file` part, the model, the language hint and
 *   the key;
 * - somebody's own OpenAI-compatible speech server with no key, as a real HTTP server on
 *   a loopback port reached with the real `fetch`, so the multipart body travels the way
 *   it does in production.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

type Hub = TestHub & { token: string };

interface SpeechRow {
  id: string;
  slug: string;
}

/** The body a browser's `FormData` makes, as `inject` needs it. */
async function multipart(fields: Record<string, string | Blob | [Blob, string]>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) form.append(name, value[0], value[1]);
    else form.append(name, value);
  }
  const request = new Request('http://local.test/', { method: 'POST', body: form });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
  };
}

const WEBM = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03])], {
  type: 'audio/webm;codecs=opus',
});

async function transcribe(hub: Hub, fields: Record<string, string | Blob | [Blob, string]>) {
  const body = await multipart(fields);
  return authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/speech/transcriptions',
    payload: body.payload,
    headers: body.headers,
  });
}

async function speechRows(hub: Hub): Promise<{ stt: SpeechRow[]; tts: SpeechRow[] }> {
  const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/speech' });
  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    stt: { providers: SpeechRow[] };
    tts: { providers: SpeechRow[] };
  };
  return { stt: body.stt.providers, tts: body.tts.providers };
}

async function addOpenAi(hub: Hub) {
  const response = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/models/providers',
    payload: { preset: 'openai', label: 'OpenAI', kind: 'llm', api_key: 'sk-openai-voice' },
  });
  expect(response.statusCode, response.body).toBe(201);
  const rows = await speechRows(hub);
  const stt = rows.stt.find((row) => row.slug === 'openai-stt')!;
  const tts = rows.tts.find((row) => row.slug === 'openai-tts')!;
  const chosen = await authed(hub, hub.token, {
    method: 'PATCH',
    url: '/api/v1/models/speech',
    payload: { stt_provider_id: stt.id, tts_provider_id: tts.id },
  });
  expect(chosen.statusCode, chosen.body).toBe(200);
  return { stt, tts };
}

/** What a scripted OpenAI saw of one transcription request. */
interface Seen {
  url: string;
  authorization: string | null;
  file: File | null;
  model: string | null;
  language: string | null;
}

function scriptedOpenAi(answer: () => { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('/audio/transcriptions')) {
      const form = init.body as FormData;
      const headers = new Headers(init.headers);
      const file = form.get('file');
      seen.push({
        url,
        authorization: headers.get('authorization'),
        file: file instanceof File ? file : null,
        model: form.get('model') as string | null,
        language: form.get('language') as string | null,
      });
      const { status, json } = answer();
      return new Response(JSON.stringify(json), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // The catalogue refresh a new provider starts: nothing to list.
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const hubs: Hub[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function hubWith(fetchImpl?: typeof fetch): Promise<Hub> {
  const hub = await signedInHub({}, fetchImpl ? { models: { fetchImpl } } : {});
  hubs.push(hub);
  return hub;
}

describe('models.transcribe', () => {
  it('sends the recording to the chosen OpenAI row and returns its words', async () => {
    const openai = scriptedOpenAi(() => ({ json: { text: '  شغّل الاختبارات  ' } }));
    const hub = await hubWith(openai.fetchImpl);
    const { stt } = await addOpenAi(hub);

    const response = await transcribe(hub, {
      audio: [WEBM, 'blob'],
      language: 'ar-SA',
      duration_ms: '2400',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      text: 'شغّل الاختبارات',
      language: 'ar',
      duration_ms: 2400,
      provider_id: stt.id,
      model: 'gpt-transcribe',
    });

    expect(openai.seen).toHaveLength(1);
    const [call] = openai.seen;
    expect(call!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(call!.authorization).toBe('Bearer sk-openai-voice');
    expect(call!.model).toBe('gpt-transcribe');
    // Whisper takes ISO-639-1; the browser's tag is cut to it.
    expect(call!.language).toBe('ar');
    // A browser calls it `blob`; the server tells the format by the extension.
    expect(call!.file?.name).toBe('blob.webm');
    expect(call!.file?.type).toBe('audio/webm');
    expect(new Uint8Array(await call!.file!.arrayBuffer())).toEqual(
      new Uint8Array(await WEBM.arrayBuffer()),
    );
  });

  it('asks with no language when the person chose auto-detect', async () => {
    const openai = scriptedOpenAi(() => ({
      json: { text: 'hello', language: 'english', duration: 1.25 },
    }));
    const hub = await hubWith(openai.fetchImpl);
    await addOpenAi(hub);
    const response = await transcribe(hub, { audio: [WEBM, 'take.webm'] });
    expect(response.statusCode, response.body).toBe(200);
    // The provider's own figures win over nothing.
    expect(response.json()).toMatchObject({
      text: 'hello',
      language: 'english',
      duration_ms: 1250,
    });
    expect(openai.seen[0]!.language).toBeNull();
  });

  it('starts a new OpenAI speech-to-text row on gpt-transcribe, not the retiring whisper-1', async () => {
    const openai = scriptedOpenAi(() => ({ json: { text: 'hi' } }));
    const hub = await hubWith(openai.fetchImpl);
    const { stt } = await addOpenAi(hub);
    const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/speech' });
    const row = (
      listed.json() as { stt: { providers: { id: string; settings: { model: string | null } }[] } }
    ).stt.providers.find((item) => item.id === stt.id);
    expect(row?.settings.model).toBe('gpt-transcribe');
    await transcribe(hub, { audio: [WEBM, 'take.webm'] });
    expect(openai.seen[0]!.model).toBe('gpt-transcribe');
  });

  it('never rewrites the model an existing speech-to-text row already holds', async () => {
    const openai = scriptedOpenAi(() => ({ json: { text: 'hi' } }));
    const hub = await hubWith(openai.fetchImpl);
    const { stt } = await addOpenAi(hub);
    // A row made by an older hub, when whisper-1 was the preset's default: written as it
    // was stored then, straight into the database.
    const sqlite = new Database(path.join(hub.dataDir, 'hub.sqlite'));
    try {
      sqlite
        .prepare('UPDATE providers SET settings = ? WHERE id = ?')
        .run(JSON.stringify({ model: 'whisper-1', language: null, voice: null }), stt.id);
    } finally {
      sqlite.close();
    }
    const modelOf = async () => {
      const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/speech' });
      return (
        listed.json() as {
          stt: { providers: { id: string; settings: { model: string | null } }[] };
        }
      ).stt.providers.find((item) => item.id === stt.id)?.settings.model;
    };
    expect(await modelOf()).toBe('whisper-1');
    // Saving the key again and choosing the row again touch neither the row's model…
    const provider = (
      (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/providers' })).json() as {
        items: { id: string; slug: string }[];
      }
    ).items.find((item) => item.slug === 'openai')!;
    const rekey = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/models/providers/${provider.id}`,
      payload: { api_key: 'sk-openai-voice-2' },
    });
    expect(rekey.statusCode, rekey.body).toBe(200);
    const chosen = await authed(hub, hub.token, {
      method: 'PATCH',
      url: '/api/v1/models/speech',
      payload: { stt_provider_id: stt.id },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(await modelOf()).toBe('whisper-1');
    // …nor what a transcription asks for.
    await transcribe(hub, { audio: [WEBM, 'take.webm'] });
    expect(openai.seen.at(-1)!.model).toBe('whisper-1');
  });

  it('says no speech-to-text provider is chosen, never an empty transcript', async () => {
    const hub = await hubWith();
    const response = await transcribe(hub, { audio: [WEBM, 'take.webm'] });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'agent_unavailable',
      error: 'No speech-to-text provider is chosen for this profile.',
      details: { reason: 'no_stt_provider' },
    });
  });

  it('answers 400 no_speech for a silent take', async () => {
    const openai = scriptedOpenAi(() => ({ json: { text: '   ' } }));
    const hub = await hubWith(openai.fetchImpl);
    await addOpenAi(hub);
    const response = await transcribe(hub, { audio: [WEBM, 'take.webm'] });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      details: { reason: 'no_speech' },
    });
  });

  it("relays the provider's refusal in its own words", async () => {
    const openai = scriptedOpenAi(() => ({
      status: 401,
      json: { error: { message: 'Incorrect API key provided' } },
    }));
    const hub = await hubWith(openai.fetchImpl);
    await addOpenAi(hub);
    const response = await transcribe(hub, { audio: [WEBM, 'take.webm'] });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'agent_unavailable',
      details: {
        reason: 'unauthorized',
        detail: 'Incorrect API key provided',
        provider: 'openai-stt',
      },
    });
    expect(response.body).not.toContain('sk-openai-voice');
  });

  it('refuses a request with no recording, or one that is not multipart', async () => {
    const hub = await hubWith();
    const empty = await transcribe(hub, { language: 'en' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: 'validation_failed' });

    const json = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/speech/transcriptions',
      payload: { audio: 'not a file' },
    });
    expect(json.statusCode).toBe(400);
    expect(json.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a recording over 25 MB with the ceiling', async () => {
    const hub = await hubWith();
    const big = new Blob([new Uint8Array(25 * 1024 * 1024 + 10)], { type: 'audio/wav' });
    const response = await transcribe(hub, { audio: [big, 'long.wav'] });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: 'payload_too_large',
      details: { max_bytes: 25 * 1024 * 1024 },
    });
  });
});

/**
 * A self-hosted OpenAI-compatible speech server (Speaches, LocalAI, faster-whisper-server
 * and the like), scripted: it wants no key, transcribes whatever it receives into a fixed
 * sentence after checking the parts are there, and speaks a few bytes of "audio".
 */
async function speechServer(): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      requests.push(`${request.method} ${request.url}`);
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.headers.authorization) return json(400, { error: 'no key expected here' });
      if (request.method === 'GET' && request.url === '/v1/models') {
        return json(200, { data: [{ id: 'whisper-small' }, { id: 'kokoro' }] });
      }
      if (request.method === 'POST' && request.url === '/v1/audio/transcriptions') {
        const type = request.headers['content-type'] ?? '';
        if (!type.startsWith('multipart/form-data')) return json(415, { error: 'multipart only' });
        if (!/name="file"; filename="dictation\.webm"/.test(body)) {
          return json(400, { error: 'no file part' });
        }
        if (!/name="model"\r\n\r\nwhisper-small\r\n/.test(body)) {
          return json(400, { error: 'unknown model' });
        }
        return json(200, { text: 'مرحبا من خادم الكلام' });
      }
      if (request.method === 'POST' && request.url === '/v1/audio/speech') {
        const asked = JSON.parse(body) as { input?: string; voice?: string; model?: string };
        if (asked.voice !== 'af_sky' || asked.model !== 'kokoro' || !asked.input) {
          return json(400, { error: 'bad speech request' });
        }
        response.writeHead(200, { 'content-type': 'audio/mpeg' });
        return response.end(Buffer.from('ID3-fake-mp3'));
      }
      return json(404, { error: 'not found' });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

describe('an OpenAI-compatible speech server of your own', () => {
  it('transcribes and speaks end to end, with no key, over real HTTP', async () => {
    const server = await speechServer();
    const hub = await hubWith(globalThis.fetch);

    const add = async (kind: 'stt' | 'tts', label: string) => {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/models/providers',
        payload: { label, kind, base_url: server.baseUrl },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json() as { id: string; kind: string };
    };
    const stt = await add('stt', 'Local whisper');
    const tts = await add('tts', 'Local voice');
    expect([stt.kind, tts.kind]).toEqual(['stt', 'tts']);

    const chosen = await authed(hub, hub.token, {
      method: 'PATCH',
      url: '/api/v1/models/speech',
      payload: {
        stt_provider_id: stt.id,
        tts_provider_id: tts.id,
        providers: [
          { id: stt.id, settings: { model: 'whisper-small' } },
          { id: tts.id, settings: { model: 'kokoro', voice: 'af_sky' } },
        ],
      },
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    // A server that wants no key is ready without one.
    expect(chosen.json()).toMatchObject({
      stt: { ready: true, reason: null, active_provider_id: stt.id },
      tts: { ready: true, reason: null, active_provider_id: tts.id },
    });

    const heard = await transcribe(hub, {
      audio: [WEBM, 'dictation.webm'],
      duration_ms: '900',
    });
    expect(heard.statusCode, heard.body).toBe(200);
    expect(heard.json()).toMatchObject({
      text: 'مرحبا من خادم الكلام',
      duration_ms: 900,
      provider_id: stt.id,
      model: 'whisper-small',
    });

    const spoken = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/speech/speech',
      payload: { text: 'اكتملت الاختبارات.', language: 'ar' },
    });
    expect(spoken.statusCode, spoken.body).toBe(200);
    expect(spoken.headers['content-type']).toContain('audio/mpeg');
    expect(spoken.rawPayload.toString()).toBe('ID3-fake-mp3');
    expect(spoken.headers['x-speech-provider']).toMatch(/^custom-local-voice/);

    expect(server.requests).toContain('POST /v1/audio/transcriptions');
    expect(server.requests).toContain('POST /v1/audio/speech');
  });
});
