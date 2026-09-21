import { mkdtempSync, rmSync } from 'node:fs';
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
import { agentsModule } from './index.js';
import { agentStatus, serializeAgent } from './serialize.js';
import { CATALOG, HERMES_ENTRY, INSTALLABLE, assertCatalogIsWellFormed } from './catalog/index.js';
import { parseVersion } from './adapters/host.js';

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
  it('always lists Hermes first and every known coding agent as not_installed', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
      expect(response.statusCode).toBe(200);
      const items = (response.json() as { items: { slug: string; status: string }[] }).items;
      expect(items[0]?.slug).toBe('hermes');
      expect(items.map((item) => item.slug).sort()).toEqual(
        CATALOG.map((entry) => entry.id).sort(),
      );
      // Nothing is installed in the test environment: the PATH points at an empty dir.
      for (const item of items) expect(item.status).toBe('not_installed');
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

  it('reads one agent and its adapter-declared settings form', async () => {
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

      const settings = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${hermes.id}/settings`,
      });
      const sections = (settings.json() as { sections: { key: string }[] }).sections;
      expect(sections.map((section) => section.key)).toEqual([
        'agent',
        'memory',
        'session',
        'gateway',
      ]);
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
    const hub = await signedInHub();
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const hermes = items.find((item) => item.slug === 'hermes')!;

      const disabled = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${hermes.id}`,
        payload: { enabled: false },
      });
      expect(disabled.json()).toMatchObject({ enabled: false });

      const saved = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${hermes.id}/settings`,
        payload: { section: 'session', values: { approvals_mode: 'always' } },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ restart_job_id: null });
      const field = (
        saved.json() as { section: { fields: { key: string; value: unknown }[] } }
      ).section.fields.find((item) => item.key === 'approvals_mode');
      expect(field?.value).toBe('always');
    } finally {
      await hub.close();
    }
  });

  it('refuses a field the adapter never declared', async () => {
    const hub = await signedInHub();
    try {
      const items = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json() as {
          items: { id: string; slug: string }[];
        }
      ).items;
      const hermes = items.find((item) => item.slug === 'hermes')!;
      const response = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${hermes.id}/settings`,
        payload: { section: 'session', values: { made_up: true } },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'state_invalid' });
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

  it('check-update compares what is installed against the catalog’s pin', async () => {
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
      // "Up to date" means the catalog's pin, not whatever npm publishes today. The fake
      // installer reports 1.2.3 on disk while the catalog pins something else, so the
      // hub says an update is available — to the pinned version, not to `latest`.
      const pinned = INSTALLABLE.find((entry) => entry.id === 'gemini-cli')!;
      const version = pinned.install.kind === 'npm' ? pinned.install.version : null;
      expect(job.json()).toMatchObject({
        kind: 'check_update',
        status: 'succeeded',
        result: { latest_version: version, update_available: true },
      });
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
    const dataDir = mkdtempSync(path.join(tmpdir(), 'majlis-reconcile-'));
    const env = { DATA_DIR: dataDir, HUB_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD };
    try {
      // First boot: nothing on the volume, so nothing claims to be installed.
      const first = await testHub(env, { agents: { installer: fakeInstaller() } });
      expect((await listAgents(first)).every((item) => item.status === 'not_installed')).toBe(true);
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
  });
});

describe('agents: the curated catalog (ADR 0006)', () => {
  it('is well formed: unique ids, an exact version pin and a licence on every entry', () => {
    expect(() => assertCatalogIsWellFormed()).not.toThrow();
    for (const entry of INSTALLABLE) {
      expect(entry.install.kind).toBe('npm');
      expect(entry.licence).toBeTruthy();
    }
  });

  it('ships Hermes as bundled, so no job can install or remove it', () => {
    expect(HERMES_ENTRY.install.kind).toBe('bundled');
    expect(INSTALLABLE.map((entry) => entry.id)).not.toContain('hermes');
  });

  it('rejects a catalog that pins a range instead of a version', () => {
    expect(() =>
      assertCatalogIsWellFormed([
        { ...HERMES_ENTRY, install: { kind: 'npm', package: 'x', version: '^1.0.0' } },
      ]),
    ).toThrow(/pin an exact version/);
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
