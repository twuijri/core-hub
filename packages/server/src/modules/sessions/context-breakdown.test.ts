/**
 * `sessions.getContextBreakdown` over the real routes (decision §102): the window by category
 * as the agent reports it, in the contract shape — and `available: false` when the agent
 * cannot tell or has no conversation open, never an error.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type FakeRunnerOptions,
} from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);
const validate = ajv.compile({
  $ref: '#/components/schemas/SessionContextBreakdown',
  components: document?.components ?? {},
});

async function hub(options: FakeRunnerOptions): Promise<TestHub> {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner(options),
  });
  return testHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
}

async function breakdownOf(h: TestHub): Promise<{ status: number; body: unknown }> {
  const created = await h.app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: { 'x-hub-profile': 'default' },
    payload: { agent_id: AGENT_ID },
  });
  const id = (created.json() as { id: string }).id;
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${id}/context`,
    headers: { 'x-hub-profile': 'default' },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('the context window by category', () => {
  it('answers what the agent reports, in the contract shape', async () => {
    const h = await hub({
      contextBreakdown: {
        usedTokens: 48_210,
        windowTokens: 200_000,
        estimated: false,
        categories: [
          { id: 'system_prompt', label: 'System prompt', tokens: 3120 },
          { id: 'conversation', label: 'Conversation', tokens: 29_500 },
        ],
      },
    });
    try {
      const { status, body } = await breakdownOf(h);
      expect(status).toBe(200);
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
      expect(body).toEqual({
        available: true,
        used_tokens: 48_210,
        window_tokens: 200_000,
        estimated: false,
        categories: [
          { id: 'system_prompt', label: 'System prompt', tokens: 3120 },
          { id: 'conversation', label: 'Conversation', tokens: 29_500 },
        ],
      });
    } finally {
      await h.close();
    }
  });

  it('says it is not available when the agent cannot tell or has nothing open', async () => {
    for (const options of [{}, { contextBreakdown: null }] as FakeRunnerOptions[]) {
      const h = await hub(options);
      try {
        const { status, body } = await breakdownOf(h);
        expect(status).toBe(200);
        expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
        expect(body).toMatchObject({ available: false, categories: [] });
      } finally {
        await h.close();
      }
    }
  });

  it('is 404 for a conversation that does not exist', async () => {
    const h = await hub({});
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/sessions/01J8QK3ZR2W7M5N4P6T8V9X0ZZ/context',
        headers: { 'x-hub-profile': 'default' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
