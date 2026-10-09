/**
 * A newer Hermes for a person's own Hermes (DECISIONS §132, the owner's addition of 2026-09-28):
 * the hub learns Hermes's releases from GitHub, as it learns other agents' from npm — asked, never
 * installed on its own — so the card says an update exists and whether Core Hub was tested with
 * it; Hermes's own updater takes it (§119). The image's Hermes, which comes with the image, is
 * never looked up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  authed,
  drainJobs,
  emptyAdapterSet,
  signedInHub,
  type TestHub,
} from '../../../tests/unit/helpers.js';
import type { AgentProbe } from './adapters/types.js';
import { HERMES_TESTED } from './catalog/hermes-versions.js';
import { agentsServiceFor } from './index.js';
import type { HermesUpdater } from './service.js';
import { createPackageRegistry, releaseVersionOf, type PackageRegistry } from './update-policy.js';

const hubs: TestHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
});

/** GitHub's `GET /repos/{repo}/releases`, as Hermes's look. */
const RELEASES = [
  { tag_name: 'v2026.10.8', name: 'Hermes Agent v0.22.1 (v2026.10.8)', prerelease: true },
  { tag_name: 'v2026.10.1', name: 'Hermes Agent v0.22.0 (v2026.10.1)', draft: true },
  { tag_name: 'v2026.9.30', name: 'Hermes Agent v0.21.6 (v2026.9.30)' },
  { tag_name: 'v2026.9.24', name: 'Hermes Agent v0.21.5 (v2026.9.24)' },
  { tag_name: 'v2026.9.14', name: 'Hermes Agent v0.21.3 (v2026.9.14)' },
];

function fakeGitHub(answer: () => Response) {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    asked.push(String(input));
    return answer();
  };
  return { fetchImpl, asked };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function personsHermes(version: string): () => AgentProbe {
  return () => ({
    installed: true,
    source: 'user_cli',
    executablePath: '/Users/sam/.local/bin/hermes',
    version,
    runtime: { state: 'running', url: 'http://127.0.0.1:8642', error: null },
    error: null,
  });
}

const updater = (available: boolean): HermesUpdater => ({
  available: () => available,
  run: async () => undefined,
  restart: async () => undefined,
});

async function hubWith(options: {
  version: string;
  ownHermes: boolean;
  registry: PackageRegistry;
}): Promise<TestHub & { token: string }> {
  const hub = await signedInHub(
    {},
    {
      agents: {
        adapters: emptyAdapterSet(personsHermes(options.version)),
        hermesUpdate: updater(options.ownHermes),
        updates: { registry: options.registry, firstCheckMs: 3_600_000 },
      },
    },
  );
  hubs.push(hub);
  return hub;
}

async function hermesOf(hub: TestHub & { token: string }) {
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  return (
    list.json() as { items: Array<{ id: string; slug: string; install: Record<string, unknown> }> }
  ).items.find((agent) => agent.slug === 'hermes')!;
}

async function checkUpdate(hub: TestHub & { token: string }, id: string) {
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: `/api/v1/agents/${id}/check-update`,
  });
  expect(res.statusCode, res.body).toBe(202);
  await drainJobs(hub.app);
}

describe('GitHub releases as a registry', () => {
  it('names the newest published release by the version in its title, never a draft or a pre-release', async () => {
    const github = fakeGitHub(() => json(RELEASES));
    const registry = createPackageRegistry({ fetchImpl: github.fetchImpl });
    expect(await registry.latest('github', 'NousResearch/hermes-agent')).toBe('0.21.6');
    expect(github.asked).toEqual([
      'https://api.github.com/repos/NousResearch/hermes-agent/releases?per_page=30',
    ]);
    expect(
      releaseVersionOf({ name: 'Hermes Agent v0.21.5 (v2026.9.24)', tag_name: 'v2026.9.24' }),
    ).toBe('0.21.5');
    expect(releaseVersionOf({ name: 'Release', tag_name: 'v1.2.3' })).toBe('1.2.3');
    expect(releaseVersionOf({ name: 'Nightly', tag_name: 'nightly' })).toBeNull();
  });

  it('answers none for an empty list, and throws when GitHub cannot be reached', async () => {
    expect(
      await createPackageRegistry({ fetchImpl: fakeGitHub(() => json([])).fetchImpl }).latest(
        'github',
        'NousResearch/hermes-agent',
      ),
    ).toBeNull();
    const down = createPackageRegistry({ fetchImpl: fakeGitHub(() => json({}, 503)).fetchImpl });
    await expect(down.latest('github', 'NousResearch/hermes-agent')).rejects.toThrow(/503/);
    await expect(down.latest('github', '../../etc')).rejects.toThrow(/not a GitHub repository/);
  });
});

describe("a person's own Hermes and Hermes's newer releases", () => {
  it('says an update exists, and that Core Hub is not tested with it yet', async () => {
    const github = fakeGitHub(() => json(RELEASES));
    const hub = await hubWith({
      version: '0.21.5+3397.gd25bbd0',
      ownHermes: true,
      registry: createPackageRegistry({ fetchImpl: github.fetchImpl }),
    });
    const before = await hermesOf(hub);
    expect(before.install).toMatchObject({
      self_update: true,
      tested_version: HERMES_TESTED.version,
      newer_than_tested: false,
      pinned_version: null,
    });

    // The six-hourly check lists it (never to take it on its own)…
    const candidates = agentsServiceFor(hub.app).updateCandidates();
    expect(candidates.find((candidate) => candidate.slug === 'hermes')).toMatchObject({
      registry: 'github',
      package: 'NousResearch/hermes-agent',
      autoUpdate: false,
    });
    // …and Check for updates asks GitHub now.
    await checkUpdate(hub, before.id);
    expect(github.asked).toHaveLength(1);
    expect((await hermesOf(hub)).install).toMatchObject({
      latest_version: '0.21.6',
      update_available: true,
      tested_version: HERMES_TESTED.version,
    });
  });

  it('says a Hermes past the tested release may not be supported yet', async () => {
    // One patch release past whatever the image is tested with.
    const past = HERMES_TESTED.version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
    const hub = await hubWith({
      version: past,
      ownHermes: true,
      registry: createPackageRegistry({ fetchImpl: fakeGitHub(() => json(RELEASES)).fetchImpl }),
    });
    expect((await hermesOf(hub)).install).toMatchObject({
      newer_than_tested: true,
      tested_version: HERMES_TESTED.version,
      below_minimum: false,
    });
  });

  it('never looks up the Hermes that comes with the image', async () => {
    const github = fakeGitHub(() => json(RELEASES));
    const hub = await hubWith({
      version: HERMES_TESTED.version,
      ownHermes: false,
      registry: createPackageRegistry({ fetchImpl: github.fetchImpl }),
    });
    const hermes = await hermesOf(hub);
    expect(
      agentsServiceFor(hub.app)
        .updateCandidates()
        .map((c) => c.slug),
    ).not.toContain('hermes');
    await checkUpdate(hub, hermes.id);
    expect(github.asked).toEqual([]);
    expect((await hermesOf(hub)).install).toMatchObject({
      latest_version: null,
      update_available: false,
      newer_than_tested: false,
    });
  });

  it('keeps what it knew when GitHub cannot be reached', async () => {
    let up = true;
    const github = fakeGitHub(() => (up ? json(RELEASES) : json({}, 503)));
    const hub = await hubWith({
      version: '0.21.5',
      ownHermes: true,
      registry: createPackageRegistry({ fetchImpl: github.fetchImpl }),
    });
    const hermes = await hermesOf(hub);
    await checkUpdate(hub, hermes.id);
    up = false;
    const res = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/agents/${hermes.id}/check-update`,
    });
    expect(res.statusCode).toBe(202);
    await drainJobs(hub.app);
    expect((await hermesOf(hub)).install).toMatchObject({
      latest_version: '0.21.6',
      update_available: true,
    });
  });
});
