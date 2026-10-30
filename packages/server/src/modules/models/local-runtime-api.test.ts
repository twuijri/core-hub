/**
 * Local models over HTTP (ADR 0032): unavailable on a server hub, and on a desktop hub an Ollama
 * already on the computer becomes the `ollama` provider and has its models managed.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';

const hubs: TestHub[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** An Ollama with one model that accepts pulls and deletes. */
async function fakeOllama(): Promise<{ url: string; models: Set<string> }> {
  const models = new Set<string>(['llama3.2:3b']);
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/version')
        return response.end(JSON.stringify({ version: '0.40.9' }));
      if (request.url === '/api/tags') {
        return response.end(
          JSON.stringify({ models: [...models].map((name) => ({ name, size: 1, details: {} })) }),
        );
      }
      if (request.url === '/api/ps') return response.end(JSON.stringify({ models: [] }));
      if (request.url === '/api/pull') {
        models.add(body.model ?? '');
        return response.end(`${JSON.stringify({ status: 'success' })}\n`);
      }
      if (request.url === '/api/delete') {
        models.delete(body.model ?? '');
        return response.end('{}');
      }
      response.statusCode = 404;
      response.end('{"error":"not found"}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    models,
  };
}

/** Only loopback answers: GitHub and every cloud provider are out of reach in the suite. */
const loopbackOnly = ((input: string | URL | Request, init?: RequestInit) =>
  String(input).startsWith('http://127.0.0.1')
    ? fetch(input, init)
    : Promise.reject(new Error('offline'))) as typeof fetch;

describe('local models over HTTP', () => {
  it('is unavailable on a hub that is not the desktop app’s, and refuses to install', async () => {
    const hub = await signedInHub();
    hubs.push(hub);
    const view = await authed(hub, hub.token, {
      method: 'GET',
      url: '/api/v1/models/local-runtime',
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ available: false, mode: 'none' });
    const install = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/local-runtime/install',
    });
    expect(install.statusCode).toBe(409);
  });

  it('turns an Ollama already on the computer into the ollama provider and manages its models', async () => {
    const ollama = await fakeOllama();
    const hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: loopbackOnly,
          localRuntime: { available: true, externalUrl: ollama.url },
        },
      },
    );
    hubs.push(hub);

    const view = await authed(hub, hub.token, {
      method: 'GET',
      url: '/api/v1/models/local-runtime',
    });
    expect(view.json()).toMatchObject({
      available: true,
      mode: 'external',
      state: 'running',
      version: '0.40.9',
      base_url: ollama.url,
    });

    // Boot pointed a shared `ollama` row at it, in the background.
    let provider: { slug: string; base_url: string | null } | undefined;
    for (let i = 0; i < 50 && !provider; i += 1) {
      const list = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/models/providers' });
      provider = (list.json() as { items: { slug: string; base_url: string | null }[] }).items.find(
        (row) => row.slug === 'ollama',
      );
      if (!provider) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(provider?.base_url).toBe(ollama.url);

    const pull = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/local-runtime/models',
      payload: { name: 'qwen3:4b' },
    });
    expect(pull.statusCode).toBe(202);
    await drainJobs(hub.app);
    const models = await authed(hub, hub.token, {
      method: 'GET',
      url: '/api/v1/models/local-runtime/models',
    });
    expect(models.statusCode).toBe(200);
    expect(
      (models.json() as { installed: { name: string }[] }).installed.map((m) => m.name),
    ).toEqual(['llama3.2:3b', 'qwen3:4b']);

    const removed = await authed(hub, hub.token, {
      method: 'DELETE',
      url: '/api/v1/models/local-runtime/models?name=qwen3%3A4b',
    });
    expect(removed.statusCode).toBe(204);
    expect(ollama.models.has('qwen3:4b')).toBe(false);

    // The program is the person's: the hub neither stops nor removes it.
    const stop = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/local-runtime/stop',
    });
    expect(stop.statusCode).toBe(409);
    const remove = await authed(hub, hub.token, {
      method: 'DELETE',
      url: '/api/v1/models/local-runtime',
    });
    expect(remove.statusCode).toBe(409);
  });
});
