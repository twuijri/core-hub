// `pnpm contract:test`: what the web's workflow editor calls (DECISIONS §52), driven through
// the generated TypeScript client — the live check of an unsaved drawing, every profile's
// workflows, and a run whose steps say what they produced and which way they went. Every
// answer is validated against the schema the contract documents for its status.
import { createHmac } from 'node:crypto';
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
  let baseUrl = '';

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
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
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

  it('validateWorkflow checks a drawing nobody has named yet; saving still needs a name', async () => {
    // A new workflow in an editor has no name until someone types one (DECISIONS §121).
    const drawing = {
      nodes: [node('ask', 'agent', 'افحص'), node('wait', 'delay', 'soon')],
      edges: [{ id: 'e1', from: 'ask', to: 'wait', route: 'success' }],
    };
    for (const name of ['', '   ']) {
      const unnamed = await call('schedules.validateWorkflow', 200, {
        body: { name, ...drawing },
      });
      expect(unnamed.valid).toBe(false);
      expect(unnamed.problems).toEqual([
        expect.objectContaining({ code: 'delay_out_of_range', node_id: 'wait', edge_id: null }),
      ]);
    }
    const sound = await call('schedules.validateWorkflow', 200, {
      body: { name: '', nodes: [node('ask', 'agent', 'افحص')], edges: [] },
    });
    expect(sound).toEqual({ valid: true, problems: [], warnings: [] });

    // Creating keeps its rule: an empty name is refused by the contract, a blank one by the hub.
    const empty = await call('schedules.createWorkflow', 400, {
      body: { name: '', nodes: [node('ask', 'agent', 'افحص')], edges: [] },
    });
    expect((empty.details as { fields: { path: string }[] }).fields).toEqual([
      expect.objectContaining({ path: 'name' }),
    ]);
    await call('schedules.createWorkflow', 409, {
      body: { name: '   ', nodes: [node('ask', 'agent', 'افحص')], edges: [] },
    });
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

  it('an inbound ClickUp trigger: created, secret stored, a signed delivery runs, the log and the run say so (§123)', async () => {
    const secret = 'contract-test-clickup-secret';
    const workflow = await call('schedules.createWorkflow', 201, {
      body: {
        name: 'من ClickUp',
        nodes: [
          node('gate', 'condition', '', {
            rules: {
              match: 'all',
              items: [{ path: 'trigger.event', operator: '==', value: 'taskCreated' }],
            },
          }),
          node('tell', 'notify', 'مهمة {{trigger.task_id}}'),
        ],
        edges: [{ id: 'e1', from: 'gate', to: 'tell', route: 'success' }],
      },
    });
    const workflowId = workflow.id as string;
    const trigger = await call('schedules.createWorkflowTrigger', 201, {
      params: { workflow_id: workflowId },
      body: { preset: 'clickup', events: ['taskCreated', 'taskUpdated'] },
    });
    expect(trigger.secret_stored).toBe(false);
    const stored = await call('schedules.updateWorkflowTrigger', 200, {
      params: { workflow_trigger_id: trigger.id as string },
      body: { secret },
    });
    expect(stored.secret_stored).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(secret);
    const listed = await call('schedules.listWorkflowTriggers', 200, {
      params: { workflow_id: workflowId },
    });
    expect((listed.items as unknown[]).length).toBe(1);

    // The public door, with the bytes ClickUp would send and their signature.
    const raw =
      '{"event":"taskCreated","task_id":"c-1","webhook_id":"w","history_items":[{"id":"77"}]}';
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    const receiveOp = ops.get('schedules.receiveWorkflowTrigger')!;
    const res = await fetch(`${baseUrl}${trigger.path as string}`, {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'application/json', 'x-signature': signature },
    });
    const receipt = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(receipt)).toBe(202);
    expect(schemas.validate(responseSchema(receiveOp, 202)!, receipt)).toEqual([]);
    await workflowEngineFor(hub.app).settled();

    const tested = await call('schedules.testWorkflowTrigger', 200, {
      params: { workflow_trigger_id: trigger.id as string },
      body: { event: 'taskUpdated' },
    });
    expect(tested).toMatchObject({ test: true, status: 'run_started', event: 'taskUpdated' });
    await workflowEngineFor(hub.app).settled();

    const log = await call('schedules.listWorkflowTriggerDeliveries', 200, {
      params: { workflow_trigger_id: trigger.id as string },
    });
    expect(
      (log.items as Array<Record<string, unknown>>).map((d) => [d.status, d.filtered]),
    ).toEqual([
      ['run_succeeded', true],
      ['run_succeeded', false],
    ]);
    const runs = await call('schedules.listWorkflowRuns', 200, {
      params: { workflow_id: workflowId },
      query: { task_id: 'c-1' },
    });
    expect(runs.items).toEqual([
      expect.objectContaining({
        workflow_trigger_id: trigger.id,
        delivery_id: receipt.delivery_id,
        event_id: '77',
        task_id: 'c-1',
        filtered: false,
      }),
    ]);
    await call('schedules.deleteWorkflowTrigger', 204, {
      params: { workflow_trigger_id: trigger.id as string },
    });
  });

  it('testWorkflowSend: a conversation target is made and posted in; a profile without a bot is a reason (§124)', async () => {
    const result = await call('schedules.testWorkflowSend', 200, {
      body: {
        text: 'رسالة تجريبية',
        send: {
          targets: [
            { platform: 'core_hub', session_id: null, title: 'تقارير', agent_id: AGENT },
            { platform: 'telegram', chat_id: '-1001', formatting: 'html' },
          ],
        },
      },
    });
    expect(result.status).toBe('partial');
    // §137: the Telegram target's formatting, and what each target did, as the contract says.
    expect(result).toMatchObject({ formatting: 'html', parse_mode: 'HTML', chat_id: '-1001' });
    expect((result.targets as Array<{ platform: string }>).map((t) => t.platform)).toEqual([
      'core_hub',
      'telegram',
    ]);
    const delivered = result.delivered_to as string[];
    expect(delivered).toHaveLength(1);
    const sessionId = delivered[0]!.replace('core_hub:', '');
    expect((result.failures as Array<{ reason: string }>)[0]!.reason).toContain(
      'TELEGRAM_BOT_TOKEN',
    );
    const history = await call('sessions.listMessages', 200, { params: { session_id: sessionId } });
    expect(JSON.stringify(history.items)).toContain('رسالة تجريبية');
    await call('schedules.testWorkflowSend', 400, {
      body: { text: 'x', send: { targets: [{ platform: 'fax' }] } },
    });
    await call('schedules.testWorkflowSend', 400, {
      body: {
        text: 'x',
        send: { targets: [{ platform: 'telegram', chat_id: '-1001', formatting: 'Markdown' }] },
      },
    });
  });

  it('testWorkflowStep and a failure alert, as the contract says (§127)', async () => {
    const answer = await call('schedules.testWorkflowStep', 200, {
      body: {
        node: node('gate', 'condition', 'trigger.event == taskCreated'),
        trigger: { event: 'taskCreated' },
      },
    });
    expect(answer).toMatchObject({ answer: true, executed: true, error: null });
    const workflow = await call('schedules.createWorkflow', 201, {
      body: {
        name: 'مع تنبيه',
        nodes: [node('tell', 'notify', 'x')],
        edges: [],
        on_failure: { inbox: true, send: null },
      },
    });
    expect(workflow.on_failure).toEqual({ inbox: true, send: null });
    const run = await call('schedules.runWorkflow', 202, {
      params: { workflow_id: workflow.id as string },
      body: { input: null },
    });
    await workflowEngineFor(hub.app).settled();
    const done = await call('schedules.getWorkflowRun', 200, {
      params: { workflow_run_id: run.workflow_run_id as string },
    });
    expect(done.phase).toBe('completed');
  });
});
