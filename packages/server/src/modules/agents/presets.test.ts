/**
 * Presets (contract decision §100): saving an agent's settings as a named bundle, activating it
 * back through the hub's own routes, and never keeping a secret. Every response is checked
 * against the contract's schema.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { ajvFor } from '../../../tests/contract/schema.js';
import { applyPreset, carriesSecret, withoutSecrets, type PresetCall } from './presets.js';

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

const SECRET_PROXY = 'http://proxyuser:hunter2-secret@proxy.local:3128';

async function boot(): Promise<{ hub: Hub; agent: string; root: string }> {
  hub = await signedInHub({}, { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } });
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  const root = path.join(hub.dataDir, 'hermes');
  mkdirSync(path.join(root, 'skills', 'notes-helper'), { recursive: true });
  writeFileSync(
    path.join(root, 'skills', 'notes-helper', 'SKILL.md'),
    '---\nname: notes-helper\ndescription: Keeps notes.\n---\n\n# Notes\n',
  );
  return { hub, agent, root };
}

const settingsValue = async (h: Hub, agent: string, section: string, key: string) => {
  const res = await authed(h, h.token, { method: 'GET', url: `/api/v1/agents/${agent}/settings` });
  expect(res.statusCode, res.body).toBe(200);
  const sections = (
    res.json() as {
      sections: Array<{ key: string; fields: Array<{ key: string; value: unknown }> }>;
    }
  ).sections;
  return sections.find((s) => s.key === section)?.fields.find((f) => f.key === key)?.value;
};

describe('the secret gate', () => {
  it('drops secret fields and values that carry a user and password', () => {
    expect(carriesSecret(SECRET_PROXY)).toBe(true);
    expect(carriesSecret('http://proxy.local:3128')).toBe(false);
    expect(carriesSecret(['a', { url: 'https://u:p@x.example' }])).toBe(true);
    expect(
      withoutSecrets([
        {
          key: 'network',
          fields: [
            { key: 'https_proxy', kind: 'text', value: SECRET_PROXY },
            { key: 'no_proxy', kind: 'text', value: 'localhost' },
            { key: 'api_key', kind: 'secret', value: '[stored]' },
          ],
        },
        { key: 'agent', fields: [{ key: 'max_turns', kind: 'integer', value: null }] },
      ]),
    ).toEqual({ network: { no_proxy: 'localhost' }, agent: { max_turns: null } });
  });
});

describe('applying', () => {
  it('writes nothing when the agent already matches, and never a secret from an old preset', async () => {
    const writes: Array<{ method: string; path: string; body: unknown }> = [];
    const model = { provider_id: '01J8QK3ZR2W7M5N4P6T8V9X0PV', model: 'm1' };
    const call: PresetCall = async (method, path, body) => {
      if (method !== 'GET') {
        writes.push({ method, path, body });
        return { status: 200, body: { restart_job_id: null } };
      }
      if (path === '/models/defaults') {
        return { status: 200, body: { default: model, fallbacks: [], inherited: [] } };
      }
      if (path === '/agents/A')
        return { status: 200, body: { kind: 'hermes', default_model: null } };
      if (path === '/agents/A/settings') {
        return {
          status: 200,
          body: {
            sections: [
              {
                key: 'network',
                fields: [
                  { key: 'https_proxy', kind: 'text', value: null },
                  { key: 'no_proxy', kind: 'text', value: 'localhost' },
                ],
              },
            ],
          },
        };
      }
      return { status: 404, body: { code: 'not_found' } };
    };
    const outcome = await applyPreset(call, 'A', {
      model: { default: model, fallbacks: [], agent: null },
      skills: null,
      mcp_servers: null,
      settings: { network: { https_proxy: SECRET_PROXY, no_proxy: 'localhost' } },
    });
    expect(writes).toEqual([]);
    expect(outcome.applied).toEqual(['model', 'settings']);
  });
});

describe('presets through the routes', () => {
  it('saves the current settings, keeps no secret, and activates them back', async () => {
    const { hub: h, agent, root } = await boot();
    const set = async (section: string, values: Record<string, unknown>) => {
      const res = await authed(h, h.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${agent}/settings`,
        payload: { section, values },
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    await set('agent', { max_turns: 25 });
    await set('network', { https_proxy: SECRET_PROXY, no_proxy: 'localhost' });

    const created = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/presets`,
      payload: { name: 'Quick', description: 'Fewer turns' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(schemas.validate(schema('AgentPreset'), created.json())).toEqual([]);
    const preset = created.json() as {
      id: string;
      content: {
        settings: Record<string, Record<string, unknown>>;
        skills: Record<string, boolean> | null;
        model: unknown;
      };
    };
    expect(preset.content.settings.agent?.max_turns).toBe(25);
    expect(preset.content.settings.network).toEqual({
      no_proxy: 'localhost',
      http_proxy: null,
    });
    expect(preset.content.skills).toEqual({ 'notes-helper': true });
    // No secret anywhere: not in the answer, not in the database file.
    expect(created.body).not.toContain('hunter2');
    const dbFile = path.join(h.dataDir, 'hub.sqlite');
    if (existsSync(dbFile)) expect(readFileSync(dbFile).includes('hunter2-secret')).toBe(false);

    // The name is the preset's: a second one with it is refused.
    const again = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/presets`,
      payload: { name: 'Quick' },
    });
    expect(again.statusCode).toBe(409);

    // Things move on: turns change and the skill is switched off.
    await set('agent', { max_turns: 90 });
    const off = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/agents/${agent}/skills/notes-helper`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    // Off where Hermes keeps it: its own `skills.disabled` list (§103).
    expect(readFileSync(path.join(root, 'config.yaml'), 'utf8')).toMatch(
      /skills:\s*\n\s+disabled:\s*\n\s+- notes-helper/,
    );

    const activated = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/presets/${preset.id}/activate`,
    });
    expect(activated.statusCode, activated.body).toBe(200);
    expect(schemas.validate(schema('AgentPresetActivation'), activated.json())).toEqual([]);
    const outcome = activated.json() as {
      applied: string[];
      skipped: unknown[];
      preset: { last_activated_at: string | null };
    };
    expect(outcome.applied).toEqual(expect.arrayContaining(['skills', 'settings']));
    expect(outcome.preset.last_activated_at).not.toBeNull();
    expect(await settingsValue(h, agent, 'agent', 'max_turns')).toBe(25);
    expect(existsSync(path.join(root, 'skills', 'notes-helper', 'SKILL.md'))).toBe(true);
    // The proxy with its password was never in the preset, so activating left it alone.
    expect(await settingsValue(h, agent, 'network', 'https_proxy')).toBe(SECRET_PROXY);

    const listed = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/presets`,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: Array<{ id: string }> }).items.map((p) => p.id)).toEqual([
      preset.id,
    ]);
    const read = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/presets/${preset.id}`,
    });
    expect(read.statusCode).toBe(200);
    expect(schemas.validate(schema('AgentPreset'), read.json())).toEqual([]);

    const removed = await authed(h, h.token, {
      method: 'DELETE',
      url: `/api/v1/agents/${agent}/presets/${preset.id}`,
    });
    expect(removed.statusCode).toBe(204);
    const gone = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/presets/${preset.id}`,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('reports what is gone since the preset was saved and applies the rest', async () => {
    const { hub: h, agent, root } = await boot();
    const created = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/presets`,
      payload: { name: 'With notes' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    // The skill is removed from disk after the preset was saved.
    writeFileSync(path.join(root, 'skills', 'notes-helper', 'SKILL.md'), '');
    const { rmSync } = await import('node:fs');
    rmSync(path.join(root, 'skills', 'notes-helper'), { recursive: true, force: true });

    const activated = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/presets/${id}/activate`,
    });
    expect(activated.statusCode, activated.body).toBe(200);
    const outcome = activated.json() as {
      applied: string[];
      skipped: Array<{ part: string; key: string | null; code: string }>;
    };
    expect(outcome.skipped).toContainEqual({
      part: 'skills',
      key: 'notes-helper',
      code: 'not_found',
    });
    expect(outcome.applied).toContain('settings');
  });

  it('is written by admins only, and a preset of one profile is not seen in another', async () => {
    const { hub: h, agent } = await boot();
    const made = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'Work' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const created = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/presets`,
      payload: { name: 'Default only' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const other = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/agents/${agent}/presets/${id}`,
      profile: 'work',
    });
    expect(other.statusCode).toBe(404);

    // A member may not save or activate one.
    const member = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: {
        username: 'member1',
        password: 'member-password-1',
        role: 'member',
        profiles: ['default'],
      },
    });
    expect(member.statusCode, member.body).toBe(201);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'member1', password: 'member-password-1' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const token = (login.json() as { access_token: string }).access_token;
    const refused = await authed(h, token, {
      method: 'POST',
      url: `/api/v1/agents/${agent}/presets/${id}/activate`,
    });
    expect(refused.statusCode).toBe(403);
  });
});
