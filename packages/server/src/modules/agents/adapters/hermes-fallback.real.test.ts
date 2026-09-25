/**
 * The fallback chain in the real Hermes (contract decision §54).
 *
 * The owner's outage of 2026-09-25 against Hermes itself: an OpenAI-compatible endpoint on
 * this machine answers its first model with `503 auth_unavailable` and its second one
 * normally. The hub is given that endpoint (LM Studio, shared), the first model as the chat
 * model and the second as its only fallback — through its own API, as the Defaults tab saves
 * them — and writes Hermes's `config.yaml`. Then one `python -m tui_gateway.entry` from the
 * image runs a turn on the first model:
 *
 * - `config.yaml` carries the chain as `fallback_providers`, in Hermes's own vocabulary;
 * - Hermes moves down it by itself and the second model answers;
 * - the adapter says so in the hub's words (`model.fallback`), with the model that answered.
 *
 *   COREHUB_HERMES_IMAGE=corehub:local npx vitest run --maxWorkers=1 hermes-fallback.real
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { authed, drainJobs, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { HermesTuiSession, stdioTuiChannel, type TuiChannel } from './hermes-tui.js';
import type { AgentEvent } from './types.js';

const image = process.env.COREHUB_HERMES_IMAGE;

/** Two models: `down-1` is the owner's outage, `up-1` answers. Every chat is recorded. */
function proxyModel(asked: string[]): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'down-1', object: 'model' },
              { id: 'up-1', object: 'model' },
            ],
          }),
        );
        return;
      }
      const body = raw ? (JSON.parse(raw) as { model?: string; stream?: boolean }) : {};
      asked.push(String(body.model));
      if (body.model === 'down-1') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'auth_unavailable: no auth available (providers=antigravity, model=down-1)',
              type: 'server_error',
            },
          }),
        );
        return;
      }
      const reply = 'answered by up-1';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const delta of [{ role: 'assistant', content: reply }, {}]) {
          res.write(
            `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'up-1', choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] })}\n\n`,
          );
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'up-1',
          choices: [
            { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
}

describe.skipIf(!image)('the fallback chain in the real Hermes', () => {
  const asked: string[] = [];
  let model: http.Server;
  let home: string;
  let hub: TestHub & { token: string };
  let channel: TuiChannel;
  let processEnv: Record<string, string> = {};

  beforeAll(async () => {
    model = proxyModel(asked);
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
    home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-fallback-'));
    chmodSync(home, 0o777);
    // One retry, as Hermes's own example advises beside a fallback chain: the test is about
    // the move, not about how patiently Hermes waits on a provider that is down.
    writeFileSync(path.join(home, 'config.yaml'), 'agent:\n  api_max_retries: 1\n');

    hub = await signedInHub(
      {},
      {
        models: {
          fetchImpl: globalThis.fetch,
          restartDelayMs: 0,
          hermes: {
            home: () => home,
            profileHomes: () => [],
            restart: () => Promise.resolve(true),
            applyEnvironment: (env) => {
              processEnv = { ...env };
              return true;
            },
          },
        },
      },
    );
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/models/providers',
      payload: { preset: 'lmstudio', label: 'LM Studio', kind: 'llm', base_url: url },
    });
    expect(created.statusCode, created.body).toBe(201);
    const providerId = (created.json() as { id: string }).id;
    await drainJobs(hub.app);
    const saved = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/models/defaults',
      payload: {
        default: { provider_id: providerId, model: 'down-1' },
        fallbacks: [{ provider_id: providerId, model: 'up-1' }],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    chmodSync(path.join(home, 'config.yaml'), 0o666);

    channel = stdioTuiChannel({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        '--network',
        'host',
        '-v',
        `${home}:/hh`,
        '-e',
        'HERMES_HOME=/hh',
        ...Object.entries(processEnv).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        '--entrypoint',
        '/opt/hermes/.venv/bin/python',
        image!,
        '-m',
        'tui_gateway.entry',
      ],
      env: process.env,
      readyTimeoutMs: 120_000,
    });
  }, 600_000);

  afterAll(async () => {
    await channel?.close();
    await hub?.close();
    model?.close();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // partly written by the container's user; the OS reclaims the temp dir
    }
  });

  it("writes the chain as Hermes's fallback_providers", () => {
    const config = YAML.parse(readFileSync(path.join(home, 'config.yaml'), 'utf8')) as {
      model?: { default?: string; provider?: string };
      fallback_providers?: unknown;
      agent?: unknown;
    };
    expect(config.model).toMatchObject({ default: 'down-1', provider: 'corehub-lmstudio' });
    expect(config.fallback_providers).toEqual([{ provider: 'corehub-lmstudio', model: 'up-1' }]);
    // Every other key the file had is still there.
    expect(config.agent).toEqual({ api_max_retries: 1 });
  });

  it('moves to the fallback when the chat model answers 503 auth_unavailable', async () => {
    const session = await HermesTuiSession.open(channel, null, {
      model: 'down-1',
      provider: 'corehub-lmstudio',
    });
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'run.completed' || event.type === 'run.failed') return;
      }
    })();
    await session.send({
      text: 'hello',
      model: 'down-1',
      modelProvider: 'corehub-lmstudio',
      modelProviderSlug: 'lmstudio',
      fallbacks: [
        { providerId: 'P', provider: 'corehub-lmstudio', slug: 'lmstudio', model: 'up-1' },
      ],
    });
    await reading;
    await session.close();

    const text = events
      .filter(
        (e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta',
      )
      .map((e) => e.text)
      .join('');
    expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe('run.completed');
    expect(text).toContain('answered by up-1');
    expect(asked).toContain('down-1');
    expect(asked).toContain('up-1');
    const fallback = events.find((e) => e.type === 'model.fallback');
    expect(fallback, JSON.stringify(events.map((e) => e.type))).toMatchObject({
      answered: { model: 'up-1', provider: 'lmstudio' },
    });
    expect((fallback as Extract<AgentEvent, { type: 'model.fallback' }>).failed[0]?.model).toBe(
      'down-1',
    );
  }, 300_000);
});
