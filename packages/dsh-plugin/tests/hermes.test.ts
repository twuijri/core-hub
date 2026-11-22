import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentBridge, messageText, pickAgent } from '../src/hermes.js';
import { HubConnection } from '../src/hub.js';
import { PluginStore, type StoredLink } from '../src/store.js';
import { fakeFetch, type Seen } from './fake-hub.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const link: StoredLink = {
  version: 1,
  hub: 'https://hub.example',
  token: 'hub_at_1',
  token_expires_at: null,
  device_id: 'D1',
  user: { id: 'u1', username: 'tariq', display_name: 'Tariq' },
  profiles: ['default', 'work'],
  default_profile: 'work',
  linked_at: '2026-11-22T00:00:00.000Z',
};

function hub(runStatuses: string[]) {
  let polls = 0;
  let sessions = 0;
  return fakeFetch((s: Seen) => {
    if (s.method === 'GET' && s.path === '/agents')
      return {
        status: 200,
        json: {
          items: [
            { id: 'A0', slug: 'claude-code', kind: 'acp', enabled: true },
            { id: 'A1', slug: 'hermes', kind: 'hermes', enabled: true },
          ],
        },
      };
    if (s.method === 'POST' && s.path === '/sessions') {
      sessions += 1;
      return { status: 201, json: { id: `S${sessions}` } };
    }
    const run = /^\/sessions\/(S\d)\/runs$/.exec(s.path);
    if (s.method === 'POST' && run)
      return { status: 202, json: { run_id: 'R1', message_id: 'M0', queue_position: null } };
    if (s.method === 'GET' && /\/runs\/R1$/.test(s.path)) {
      const status = runStatuses[Math.min(polls++, runStatuses.length - 1)]!;
      return {
        status: 200,
        json: {
          id: 'R1',
          status,
          output_message_id: status === 'succeeded' ? 'M2' : null,
          error: null,
        },
      };
    }
    if (s.method === 'GET' && /\/messages$/.test(s.path))
      return {
        status: 200,
        json: {
          items: [
            { id: 'M0', role: 'user', content: [{ type: 'text', text: 'hi' }] },
            {
              id: 'M2',
              role: 'assistant',
              content: [
                { type: 'text', text: 'Hello' },
                { type: 'image', attachment_id: 'x' },
                { type: 'text', text: 'there' },
              ],
            },
          ],
        },
      };
    return undefined;
  });
}

function bridge(fetch: typeof globalThis.fetch, profile: string | null = null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-dsh-agent-'));
  dirs.push(dir);
  const store = new PluginStore(dir);
  const connection = new HubConnection(link, { store, fetch });
  return new AgentBridge({
    connection: () => connection,
    store,
    settings: () => ({ profile, agent: 'hermes' }),
    pollMs: 1,
    sleep: async () => undefined,
  });
}

describe('AgentBridge', () => {
  it('starts one hub conversation per harness session in the chosen profile, and returns the answer', async () => {
    const { fetch, seen } = hub(['queued', 'running', 'succeeded']);
    const b = bridge(fetch);
    expect(await b.ask('harness-1', 'hi')).toEqual({
      state: 'answered',
      text: 'Hello\nthere',
      session_id: 'S1',
      run_id: 'R1',
    });
    const create = seen.find((s) => s.method === 'POST' && s.path === '/sessions')!;
    expect(create.body).toMatchObject({ agent_id: 'A1' });
    expect(create.headers['x-hub-profile']).toBe('work');
    await b.ask('harness-1', 'again');
    expect(seen.filter((s) => s.method === 'POST' && s.path === '/sessions')).toHaveLength(1);
    await b.ask('harness-2', 'other');
    expect(seen.filter((s) => s.method === 'POST' && s.path === '/sessions')).toHaveLength(2);
  });

  it('says when the agent waits for an approval', async () => {
    const { fetch } = hub(['running', 'waiting']);
    expect(await bridge(fetch, 'default').ask('h', 'x')).toMatchObject({ state: 'waiting' });
  });

  it('says when nothing is linked', async () => {
    const b = new AgentBridge({
      connection: () => null,
      store: new PluginStore('/nonexistent'),
      settings: () => ({ profile: null, agent: 'hermes' }),
    });
    expect(await b.ask('h', 'x')).toMatchObject({ state: 'failed', message: 'not_linked' });
  });

  it('picks the agent and reads text blocks', () => {
    const agents = [
      { id: 'A0', slug: 'x', kind: 'acp', enabled: false },
      { id: 'A2', slug: 'y', kind: 'acp', enabled: true },
    ] as never[];
    expect(pickAgent(agents, 'hermes')?.id).toBe('A2');
    expect(messageText(null)).toBe('');
  });
});
