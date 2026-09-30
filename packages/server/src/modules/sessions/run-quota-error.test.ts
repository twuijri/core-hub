/**
 * A turn whose provider ran out of quota (the model gateway, ADR 0029) fails as `rate_limited`
 * with the provider's and the model's names in `Run.error.details`, and its message in the
 * person's language (owner, 2026-09-30: «<provider> ran out of quota for <model> — pick
 * another model» instead of an agent's "Internal error: API Error: 429 {…}").
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { testHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);
const validRun = ajv.compile({
  $ref: '#/components/schemas/Run',
  components: document?.components ?? {},
});

const DETAILS = {
  reason: 'quota_exhausted',
  provider: 'CLI Proxy',
  model: 'Gemini 3.8 Flash High',
  provider_id: '01M3RXDJSY585RXYGSGJ4BW9EX',
  model_id: 'gemini-3.8-flash-high',
};

async function failedRun(language: 'ar' | 'en') {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({
      script: [
        {
          type: 'failed',
          code: 'rate_limited',
          message:
            'CLI Proxy ran out of quota for Gemini 3.8 Flash High. Pick another model for this chat.',
          details: DETAILS,
        },
      ],
    }),
  });
  const h = await testHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
  const headers = { 'x-hub-profile': 'default', 'accept-language': language };
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers,
    payload: { agent_id: AGENT_ID },
  });
  const id = (created.json() as { id: string }).id;
  const accepted = await h.app.inject({
    method: 'POST',
    url: `/api/v1/sessions/${id}/runs`,
    headers,
    payload: { content: [{ type: 'text', text: 'هلا' }] },
  });
  const runId = (accepted.json() as { run_id: string }).run_id;
  let run: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    run = (
      await h.app.inject({ method: 'GET', url: `/api/v1/sessions/${id}/runs/${runId}`, headers })
    ).json() as Record<string, unknown>;
    if (run.finished_at) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await h.close();
  return run;
}

describe('a turn whose provider ran out of quota', () => {
  it('fails as rate_limited, naming the provider and the model, in the contract shape', async () => {
    const run = await failedRun('en');
    expect(run.status).toBe('failed');
    expect(run.error).toEqual({
      code: 'rate_limited',
      error:
        'CLI Proxy ran out of quota for Gemini 3.8 Flash High. Pick another model for this chat.',
      details: DETAILS,
    });
    expect(validRun(run), JSON.stringify(validRun.errors)).toBe(true);
  });

  it('says it in the person’s language', async () => {
    const run = await failedRun('ar');
    expect((run.error as { error: string }).error).toBe(
      'نفدت حصة «CLI Proxy» من «Gemini 3.8 Flash High». اختر نموذجًا آخر لهذه المحادثة.',
    );
  });
});
