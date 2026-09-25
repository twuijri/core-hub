// `pnpm contract:test`: speech through the generated TypeScript client (contract decision §55) —
// `models.transcribe` with the multipart body a browser sends, and `models.synthesize` read as
// bytes — every answer's status documented for the operation and its body valid against the
// schema the contract gives that status. Before §55 `models.transcribe` answered `501`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';

/** A scripted OpenAI: the model list, one transcript and a few bytes of speech. */
let transcript = 'افتح آخر محادثة';
const scriptedOpenAi = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/audio/transcriptions')) return json({ text: transcript });
  if (url.endsWith('/audio/speech')) {
    return new Response(new Uint8Array([0x49, 0x44, 0x33]), {
      headers: { 'content-type': 'audio/mpeg' },
    });
  }
  return json({ data: [] });
}) as typeof fetch;

function recording(extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'a.webm');
  for (const [name, value] of Object.entries(extra)) form.append(name, value);
  return form;
}

describe.skipIf(!doc)('contract: speech', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;
  let anonymous: HubClient;

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { body?: unknown; bytes?: boolean; as?: HubClient } = {},
  ): Promise<{ data: unknown; headers: Headers | null }> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    let headers: Headers | null = null;
    try {
      const res = await (init.as ?? client).raw(op.method as ClientMethod, op.path, {
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.bytes ? { responseKind: 'bytes' as const } : {}),
      });
      status = res.status;
      data = res.data;
      headers = res.headers;
    } catch (error) {
      if (!(error instanceof HubApiError)) throw error;
      status = error.status;
      data = error.body;
    }
    expect(status, `${operationId}: ${JSON.stringify(data)}`).toBe(expectedStatus);
    const schema = responseSchema(op, status);
    if (schema) expect(schemas.validate(schema, data), operationId).toEqual([]);
    if (status >= 400) {
      expect(data).toMatchObject({ error: expect.any(String), code: expect.any(String) });
    }
    return { data, headers };
  }

  beforeAll(async () => {
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { models: { fetchImpl: scriptedOpenAi } },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const options = { baseUrl, apiBase: serverBasePath(document), profile: 'default' as const };
    client = createHubClient({ ...options, token: () => token });
    anonymous = createHubClient(options);
  });
  afterAll(async () => {
    await hub.close();
  });

  it('signs in', async () => {
    const { data } = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
      as: anonymous,
    });
    token = (data as { access_token: string }).access_token;
  });

  it('transcribe: 401 without a token, 422 no_stt_provider before one is chosen', async () => {
    await call('models.transcribe', 401, { body: recording(), as: anonymous });
    const { data } = await call('models.transcribe', 422, { body: recording() });
    expect(data).toMatchObject({ details: { reason: 'no_stt_provider' } });
  });

  it('transcribe: 400 when there is no recording in the form', async () => {
    const form = new FormData();
    form.append('language', 'ar');
    await call('models.transcribe', 400, { body: form });
  });

  it('transcribe and synthesize answer per the document once OpenAI is chosen', async () => {
    await call('models.createProvider', 201, {
      body: { preset: 'openai', label: 'OpenAI', kind: 'llm', api_key: 'sk-contract' },
    });
    const { data: speech } = await call('models.getSpeech', 200);
    const sides = speech as {
      stt: { providers: { id: string; slug: string }[] };
      tts: { providers: { id: string; slug: string }[] };
    };
    const stt = sides.stt.providers.find((row) => row.slug === 'openai-stt')!;
    const tts = sides.tts.providers.find((row) => row.slug === 'openai-tts')!;
    await call('models.updateSpeech', 200, {
      body: { stt_provider_id: stt.id, tts_provider_id: tts.id },
    });

    const { data } = await call('models.transcribe', 200, {
      body: recording({ language: 'ar', duration_ms: '1800' }),
    });
    expect(data).toEqual({
      text: 'افتح آخر محادثة',
      language: 'ar',
      duration_ms: 1800,
      provider_id: stt.id,
      model: 'whisper-1',
    });

    transcript = '';
    const silent = await call('models.transcribe', 400, { body: recording() });
    expect(silent.data).toMatchObject({ details: { reason: 'no_speech' } });

    const spoken = await call('models.synthesize', 200, {
      body: { text: 'تم.', language: 'ar' },
      bytes: true,
    });
    expect(new Uint8Array(spoken.data as ArrayBuffer)).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
    expect(spoken.headers?.get('x-speech-provider')).toBe('openai-tts');
  });
});
