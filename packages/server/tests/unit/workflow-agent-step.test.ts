/**
 * A workflow's agent step through a **real** session — across two modules, which is why
 * it lives here and not inside either: `schedules` runs the step, `sessions` runs the turn
 * (played by the scripted runner), and the composition root joins them as production does.
 */
import { describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { workflowEngineFor } from '../../src/modules/schedules/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';

async function workflow(hub: Hub, prompt: string) {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/workflows',
    payload: {
      name: 'flow',
      nodes: [
        {
          id: 'ask',
          kind: 'agent',
          title: 'ask',
          agent_id: AGENT,
          model: null,
          provider: null,
          reasoning_effort: null,
          skills: [],
          input: prompt,
          approval_required: false,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as Json).id as string;
}

async function run(hub: Hub, id: string, payload: Json) {
  const started = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/workflows/${id}/run`,
    payload,
  });
  expect(started.statusCode).toBe(202);
  await workflowEngineFor(hub.app).settled();
  const runId = (started.json() as Json).workflow_run_id as string;
  return (
    await authed(hub, hub.token, { method: 'GET', url: `/api/v1/workflow-runs/${runId}` })
  ).json() as Json & { steps: Json[] };
}

describe('workflows: an agent step through a real session', () => {
  it('opens a workflow session, sends the prompt, and reads back the reply', async () => {
    const runner = new FakeAgentRunner({
      script: [{ type: 'message_delta', text: 'تمّ التلخيص' }, { type: 'completed' }],
    });
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
      runner,
      agentTimeoutMs: 2_000,
      // The real resolver, as `modules/index.ts` composes it: the session must land in the
      // same workspace the workflow runs in.
      scopes: principalScopeResolver,
    });
    const modules = defaultModules.map((module) =>
      module.name === 'sessions' ? sessions : module,
    );
    const hub = await signedInHub({}, { modules });
    try {
      const id = await workflow(hub, 'لخّص {{input}}');
      const result = await run(hub, id, { input: 'البريد' });
      expect(result.status).toBe('succeeded');
      expect(runner.started).toHaveLength(1);
      expect(result.steps.find((s) => s.node_id === 'ask')).toMatchObject({ status: 'succeeded' });
      expect(result.steps.find((s) => s.node_id === 'ask')?.run_id).toBeTruthy();

      // The turn is an ordinary session, filed under where it came from.
      const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/sessions' });
      const items = (listed.json() as { items: Json[] }).items;
      expect(items.some((s) => s.source === 'workflow' && s.title === 'ask')).toBe(true);
    } finally {
      await hub.close();
    }
  });
});
