// `pnpm contract:test`: what the web's workflow editor calls (DECISIONS §52), driven through
// the generated TypeScript client — the live check of an unsaved drawing, every profile's
// workflows, and a run whose steps say what they produced and which way they went. Every
// answer is validated against the schema the contract documents for its status.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@corehub/contracts';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { workflowEngineFor } from '../../src/modules/schedules/index.js';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const PASSWORD = 'contract-test-password';
const AGENT = '01KAGENTXYZ000000000000000';

const node = (id: string, kind: string, input: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  title: id,
  agent_id: kind === 'agent' ? AGENT : null,
  model: null,
  provider: null,
  reasoning_effort: null,
  skills: [],
  input,
  approval_required: false,
  position: { x: 0, y: 0 },
  ...extra,
});

describe.skipIf(!doc)('contract: the workflow editor', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;

  async function call(
    operationId: string,
    expectedStatus: number,
    init: {
      params?: Record<string, string>;
      body?: unknown;
      query?: Record<string, string>;
      profile?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.query ? { query: init.query } : {}),
        ...(init.profile ? { headers: { 'X-Hub-Profile': init.profile } } : {}),
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
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
      runner: new FakeAgentRunner({
        script: [{ type: 'message_delta', text: 'تم الفحص.' }, { type: 'completed' }],
      }),
      agentTimeoutMs: 5_000,
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    client = createHubClient({
      baseUrl,
      apiBase: serverBasePath(document),
      profile: 'default',
      token: () => token,
    });
    const login = await call('auth.login', 200, {
      body: { username: 'admin', password: PASSWORD },
    });
    token = login.access_token as string;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('validateWorkflow: a sound drawing, a broken one, and a body that is not a drawing', async () => {
    const good = await call('schedules.validateWorkflow', 200, {
      body: {
        name: 'x',
        nodes: [node('ask', 'agent', 'افحص'), node('tell', 'notify', '{{steps.ask.output}}')],
        edges: [{ id: 'e1', from: 'ask', to: 'tell', route: 'success' }],
      },
    });
    expect(good).toEqual({ valid: true, problems: [], warnings: [] });

    const bad = await call('schedules.validateWorkflow', 200, {
      body: { nodes: [node('wait', 'delay', 'soon')], edges: [] },
    });
    expect(bad.valid).toBe(false);
    expect(bad.problems).toEqual([
      expect.objectContaining({ code: 'delay_out_of_range', node_id: 'wait', edge_id: null }),
    ]);

    await call('schedules.validateWorkflow', 400, { body: { nodes: [{ id: 'no kind' }] } });
  });

  it('listWorkflows with profiles=all, and a run whose steps carry output and route', async () => {
    const workflow = await call('schedules.createWorkflow', 201, {
      body: {
        name: 'فحص ثم إشعار',
        nodes: [node('ask', 'agent', 'افحص'), node('tell', 'notify', 'قال: {{steps.ask.output}}')],
        edges: [{ id: 'e1', from: 'ask', to: 'tell', route: 'success' }],
      },
    });
    const all = await call('schedules.listWorkflows', 200, { query: { profiles: 'all' } });
    expect((all.items as Array<Record<string, unknown>>).map((w) => w.id)).toContain(workflow.id);

    const started = await call('schedules.runWorkflow', 202, {
      params: { workflow_id: workflow.id as string },
      body: { input: null },
    });
    await workflowEngineFor(hub.app).settled();
    const run = await call('schedules.getWorkflowRun', 200, {
      params: { workflow_run_id: started.workflow_run_id as string },
    });
    expect(run.status).toBe('succeeded');
    const steps = run.steps as Array<Record<string, unknown>>;
    expect(steps.find((s) => s.node_id === 'ask')).toMatchObject({
      output: 'تم الفحص.',
      route: 'success',
    });
    expect(steps.find((s) => s.node_id === 'tell')).toMatchObject({
      output: 'قال: تم الفحص.',
      route: 'success',
    });
    const history = await call('schedules.listWorkflowRuns', 200, {
      params: { workflow_id: workflow.id as string },
    });
    expect((history.items as unknown[]).length).toBe(1);
  });
});
