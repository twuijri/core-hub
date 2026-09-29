/**
 * The model gateway (ADR 0029) with **the real pieces**: CLIProxyAPI 8.0.4 (the pinned release,
 * SHA-256 checked when it was fetched), the hub's own gateway in front of it, and the real ACP
 * bridges of Claude Code and Codex from npm, started by the hub's ACP adapter with the environment
 * their catalog entries' `gateway` wiring gives them. The provider is a local fake that speaks only
 * OpenAI **Chat Completions** — so Claude Code's Anthropic Messages and Codex's Responses both
 * reach it through CLIProxyAPI's translation, which is the point.
 *
 * What it proves:
 * - Claude Code answers through the gateway, and a tool call round-trips: the fake provider asks
 *   for `Write`, Claude Code writes the file, and the next request carries the tool's result;
 * - Codex answers through the Responses path;
 * - the gateway refuses a request without a session token, or with a revoked one;
 * - the provider's key reaches the provider and nothing else: not the agent's environment, not
 *   the hub's log; the session token never reaches the provider;
 * - each call's usage reaches the turn.
 *
 * It needs the network for npm (about 750 MB, kept in `COREHUB_REAL_ACP_DATA` between runs) and a
 * CLIProxyAPI (`pnpm cliproxy:fetch`, or `COREHUB_CLIPROXY_BIN`), so it is skipped unless asked:
 *
 *   node scripts/cliproxy/fetch.mjs
 *   COREHUB_REAL_GATEWAY=1 COREHUB_REAL_ACP_DATA=~/.cache/corehub-agent/acp-data \
 *     pnpm --filter @corehub/server exec vitest run src/modules/agents/model-gateway.real.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CliproxySupervisor,
  GATEWAY_MAIN_MODEL,
  GATEWAY_SMALL_MODEL,
  ModelGateway,
  devCliproxyPath,
  type GatewaySource,
} from '../models/index.js';
import { agentEnvironment, createAcpAdapter } from './adapters/acp.js';
import { hostEnvNames } from './adapters/child-env.js';
import type { AgentEvent, AgentSession, AgentTarget } from './adapters/types.js';
import { catalogEntry, type CatalogEntry } from './catalog/index.js';
import { agentBinDir, createNpmInstaller, installedVersion } from './installer.js';
import type { AgentGatewayUsage } from './ports.js';

const enabled = process.env.COREHUB_REAL_GATEWAY === '1';
const binary = process.env.COREHUB_CLIPROXY_BIN
  ? path.resolve(process.env.COREHUB_CLIPROXY_BIN)
  : devCliproxyPath();
const dataDir = process.env.COREHUB_REAL_ACP_DATA
  ? path.resolve(process.env.COREHUB_REAL_ACP_DATA)
  : mkdtempSync(path.join(tmpdir(), 'corehub-gateway-real-'));

const PROVIDER_ID = '01KGATEWAYFAKEPROVIDER0001';
const PROVIDER_KEY = 'sk-provider-secret-must-stay-in-the-hub';
const HOST_KEY = 'sk-host-anthropic-key-must-not-reach-the-agent';
const MODEL = 'fake-coder';
const PROOF_FILE = 'gateway-proof.txt';
const PROOF_TEXT = 'written through the Core Hub model gateway';
/** The folder the agent under test works in. */
let workingDir = '';

interface Seen {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** An OpenAI Chat Completions provider, and nothing else, scripted for the two agents. */
async function fakeChatProvider(): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"not here"}}');
        return;
      }
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ authorization: request.headers.authorization, body });
      const messages = (body.messages ?? []) as { role: string; content: unknown }[];
      const text = JSON.stringify(messages);
      const tools = ((body.tools ?? []) as { function?: { name?: string } }[]).map(
        (tool) => tool.function?.name,
      );
      const toolResult = messages.some((message) => message.role === 'tool');
      let reply:
        | { kind: 'text'; text: string }
        | { kind: 'tool'; name: string; args: Record<string, unknown> };
      if (toolResult) reply = { kind: 'text', text: 'The proof file is written.' };
      else if (text.includes(PROOF_FILE) && tools.includes('Write')) {
        // The conversation's folder (a model would read it from Claude Code's system prompt).
        const cwd = workingDir;
        reply = {
          kind: 'tool',
          name: 'Write',
          args: { file_path: path.join(cwd, PROOF_FILE), content: PROOF_TEXT },
        };
      } else reply = { kind: 'text', text: 'pong from the fake provider' };
      const usage = { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 };
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'chat_1',
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                message:
                  reply.kind === 'text'
                    ? { role: 'assistant', content: reply.text }
                    : {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                          {
                            id: 'call_1',
                            type: 'function',
                            function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                          },
                        ],
                      },
                finish_reason: reply.kind === 'text' ? 'stop' : 'tool_calls',
              },
            ],
            usage,
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null, extra = {}) =>
        response.write(
          `data: ${JSON.stringify({
            id: 'chat_1',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...extra,
          })}\n\n`,
        );
      if (reply.kind === 'text') {
        chunk({ role: 'assistant', content: '' }, null);
        for (const word of reply.text.split(/(?<= )/)) chunk({ content: word }, null);
        chunk({}, 'stop');
      } else {
        const args = JSON.stringify(reply.args);
        chunk(
          {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: reply.name, arguments: '' } },
            ],
          },
          null,
        );
        // Arguments in pieces, as providers stream them.
        for (let at = 0; at < args.length; at += 16) {
          chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(at, at + 16) } }] }, null);
        }
        chunk({}, 'tool_calls');
      }
      response.write(
        `data: ${JSON.stringify({ id: 'chat_1', object: 'chat.completion.chunk', model: body.model, choices: [], usage })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, seen };
}

const entryOf = (id: string): CatalogEntry => {
  const entry = catalogEntry(id);
  if (!entry?.gateway) throw new Error(`no gateway wiring for ${id}`);
  return entry;
};

describe.skipIf(!enabled)('the model gateway, for real (COREHUB_REAL_GATEWAY=1)', () => {
  let provider: Awaited<ReturnType<typeof fakeChatProvider>>;
  let gateway: ModelGateway;
  let logged = '';
  const late: AgentGatewayUsage[] = [];

  beforeAll(async () => {
    if (!existsSync(binary)) {
      throw new Error(`no CLIProxyAPI at ${binary}: run node scripts/cliproxy/fetch.mjs`);
    }
    provider = await fakeChatProvider();
    const log = pino(
      { level: 'debug' },
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          logged += chunk.toString('utf8');
          done();
        },
      }),
    );
    const source: GatewaySource = {
      upstreams: () => [
        {
          providerId: PROVIDER_ID,
          kind: 'openai-compatibility',
          baseUrl: `${provider.url}/v1`,
          apiKey: PROVIDER_KEY,
          headers: {},
          models: [{ id: MODEL, contextWindow: 200_000 }],
        },
      ],
      resolveKey: () => null,
      target: (_workspace, providerId, model) =>
        providerId === PROVIDER_ID && model === MODEL
          ? {
              providerId,
              model,
              modelLabel: 'Fake Coder',
              price: (usage) => ({
                costMicroUsd: usage.inputTokens + usage.outputTokens,
                costSource: 'estimated',
              }),
            }
          : { refusal: `unknown model ${model}` },
      modelKeys: () => [`fake/${MODEL}`],
      recordLate: (_grant, _runId, usage) => late.push(usage),
    };
    gateway = new ModelGateway({
      cliproxy: new CliproxySupervisor({
        binary,
        stateDir: mkdtempSync(path.join(tmpdir(), 'corehub-gateway-state-')),
        log: log as never,
        env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
      }),
      source,
      log: log as never,
      enabled: true,
    });
  }, 60_000);

  afterAll(async () => {
    await gateway?.close();
    provider?.server.close();
    if (!process.env.COREHUB_REAL_ACP_DATA) rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses a call with no session token, and with a revoked one', async () => {
    const grant = await gateway.open({
      workspace: 'w',
      agentId: 'a',
      agentSlug: 'claude-code',
      sessionId: 's0',
      userId: null,
      alive: () => true,
    });
    const call = (headers: Record<string, string>) =>
      fetch(`${grant.anthropicBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: GATEWAY_MAIN_MODEL, max_tokens: 8, messages: [] }),
      });
    expect((await call({})).status).toBe(401);
    expect((await call({ 'x-api-key': 'chgw_not-a-token-the-hub-made' })).status).toBe(401);
    grant.revoke();
    const revoked = await call({ authorization: `Bearer ${grant.token}` });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
  });

  async function runAgent(
    id: 'claude-code' | 'codex',
    prompt: string,
  ): Promise<{ said: string; events: AgentEvent[]; reports: AgentGatewayUsage[]; env: NodeJS.ProcessEnv; home: string; token: string }> {
    const entry = entryOf(id);
    const installer = createNpmInstaller({
      dataDir,
      host: { pathValue: process.env.PATH, inherited: process.env },
    });
    const pinned = entry.install.kind === 'npm' ? entry.install.version : '';
    if (installedVersion(dataDir, entry, { current: true }) !== pinned) {
      await installer.install(entry, async () => {});
    }
    const home = mkdtempSync(path.join(tmpdir(), `corehub-gateway-home-${id}-`));
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    workingDir = home;
    const grant = await gateway.open({
      workspace: 'w',
      agentId: id,
      agentSlug: id,
      sessionId: `s-${id}`,
      userId: null,
      alive: () => true,
    });
    const reports: AgentGatewayUsage[] = [];
    grant.setTurn({
      runId: `run-${id}`,
      providerId: PROVIDER_ID,
      model: MODEL,
      report: (usage) => reports.push(usage),
    });
    const wired = entry.gateway!.env({
      anthropicBaseUrl: grant.anthropicBaseUrl,
      openaiBaseUrl: grant.openaiBaseUrl,
      origin: grant.origin,
      token: grant.token,
      mainModel: GATEWAY_MAIN_MODEL,
      smallModel: GATEWAY_SMALL_MODEL,
      contextWindow: 200_000,
    });
    // The host has keys of its own; on the gateway none of them may reach the agent.
    const inherited: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex'),
      ANTHROPIC_API_KEY: HOST_KEY,
      OPENAI_API_KEY: HOST_KEY,
    };
    const target: AgentTarget = {
      slug: id,
      name: entry.name,
      command: [entry.binary],
      executablePath: path.join(agentBinDir(dataDir, id), entry.binary),
      endpoint: null,
      cwd: home,
      env: { ...wired, NO_PROXY: '127.0.0.1,localhost,::1' },
      envRemove: [...entry.gateway!.clears, ...Object.values(entry.credentials)].filter(
        (name) => !(name in wired),
      ),
    };
    const env = agentEnvironment(inherited, target, hostEnvNames(entry));
    const adapter = createAcpAdapter({
      host: {
        pathValue: `${agentBinDir(dataDir, id)}${path.delimiter}${process.env.PATH ?? ''}`,
        inherited,
      },
    });
    const session: AgentSession = await adapter.start(target);
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === 'approval.requested') {
          const allow =
            event.options.find((option) => option.kind === 'allow_once') ??
            event.options.find((option) => option.kind.startsWith('allow')) ??
            event.options[0];
          if (allow) await session.respond(event.id, allow.id);
        }
      }
    })();
    try {
      const done = await session.send({ text: prompt });
      expect(done.stopReason).toBe('end_turn');
    } finally {
      await session.close();
      await reading;
      grant.revoke();
    }
    const said = events
      .filter((event): event is Extract<AgentEvent, { type: 'message.delta' }> => event.type === 'message.delta')
      .map((event) => event.text)
      .join('');
    return { said, events, reports, env, home, token: grant.token };
  }

  it(
    'Claude Code answers through an OpenAI-compatible provider and round-trips a tool call',
    async () => {
      const before = provider.seen.length;
      const result = await runAgent(
        'claude-code',
        `Create the file ${PROOF_FILE} in the working directory with the Write tool.`,
      );
      if (process.env.COREHUB_REAL_GATEWAY_DEBUG) {
        console.log(JSON.stringify({ said: result.said, events: result.events, seen: provider.seen.slice(before).map((c) => ({ ...c, body: JSON.stringify(c.body).slice(0, 1500) })) }, null, 1).slice(0, 20000));
        console.log(logged.slice(-6000));
      }
      // The tool ran: the file is there, with what the provider asked for.
      const proof = path.join(result.home, PROOF_FILE);
      expect(existsSync(proof)).toBe(true);
      expect(readFileSync(proof, 'utf8')).toBe(PROOF_TEXT);
      expect(result.events.some((event) => event.type === 'tool.started')).toBe(true);
      expect(result.said).toContain('The proof file is written.');
      // The provider saw Anthropic Messages translated to Chat, the tool's result included.
      const calls = provider.seen.slice(before);
      expect(calls.some((call) => ((call.body.messages ?? []) as { role: string }[]).some((m) => m.role === 'tool'))).toBe(true);
      for (const call of calls) {
        expect(call.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
        expect(call.body.model).toBe(MODEL);
      }
      expect(result.reports.length).toBeGreaterThan(0);
      expect(result.reports.at(-1)).toMatchObject({ modelLabel: 'Fake Coder', providerId: PROVIDER_ID });
      expect(result.reports.at(-1)!.inputTokens).toBeGreaterThanOrEqual(1200);
      expect(result.reports.at(-1)!.costSource).toBe('estimated');
      checkIsolation(result);
      rmSync(result.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    15 * 60_000,
  );

  it(
    'Codex answers through the Responses path',
    async () => {
      const before = provider.seen.length;
      const result = await runAgent('codex', 'Say pong.');
      expect(result.said).toContain('pong from the fake provider');
      const calls = provider.seen.slice(before);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
        expect(call.body.model).toBe(MODEL);
      }
      expect(result.reports.length).toBeGreaterThan(0);
      checkIsolation(result);
      try {
        rmSync(result.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Codex may still be writing its session files as it exits.
      }
    },
    15 * 60_000,
  );

  function checkIsolation(result: { env: NodeJS.ProcessEnv; token: string }): void {
    // The agent had the token and the gateway's address, and no key of anyone's.
    const values = Object.values(result.env).join('\n');
    expect(values).not.toContain(PROVIDER_KEY);
    expect(values).not.toContain(HOST_KEY);
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(values).toContain(result.token);
    // The provider never saw the session token; the hub's log never saw either.
    for (const call of provider.seen) expect(call.authorization ?? '').not.toContain(result.token);
    expect(logged).not.toContain(PROVIDER_KEY);
    expect(logged).not.toContain(result.token);
  }
});
