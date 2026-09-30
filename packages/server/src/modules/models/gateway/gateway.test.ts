/**
 * The model gateway (ADR 0029) against a stand-in for CLIProxyAPI (`testing/fake-cliproxy.mjs`),
 * which reads the file the hub writes exactly as the real one does. The real CLIProxyAPI with the
 * real agents is `agents/model-gateway.real.test.ts`.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

/** CLIProxyAPI's file, as far as these tests read it. */
interface CliproxyYaml {
  server: Record<string, unknown>;
  management: Record<string, unknown>;
  access: { 'api-keys': string[] };
  routing: Record<string, unknown>;
  plugins: { enabled: boolean };
  oauth: Record<string, string>;
  'api-keys': Record<string, { keys: unknown; models: unknown[]; [field: string]: unknown }[]>;
}
import { CliproxySupervisor } from './cliproxy.js';
import { NO_KEY, cliproxyConfig, upstreamPrefix, type GatewayUpstream } from './cliproxy-config.js';
import { ModelGateway, isLoopback, type GatewaySource } from './gateway.js';
import type { GatewayTurnUsage } from './tokens.js';
import { UsageTap, readGeminiUsage, readUsage } from './usage.js';

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testing',
  'fake-cliproxy.mjs',
);
const log = pino({ level: 'silent' });
const PROVIDER = '01KPROVIDERAAAAAAAAAAAAAAA';
const OTHER = '01KPROVIDERBBBBBBBBBBBBBBB';
const KEY = 'sk-real-provider-key';

function upstream(overrides: Partial<GatewayUpstream> = {}): GatewayUpstream {
  return {
    providerId: PROVIDER,
    kind: 'openai-compatibility',
    baseUrl: 'https://provider.example/v1',
    apiKey: KEY,
    headers: {},
    models: [
      { id: 'coder', contextWindow: 128_000 },
      { id: 'vendor/slashed', contextWindow: null },
      { id: 'broken', contextWindow: null },
      { id: 'qwen3:8b', contextWindow: null },
    ],
    ...overrides,
  };
}

interface Harness {
  gateway: ModelGateway;
  cliproxy: CliproxySupervisor;
  stateDir: string;
  late: { runId: string; usage: GatewayTurnUsage }[];
  upstreams: GatewayUpstream[];
}

const open: Harness[] = [];

function harness(
  options: { binary?: string | null; enabled?: boolean; env?: NodeJS.ProcessEnv } = {},
): Harness {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'corehub-gw-test-'));
  const late: Harness['late'] = [];
  const upstreams = [upstream()];
  const source: GatewaySource = {
    upstreams: () => upstreams,
    resolveKey: (_workspace, key) =>
      key === 'example/coder' ? { providerId: PROVIDER, model: 'coder' } : null,
    target: (_workspace, providerId, model) => {
      if (model === 'refused') return { refusal: 'refused on purpose' };
      return {
        providerId,
        model,
        modelLabel: `Label ${model}`,
        price: (usage) => ({ costMicroUsd: usage.inputTokens * 2, costSource: 'estimated' }),
      };
    },
    modelKeys: () => ['example/coder'],
    recordLate: (_grant, runId, usage) => late.push({ runId, usage }),
  };
  const cliproxy = new CliproxySupervisor({
    binary: options.binary === undefined ? FAKE : options.binary,
    stateDir,
    log,
    env: { PATH: process.env.PATH ?? '', ...options.env },
    readyTimeoutMs: 10_000,
  });
  const gateway = new ModelGateway({ cliproxy, source, log, enabled: options.enabled ?? true });
  const made = { gateway, cliproxy, stateDir, late, upstreams };
  open.push(made);
  return made;
}

afterEach(async () => {
  for (const made of open.splice(0)) {
    await made.gateway.close();
    rmSync(made.stateDir, { recursive: true, force: true });
  }
});

async function grantOf(h: Harness, alive = () => true) {
  return h.gateway.open({
    workspace: 'w1',
    agentId: 'agent-1',
    agentSlug: 'claude-code',
    sessionId: 'session-1',
    userId: 'user-1',
    alive,
  });
}

const post = (
  url: string,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe('CLIProxyAPI configuration', () => {
  it('listens on loopback, accepts only the hub key, and routes each row by its own prefix', () => {
    const text = cliproxyConfig({
      port: 4321,
      internalKey: 'internal',
      authDir: '/data/gateway/cliproxy-auth',
      upstreams: [
        upstream(),
        upstream({
          providerId: OTHER,
          kind: 'claude',
          baseUrl: 'https://api.anthropic.com',
          apiKey: null,
        }),
        upstream({ providerId: '01KEMPTY', models: [] }),
      ],
    });
    const config = parse(text) as CliproxyYaml;
    expect(config.server).toMatchObject({
      host: '127.0.0.1',
      port: 4321,
      discovery: { enabled: false },
    });
    // The management API is off (an empty key), and so is everything else a person could reach.
    expect(config.management).toMatchObject({
      'secret-key': '',
      'allow-remote': false,
      'disable-control-panel': true,
    });
    expect(config.access['api-keys']).toEqual(['internal']);
    expect(config.routing['force-model-prefix']).toBe(true);
    expect(config.plugins.enabled).toBe(false);
    expect(config.oauth['auth-dir']).toBe('/data/gateway/cliproxy-auth');
    const compat = config['api-keys']['openai-compatibility'];
    expect(compat).toHaveLength(1);
    expect(compat[0]).toMatchObject({
      name: upstreamPrefix(PROVIDER),
      prefix: `h${PROVIDER.toLowerCase()}`,
      'base-url': 'https://provider.example/v1',
      keys: [{ 'api-key': KEY }],
    });
    expect(compat[0].models).toContainEqual({
      name: 'coder',
      alias: 'coder',
      'max-context-length': 128_000,
    });
    // The Gemini wire splits `models/<model>:<method>` on the colon: an id with one is served
    // under an alias without it, and `name` keeps the id the provider knows.
    expect(compat[0].models).toContainEqual({ name: 'qwen3:8b', alias: 'qwen3__8b' });
    // A provider that needs no key still gets a stand-in; a provider with no models is left out.
    expect(config['api-keys'].claude[0].keys).toEqual([{ 'api-key': NO_KEY }]);
    expect(JSON.stringify(config)).not.toContain('01KEMPTY'.toLowerCase());
  });

  it('writes its file readable by the hub only, and removes it when stopped', async () => {
    const h = harness();
    await grantOf(h);
    const files = readdirSync(h.stateDir).filter((name) => name.endsWith('.yaml'));
    expect(files).toHaveLength(1);
    const file = path.join(h.stateDir, files[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(h.stateDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toContain(KEY);
    await h.gateway.close();
    expect(readdirSync(h.stateDir).filter((name) => name.endsWith('.yaml'))).toEqual([]);
  });
});

describe('the gateway', () => {
  it('is unavailable without CLIProxyAPI or when switched off, and says so', async () => {
    expect(harness({ binary: null }).gateway.available()).toBe(false);
    const off = harness({ enabled: false });
    expect(off.gateway.available()).toBe(false);
    await expect(grantOf(off)).rejects.toThrow(/off/);
  });

  it('refuses a call without a live session token, in the wire the agent speaks', async () => {
    let alive = true;
    const h = harness();
    const grant = await grantOf(h, () => alive);
    const url = `${grant.anthropicBaseUrl}/v1/messages`;
    const none = await post(url, null, { model: 'corehub-main' });
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    });
    const forged = await post(`${grant.openaiBaseUrl}/responses`, 'chgw_forged', {
      model: 'corehub-main',
    });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ error: { type: 'authentication_error' } });
    // The process is gone: its token is too.
    alive = false;
    expect((await post(url, grant.token, { model: 'corehub-main' })).status).toBe(401);
    // Claude Code's warm-up probe needs nothing.
    expect((await fetch(`${grant.anthropicBaseUrl}/api/hello`, { method: 'HEAD' })).status).toBe(
      200,
    );
  });

  it('refuses a revoked token', async () => {
    const h = harness();
    const grant = await grantOf(h);
    grant.revoke();
    expect(
      (await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, { model: 'x' })).status,
    ).toBe(401);
  });

  it('turns the alias into the turn’s model, sends the hub key instead of the token, and streams the answer back', async () => {
    const h = harness();
    const grant = await grantOf(h);
    const reports: GatewayTurnUsage[] = [];
    grant.setTurn({
      runId: 'run-1',
      providerId: PROVIDER,
      model: 'coder',
      report: (u) => reports.push(u),
    });
    const answer = await post(
      `${grant.anthropicBaseUrl}/v1/messages?beta=true`,
      null,
      { model: 'corehub-main', stream: true, max_tokens: 10, messages: [] },
      { 'x-api-key': grant.token, 'anthropic-beta': 'interleaved-thinking' },
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('text/event-stream');
    expect(answer.headers.get('x-fake-model')).toBe(`${upstreamPrefix(PROVIDER)}/coder`);
    expect(answer.headers.get('x-fake-authorization')).not.toContain(grant.token);
    expect(answer.headers.get('x-fake-authorization')).toMatch(/^Bearer /);
    expect(answer.headers.get('x-fake-x-api-key')).toBe('');
    expect(answer.headers.get('x-fake-path')).toBe('/v1/messages?beta=true');
    expect(answer.headers.get('x-fake-beta')).toBe('interleaved-thinking');
    const text = await answer.text();
    expect(text).toContain('event: message_stop');
    expect(text).toContain('"text":"hello"');
    // A second call of the same turn adds to the first.
    await (
      await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
        model: 'corehub-small',
        stream: true,
      })
    ).text();
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      modelLabel: 'Label coder',
      providerId: PROVIDER,
      inputTokens: 11,
      outputTokens: 4,
      cacheReadTokens: 5,
      costMicroUsd: 22,
      costSource: 'estimated',
    });
    expect(reports[1]).toMatchObject({
      inputTokens: 22,
      outputTokens: 8,
      cacheReadTokens: 10,
      costMicroUsd: 44,
    });
  });

  it('reads the usage of the Responses and Chat Completions wires', async () => {
    const h = harness();
    const grant = await grantOf(h);
    const reports: GatewayTurnUsage[] = [];
    grant.setTurn({
      runId: 'run-2',
      providerId: PROVIDER,
      model: 'vendor/slashed',
      report: (u) => reports.push(u),
    });
    const responses = await post(`${grant.openaiBaseUrl}/responses`, grant.token, {
      model: 'corehub-main',
      stream: true,
    });
    expect(responses.headers.get('x-fake-model')).toBe(
      `${upstreamPrefix(PROVIDER)}/vendor/slashed`,
    );
    await responses.text();
    expect(reports.at(-1)).toMatchObject({
      inputTokens: 20,
      outputTokens: 6,
      cacheReadTokens: 2,
      reasoningTokens: 1,
    });
    await (
      await post(`${grant.openaiBaseUrl}/chat/completions`, grant.token, {
        model: 'gpt-anything',
        stream: true,
      })
    ).text();
    expect(reports.at(-1)).toMatchObject({ inputTokens: 50, outputTokens: 14 });
  });

  it('accepts a catalogue key for a model of its own, and refuses what it cannot serve', async () => {
    const h = harness();
    const grant = await grantOf(h);
    // No turn yet, and no model named: nothing to run on.
    const nothing = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
      model: 'corehub-main',
    });
    expect(nothing.status).toBe(400);
    expect((await nothing.json()).error.message).toMatch(/no model is chosen/);
    const keyed = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
      model: 'example/coder',
    });
    expect(keyed.status).toBe(200);
    expect(keyed.headers.get('x-fake-model')).toBe(`${upstreamPrefix(PROVIDER)}/coder`);
    grant.setTurn({ runId: 'run-3', providerId: PROVIDER, model: 'refused', report: () => {} });
    const refused = await post(`${grant.openaiBaseUrl}/chat/completions`, grant.token, {
      model: 'corehub-main',
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { message: 'refused on purpose' } });
    grant.setTurn({ runId: 'run-3', providerId: OTHER, model: 'coder', report: () => {} });
    const missing = await post(`${grant.openaiBaseUrl}/chat/completions`, grant.token, {
      model: 'corehub-main',
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.message).toMatch(/not available to coding agents/);
  });

  it('passes a provider error through as it came, and counts nothing for it', async () => {
    const h = harness();
    const grant = await grantOf(h);
    const reports: GatewayTurnUsage[] = [];
    grant.setTurn({
      runId: 'run-4',
      providerId: PROVIDER,
      model: 'broken',
      report: (u) => reports.push(u),
    });
    const answer = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
      model: 'corehub-main',
    });
    expect(answer.status).toBe(429);
    expect(answer.headers.get('retry-after')).toBe('7');
    expect(await answer.json()).toMatchObject({
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
    expect(reports).toEqual([]);
  });

  it('adds a call that ends after its turn straight to that run', async () => {
    const h = harness();
    const grant = await grantOf(h);
    grant.setTurn({ runId: 'run-5', providerId: PROVIDER, model: 'coder', report: () => {} });
    grant.setTurn(null);
    // Between turns the agent still runs on the last turn's model (a background title).
    await (
      await post(`${grant.openaiBaseUrl}/responses`, grant.token, {
        model: 'corehub-small',
        stream: true,
      })
    ).text();
    expect(h.late).toEqual([
      {
        runId: 'run-5',
        usage: expect.objectContaining({
          inputTokens: 20,
          outputTokens: 6,
          modelLabel: 'Label coder',
        }),
      },
    ]);
  });

  it('lists the aliases and the profile’s models in each wire', async () => {
    const h = harness();
    const grant = await grantOf(h);
    const anthropic = await fetch(`${grant.anthropicBaseUrl}/v1/models`, {
      headers: { 'x-api-key': grant.token },
    });
    expect((await anthropic.json()).data.map((m: { id: string }) => m.id)).toEqual([
      'corehub-main',
      'corehub-small',
      'example/coder',
    ]);
    const openai = await fetch(`${grant.openaiBaseUrl}/models`, {
      headers: { authorization: `Bearer ${grant.token}` },
    });
    expect(await openai.json()).toMatchObject({
      object: 'list',
      data: [{ id: 'corehub-main' }, { id: 'corehub-small' }, { id: 'example/coder' }],
    });
  });

  it('serves the Gemini wire: the model in the path, the key as Gemini sends it, its usage', async () => {
    const h = harness();
    const grant = await grantOf(h);
    const reports: GatewayTurnUsage[] = [];
    grant.setTurn({
      runId: 'run-g',
      providerId: PROVIDER,
      model: 'coder',
      report: (u) => reports.push(u),
    });
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    // `@google/genai` under `GOOGLE_GEMINI_BASE_URL`: `x-goog-api-key`, `?alt=sse`.
    const streamed = await post(
      `${grant.googleBaseUrl}/v1beta/models/corehub-main:streamGenerateContent?alt=sse`,
      null,
      body,
      { 'x-goog-api-key': grant.token },
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('x-fake-path')).toBe(
      `/v1beta/models/${upstreamPrefix(PROVIDER)}/coder:streamGenerateContent?alt=sse`,
    );
    expect(streamed.headers.get('x-fake-authorization')).not.toContain(grant.token);
    expect(await streamed.text()).toContain('"text":"lo"');
    expect(reports.at(-1)).toMatchObject({
      modelLabel: 'Label coder',
      inputTokens: 40,
      outputTokens: 8,
      reasoningTokens: 3,
      cacheReadTokens: 10,
    });
    // Its router and utility calls name Gemini models of their own: the turn's model all the
    // same. The other way to send the key, `?key=`, is taken out before anything goes on.
    const whole = await post(
      `${grant.googleBaseUrl}/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${grant.token}`,
      null,
      body,
    );
    expect(whole.status).toBe(200);
    expect(whole.headers.get('x-fake-path')).toBe(
      `/v1beta/models/${upstreamPrefix(PROVIDER)}/coder:generateContent`,
    );
    expect(reports.at(-1)).toMatchObject({ inputTokens: 49, outputTokens: 10 });
    const counted = await post(
      `${grant.googleBaseUrl}/v1beta/models/corehub-main:countTokens`,
      grant.token,
      body,
    );
    expect(await counted.json()).toEqual({ totalTokens: 4 });
    // A model id with a colon (Ollama's) reaches CLIProxyAPI under its colon-free alias, which
    // CLIProxyAPI maps back to the real id upstream.
    grant.setTurn({ runId: 'run-g', providerId: PROVIDER, model: 'qwen3:8b', report: () => {} });
    const colon = await post(
      `${grant.googleBaseUrl}/v1beta/models/corehub-main:generateContent`,
      grant.token,
      body,
    );
    expect(colon.status).toBe(200);
    expect(colon.headers.get('x-fake-path')).toBe(
      `/v1beta/models/${upstreamPrefix(PROVIDER)}/qwen3__8b:generateContent`,
    );
  });

  it('answers the Gemini wire in its own words: refusals, the model list, an unknown path', async () => {
    const h = harness();
    const grant = await grantOf(h);
    const none = await post(
      `${grant.googleBaseUrl}/v1beta/models/corehub-main:generateContent`,
      null,
      {},
    );
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: { code: 401, status: 'UNAUTHENTICATED' } });
    const unchosen = await post(
      `${grant.googleBaseUrl}/v1beta/models/corehub-main:generateContent`,
      grant.token,
      {},
    );
    expect(unchosen.status).toBe(400);
    expect(await unchosen.json()).toMatchObject({
      error: { status: 'INVALID_ARGUMENT', message: expect.stringMatching(/no model is chosen/) },
    });
    const list = await fetch(`${grant.googleBaseUrl}/v1beta/models`, {
      headers: { 'x-goog-api-key': grant.token },
    });
    expect((await list.json()).models.map((m: { name: string }) => m.name)).toEqual([
      'models/corehub-main',
      'models/corehub-small',
      'models/example/coder',
    ]);
    const one = await fetch(`${grant.googleBaseUrl}/v1beta/models/corehub-main`, {
      headers: { 'x-goog-api-key': grant.token },
    });
    expect(await one.json()).toMatchObject({ name: 'models/corehub-main' });
    const unknown = await post(
      `${grant.googleBaseUrl}/v1beta/models/x:embedContent`,
      grant.token,
      {},
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { status: 'NOT_FOUND' } });
  });

  it('starts a new CLIProxyAPI when the providers change, and stops the old one', async () => {
    const h = harness();
    const grant = await grantOf(h);
    const first = h.cliproxy.status().port;
    grant.setTurn({ runId: 'run-6', providerId: PROVIDER, model: 'coder', report: () => {} });
    h.upstreams.splice(0, 1, upstream({ models: [{ id: 'coder', contextWindow: 64_000 }] }));
    // Read again after the gateway's short cache: open() always reads fresh.
    await grantOf(h);
    const second = h.cliproxy.status().port;
    expect(second).not.toBe(first);
    expect(
      (await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, { model: 'corehub-main' }))
        .status,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(fetch(`http://127.0.0.1:${first}/v1/models`)).rejects.toThrow();
  });

  it('starts CLIProxyAPI again when it dies', async () => {
    const h = harness({ env: { FAKE_CLIPROXY_EXIT_AFTER_MS: '400' } });
    const grant = await grantOf(h);
    grant.setTurn({ runId: 'run-7', providerId: PROVIDER, model: 'coder', report: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(h.cliproxy.status().state).toBe('error');
    const answer = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
      model: 'corehub-main',
    });
    expect(answer.status).toBe(200);
    expect(h.cliproxy.status().state).toBe('running');
  });
});

describe('usage and addresses', () => {
  it('reads each wire’s usage, streamed or whole', () => {
    expect(
      readUsage({
        prompt_tokens: 3,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 1 },
      }),
    ).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 1 });
    expect(readUsage({ input_tokens: 9, cache_creation_input_tokens: 4 })).toEqual({
      inputTokens: 9,
      cacheWriteTokens: 4,
    });
    expect(readUsage(null)).toBeNull();
    const whole = new UsageTap('application/json');
    whole.push('{"usage":{"input_tokens":7,');
    whole.push('"output_tokens":1}}');
    expect(whole.result()).toMatchObject({ inputTokens: 7, outputTokens: 1 });
    const split = new UsageTap('text/event-stream');
    split.push('data: {"type":"response.completed","response":{"usage":{"input_');
    split.push('tokens":5,"output_tokens":2}}}\n\n');
    expect(split.result()).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    expect(new UsageTap('text/event-stream').result()).toBeNull();
    // Gemini: thinking is output too; a stream without `alt=sse` is one JSON array.
    expect(
      readGeminiUsage({
        promptTokenCount: 12,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 6,
        cachedContentTokenCount: 2,
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 10, reasoningTokens: 6, cacheReadTokens: 2 });
    const array = new UsageTap('application/json');
    array.push('[{"usageMetadata":{"promptTokenCount":1}},');
    array.push('{"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}]');
    expect(array.result()).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    const sse = new UsageTap('text/event-stream');
    sse.push(
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":1}}\n\n',
    );
    expect(sse.result()).toMatchObject({ inputTokens: 8, outputTokens: 1 });
  });

  it('reads the usage of a chunk that also carries Arabic text, cut at every byte', () => {
    // Some providers put the last words and the usage in one chunk; a chunk boundary inside a
    // letter must not cost the usage (each piece is decoded across chunks).
    const event = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'أساعد؟' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    })}\n\n`;
    const bytes = Buffer.from(event, 'utf8');
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const tap = new UsageTap('text/event-stream');
      tap.push(bytes.subarray(0, cut));
      tap.push(bytes.subarray(cut));
      expect(tap.result(), `cut at ${cut}`).toMatchObject({ inputTokens: 11, outputTokens: 4 });
    }
  });

  it('knows a loopback address from any other', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopback(address)).toBe(true);
    }
    for (const address of ['10.0.0.2', '172.17.0.1', '::ffff:192.168.1.4', 'fe80::1', undefined]) {
      expect(isLoopback(address)).toBe(false);
    }
  });
});
