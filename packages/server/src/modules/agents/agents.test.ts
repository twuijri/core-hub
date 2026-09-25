import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  TEST_ADMIN_PASSWORD,
  authed,
  drainJobs,
  expectModuleRegistered,
  fakeInstaller,
  signedInHub,
  testHub,
} from '../../../tests/unit/helpers.js';
import { agentsModule, agentsServiceFor } from './index.js';
import { agentStatus, serializeAgent } from './serialize.js';
import {
  ACCEPTED_LICENCES,
  CATALOG,
  HERMES_ENTRY,
  INSTALLABLE,
  assertCatalogIsWellFormed,
  pinnedPackages,
  type CatalogEntry,
} from './catalog/index.js';
import { parseVersion } from './adapters/host.js';

/** A gateway that answers its health probe, so the runtime is `external` and has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

const rowBase = {
  id: '01J8QK3ZR2W7M5N4P6T8V9X0AG',
  ownerId: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  slug: 'claude-code',
  name: 'Claude Code',
  vendor: 'Anthropic',
  description: null,
  icon: null,
  adapterId: '01J8QK3ZR2W7M5N4P6T8V9X0AD',
  adapterKind: 'acp' as const,
  source: 'user_cli' as const,
  command: ['claude-code-acp'],
  executablePath: '/usr/local/bin/claude-code-acp',
  packageName: '@zed-industries/claude-code-acp',
  endpoint: null,
  version: '2.1.0',
  latestVersion: '2.1.4',
  autoUpdate: false,
  checkedAt: new Date(0),
  licence: 'Apache-2.0',
  installState: 'installed' as const,
  installJobId: null,
  detectedAt: new Date(0),
  capabilities: ['streaming' as const],
  sections: ['settings' as const],
  limited: false,
  selectable: true,
  lastError: null,
  archivedAt: null,
};

describe('module: agents', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(agentsModule);
  });
});

describe('agents: the status a card shows', () => {
  it('reports the install lifecycle before anything else', () => {
    expect(agentStatus({ ...rowBase, installState: 'installing' }, true)).toBe('installing');
    expect(agentStatus({ ...rowBase, installState: 'updating' }, true)).toBe('updating');
    expect(agentStatus({ ...rowBase, installState: 'failed' }, true)).toBe('error');
  });

  it('is `not_installed`, not `available`, for an agent that is only listed (ADR 0006)', () => {
    expect(agentStatus({ ...rowBase, installState: 'not_installed' }, true)).toBe('not_installed');
  });

  it('distinguishes disabled and limited from available', () => {
    expect(agentStatus(rowBase, false)).toBe('disabled');
    expect(agentStatus({ ...rowBase, limited: true }, true)).toBe('limited');
    expect(agentStatus(rowBase, true)).toBe('available');
  });
});

describe('agents: the shape a client reads', () => {
  it('fills the install block and computes update_available', () => {
    const agent = serializeAgent(rowBase, {
      profile: 'work',
      settings: undefined,
      runtime: { state: 'not_applicable', url: null, error: null },
    });
    expect(agent).toMatchObject({
      profile: 'work',
      kind: 'acp',
      status: 'available',
      enabled: true,
      limited: false,
      default_model: null,
    });
    expect(agent.install).toMatchObject({
      source: 'user_cli',
      package: '@zed-industries/claude-code-acp',
      command: 'claude-code-acp',
      version: '2.1.0',
      latest_version: '2.1.4',
      update_available: true,
      auto_update_supported: true,
    });
  });

  it('never claims an update when the hub does not know the latest version', () => {
    const agent = serializeAgent(
      { ...rowBase, latestVersion: null },
      {
        profile: 'work',
        settings: undefined,
        runtime: { state: 'not_applicable', url: null, error: null },
      },
    );
    expect(agent.install.update_available).toBe(false);
  });
});

describe('agents: the registry a hub boots with', () => {
  it('lists Hermes first, the direct agent second, and every coding agent as not_installed', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
      expect(response.statusCode).toBe(200);
      const items = (response.json() as { items: { slug: string; status: string }[] }).items;
      // The two a fresh install shows (ADR 0006; ADOPTION-BACKLOG §2.15).
      expect(items.slice(0, 2).map((item) => item.slug)).toEqual(['hermes', 'direct']);
      expect(items.map((item) => item.slug).sort()).toEqual(
        CATALOG.map((entry) => entry.id).sort(),
      );
      // Nothing is installed in the test environment: the PATH points at an empty dir.
      // The hub's own agent is the exception — it *is* the hub, so it is always there.
      for (const item of items) {
        expect(item.status).toBe(item.slug === 'direct' ? 'available' : 'not_installed');
      }
    } finally {
      await hub.close();
    }
  });

  it('never offers to install or remove the direct agent: it is the hub (ADR 0006)', async () => {
    const hub = await signedInHub();
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: {
            id: string;
            slug: string;
            install: { source: string; package: string | null };
          }[];
        }
      ).items;
      const direct = items.find((item) => item.slug === 'direct');
      expect(direct?.install).toMatchObject({ source: 'builtin', package: null });
      const lifecycle: [string, string][] = [
        ['POST', 'install'],
        ['DELETE', 'install'],
        ['POST', 'update'],
      ];
      for (const [method, operation] of lifecycle) {
        const response = await authed(hub, hub.token, {
          method,
          url: `/api/v1/agents/${direct?.id}/${operation}`,
        });
        expect(response.statusCode).toBe(422);
        expect((response.json() as { code: string }).code).toBe('agent_unavailable');
      }
    } finally {
      await hub.close();
    }
  });

  it("names the direct agent in the reader's language (TEAM-RULES §4)", async () => {
    const hub = await signedInHub();
    try {
      const read = async (language: string): Promise<Record<string, string>> => {
        const response = await authed(hub, hub.token, {
          method: 'GET',
          url: '/api/v1/agents',
          headers: { 'accept-language': language },
        });
        const items = (response.json() as { items: { slug: string; name: string }[] }).items;
        return Object.fromEntries(items.map((item) => [item.slug, item.name]));
      };
      expect((await read('en')).direct).toBe('Direct');
      expect((await read('ar')).direct).toBe('مباشر');
      // A brand is a brand in both: nothing is translated that should not be.
      expect((await read('ar')).hermes).toBe('Hermes');
    } finally {
      await hub.close();
    }
  });

  it('does not list the process harness: it is declared but not selectable (ADR 0002)', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/agents?kind=harness',
      });
      expect((response.json() as { items: unknown[] }).items).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('reads one agent, and no Hermes settings where there is no Hermes home', async () => {
    const hub = await signedInHub();
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const hermes = items.find((item) => item.slug === 'hermes')!;

      const one = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${hermes.id}`,
      });
      expect(one.json()).toMatchObject({ slug: 'hermes', kind: 'hermes', vendor: 'Nous Research' });

      // No Hermes home on this hub: its settings are its files, so there is nothing to read.
      const settings = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${hermes.id}/settings`,
      });
      expect(settings.statusCode).toBe(409);
      expect(settings.json()).toMatchObject({ details: { reason: 'runtime_absent' } });
    } finally {
      await hub.close();
    }
  });

  it('answers 404 for an unknown agent id instead of guessing', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/agents/01J8QK3ZR2W7M5N4P6T8V9X0ZZ',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found', details: { resource: 'agent' } });
    } finally {
      await hub.close();
    }
  });
});

describe('agents: per-workspace settings', () => {
  it('disables an agent for this workspace only and stores a settings value', async () => {
    const hub = await signedInHub(
      {},
      { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } },
    );
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const hermes = items.find((item) => item.slug === 'hermes')!;
      mkdirSync(path.join(hub.dataDir, 'hermes'), { recursive: true });

      const disabled = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${hermes.id}`,
        payload: { enabled: false },
      });
      expect(disabled.json()).toMatchObject({ enabled: false });

      const saved = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${hermes.id}/settings`,
        payload: { section: 'approvals', values: { approvals_mode: 'manual' } },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ restart_job_id: null });
      const field = (
        saved.json() as { section: { fields: { key: string; value: unknown }[] } }
      ).section.fields.find((item) => item.key === 'approvals_mode');
      expect(field?.value).toBe('manual');
      // Hermes's own key, in its own file — not a row of the hub's.
      expect(readFileSync(path.join(hub.dataDir, 'hermes', 'config.yaml'), 'utf8')).toContain(
        'mode: manual',
      );
    } finally {
      await hub.close();
    }
  });

  it('refuses a field Hermes does not have', async () => {
    const hub = await signedInHub(
      {},
      { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } },
    );
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const hermes = items.find((item) => item.slug === 'hermes')!;
      mkdirSync(path.join(hub.dataDir, 'hermes'), { recursive: true });
      const response = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${hermes.id}/settings`,
        payload: { section: 'agent', values: { made_up: true } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'validation_failed',
        details: { field: 'values.made_up', reason: 'setting_unknown' },
      });
    } finally {
      await hub.close();
    }
  });
});

describe('agents: install as a job (invariant 4)', () => {
  it('answers 202 with a job id, then the job finishes and the agent is installed', async () => {
    const installer = fakeInstaller();
    const hub = await signedInHub({}, { agents: { installer } });
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const claude = items.find((item) => item.slug === 'claude-code')!;

      const accepted = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${claude.id}/install`,
      });
      expect(accepted.statusCode).toBe(202);
      const jobId = (accepted.json() as { job_id: string }).job_id;
      expect(jobId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

      await drainJobs(hub.app);

      const job = await authed(hub, hub.token, { method: 'GET', url: `/api/v1/jobs/${jobId}` });
      expect(job.json()).toMatchObject({
        kind: 'install',
        status: 'succeeded',
        profile: 'default',
        resource: { kind: 'agent', id: claude.id },
        result: { version: '1.2.3' },
        error: null,
      });

      const after = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${claude.id}`,
      });
      expect(after.json()).toMatchObject({
        status: 'available',
        install: { source: 'managed', version: '1.2.3' },
      });
      expect(installer.calls).toEqual(['install:claude-code']);
    } finally {
      await hub.close();
    }
  });

  it('a failed install is job.failed with the installer’s message, never a 200', async () => {
    const installer = fakeInstaller({
      install: async () => {
        throw new Error('npm ERR! 404 Not Found');
      },
    });
    const hub = await signedInHub({}, { agents: { installer } });
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const codex = items.find((item) => item.slug === 'codex')!;
      const accepted = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${codex.id}/install`,
      });
      const jobId = (accepted.json() as { job_id: string }).job_id;
      await drainJobs(hub.app);

      const job = await authed(hub, hub.token, { method: 'GET', url: `/api/v1/jobs/${jobId}` });
      expect(job.json()).toMatchObject({ status: 'failed' });
      expect((job.json() as { error: { code: string } }).error.code).toBe('internal');

      const after = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${codex.id}`,
      });
      expect(after.json()).toMatchObject({
        status: 'error',
        install: { error: 'npm ERR! 404 Not Found' },
      });
    } finally {
      await hub.close();
    }
  });

  it('refuses to uninstall something that is not installed', async () => {
    const hub = await signedInHub({}, { agents: { installer: fakeInstaller() } });
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const codex = items.find((item) => item.slug === 'codex')!;
      const response = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/agents/${codex.id}/install`,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'conflict' });
    } finally {
      await hub.close();
    }
  });

  it('refuses to install Hermes through the hub: it ships inside the image', async () => {
    const hub = await signedInHub({}, { agents: { installer: fakeInstaller() } });
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const hermes = items.find((item) => item.slug === 'hermes')!;
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${hermes.id}/install`,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'agent_unavailable' });
    } finally {
      await hub.close();
    }
  });

  it('check-update on an agent the hub has not installed reports the pin and asks no registry', async () => {
    const installer = fakeInstaller();
    const hub = await signedInHub({}, { agents: { installer } });
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const gemini = items.find((item) => item.slug === 'gemini-cli')!;
      const accepted = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/agents/${gemini.id}/check-update`,
      });
      expect(accepted.statusCode).toBe(202);
      await drainJobs(hub.app);
      const job = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/jobs/${(accepted.json() as { job_id: string }).job_id}`,
      });
      // The pin is the floor of "latest"; with nothing installed there is nothing to update
      // and nothing to ask the registry about (the test registry would fail the job).
      const pinned = INSTALLABLE.find((entry) => entry.id === 'gemini-cli')!;
      const version = pinned.install.kind === 'npm' ? pinned.install.version : null;
      expect(job.json()).toMatchObject({
        kind: 'check_update',
        status: 'succeeded',
        result: { latest_version: version, pinned_version: version, update_available: false },
      });
      expect(installer.calls).not.toContain('health:gemini-cli');
    } finally {
      await hub.close();
    }
  });
});

describe('agents: reconciling the table with the data volume (ADR 0006)', () => {
  /** Signs in against a hub that already has an owner, to read its registry. */
  const listAgents = async (hub: { app: FastifyInstance }) => {
    const signIn = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
    });
    const token = (signIn.json() as { access_token: string }).access_token;
    const response = await authed(hub, token, { method: 'GET', url: '/api/v1/agents' });
    return (
      response.json() as { items: { slug: string; status: string; install: { source: string } }[] }
    ).items;
  };

  it('keeps an install across a restart, and notices when the volume was cleared', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-reconcile-'));
    const env = { DATA_DIR: dataDir, HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD };
    try {
      // First boot: nothing on the volume, so nothing claims to be installed.
      const first = await testHub(env, { agents: { installer: fakeInstaller() } });
      // The hub's own agent is always installed; it is the hub, not a directory.
      expect(
        (await listAgents(first))
          .filter((item) => item.slug !== 'direct')
          .every((item) => item.status === 'not_installed'),
      ).toBe(true);
      await first.app.close();

      // The agent's directory now exists on the volume: a restart must find it.
      const second = await testHub(env, {
        agents: { installer: fakeInstaller({ isPresent: () => true }) },
      });
      try {
        const codex = (await listAgents(second)).find((item) => item.slug === 'codex');
        expect(codex).toMatchObject({ status: 'available', install: { source: 'managed' } });
      } finally {
        await second.app.close();
      }

      // Somebody cleared the volume: the row must stop claiming the agent is installed.
      const third = await testHub(env, {
        agents: { installer: fakeInstaller({ isPresent: () => false }) },
      });
      try {
        const codex = (await listAgents(third)).find((item) => item.slug === 'codex');
        expect(codex?.status).toBe('not_installed');
      } finally {
        await third.app.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
    // Three hub boots (argon2 owner hash + migrations each) exceed 5 s on a CI runner.
  }, 30_000);
});

describe('agents: the curated catalog (ADR 0006)', () => {
  it('is well formed: unique ids, an exact version pin and a licence on every entry', () => {
    expect(() => assertCatalogIsWellFormed()).not.toThrow();
    const ids = CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of INSTALLABLE) {
      expect(entry.install.kind).toBe('npm');
      expect(ACCEPTED_LICENCES).toContain(entry.licence);
      for (const pin of pinnedPackages(entry)) expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('carries the coding agents verified on 2026-09-25, each at its exact pin', () => {
    const pins = Object.fromEntries(
      INSTALLABLE.map((entry) => [
        entry.id,
        pinnedPackages(entry).map((pin) => `${pin.package}@${pin.version}`),
      ]),
    );
    expect(pins).toMatchObject({
      'qwen-code': ['@qwen-code/qwen-code@0.24.5'],
      'kimi-code': ['@moonshot-ai/kimi-code@2.1.1'],
      pi: ['@earendil-works/pi-coding-agent@0.87.1', 'pi-acp@0.0.34'],
    });
    const byId = (id: string) => CATALOG.find((entry) => entry.id === id)!;
    expect(byId('qwen-code')).toMatchObject({ binary: 'qwen', protocolArgs: ['--acp'] });
    expect(byId('kimi-code')).toMatchObject({ binary: 'kimi', protocolArgs: ['acp'] });
    // Pi's ACP side is its adapter; the health check asks the CLI it drives.
    expect(byId('pi')).toMatchObject({
      binary: 'pi-acp',
      health: { kind: 'command', binary: 'pi' },
    });
  });

  it('ships Hermes as bundled, so no job can install or remove it', () => {
    expect(HERMES_ENTRY.install.kind).toBe('bundled');
    expect(INSTALLABLE.map((entry) => entry.id)).not.toContain('hermes');
  });

  const npmEntry = (id: string, version: string, extra: Partial<CatalogEntry> = {}) =>
    ({
      ...HERMES_ENTRY,
      id,
      adapter: 'acp',
      install: { kind: 'npm', package: `pkg-${id}`, version },
      ...extra,
    }) as CatalogEntry;

  it('rejects a catalog that pins a range, a tag or a pre-release instead of a version', () => {
    for (const version of ['^1.0.0', 'latest', '0.1.5-rc.3', '1.2']) {
      expect(() => assertCatalogIsWellFormed([npmEntry('x1', version)])).toThrow(
        /pin an exact version/,
      );
    }
    expect(() =>
      assertCatalogIsWellFormed([
        npmEntry('x1', '1.0.0', {
          install: {
            kind: 'npm',
            package: 'a',
            version: '1.0.0',
            companions: [{ package: 'b', version: '~1.0.0' }],
          },
        }),
      ]),
    ).toThrow(/pin an exact version of b/);
  });

  it('rejects a duplicate id, a package named twice, and a licence the hub does not accept', () => {
    expect(() =>
      assertCatalogIsWellFormed([npmEntry('x1', '1.0.0'), npmEntry('x1', '1.0.1')]),
    ).toThrow(/duplicate id/);
    expect(() =>
      assertCatalogIsWellFormed([
        npmEntry('x1', '1.0.0'),
        npmEntry('x2', '1.0.0', { install: { kind: 'npm', package: 'pkg-x1', version: '2.0.0' } }),
      ]),
    ).toThrow(/named twice/);
    expect(() =>
      assertCatalogIsWellFormed([npmEntry('x1', '1.0.0', { licence: 'AGPL-3.0-only' })]),
    ).toThrow(/does not accept/);
    expect(() => assertCatalogIsWellFormed([npmEntry('x1', '1.0.0', { binary: '' })])).toThrow(
      /names no binary/,
    );
  });
});

describe('agents: host probing helpers', () => {
  it('reads a version out of whatever a CLI prints', () => {
    expect(parseVersion('2.1.0')).toBe('2.1.0');
    expect(parseVersion('claude-code/2.1.4 (darwin-arm64)')).toBe('2.1.4');
    expect(parseVersion('hermes version 0.21.3-rc.1')).toBe('0.21.3-rc.1');
    expect(parseVersion('no version here')).toBeNull();
  });
});

describe('agents: the profile a run is started in (ADR 0014 stage 3)', () => {
  it("names the workspace's Hermes profile on every run target: its slug, or `default`", async () => {
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/profiles',
        payload: { slug: 'designer', name: 'Designer' },
      });
      expect(created.statusCode).toBe(201);
      const listed = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' });
      const items = (listed.json() as { items: { id: string; slug: string }[] }).items;
      const idOf = (slug: string) => items.find((item) => item.slug === slug)!.id;

      const agents = agentsServiceFor(hub.app);
      const hermes = agents.loadAgentBySlug('hermes');
      const run = { sessionRef: null, cwd: null, model: null, reasoningEffort: null };
      expect(agents.targetFor(hermes, idOf('designer'), run).profile).toBe('designer');
      expect(agents.targetFor(hermes, idOf('default'), run).profile).toBe('default');
      // A workspace the hub does not know has no profile: the runtime's own default.
      expect(agents.targetFor(hermes, '01J8QK3ZR2W7M5N4P6T8V9X0ZZ', run).profile).toBeNull();
    } finally {
      await hub.close();
    }
  });
});
