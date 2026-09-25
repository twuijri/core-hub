// `pnpm contract:test`: the platforms the hub links (`agents.listChannelPlatforms`), linking one
// by its credentials, its settings and unlinking it — every answer validated against the schema
// the contract documents for its status. Discord's `/users/@me` is scripted; Hermes is a fake
// `hermes` on PATH with a fake spawner, so nothing leaves the machine.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import type { SpawnedProcess, Spawner } from '../../src/modules/agents/hermes-runtime.js';
import type { HermesApiCall } from '../../src/modules/agents/hermes-tools.js';
import { authed, signedInHub, type TestHub } from '../unit/helpers.js';
import { ajvFor, operationsById, responseSchema } from './schema.js';

const doc = loadOpenApiDocument();
const TOKEN = 'fake-discord-token-for-tests-only-0000000000000000000000000000001';

class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = 9700;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    setTimeout(() => this.emit('exit', 0, null), 1);
    return true;
  }
}

describe.skipIf(!doc)('contract: messaging platforms linked by credentials', () => {
  const document = doc!;
  const ops = operationsById(document);
  const schemas = ajvFor(document);
  let hub: TestHub & { token: string };
  let bin: string;
  let agent: string;

  beforeAll(async () => {
    bin = mkdtempSync(path.join(tmpdir(), 'corehub-contract-channels-'));
    writeFileSync(path.join(bin, 'hermes'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(bin, 'hermes'), 0o755);
    const spawnImpl: Spawner = () => new FakeChild();
    const api: HermesApiCall = async <T>() => ({ pending: [], approved: [] }) as T;
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Headers(init?.headers).get('authorization') === `Bot ${TOKEN}`
        ? new Response(JSON.stringify({ id: '1234567890123456789', username: 'office_helper' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ message: '401: Unauthorized' }), { status: 401 });
    hub = await signedInHub(
      {},
      {
        agents: {
          pathValue: bin,
          runtime: { spawnImpl, healthIntervalMs: 0, gatewayBackoffMs: [5] },
          hermesApi: api,
          channelProbe: { fetchImpl },
        },
      },
    );
    const list = await authed(hub, hub.token, { url: '/api/v1/agents' });
    agent = (list.json() as { items: Array<{ id: string; kind: string }> }).items.find(
      (row) => row.kind === 'hermes',
    )!.id;
  });
  afterAll(async () => {
    await hub.close();
    rmSync(bin, { recursive: true, force: true });
  });

  async function call(
    operationId: string,
    status: number,
    init: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: unknown },
  ): Promise<Record<string, unknown>> {
    const op = ops.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    const res = await authed(hub, hub.token, {
      method:
        init.method ?? (op.method.toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'),
      url: `/api/v1${init.url}`,
      ...(init.payload === undefined ? {} : { payload: init.payload }),
    });
    expect(res.statusCode, `${operationId}: ${res.body}`).toBe(status);
    const body = res.json() as Record<string, unknown>;
    const schema = responseSchema(op, status);
    if (schema) expect(schemas.validate(schema, body), operationId).toEqual([]);
    return body;
  }

  it('lists the platforms as the contract says', async () => {
    const body = await call('agents.listChannelPlatforms', 200, {
      url: `/agents/${agent}/channel-platforms`,
    });
    expect((body.items as unknown[]).length).toBeGreaterThan(15);
  });

  it('links Discord, reads and writes its settings, and unlinks it', async () => {
    const refused = await call('agents.linkChannel', 400, {
      url: `/agents/${agent}/channels/discord/link`,
      payload: {
        credentials: {
          DISCORD_BOT_TOKEN:
            'fake-discord-token-for-tests-only-0000000000000000000000000000bad',
        },
      },
    });
    expect(refused.details).toMatchObject({ reason: 'credentials_rejected' });
    const linked = await call('agents.linkChannel', 200, {
      url: `/agents/${agent}/channels/discord/link`,
      payload: { credentials: { DISCORD_BOT_TOKEN: TOKEN }, allowed_users: ['42'] },
    });
    expect(linked).toMatchObject({ login: 'credentials', link: { linked: true } });
    await call('agents.listChannels', 200, { url: `/agents/${agent}/channels` });
    await call('agents.getChannelSettings', 200, {
      url: `/agents/${agent}/channels/discord/settings`,
    });
    await call('agents.updateChannelSettings', 200, {
      url: `/agents/${agent}/channels/discord/settings`,
      payload: { values: { require_mention: false, home_channel: '3333' } },
    });
    const unlinked = await call('agents.unlinkChannel', 200, {
      url: `/agents/${agent}/channels/discord/unlink`,
    });
    expect(unlinked).toMatchObject({ link: { linked: false } });
  });
});
