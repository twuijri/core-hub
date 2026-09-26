/**
 * The Memory page's routes write and read where Hermes does, in the profile the request names:
 * `SOUL.md` at the profile home, `MEMORY.md` / `USER.md` in its `memories/` folder. The real
 * Hermes reading and writing the same files is `memory.real.test.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

type Hub = TestHub & { token: string };
let hub: Hub | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

/** A gateway that answers its health probe, so the runtime is `external` and has a home. */
const healthy: typeof fetch = async () =>
  new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });

async function boot(): Promise<{ hub: Hub; agent: string; root: string }> {
  hub = await signedInHub({}, { agents: { adapterOptions: { hermes: { fetchImpl: healthy } } } });
  const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
  const agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
    (row) => row.kind === 'hermes',
  )!.id;
  const root = path.join(hub.dataDir, 'hermes');
  mkdirSync(root, { recursive: true });
  return { hub, agent, root };
}

interface Item {
  id: string;
  title: string;
  content: string | null;
}

async function memoryOf(h: Hub, agent: string, profile: string): Promise<Record<string, Item>> {
  const res = await authed(h, h.token, {
    method: 'GET',
    url: `/api/v1/agents/${agent}/memory`,
    profile,
  });
  expect(res.statusCode, res.body).toBe(200);
  return Object.fromEntries((res.json() as { items: Item[] }).items.map((i) => [i.id, i]));
}

describe('the Memory page, where Hermes reads', () => {
  it("writes a profile's memory into its own memories/ and reads back what Hermes kept", async () => {
    const { hub: h, agent, root } = await boot();
    const made = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { slug: 'work', name: 'Work' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const work = path.join(root, 'profiles', 'work');
    mkdirSync(work, { recursive: true });

    const saved = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/memory/memory`,
      payload: { content: 'The deploy runs on Fridays.' },
      profile: 'work',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ id: 'memory', title: 'memories/MEMORY.md' });
    expect(readFileSync(path.join(work, 'memories', 'MEMORY.md'), 'utf8')).toBe(
      'The deploy runs on Fridays.',
    );
    expect(existsSync(path.join(work, 'MEMORY.md'))).toBe(false);
    // Not the default profile's.
    expect(existsSync(path.join(root, 'memories', 'MEMORY.md'))).toBe(false);
    expect((await memoryOf(h, agent, 'default')).memory!.content).toBe('');

    // What Hermes itself kept about the person, in its own file and format, shows on the page.
    mkdirSync(path.join(root, 'memories'), { recursive: true });
    writeFileSync(path.join(root, 'memories', 'USER.md'), 'Prefers short answers.\n§\nيحب القهوة.');
    expect((await memoryOf(h, agent, 'default')).user!.content).toBe(
      'Prefers short answers.\n§\nيحب القهوة.',
    );
    expect((await memoryOf(h, agent, 'work')).user!.content).toBe('');
  });

  it('refuses to grow a list past its budget, with the budget in the answer', async () => {
    const { hub: h, agent, root } = await boot();
    writeFileSync(path.join(root, 'config.yaml'), 'memory:\n  user_char_limit: 10\n');
    const res = await authed(h, h.token, {
      method: 'PUT',
      url: `/api/v1/agents/${agent}/memory/user`,
      payload: { content: 'more than ten characters' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({
      details: { reason: 'memory_too_long', limit: 10, length: 24 },
    });
    expect(existsSync(path.join(root, 'memories', 'USER.md'))).toBe(false);
  });

  it('lists each entry on its own with the budget it counts against (decision §102)', async () => {
    const { hub: h, agent, root } = await boot();
    writeFileSync(path.join(root, 'config.yaml'), 'memory:\n  user_char_limit: 500\n');
    mkdirSync(path.join(root, 'memories'), { recursive: true });
    // Hermes's separator with stray spaces and an empty entry: listed as Hermes reads it.
    writeFileSync(path.join(root, 'memories', 'USER.md'), ' Prefers short answers. \n§\n\n§\nيحب القهوة.');
    const items = await memoryOf(h, agent, 'default');
    expect(items.user).toMatchObject({
      entries: ['Prefers short answers.', 'يحب القهوة.'],
      char_limit: 500,
      // "Prefers short answers." (22) + "\n§\n" (3) + "يحب القهوة." (11), in code points.
      char_count: 36,
    });
    // MEMORY.md is not there yet: no entries, Hermes's default budget.
    expect(items.memory).toMatchObject({ entries: [], char_limit: 2200, char_count: 0 });
    // SOUL.md is one text with no budget.
    expect(items.soul).toMatchObject({ entries: null, char_limit: null, char_count: null });
  });
});
