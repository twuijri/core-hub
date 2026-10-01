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
import {
  ModelGateway,
  isLoopback,
  classifyLimit,
  estimateTokens,
  withoutThinking,
  lowerThinking,
  trimTools,
  scrubInternalNames,
  type GatewaySource,
} from './gateway.js';
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
      { id: 'flash-spent', contextWindow: null },
      { id: 'flash-per-minute', contextWindow: null },
      { id: 'flash-per-day', contextWindow: null },
      { id: 'flash-busy', contextWindow: null },
      { id: 'gemini-thinks', contextWindow: null },
      { id: 'claude-thinks', contextWindow: null },
      { id: 'gemini-high-effort', contextWindow: null },
      { id: 'gemini-big-tools', contextWindow: null },
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
  const gateway = new ModelGateway({
    cliproxy,
    source,
    log,
    enabled: options.enabled ?? true,
    limitWait: { defaultMs: 20, maxMs: 1_000 },
  });
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
      managementKey: 'management-secret',
      authDir: '/data/gateway/cliproxy-auth',
      upstreams: [
        upstream(),
        upstream({
          providerId: '01KSUBSCRIPTION',
          kind: 'subscription',
          baseUrl: '',
          apiKey: null,
        }),
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
    // The management API answers the hub's own secret from loopback only (DECISIONS §143); its
    // panel is off, and so is everything else a person could reach.
    expect(config.management).toMatchObject({
      'secret-key': 'management-secret',
      'allow-remote': false,
      'disable-control-panel': true,
    });
    // A subscription row is no key group: its accounts are in the store.
    expect(JSON.stringify(config['api-keys'])).not.toContain('01KSUBSCRIPTION');
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

  it('serves the turn’s model whatever id the agent names, and refuses what it cannot serve', async () => {
    const h = harness();
    const grant = await grantOf(h);
    // No turn yet: nothing to run on, even for an id the catalogue knows.
    for (const model of ['corehub-main', 'example/coder']) {
      const nothing = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, { model });
      expect(nothing.status).toBe(400);
      expect((await nothing.json()).error.message).toMatch(/no model is chosen/);
    }
    // The person chose `vendor/slashed`; an agent that names another model of the catalogue (a
    // Claude "opus" its bridge picked from `/v1/models`), or a vendor id, still gets that one
    // (owner, 2026-09-30).
    grant.setTurn({
      runId: 'run-2',
      providerId: PROVIDER,
      model: 'vendor/slashed',
      report: () => {},
    });
    for (const model of ['example/coder', 'claude-opus-4-6-thinking', 'corehub-small']) {
      const keyed = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, { model });
      expect(keyed.status).toBe(200);
      expect(keyed.headers.get('x-fake-model')).toBe(`${upstreamPrefix(PROVIDER)}/vendor/slashed`);
    }
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
    expect((await missing.json()).error.message).toMatch(/not available to agents/);
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

  describe('a provider whose quota is spent (owner, 2026-09-30)', () => {
    const calls = async (h: Harness): Promise<Record<string, number>> => {
      const lease = await h.cliproxy.lease(h.upstreams);
      try {
        const answer = await fetch(`http://127.0.0.1:${lease.port}/fake/calls`, {
          headers: { authorization: `Bearer ${lease.key}` },
        });
        return (await answer.json()) as Record<string, number>;
      } finally {
        lease.done();
      }
    };
    const spentModel = `${upstreamPrefix(PROVIDER)}/flash-spent`;

    it('answers at once in words no agent retries, names the provider and model people know, and tells the turn', async () => {
      const h = harness();
      h.upstreams[0] = upstream();
      const grant = await grantOf(h);
      const exhausted: unknown[] = [];
      grant.setTurn({
        runId: 'run-q',
        providerId: PROVIDER,
        model: 'flash-spent',
        report: () => {},
        exhausted: (failure) => exhausted.push(failure),
      });
      // Claude Code's wire.
      const anthropic = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
        model: 'corehub-main',
      });
      expect(anthropic.status).toBe(429);
      expect(anthropic.headers.get('x-should-retry')).toBe('false');
      const said = (await anthropic.json()) as { error: { type: string; message: string } };
      expect(said.error.type).toBe('rate_limit_error');
      // Google's bare RESOURCE_EXHAUSTED, waited out once and refused again: a limit for now,
      // not a spent quota (owner, 2026-10-01: the account had just been signed in).
      expect(said.error.message).toMatch(
        /^The provider is limiting requests to Label flash-spent right now/,
      );
      expect(said.error.message).toContain('Resource has been exhausted');
      // The provider's words, never a vendor's raw JSON inside them.
      expect(said.error.message).not.toContain('{"error"');
      // Never the hub's internal name for the provider row.
      expect(said.error.message).not.toMatch(/h01k/i);
      expect(exhausted).toEqual([
        expect.objectContaining({ providerId: PROVIDER, model: 'flash-spent' }),
      ]);
      // The agent's retries are answered by the gateway, not sent to the provider again.
      const openai = await post(`${grant.openaiBaseUrl}/chat/completions`, grant.token, {
        model: 'corehub-main',
      });
      expect(openai.status).toBe(429);
      expect(openai.headers.get('x-should-retry')).toBe('false');
      expect(await openai.json()).toMatchObject({
        error: { type: 'insufficient_quota', code: 'insufficient_quota' },
      });
      const gemini = await fetch(
        `${grant.googleBaseUrl}/v1beta/models/corehub-main:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': grant.token },
          body: '{}',
        },
      );
      expect(gemini.status).toBe(429);
      expect(await gemini.json()).toMatchObject({
        error: {
          status: 'RESOURCE_EXHAUSTED',
          details: [expect.objectContaining({ reason: 'MODEL_CAPACITY_EXHAUSTED' })],
        },
      });
      // Refused, asked on the Chat route what the refusal really is (CLIProxyAPI keeps only the
      // message on Claude Code's wire), asked once more after a wait, then never again.
      expect((await calls(h))[spentModel]).toBe(3);
      // A new turn asks the provider again: the quota may be back.
      grant.setTurn({
        runId: 'run-q2',
        providerId: PROVIDER,
        model: 'flash-spent',
        report: () => {},
      });
      await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, { model: 'corehub-main' });
      expect((await calls(h))[spentModel]).toBe(6);
    });

    it('moves the turn down the profile’s fallback chain, and keeps it there', async () => {
      const h = harness();
      const grant = await grantOf(h);
      const moves: unknown[] = [];
      const exhausted: unknown[] = [];
      grant.setTurn({
        runId: 'run-f',
        providerId: PROVIDER,
        model: 'flash-spent',
        report: () => {},
        fallbacks: [
          { providerId: PROVIDER, model: 'flash-spent' },
          { providerId: PROVIDER, model: 'coder' },
        ],
        exhausted: (failure) => exhausted.push(failure),
        fellBack: (move) => moves.push(move),
      });
      const answer = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
        model: 'corehub-main',
      });
      expect(answer.status).toBe(200);
      expect(answer.headers.get('x-fake-model')).toBe(`${upstreamPrefix(PROVIDER)}/coder`);
      expect(moves).toEqual([
        expect.objectContaining({
          failed: expect.objectContaining({ model: 'flash-spent' }),
          answered: expect.objectContaining({ model: 'coder', modelLabel: 'Label coder' }),
        }),
      ]);
      expect(exhausted).toEqual([]);
      // The rest of the turn stays on the model that answered.
      const next = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
        model: 'corehub-main',
      });
      expect(next.headers.get('x-fake-model')).toBe(`${upstreamPrefix(PROVIDER)}/coder`);
      expect((await calls(h))[spentModel]).toBe(3);
    });

    it('waits out a per-minute limit once and answers; a per-day quota is spent at once', async () => {
      const h = harness();
      const grant = await grantOf(h);
      const waits: unknown[] = [];
      const exhausted: unknown[] = [];
      grant.setTurn({
        runId: 'run-m',
        providerId: PROVIDER,
        model: 'flash-per-minute',
        report: () => {},
        waiting: (wait) => waits.push(wait),
        exhausted: (failure) => exhausted.push(failure),
      });
      const minute = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
        model: 'corehub-main',
      });
      expect(minute.status).toBe(200);
      expect(waits).toEqual([expect.objectContaining({ modelLabel: 'Label flash-per-minute' })]);
      expect(exhausted).toEqual([]);
      expect((await calls(h))[`${upstreamPrefix(PROVIDER)}/flash-per-minute`]).toBe(2);
      grant.setTurn({
        runId: 'run-d',
        providerId: PROVIDER,
        model: 'flash-per-day',
        report: () => {},
        waiting: (wait) => waits.push(wait),
        exhausted: (failure) => exhausted.push(failure),
      });
      const day = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
        model: 'corehub-main',
      });
      expect(day.status).toBe(429);
      expect(day.headers.get('x-should-retry')).toBe('false');
      expect(exhausted).toHaveLength(1);
      expect(waits).toHaveLength(1);
      expect((await calls(h))[`${upstreamPrefix(PROVIDER)}/flash-per-day`]).toBe(1);
    });

    it('reads the provider’s own reason where CLIProxyAPI keeps only the message: no capacity is not a spent quota', async () => {
      const h = harness();
      const grant = await grantOf(h);
      const waits: unknown[] = [];
      const moves: { failed: { reason: string; said: string } }[] = [];
      grant.setTurn({
        runId: 'run-busy',
        providerId: PROVIDER,
        model: 'flash-busy',
        report: () => {},
        fallbacks: [{ providerId: PROVIDER, model: 'coder' }],
        waiting: (wait) => waits.push(wait),
        fellBack: (move) => moves.push(move),
      });
      const answer = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, {
        model: 'corehub-main',
      });
      expect(answer.status).toBe(200);
      expect(answer.headers.get('x-fake-model')).toBe(`${upstreamPrefix(PROVIDER)}/coder`);
      expect(waits).toEqual([expect.objectContaining({ reason: 'no_capacity' })]);
      expect(moves[0]!.failed.reason).toBe('no_capacity');
      // Google's own reason, in the words the chat shows.
      expect(moves[0]!.failed.said).toContain('No capacity available for model');
      expect(moves[0]!.failed.said).toContain('MODEL_CAPACITY_EXHAUSTED');
      expect(moves[0]!.failed.said).not.toMatch(/h01k/i);
    });

    it('asks a Gemini model again without the agent’s thinking settings when it answers a plain request; never a Claude model', async () => {
      const h = harness();
      const grant = await grantOf(h);
      const fellBack: unknown[] = [];
      grant.setTurn({
        runId: 'run-thinks',
        providerId: PROVIDER,
        model: 'gemini-thinks',
        report: () => {},
        fallbacks: [{ providerId: PROVIDER, model: 'coder' }],
        fellBack: (move) => fellBack.push(move),
      });
      const thinking = {
        model: 'corehub-main',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      };
      const first = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, thinking);
      expect(first.status).toBe(200);
      // The turn's own model answered, asked without the thinking settings; no fallback.
      expect(first.headers.get('x-fake-model')).toBe(`${upstreamPrefix(PROVIDER)}/gemini-thinks`);
      expect(first.headers.get('x-fake-thinking')).toBe('no');
      expect(fellBack).toEqual([]);
      // The next call of the session goes the same way at once.
      const next = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, thinking);
      expect(next.status).toBe(200);
      expect(next.headers.get('x-fake-thinking')).toBe('no');
      // A Claude model is never asked differently, refused or not («ما ابي نخرب كلود علشان جيميناي»):
      // its request reaches the provider as Claude Code sent it, and the chain takes over.
      const claude = await grantOf(h);
      const claudeMoves: unknown[] = [];
      claude.setTurn({
        runId: 'run-claude',
        providerId: PROVIDER,
        model: 'claude-thinks',
        report: () => {},
        fallbacks: [{ providerId: PROVIDER, model: 'coder' }],
        fellBack: (move) => claudeMoves.push(move),
      });
      const asked = await post(`${claude.anthropicBaseUrl}/v1/messages`, claude.token, thinking);
      expect(asked.headers.get('x-fake-model')).toBe(`${upstreamPrefix(PROVIDER)}/coder`);
      expect(asked.headers.get('x-fake-thinking')).toBe('yes');
      expect(asked.headers.get('x-fake-effort')).toBe('high');
      expect(claudeMoves).toHaveLength(1);
      expect(
        withoutThinking({
          model: 'm',
          thinking: {},
          generationConfig: { thinkingConfig: {}, topP: 1 },
        }),
      ).toEqual({ model: 'm', generationConfig: { topP: 1 } });
    });

    it('lowers a Gemini model’s thinking first, and trims its tools only when nothing else answers', async () => {
      const h = harness();
      const ask = async (model: string, body: Record<string, unknown>) => {
        const grant = await grantOf(h);
        grant.setTurn({ runId: `run-${model}`, providerId: PROVIDER, model, report: () => {} });
        const answer = await post(`${grant.anthropicBaseUrl}/v1/messages`, grant.token, body);
        return { answer, grant };
      };
      const thinking = {
        model: 'corehub-main',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      };
      // Refused only at high effort: answered with thinking still on, at low effort.
      const high = await ask('gemini-high-effort', thinking);
      expect(high.answer.status).toBe(200);
      expect(high.answer.headers.get('x-fake-thinking')).toBe('yes');
      expect(high.answer.headers.get('x-fake-effort')).toBe('low');
      // Refused for its tools' size: answered with the same tools, their descriptions trimmed.
      const tools = Array.from({ length: 6 }, (_, i) => ({
        name: `tool_${i}`,
        description: 'A long description of what this tool does. '.repeat(10),
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'where' } },
        },
      }));
      const big = await ask('gemini-big-tools', { ...thinking, tools });
      expect(big.answer.status).toBe(200);
      expect(big.answer.headers.get('x-fake-thinking')).toBe('no');
      expect(trimTools({ tools }).tools).toEqual(
        tools.map((tool) => ({
          name: tool.name,
          description: `${tool.description.slice(0, 159)}…`,
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        })),
      );
      expect(lowerThinking(thinking)).toEqual({ ...thinking, output_config: { effort: 'low' } });
    });

    it('counts tokens itself: Claude Code’s many count_tokens calls never reach the provider', async () => {
      const h = harness();
      const grant = await grantOf(h);
      grant.setTurn({
        runId: 'run-count',
        providerId: PROVIDER,
        model: 'flash-busy',
        report: () => {},
      });
      const body = {
        model: 'corehub-main',
        system: 'You are Claude Code.',
        messages: [{ role: 'user', content: 'هلا '.repeat(100) }],
        tools: [{ name: 'Write', input_schema: { type: 'object' } }],
      };
      for (let i = 0; i < 15; i += 1) {
        const counted = await post(
          `${grant.anthropicBaseUrl}/v1/messages/count_tokens`,
          grant.token,
          body,
        );
        expect(counted.status).toBe(200);
        const { input_tokens } = (await counted.json()) as { input_tokens: number };
        expect(input_tokens).toBe(estimateTokens(body));
        expect(input_tokens).toBeGreaterThan(100);
      }
      expect((await calls(h))[`${upstreamPrefix(PROVIDER)}/flash-busy`]).toBeUndefined();
    });

    it('takes the hub’s internal names out of any other error it passes on', () => {
      const text = `unknown model ${upstreamPrefix(PROVIDER)}/coder, nor ${upstreamPrefix(OTHER)}/x`;
      expect(
        scrubInternalNames(text, {
          providerId: PROVIDER,
          model: 'coder',
          modelLabel: 'Coder',
          providerLabel: 'CLI Proxy',
        }),
      ).toBe('unknown model CLI Proxy / Coder, nor x');
      const wait = { defaultMs: 20_000, maxMs: 30_000 };
      expect(classifyLimit(429, '{"error":{"message":"slow down"}}')).toEqual({ kind: 'pass' });
      expect(classifyLimit(429, '{"error":{"code":"insufficient_quota"}}')).toEqual({
        kind: 'spent',
      });
      expect(classifyLimit(402, 'Payment Required')).toEqual({ kind: 'spent' });
      expect(classifyLimit(403, 'invalid credentials')).toEqual({ kind: 'pass' });
      expect(classifyLimit(500, 'quota')).toEqual({ kind: 'pass' });
      // Google's words are the same for both; its details and the headers tell them apart.
      const exhaustedWords = '{"error":{"status":"RESOURCE_EXHAUSTED","message":"check quota"}}';
      const limited = { kind: 'wait', reason: 'rate_limited' };
      expect(classifyLimit(429, exhaustedWords, {}, wait)).toEqual({ ...limited, ms: 20_000 });
      expect(classifyLimit(429, exhaustedWords, { 'retry-after': '7' }, wait)).toEqual({
        ...limited,
        ms: 7_000,
      });
      expect(
        classifyLimit(429, `${exhaustedWords} "retryDelay": "12.5s" PerMinute`, {}, wait),
      ).toEqual({ ...limited, ms: 12_500 });
      expect(classifyLimit(429, `${exhaustedWords} GenerateRequestsPerDay`, {}, wait)).toEqual({
        kind: 'spent',
      });
      expect(classifyLimit(429, 'Quota exceeded. Please retry in 3.2s.', {}, wait)).toEqual({
        ...limited,
        ms: 3_200,
      });
      // Antigravity (2026-10-01): the server's capacity is not the account's quota.
      const capacity = { kind: 'wait', reason: 'no_capacity' };
      expect(
        classifyLimit(
          429,
          '{"error":{"code":429,"message":"No capacity available for model gemini-3.8-flash-high on the server","status":"RESOURCE_EXHAUSTED","details":[{"reason":"MODEL_CAPACITY_EXHAUSTED"}]}}',
          {},
          wait,
        ),
      ).toEqual({ ...capacity, ms: 5_000 });
      expect(
        classifyLimit(503, 'The model is overloaded. Please try again later.', {}, wait),
      ).toEqual({
        ...capacity,
        ms: 5_000,
      });
      expect(classifyLimit(503, 'upstream connect error', {}, wait)).toEqual({ kind: 'pass' });
      // The account's own quota for the model, with when it comes back: spent for this turn.
      expect(
        classifyLimit(
          429,
          'You have exhausted your capacity on this model. Your quota will reset after 2h10m.',
          {},
          wait,
        ),
      ).toEqual({ kind: 'spent' });
      expect(
        classifyLimit(429, '{"error":{"details":[{"reason":"QUOTA_EXHAUSTED"}]}}', {}, wait),
      ).toEqual({ kind: 'spent' });
    });
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
