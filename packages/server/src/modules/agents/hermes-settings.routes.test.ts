/**
 * The Hermes Settings page's routes (contract decision §56): `agents.getSettings` and
 * `agents.updateSettings` read and write Hermes's own keys in **the selected profile's** files, and
 * the review list of staged memory and skill writes answers per profile too. Every response is
 * checked against the contract's schema.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { ajvFor } from '../../../tests/contract/schema.js';
import type { HermesPython } from './hermes-pending-writes.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

const doc = loadOpenApiDocument()!;
const schemas = ajvFor(doc);
const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

async function boot(
  python?: HermesPython,
): Promise<{ hub: Hub; agent: string; root: string; work: string }> {
  hub = await signedInHub(
    {},
    {
      agents: {
        adapterOptions: { hermes: { fetchImpl: healthy } },
        ...(python ? { hermesPython: python } : {}),
      },
    },
  );
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  const root = path.join(hub.dataDir, 'hermes');
  mkdirSync(root, { recursive: true });
  const made = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/profiles',
    payload: { slug: 'work', name: 'Work' },
  });
  expect(made.statusCode, made.body).toBe(201);
  const work = path.join(root, 'profiles', 'work');
  mkdirSync(work, { recursive: true });
  return { hub, agent, root, work };
}

interface Section {
  key: string;
  applies: string;
  fields: Array<{ key: string; value: unknown }>;
}

const valueOf = (sections: Section[], section: string, key: string) =>
  sections.find((s) => s.key === section)?.fields.find((f) => f.key === key)?.value;

describe('Hermes settings, per profile', () => {
  it("reads and writes the selected profile's own files, never another's", async () => {
    const { hub: h, agent, root, work } = await boot();
    writeFileSync(path.join(root, 'config.yaml'), '# mine\nagent:\n  max_turns: 90\n');

    const saved = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/settings`,
      payload: { section: 'agent', values: { max_turns: 25, reasoning_effort: 'low' } },
      profile: 'work',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(schemas.validate(schema('AgentSettingsResult'), saved.json())).toEqual([]);
    expect(saved.json()).toMatchObject({ restart_job_id: null, section: { key: 'agent' } });
    expect(readFileSync(path.join(work, 'config.yaml'), 'utf8')).toBe(
      'agent:\n  max_turns: 25\n  reasoning_effort: low\n',
    );
    // The default profile's file is untouched, comment and all.
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).toBe(
      '# mine\nagent:\n  max_turns: 90\n',
    );

    const read = async (profile: string) => {
      const res = await authed(h, h.token, {
        method: 'GET',
        url: `/api/v1/agents/${agent}/settings`,
        profile,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(schemas.validate(schema('AgentSettings'), res.json())).toEqual([]);
      return (res.json() as { sections: Section[] }).sections;
    };
    expect(valueOf(await read('work'), 'agent', 'max_turns')).toBe(25);
    expect(valueOf(await read('default'), 'agent', 'max_turns')).toBe(90);
    expect((await read('default')).map((s) => s.key)).toEqual([
      'agent',
      'memory',
      'approvals',
      'network',
      'privacy',
    ]);
  });

  it("writes the proxy to the profile's .env and says it applies after a restart", async () => {
    const { hub: h, agent, root } = await boot();
    const saved = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/settings`,
      payload: {
        section: 'network',
        values: { https_proxy: 'http://proxy.local:3128', no_proxy: 'localhost,127.0.0.1' },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      section: { key: 'network', applies: 'restart', restart_required: true },
      // Not a Hermes this hub runs (external): nothing to restart from here.
      restart_job_id: null,
    });
    const env = readFileSync(path.join(root, '.env'), 'utf8');
    expect(env).toContain('HTTPS_PROXY=http://proxy.local:3128');
    expect(env).toContain('NO_PROXY=localhost,127.0.0.1');
  });

  it('refuses a wrong value in the words of the field, and an unknown section', async () => {
    const { hub: h, agent } = await boot();
    const wrong = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/settings`,
      payload: { section: 'network', values: { https_proxy: 'not a url' } },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({
      code: 'validation_failed',
      details: { field: 'values.https_proxy', reason: 'format_invalid' },
    });
    const unknown = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/settings`,
      payload: { section: 'session', values: {} },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('says so when Hermes has no such profile', async () => {
    const { hub: h, agent, work } = await boot();
    const { rmSync } = await import('node:fs');
    rmSync(work, { recursive: true, force: true });
    const res = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/settings`,
      profile: 'work',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { reason: 'hermes_profile_absent' } });
  });
});

describe('Hermes pending writes, per profile', () => {
  function stage(home: string, kind: 'memory' | 'skills', id: string): void {
    mkdirSync(path.join(home, 'pending', kind), { recursive: true });
    writeFileSync(
      path.join(home, 'pending', kind, `${id}.json`),
      JSON.stringify({
        id,
        subsystem: kind,
        action: 'add',
        summary: `staged ${id}`,
        origin: 'foreground',
        created_at: 1_790_000_000,
        payload: { action: 'add', target: 'memory', content: `fact ${id}` },
      }),
    );
  }

  it('lists, approves through Hermes and rejects — in the profile asked for', async () => {
    const approved: string[] = [];
    const python: HermesPython = async (home, argv) => {
      approved.push(`${home}:${argv[1]}:${argv[2]}`);
      return { code: 0, stdout: '{"found": true, "applied": true}', stderr: '' };
    };
    const { hub: h, agent, root, work } = await boot(python);
    stage(work, 'memory', 'aa11');
    stage(work, 'skills', 'bb22');
    stage(root, 'memory', 'cc33');

    const list = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/pending-writes`,
      profile: 'work',
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(schemas.validate(schema('PendingWriteList'), list.json())).toEqual([]);
    expect((list.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([
      'aa11',
      'bb22',
    ]);

    const approve = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/pending-writes/memory/aa11/approve`,
      profile: 'work',
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(schemas.validate(schema('PendingWriteApplied'), approve.json())).toEqual([]);
    expect(approved).toEqual([`${work}:memory:aa11`]);

    const reject = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/pending-writes/skills/bb22`,
      profile: 'work',
    });
    expect(reject.statusCode).toBe(204);
    expect(existsSync(path.join(work, 'pending', 'skills', 'bb22.json'))).toBe(false);
    // The default profile's write is its own.
    expect(existsSync(path.join(root, 'pending', 'memory', 'cc33.json'))).toBe(true);

    const again = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/pending-writes/skills/bb22`,
      profile: 'work',
    });
    expect(again.statusCode).toBe(404);
  });

  it("answers 409 with Hermes's words when it cannot apply the write", async () => {
    const python: HermesPython = async () => ({
      code: 0,
      stdout: '{"found": true, "applied": false, "error": "Memory at 2190/2200 chars."}',
      stderr: '',
    });
    const { hub: h, agent, root } = await boot(python);
    stage(root, 'memory', 'dd44');
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/pending-writes/memory/dd44/approve`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'state_invalid',
      details: { reason: 'pending_not_applied', message: 'Memory at 2190/2200 chars.' },
    });
    expect(existsSync(path.join(root, 'pending', 'memory', 'dd44.json'))).toBe(true);
  });

  it('cannot approve without a Hermes installed beside the hub, but still says 404 first', async () => {
    const { hub: h, agent, root } = await boot();
    stage(root, 'memory', 'ee55');
    const missing = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/pending-writes/memory/nope/approve`,
    });
    expect(missing.statusCode).toBe(404);
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/pending-writes/memory/ee55/approve`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { reason: 'hermes_not_supervised' } });
  });
});
