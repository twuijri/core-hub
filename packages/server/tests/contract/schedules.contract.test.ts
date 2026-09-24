// `pnpm contract:test`: the hub firing its own schedules, and a workflow step's approval,
// driven through the generated TypeScript client — every answer validated against the
// schema the contract documents for its status, and every realtime envelope the firing
// emits validated against its event schema (`packages/contracts/events/**`).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type HubClient,
} from '@majlis/contracts';
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
const eventsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../contracts/events',
);

/** Validates an envelope against `events/<namespace>/<event>.schema.json`. */
function eventValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
    addFormatsModule) as FormatsPlugin;
  addFormats(ajv);
  return (namespace: string, envelope: { event: string }): string[] => {
    const file = path.join(eventsDir, namespace, `${envelope.event}.schema.json`);
    const schema = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete schema.$id;
    const validate = ajv.compile(schema);
    return validate(envelope)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
  };
}

describe.skipIf(!doc)('contract: schedules fire, and a workflow step waits for a person', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  const validEvent = eventValidator();
  let hub: TestHub;
  let token: string | undefined;
  let client: HubClient;
  const envelopes: Array<{ namespace: string; envelope: { event: string } }> = [];

  async function call(
    operationId: string,
    expectedStatus: number,
    init: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    let status: number;
    let data: unknown;
    try {
      const res = await client.raw(op.method as ClientMethod, op.path, {
        ...(init.params ? { params: init.params } : {}),
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
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
      runner: new FakeAgentRunner({
        script: [{ type: 'message_delta', text: 'تم.' }, { type: 'completed' }],
      }),
      agentTimeoutMs: 5_000,
      scopes: principalScopeResolver,
    });
    hub = await testHub(
      { HUB_ADMIN_PASSWORD: PASSWORD },
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    // Every envelope the schedules namespace sends, as a socket in the room would get it.
    const nsp = hub.app.hub.io.of('/rt/schedules');
    const to = nsp.to.bind(nsp);
    nsp.to = ((room: string) => {
      const target = to(room);
      return {
        emit: (event: string, envelope: { event: string }) => {
          envelopes.push({ namespace: 'schedules', envelope });
          return target.emit(event, envelope);
        },
      };
    }) as never;
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

  const trigger = {
    kind: 'cron',
    expression: '0 9 * * *',
    every_minutes: null,
    run_at: null,
    timezone: 'Asia/Riyadh',
  };
  const target = {
    kind: 'agent_prompt',
    agent_id: AGENT,
    prompt: 'اكتب ملخص اليوم',
    model: null,
    provider: null,
    skills: [],
    workflow_id: null,
    input: null,
  };

  it('runNow answers the real ids, and the history and the events follow the contract', async () => {
    const schedule = await call('schedules.create', 201, {
      body: { name: 'تقرير', trigger, target },
    });
    const accepted = await call('schedules.runNow', 202, {
      params: { schedule_id: schedule.id as string },
    });
    expect(accepted.session_id).toBeTruthy();
    expect(accepted.run_id).toBeTruthy();
    const deadline = Date.now() + 5_000;
    let runs: Record<string, unknown>;
    do {
      runs = await call('schedules.listRuns', 200, { params: { schedule_id: schedule.id as string } });
      if ((runs.items as { status: string }[])[0]?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    expect((runs.items as { status: string }[])[0]?.status).toBe('succeeded');
    await call('schedules.getRun', 200, {
      params: {
        schedule_id: schedule.id as string,
        schedule_run_id: accepted.schedule_run_id as string,
      },
    });

    // A target that cannot start: the documented 409.
    const orphan = await call('schedules.create', 201, {
      body: { name: 'بلا وكيل', trigger, target: { ...target, agent_id: null } },
    });
    await call('schedules.runNow', 409, { params: { schedule_id: orphan.id as string } });

    const names = envelopes.map((entry) => entry.envelope.event);
    for (const event of ['schedule.fired', 'schedule_run.started', 'schedule_run.completed', 'schedule_run.failed']) {
      expect(names).toContain(event);
    }
    for (const entry of envelopes.filter((e) =>
      /^schedule(\.fired|\.updated|_run\.)/.test(e.envelope.event),
    )) {
      expect(validEvent(entry.namespace, entry.envelope), entry.envelope.event).toEqual([]);
    }
  });

  it('a workflow step waits as an Approval, and the answer is an Approval too', async () => {
    const node = (id: string, kind: string, input: string) => ({
      id,
      kind,
      title: id,
      agent_id: null,
      model: null,
      provider: null,
      reasoning_effort: null,
      skills: [],
      input,
      approval_required: false,
      position: { x: 0, y: 0 },
    });
    const workflow = await call('schedules.createWorkflow', 201, {
      body: {
        name: 'نشر',
        nodes: [node('gate', 'approval', 'انشر؟'), node('done', 'notify', 'نُشر')],
        edges: [{ id: 'e', from: 'gate', to: 'done', route: 'success' }],
      },
    });
    const started = await call('schedules.runWorkflow', 202, {
      params: { workflow_id: workflow.id as string },
      body: { input: null },
    });
    await workflowEngineFor(hub.app).settled();
    const waiting = await call('schedules.getWorkflowRun', 200, {
      params: { workflow_run_id: started.workflow_run_id as string },
    });
    expect(waiting.status).toBe('waiting');
    const listed = await call('sessions.listApprovals', 200);
    const approval = (listed.items as Record<string, unknown>[]).find(
      (item) => item.kind === 'workflow_step',
    )!;
    await call('sessions.getApproval', 200, { params: { approval_id: approval.id as string } });
    const answered = await call('sessions.respondApproval', 200, {
      params: { approval_id: approval.id as string },
      body: { decision: 'approve_once', answer: null },
    });
    expect(answered.status).toBe('approved');
    await call('sessions.respondApproval', 409, {
      params: { approval_id: approval.id as string },
      body: { decision: 'deny', answer: null },
    });
    await workflowEngineFor(hub.app).settled();
    const done = await call('schedules.getWorkflowRun', 200, {
      params: { workflow_run_id: started.workflow_run_id as string },
    });
    expect(done.status).toBe('succeeded');
    const waitingEvent = envelopes.find((entry) => entry.envelope.event === 'step.waiting');
    expect(waitingEvent).toBeTruthy();
    expect(validEvent('schedules', waitingEvent!.envelope)).toEqual([]);
  });
});
