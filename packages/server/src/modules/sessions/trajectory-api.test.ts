/**
 * `GET /sessions/{id}/trajectory` over the real routes (contract `sessions.getTrajectory`,
 * decision §42): a scripted run with tool calls answers a document that matches the
 * contract's `Trajectory`, `download=true` sends it as the session log file, and another
 * profile's conversation is not found.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadOpenApiDocument } from '@majlis/contracts';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const document = loadOpenApiDocument();
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);

function schemaErrors(name: string, data: unknown): string[] {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${name}`,
    components: document?.components ?? {},
  });
  return validate(data)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

async function hub(): Promise<TestHub> {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({
      script: [
        { type: 'message_delta', text: 'سأقرأ الملف.' },
        { type: 'tool_started', ref: 't1', name: 'read_file', input: { path: 'README.md' } },
        { type: 'tool_completed', ref: 't1', output: '# README' },
        { type: 'tool_started', ref: 't2', name: 'shell', input: { command: 'false' } },
        { type: 'tool_failed', ref: 't2', output: 'exit 1', exitCode: 1 },
        { type: 'message_delta', text: 'فشل الأمر.' },
        { type: 'usage', inputTokens: 40, outputTokens: 12 },
        { type: 'completed' },
      ],
    }),
  });
  return testHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
}

async function get(app: FastifyInstance, url: string, profile = 'default') {
  return app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { 'x-hub-profile': profile } });
}

describe('sessions.getTrajectory', () => {
  it('answers the steps and metrics of a run with tool calls, in the contract shape', async () => {
    const h = await hub();
    try {
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: { 'x-hub-profile': 'default' },
        payload: { agent_id: AGENT_ID },
      });
      const id = (created.json() as { id: string }).id;
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${id}/runs`,
        headers: { 'x-hub-profile': 'default' },
        payload: { content: [{ type: 'text', text: 'اقرأ الملف ثم شغّل الأمر' }] },
      });

      let body: {
        live: boolean;
        timing: string;
        steps: Array<{
          kind: string;
          status: string;
          text: string | null;
          tool_call_only: boolean;
        }>;
        metrics: Record<string, unknown>;
      } = { live: true, timing: 'none', steps: [], metrics: {} };
      for (let attempt = 0; attempt < 50 && body.live; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        body = (await get(h.app, `/sessions/${id}/trajectory`)).json();
      }

      expect(schemaErrors('Trajectory', body)).toEqual([]);
      expect(body.live).toBe(false);
      expect(body.timing).toBe('full');
      // Between the two calls the model may hold the floor for a few milliseconds, or none:
      // a silent turn that only hands over to the next tool appears only when it took time.
      const said = body.steps.filter((s) => !(s.kind === 'turn' && s.tool_call_only));
      expect(said.map((s) => [s.kind, s.status, s.text])).toEqual([
        ['input', 'succeeded', 'اقرأ الملف ثم شغّل الأمر'],
        ['turn', 'succeeded', 'سأقرأ الملف.'],
        ['tool', 'succeeded', null],
        ['tool', 'failed', null],
        ['turn', 'succeeded', 'فشل الأمر.'],
      ]);
      expect(body.metrics).toMatchObject({
        exchanges: 1,
        turns: body.steps.filter((s) => s.kind === 'turn').length,
        steps: body.steps.length,
        tool_calls: 2,
        failed_tool_calls: 1,
        input_tokens: 40,
        output_tokens: 12,
        cache_hit_pct: null,
      });

      const log = await get(h.app, `/sessions/${id}/trajectory?download=true`);
      expect(log.statusCode).toBe(200);
      expect(log.headers['content-disposition']).toBe(
        `attachment; filename="session-${id}-log.json"`,
      );
      expect(schemaErrors('Trajectory', log.json())).toEqual([]);

      // Another profile does not see this conversation.
      const elsewhere = await get(h.app, `/sessions/${id}/trajectory`, 'other');
      expect([403, 404]).toContain(elsewhere.statusCode);
    } finally {
      await h.close();
    }
  });

  it('answers 404 for a conversation that does not exist', async () => {
    const h = await hub();
    try {
      const res = await get(h.app, '/sessions/01J8QK3ZR2W7M5N4P6T8V9X0ZZ/trajectory');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
    } finally {
      await h.close();
    }
  });
});
