/**
 * Core Hub's skill library through the hub's own routes (decision §60): listed as `source:
 * library` in the `core-hub` category with the library's summary, an edit marked and restored,
 * the per-profile switch, and the refusals. Plus the boot-time seed over every profile Hermes has.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { seedSkillLibraryOfEveryProfile } from './index.js';
import { LIBRARY_CATEGORY, shippedLibrary } from './skill-library.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

async function boot(): Promise<{ hub: Hub; agent: string; root: string }> {
  hub = await signedInHub({}, { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } });
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  return { hub, agent, root: path.join(hub.dataDir, 'hermes') };
}

interface Listed {
  categories: Array<{
    key: string;
    skills: Array<{ key: string; source: string; library: string | null }>;
  }>;
  library: { enabled: boolean; available: number; installed: number; edited: number };
}

async function list(h: Hub, agent: string): Promise<Listed> {
  const res = await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/skills` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Listed;
}

const setLibrary = (h: Hub, agent: string, enabled: boolean) =>
  authed(h, h.token, {
    method: 'PATCH',
    url: `/api/v1/agents/${agent}/skill-library`,
    payload: { enabled },
  });

describe('the Core Hub skill library on the Skills page', () => {
  it('is installed on request, listed as library skills in their category, and summarised', async () => {
    const { hub: h, agent, root } = await boot();
    const available = shippedLibrary().skills.size;
    // An external gateway's home is not seeded at boot: the page offers to install.
    const before = await list(h, agent);
    expect(before.library).toEqual({ enabled: true, available, installed: 0, edited: 0 });

    const on = await setLibrary(h, agent, true);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toEqual({ enabled: true, available, installed: available, edited: 0 });

    const after = await list(h, agent);
    const category = after.categories.find((entry) => entry.key === LIBRARY_CATEGORY)!;
    expect(category.skills.map((skill) => skill.key)).toContain('image-generate');
    expect(category.skills.every((skill) => skill.source === 'library')).toBe(true);
    expect(category.skills.every((skill) => skill.library === 'current')).toBe(true);
    expect(
      existsSync(path.join(root, 'skills', LIBRARY_CATEGORY, 'image-generate', 'SKILL.md')),
    ).toBe(true);
  });

  it('marks an edited skill, and Restore puts the library’s version back', async () => {
    const { hub: h, agent, root } = await boot();
    await setLibrary(h, agent, true);
    const file = path.join(root, 'skills', LIBRARY_CATEGORY, 'summarize', 'SKILL.md');
    const shipped = readFileSync(file, 'utf8');
    const mine = shipped.replace('# Summarize Skill', '# My summaries');

    const put = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/skills/summarize`,
      payload: { content: mine },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ source: 'library', library: 'edited' });
    expect((await list(h, agent)).library.edited).toBe(1);

    const restored = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills/summarize/restore`,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ key: 'summarize', library: 'current' });
    expect(readFileSync(file, 'utf8')).toBe(shipped);
  });

  it('switched off: the untouched skills go, the edited one stays as the person’s', async () => {
    const { hub: h, agent, root } = await boot();
    await setLibrary(h, agent, true);
    const file = path.join(root, 'skills', LIBRARY_CATEGORY, 'translate', 'SKILL.md');
    const mine = `${readFileSync(file, 'utf8')}\nMy glossary.\n`;
    await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/skills/translate`,
      payload: { content: mine },
    });

    const off = await setLibrary(h, agent, false);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ enabled: false, installed: 0, edited: 0 });
    const listed = await list(h, agent);
    const keys = listed.categories.flatMap((entry) => entry.skills.map((skill) => skill.key));
    expect(keys).toEqual(['translate']);
    expect(listed.categories[0]!.skills[0]).toMatchObject({ source: 'user', library: null });
    expect(readFileSync(file, 'utf8')).toBe(mine);

    // Restore needs the library on.
    const refused = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills/translate/restore`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ details: { reason: 'skill_library_off' } });
  });

  it('refuses Restore for a skill the library does not ship', async () => {
    const { hub: h, agent } = await boot();
    await setLibrary(h, agent, true);
    await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/skills/my-own`,
      payload: { content: '---\nname: my-own\ndescription: Mine.\n---\n\nBody.\n' },
    });
    const res = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/skills/my-own/restore`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { reason: 'skill_not_library' } });
  });

  it('refuses a switch that is not a boolean', async () => {
    const { hub: h, agent } = await boot();
    const res = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/skill-library`,
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the boot-time seed', () => {
  it('installs the library into the default profile and every named one Hermes has', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'corehub-seed-root-'));
    try {
      mkdirSync(path.join(root, 'profiles', 'work'), { recursive: true });
      const logged: object[] = [];
      seedSkillLibraryOfEveryProfile(root, {
        info: (obj: object) => logged.push(obj),
        warn: () => undefined,
      } as never);
      for (const home of [root, path.join(root, 'profiles', 'work')]) {
        expect(
          existsSync(path.join(home, 'skills', LIBRARY_CATEGORY, 'image-edit', 'SKILL.md')),
          home,
        ).toBe(true);
      }
      expect(logged).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
