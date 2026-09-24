/**
 * The agent's Plugins page on the hub: Hermes's own `hermes plugins` command, run against the
 * selected profile's home (`hermes-plugins.ts`), here played by `fakeHermesPlugins`. The real
 * command is `hermes-plugins.real.test.ts`.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { auditFor, serializeJob } from '../audit/index.js';
import { parsePluginList, sentenceOf, type HermesCli } from './hermes-plugins.js';
import { fakeHermesPlugins } from './testing/fake-hermes-plugins.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

/** A gateway that answers its health probe, so the runtime is `external` and has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

async function boot(hermesCli?: HermesCli): Promise<{ hub: Hub; agent: string; root: string }> {
  hub = await signedInHub(
    {},
    {
      agents: {
        adapterOptions: { hermes: { fetchImpl: healthy } },
        ...(hermesCli ? { hermesCli } : {}),
      },
    },
  );
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agents = (list.json() as { items: Array<{ id: string; kind: string }> }).items;
  const agent = agents.find((row) => row.kind === 'hermes')!.id;
  const root = path.join(hub.dataDir, 'hermes');
  mkdirSync(root, { recursive: true });
  return { hub, agent, root };
}

interface Listed {
  items: Array<{
    key: string;
    source: string;
    status: string;
    enabled: boolean;
    removable: boolean;
    version: string | null;
  }>;
  warnings: string[];
}

describe("Hermes's list, read", () => {
  it("keeps Hermes's words and ignores what it printed before the array", () => {
    const parsed = parsePluginList(
      [
        'Warning: something Hermes logs on stdout',
        '[',
        '  {"name": "kanban", "status": "not enabled", "version": "1.0.0", "description": "Board", "source": "bundled", "removed": null},',
        '  {"name": "langfuse", "status": "disabled", "version": "", "description": "", "source": "entrypoint", "removed": null},',
        '  {"name": "old-thing", "status": "enabled", "version": "0.1", "description": "x", "source": "catalog:community@1a2b3c4d", "removed": "withdrawn: unsafe"}',
        ']',
      ].join('\n'),
    );
    expect(
      parsed.items.map((item) => [item.key, item.source, item.status, item.removable]),
    ).toEqual([
      ['kanban', 'bundled', 'not_enabled', false],
      ['langfuse', 'external', 'disabled', false],
      ['old-thing', 'user', 'enabled', true],
    ]);
    expect(parsed.items[1]?.version).toBeNull();
    expect(parsed.warnings).toEqual(['old-thing: withdrawn: unsafe']);
  });

  it('reads "No plugins installed." as an empty list', () => {
    expect(
      parsePluginList('No plugins installed.\nInstall with: hermes plugins install owner/repo\n'),
    ).toEqual({ items: [], warnings: [] });
  });

  it("takes Hermes's sentence from a refusal, and the traceback's last line from a crash", () => {
    expect(
      sentenceOf({ code: 1, stdout: "Plugin 'ghost' is not installed or bundled.\n", stderr: '' }),
    ).toBe("Plugin 'ghost' is not installed or bundled.");
    expect(
      sentenceOf({
        code: 1,
        stdout: 'Cloning x...\n',
        stderr: 'Traceback (most recent call last):\n  File "x"\nOSError: disk full\n',
      }),
    ).toBe('OSError: disk full');
  });
});

describe('the Plugins page through the routes', () => {
  it('lists what Hermes lists, with its status, in the default profile', async () => {
    const fake = fakeHermesPlugins();
    const { hub: h, agent, root } = await boot(fake.cli);
    const res = await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/plugins` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Listed;
    expect(body.items.map((item) => [item.key, item.source, item.status])).toEqual([
      ['disk-cleanup', 'bundled', 'not_enabled'],
      ['kanban', 'bundled', 'not_enabled'],
    ]);
    // Against the default profile's home: Hermes's root.
    expect(fake.calls).toEqual([`${root} plugins list --json`]);
  });

  it("switches a plugin on and off in that profile's own lists, never another's", async () => {
    const fake = fakeHermesPlugins();
    const { hub: h, agent, root } = await boot(fake.cli);
    const made = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'Work' },
    });
    expect(made.statusCode, made.body).toBe(201);
    mkdirSync(path.join(root, 'profiles', 'work'), { recursive: true });

    const on = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/plugins/kanban`,
      payload: { enabled: true },
      profile: 'work',
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ key: 'kanban', status: 'enabled', enabled: true });
    expect(fake.calls).toContain(
      `${path.join(root, 'profiles', 'work')} plugins enable kanban --no-allow-tool-override`,
    );

    const statusIn = async (profile: string) =>
      (
        (
          await authed(h, h.token, {
            method: 'GET',
            url: `/api/v1/agents/${agent}/plugins`,
            profile,
          })
        ).json() as Listed
      ).items.find((item) => item.key === 'kanban')?.status;
    expect(await statusIn('work')).toBe('enabled');
    expect(await statusIn('default')).toBe('not_enabled');

    const off = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/plugins/kanban`,
      payload: { enabled: false },
      profile: 'work',
    });
    expect(off.json()).toMatchObject({ status: 'disabled', enabled: false });
  });

  it('answers 404 for a plugin Hermes does not have, before asking it to act', async () => {
    const fake = fakeHermesPlugins();
    const { hub: h, agent } = await boot(fake.cli);
    const res = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/plugins/ghost`,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(fake.calls.some((call) => call.includes('enable ghost'))).toBe(false);
  });

  it('installs as a job, switched off, and removes what was installed — never what Hermes ships', async () => {
    const fake = fakeHermesPlugins();
    const { hub: h, agent, root } = await boot(fake.cli);
    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/plugins`,
      payload: { identifier: 'chrome-profiles' },
    });
    expect(started.statusCode, started.body).toBe(202);
    const jobId = (started.json() as { job_id: string }).job_id;
    await drainJobs(h.app);
    const row = auditFor(h.app).job(jobId)!;
    const job = serializeJob(row, 'default');
    expect(job).toMatchObject({
      kind: 'plugin_install',
      status: 'succeeded',
      resource: { kind: 'agent', id: agent },
      result: { name: 'chrome-profiles', identifier: 'chrome-profiles' },
    });
    expect(fake.calls).toContain(`${root} plugins install chrome-profiles --no-enable`);

    const listed = (
      await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/plugins` })
    ).json() as Listed;
    expect(listed.items.find((item) => item.key === 'chrome-profiles')).toMatchObject({
      source: 'user',
      status: 'not_enabled',
      removable: true,
    });

    const shipped = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/plugins/kanban`,
    });
    expect(shipped.statusCode).toBe(409);
    expect(shipped.json()).toMatchObject({ details: { reason: 'plugin_bundled' } });

    const removed = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/plugins/chrome-profiles`,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(fake.calls).toContain(`${root} plugins remove chrome-profiles`);
  });

  it("fails the install job with Hermes's own sentence when Hermes refuses", async () => {
    const fake = fakeHermesPlugins();
    const { hub: h, agent } = await boot(fake.cli);
    const started = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/plugins`,
      payload: { identifier: 'nobody/nothing' },
    });
    expect(started.statusCode).toBe(202);
    await drainJobs(h.app);
    const job = serializeJob(
      auditFor(h.app).job((started.json() as { job_id: string }).job_id)!,
      'default',
    );
    expect(job).toMatchObject({
      status: 'failed',
      error: { code: 'conflict', error: "repository 'nobody/nothing' not found" },
    });
  });

  it('refuses an identifier that would read as an option', async () => {
    const fake = fakeHermesPlugins();
    const { hub: h, agent } = await boot(fake.cli);
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/plugins`,
      payload: { identifier: '--allow-removed' },
    });
    expect(res.statusCode).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it('says clearly when the hub does not run Hermes itself', async () => {
    const { hub: h, agent } = await boot();
    for (const request of [
      { method: 'GET' as const, url: `/api/v1/agents/${agent}/plugins` },
      {
        method: 'PATCH' as const,
        url: `/api/v1/agents/${agent}/plugins/kanban`,
        payload: { enabled: true },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/agents/${agent}/plugins`,
        payload: { identifier: 'chrome-profiles' },
      },
      { method: 'DELETE' as const, url: `/api/v1/agents/${agent}/plugins/kanban` },
    ]) {
      const res = await authed(h, h.token, request);
      expect(res.statusCode, `${request.method} ${res.body}`).toBe(409);
      expect(res.json()).toMatchObject({
        code: 'state_invalid',
        details: { reason: 'hermes_not_supervised' },
      });
    }
  });
});
