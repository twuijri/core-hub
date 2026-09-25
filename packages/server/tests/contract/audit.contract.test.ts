// `pnpm contract:test`: the Usage and Skills usage reports (contract decision §50) through the
// generated TypeScript client, every answer validated against the schema the contract documents
// for its status — seeded ledgers, `profiles=all`, one agent, the caller's calendar, and the
// refusals (a period outside 1–365 days, an agent id that is not one, nobody signed in).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { requireSqlite } from '../../src/lib/db.js';
import { defaultWorkspace } from '../../src/modules/auth/index.js';
import { skillUses, usageRecords } from '../../src/modules/audit/schema.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';
const AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0A1';
const OTHER_AGENT = '01J8QK3ZR2W7M5N4P6T8V9X0A2';

describe.skipIf(!doc)('contract: the Usage and Skills usage reports', () => {
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
    init: { query?: Record<string, string | number>; body?: unknown; as?: HubClient } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await (init.as ?? client).raw(op.method as ClientMethod, op.path, {
        ...(init.query ? { query: init.query } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      status = res.status;
      data = res.data;
    } catch (error) {
      if (!(error instanceof HubApiError)) throw error;
      status = error.status;
      data = error.body;
    }
    expect(status, `${operationId}: ${JSON.stringify(data)}`).toBe(expectedStatus);
    const schema = responseSchema(op, status);
    if (schema) expect(schemas.validate(schema, data), operationId).toEqual([]);
    return (data ?? {}) as Record<string, unknown>;
  }

  beforeAll(async () => {
    hub = await testHub({ HUB_ADMIN_PASSWORD: PASSWORD });
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

  it('signs in and seeds a week of usage and skill use', async () => {
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
      as: anonymous,
    });
    token = login.access_token as string;

    const db = requireSqlite(hub.app.hub.database);
    const workspace = defaultWorkspace(db)!.id;
    const owner = (login.user as { id: string }).id;
    const now = Date.now();
    const base = {
      ownerId: owner,
      workspace,
      sessionId: '01J8QK3ZR2W7M5N4P6T8V9X0S1',
      modelLabel: 'gpt-test',
    };
    db.insert(usageRecords)
      .values([
        {
          ...base,
          id: '01J8QK3ZR2W7M5N4P6T8V9X0U1',
          runId: '01J8QK3ZR2W7M5N4P6T8V9X0R1',
          agentId: AGENT,
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 500,
          costMicroUsd: 2_500,
          costSource: 'estimated',
          recordedAt: new Date(now - 60_000),
        },
        {
          ...base,
          id: '01J8QK3ZR2W7M5N4P6T8V9X0U2',
          runId: '01J8QK3ZR2W7M5N4P6T8V9X0R2',
          agentId: OTHER_AGENT,
          modelLabel: 'claude-test',
          inputTokens: 300,
          outputTokens: 100,
          recordedAt: new Date(now - 3 * 86_400_000),
        },
      ])
      .run();
    db.insert(skillUses)
      .values({
        id: '01J8QK3ZR2W7M5N4P6T8V9X0K1',
        ownerId: owner,
        workspace,
        skill: 'arxiv',
        agentId: AGENT,
        sessionId: base.sessionId,
        runId: '01J8QK3ZR2W7M5N4P6T8V9X0R1',
        usedAt: new Date(now - 60_000),
      })
      .run();
  });

  it('audit.getUsage answers the seeded week in the contract shape', async () => {
    const report = await call('audit.getUsage', 200, { query: { days: 7 } });
    expect(report.period).toMatchObject({ days: 7 });
    expect(report.profiles).toEqual(['default']);
    expect(report.totals).toMatchObject({
      input_tokens: 1_300,
      output_tokens: 300,
      cache_read_tokens: 500,
      cache_write_tokens: null,
      cost_source: 'estimated',
    });
    expect(report.by_day).toHaveLength(7);
    expect((report.by_model as unknown[]).length).toBe(2);
  });

  it('audit.getUsage covers every profile, one agent, and the caller’s calendar', async () => {
    const all = await call('audit.getUsage', 200, { query: { days: 30, profiles: 'all' } });
    expect(all.profiles).toContain('default');
    const one = await call('audit.getUsage', 200, {
      query: { days: 365, agent_id: AGENT, utc_offset_minutes: 180 },
    });
    expect(one.totals).toMatchObject({ input_tokens: 1_000 });
    expect(one.by_day).toHaveLength(365);
    expect((one.agents as unknown[]).length).toBe(2);
  });

  it('audit.getSkillUsage answers what was loaded, and from when it was counted', async () => {
    const report = await call('audit.getSkillUsage', 200, { query: { days: 90 } });
    expect(report.totals).toMatchObject({ uses: 1, top_skill: { skill: 'arxiv', uses: 1 } });
    expect(report.top_series).toEqual(['arxiv']);
    expect(typeof report.counting_since).toBe('string');
    const none = await call('audit.getSkillUsage', 200, {
      query: { days: 7, agent_id: OTHER_AGENT },
    });
    expect(none.totals).toMatchObject({ uses: 0, top_skill: null });
  });

  it('refuses a period outside 1–365 days and an agent id that is not one', async () => {
    await call('audit.getUsage', 400, { query: { days: 0 } });
    await call('audit.getUsage', 400, { query: { days: 366 } });
    await call('audit.getSkillUsage', 400, { query: { agent_id: 'not-an-id' } });
    await call('audit.getUsage', 400, { query: { utc_offset_minutes: 900 } });
  });

  it('answers nobody who is not signed in', async () => {
    await call('audit.getUsage', 401, { as: anonymous });
    await call('audit.getSkillUsage', 401, { as: anonymous });
  });
});
