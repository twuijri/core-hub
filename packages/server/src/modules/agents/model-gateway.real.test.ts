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
 * - with `COREHUB_REAL_GATEWAY_ALL=1` (phase 2, DECISIONS §141), each of Gemini CLI (the Gemini
 *   wire, translated by CLIProxyAPI to Chat Completions), Goose, OpenCode, Qwen Code, Kimi Code,
 *   Grok Build and Pi round-trips a tool call the same way — the provider asks for the agent's own
 *   file-writing tool (found in the tools the agent sent, its arguments read from the tool's
 *   schema), the agent writes the file, and the next request carries the result — on nothing but
 *   its catalog wiring and the block of its own settings the hub writes (`gateway-config.ts`);
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { applyGatewayConfig } from './gateway-config.js';
import { agentBinDir, createNpmInstaller, installedVersion } from './installer.js';
import type { AdapterSet } from './adapters/index.js';
import type { AgentGatewayUsage, RunnerEvent } from './ports.js';
import { AgentRunner } from './runner.js';
import type { AgentsService } from './service.js';

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
/** Every real provider says when an answer was made; Grok Build refuses a chunk without it. */
const CREATED = 1_790_000_000;
const PROOF_FILE = 'gateway-proof.txt';
/** An Arabic greeting, streamed a token at a time and cut inside its characters' bytes. */
const ARABIC_PROMPT = 'هلا';
const ARABIC_TOKENS = ['ه', 'لا', '!', ' كيف', ' أ', 'قدر', ' أ', 'ساعد', '؟'];
const PROOF_TEXT = 'written through the Core Hub model gateway';
/** A person's own Grok Build settings, a Pi provider and a Gemini CLI Google sign-in. */
const PERSON_GROK = '# my own settings\n[models]\ndefault = "grok-4.5"\n';
const PERSON_PI = JSON.stringify(
  {
    providers: {
      ollama: {
        baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        apiKey: 'ollama',
        models: [{ id: 'mine:1b' }],
      },
    },
  },
  null,
  2,
);
const PERSON_GEMINI = JSON.stringify({
  security: { auth: { selectedType: 'oauth-personal' } },
  ui: { theme: 'Default' },
});
/** While true the provider answers every call as a provider out of quota does (Google's words). */
let exhausted = false;
const EXHAUSTED_BODY = JSON.stringify({
  error: {
    code: 429,
    message: 'Resource has been exhausted (e.g. check quota).',
    status: 'RESOURCE_EXHAUSTED',
  },
});
/** The folder the agent under test works in. */
let workingDir = '';

interface Seen {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface ChatTool {
  function?: { name?: string; parameters?: { properties?: Record<string, JsonSchema> } };
}
interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
}

/** Tool names that write a file, most specific first (each agent's own: Claude Code's `Write`,
 * Gemini CLI's and Qwen Code's `write_file`, OpenCode's and Pi's `write`, Kimi Code's
 * `WriteFile`, Goose's text editor …). */
const WRITE_TOOLS = [
  /^Write$/,
  /^write_file$/i,
  /^write$/i,
  /^WriteFile$/,
  /write/i,
  /text_editor/i,
];

/**
 * The call a model would make to write the proof file with this agent's own tool: the tool is
 * found by name among those the agent sent, its arguments by the names in its schema.
 */
function writeCall(
  tools: ChatTool[],
  file: string,
  text: string,
): { name: string; args: Record<string, unknown> } | null {
  for (const pattern of WRITE_TOOLS) {
    const tool = tools.find((candidate) => pattern.test(candidate.function?.name ?? ''));
    const name = tool?.function?.name;
    if (!tool || !name) continue;
    const args: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(tool.function?.parameters?.properties ?? {})) {
      if (/^(file_?path|filepath|path|file|filename|absolute_?path|target_?file)$/i.test(key)) {
        args[key] = file;
      } else if (/^(content|contents|text|file_?text|data|body)$/i.test(key)) args[key] = text;
      else if (schema.enum?.includes('write')) args[key] = 'write';
      else if (schema.enum?.includes('create')) args[key] = 'create';
      else if (/^(mode|operation)$/i.test(key) && schema.enum?.includes('overwrite')) {
        args[key] = 'overwrite';
      }
    }
    if (Object.values(args).includes(file)) return { name, args };
  }
  return null;
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
      if (exhausted) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(EXHAUSTED_BODY);
        return;
      }
      const messages = (body.messages ?? []) as { role: string; content: unknown }[];
      const text = JSON.stringify(messages);
      const tools = (body.tools ?? []) as ChatTool[];
      const toolResult = messages.some((message) => message.role === 'tool');
      // The conversation's folder (a model would read it from the agent's system prompt).
      const call = text.includes(PROOF_FILE)
        ? writeCall(tools, path.join(workingDir, PROOF_FILE), PROOF_TEXT)
        : null;
      let reply:
        | { kind: 'text'; text: string; tokens?: string[] }
        | { kind: 'tool'; name: string; args: Record<string, unknown> };
      if (text.includes(ARABIC_PROMPT) && !toolResult) {
        reply = { kind: 'text', text: ARABIC_TOKENS.join(''), tokens: ARABIC_TOKENS };
      } else if (toolResult) reply = { kind: 'text', text: 'The proof file is written.' };
      else if (call) reply = { kind: 'tool', ...call };
      else reply = { kind: 'text', text: 'pong from the fake provider' };
      const usage = { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 };
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'chat_1',
            object: 'chat.completion',
            created: CREATED,
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
      if (reply.kind === 'text' && reply.tokens) {
        // Every token its own chunk, and the bytes cut every 5 — inside the letters' two-byte
        // sequences — each piece a write of its own.
        const shape = process.env.PROBE_SHAPE ?? '';
        const events = [
          { role: 'assistant', content: '' },
          ...reply.tokens.flatMap((content) =>
            shape === 'reasoning'
              ? [{ reasoning_content: 'hmm ' }, { content }]
              : shape === 'both'
                ? [{ reasoning_content: 'r', content }]
                : [{ content }],
          ),
        ].map((delta) => ({
          delta: delta as Record<string, unknown>,
          finish: null as string | null,
        }));
        events.push({ delta: {}, finish: 'stop' });
        const text =
          events
            .map(
              ({ delta, finish }) =>
                `data: ${JSON.stringify({ id: 'chat_ar', object: 'chat.completion.chunk', created: CREATED, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            )
            .join('') +
          `data: ${JSON.stringify({ id: 'chat_ar', object: 'chat.completion.chunk', created: CREATED, model: body.model, choices: [], usage })}\n\ndata: [DONE]\n\n`;
        const owner = (delta: Record<string, unknown>, finish: string | null, extra = {}) =>
          `data: ${JSON.stringify({ id: 'resp_1', object: 'chat.completion.chunk', created: CREATED, model: body.model, choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish }], ...extra })}\n\n`;
        const ownerText =
          ['**Greeting**', ' the user', '\n\n']
            .map((r) => owner({ role: 'assistant', reasoning_content: r }, null))
            .join('') +
          reply.tokens.map((c) => owner({ role: 'assistant', content: c }, null)).join('') +
          owner({}, 'stop', { usage }) +
          'data: [DONE]\n\n';
        const bytes = Buffer.from(shape === 'owner' ? ownerText : text, 'utf8');
        void (async () => {
          for (let at = 0; at < bytes.length; at += 5) {
            response.write(bytes.subarray(at, at + 5));
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          response.end();
        })();
        return;
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null, extra = {}) =>
        response.write(
          `data: ${JSON.stringify({
            id: 'chat_1',
            object: 'chat.completion.chunk',
            created: CREATED,
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
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: reply.name, arguments: '' },
              },
            ],
          },
          null,
        );
        // Arguments in pieces, as providers stream them.
        for (let at = 0; at < args.length; at += 16) {
          chunk(
            { tool_calls: [{ index: 0, function: { arguments: args.slice(at, at + 16) } }] },
            null,
          );
        }
        chunk({}, 'tool_calls');
      }
      response.write(
        `data: ${JSON.stringify({
          id: 'chat_1',
          object: 'chat.completion.chunk',
          created: CREATED,
          model: body.model,
          choices: [],
          usage,
        })}\n\n`,
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
  const stateDir = mkdtempSync(path.join(tmpdir(), 'corehub-gateway-state-'));

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
        stateDir,
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
    rmSync(stateDir, { recursive: true, force: true });
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
    expect(await revoked.json()).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    });
  });

  /** An agent installed, its home and its gateway grant, and the target the hub would start. */
  async function prepareAgent(id: string) {
    const entry = entryOf(id);
    const installer = createNpmInstaller({
      dataDir,
      host: { pathValue: process.env.PATH, inherited: process.env },
    });
    const present =
      entry.install.kind === 'npm'
        ? installedVersion(dataDir, entry, { current: true }) === entry.install.version
        : installer.isPresent(entry);
    if (!present) await installer.install(entry, async () => {});
    const home = mkdtempSync(path.join(tmpdir(), `corehub-gateway-home-${id}-`));
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    // A person's own settings that the hub's block must leave alone (Grok Build, Pi, Gemini CLI).
    mkdirSync(path.join(home, '.grok'), { recursive: true });
    writeFileSync(path.join(home, '.grok', 'config.toml'), PERSON_GROK);
    mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), PERSON_PI);
    mkdirSync(path.join(home, '.gemini'), { recursive: true });
    writeFileSync(path.join(home, '.gemini', 'settings.json'), PERSON_GEMINI);
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
    const context = {
      anthropicBaseUrl: grant.anthropicBaseUrl,
      openaiBaseUrl: grant.openaiBaseUrl,
      googleBaseUrl: grant.googleBaseUrl,
      origin: grant.origin,
      token: grant.token,
      mainModel: GATEWAY_MAIN_MODEL,
      smallModel: GATEWAY_SMALL_MODEL,
      contextWindow: 200_000,
    };
    const wired = entry.gateway!.env(context);
    // The host has keys of its own; on the gateway none of them may reach the agent.
    const inherited: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex'),
      ANTHROPIC_API_KEY: HOST_KEY,
      OPENAI_API_KEY: HOST_KEY,
      // The key of each provider the agent reads (Gemini CLI's `GEMINI_API_KEY`, Grok Build's
      // `XAI_API_KEY` …), set by the host all the same.
      ...Object.fromEntries(Object.values(entry.credentials).map((name) => [name, HOST_KEY])),
    };
    // The block of its own settings the hub keeps, exactly as the service writes it.
    let sessionConfig: Record<string, string> | undefined;
    if (entry.gateway!.config) {
      const written = applyGatewayConfig({
        kind: entry.gateway!.config,
        context,
        env: inherited,
        home,
        stateDir: path.join(home, 'hub-gateway-agents'),
      });
      if (!written.ok) throw new Error(written.reason);
      Object.assign(wired, written.env);
      sessionConfig = written.sessionConfig;
    }
    const target: AgentTarget = {
      slug: id,
      name: entry.name,
      command: [entry.binary, ...entry.protocolArgs],
      executablePath: path.join(agentBinDir(dataDir, id), entry.binary),
      endpoint: null,
      cwd: home,
      env: { ...wired, NO_PROXY: '127.0.0.1,localhost,::1' },
      envRemove: [...entry.gateway!.clears, ...Object.values(entry.credentials)].filter(
        (name) => !(name in wired),
      ),
      ...(sessionConfig ? { sessionConfig } : {}),
    };
    const env = agentEnvironment(inherited, target, hostEnvNames(entry));
    const adapter = createAcpAdapter({
      host: {
        pathValue: `${agentBinDir(dataDir, id)}${path.delimiter}${process.env.PATH ?? ''}`,
        inherited,
      },
    });
    return { target, adapter, grant, reports, env, home };
  }

  async function runAgent(
    id: string,
    prompt: string,
  ): Promise<{
    said: string;
    events: AgentEvent[];
    reports: AgentGatewayUsage[];
    env: NodeJS.ProcessEnv;
    home: string;
    token: string;
  }> {
    const { target, adapter, grant, reports, env, home } = await prepareAgent(id);
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
      .filter(
        (event): event is Extract<AgentEvent, { type: 'message.delta' }> =>
          event.type === 'message.delta',
      )
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
      // The tool ran: the file is there, with what the provider asked for.
      const proof = path.join(result.home, PROOF_FILE);
      expect(existsSync(proof)).toBe(true);
      expect(readFileSync(proof, 'utf8')).toBe(PROOF_TEXT);
      expect(result.events.some((event) => event.type === 'tool.started')).toBe(true);
      expect(result.said).toContain('The proof file is written.');
      // The provider saw Anthropic Messages translated to Chat, the tool's result included.
      const calls = provider.seen.slice(before);
      expect(
        calls.some((call) =>
          ((call.body.messages ?? []) as { role: string }[]).some((m) => m.role === 'tool'),
        ),
      ).toBe(true);
      for (const call of calls) {
        expect(call.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
        expect(call.body.model).toBe(MODEL);
      }
      expect(result.reports.length).toBeGreaterThan(0);
      expect(result.reports.at(-1)).toMatchObject({
        modelLabel: 'Fake Coder',
        providerId: PROVIDER_ID,
      });
      expect(result.reports.at(-1)!.inputTokens).toBeGreaterThanOrEqual(1200);
      expect(result.reports.at(-1)!.costSource).toBe('estimated');
      checkIsolation(result);
      rmSync(result.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    15 * 60_000,
  );

  it(
    'Claude Code streams Arabic intact, cut inside its letters, and ends the turn',
    async () => {
      const result = await runAgent('claude-code', ARABIC_PROMPT);
      expect(result.said).toBe(ARABIC_TOKENS.join(''));
      rmSync(result.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    5 * 60_000,
  );

  /**
   * An agent run the way the hub runs it: the real `AgentRunner`, the agent's process started by
   * the ACP adapter on its catalog wiring, and its gateway grant handed to the runner, which names
   * each turn's model to the gateway.
   */
  async function withRunner(
    id: string,
    use: (turn: (runId: string, text: string) => Promise<RunnerEvent[]>) => Promise<void>,
  ): Promise<void> {
    const { target, adapter, grant, home } = await prepareAgent(id);
    const service = {
      loadAgent: () => ({
        id: `agent-${id}`,
        slug: id,
        installState: 'installed',
        adapterKind: 'acp',
      }),
      settled: async () => {},
      selectionFor: () => ({ model: MODEL, provider: null, providerId: PROVIDER_ID }),
      fallbacksFor: () => [],
      providerSlugOf: () => 'fake',
      modelSourceFor: () => 'hub',
      openGateway: async () => grant,
      targetFor: () => target,
    };
    const runner = new AgentRunner({
      service: service as unknown as AgentsService,
      adapters: { byKind: () => adapter } as unknown as AdapterSet,
      log: pino({ level: 'silent' }) as never,
    });
    const turn = async (runId: string, text: string) => {
      await runner.start({
        runId,
        sessionId: `S-runner-${id}`,
        workspace: 'w',
        agentId: `agent-${id}`,
        agentSessionRef: null,
        workingDir: home,
        model: null,
        provider: null,
        reasoningEffort: null,
        userId: 'u1',
        prompt: [{ type: 'text' as const, text }],
        files: null,
        allowedTools: [],
      });
      const out: RunnerEvent[] = [];
      for await (const event of runner.stream(runId)) out.push(event);
      return out;
    };
    try {
      await use(turn);
    } finally {
      exhausted = false;
      await runner.closeAll();
      grant.revoke();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  const saidIn = (events: RunnerEvent[]) =>
    events
      .filter(
        (event): event is Extract<RunnerEvent, { type: 'message_delta' }> =>
          event.type === 'message_delta',
      )
      .map((event) => event.text)
      .join('');

  it(
    'after a turn the provider refused, the next turn streams Arabic intact and ends (the runner)',
    async () => {
      await withRunner('claude-code', async (turn) => {
        exhausted = true;
        const refused = await turn('run-refused', 'Say hello.');
        exhausted = false;
        expect(refused.at(-1)).toMatchObject({ type: 'failed' });
        const answered = await turn('run-arabic', ARABIC_PROMPT);
        expect(saidIn(answered)).toBe(ARABIC_TOKENS.join(''));
        expect(answered.at(-1)).toMatchObject({ type: 'completed' });
      });
    },
    5 * 60_000,
  );

  // A provider out of quota (owner, 2026-09-30: "Thinking 109 s", then an API error naming the
  // hub's internal provider id): the gateway answers in words each agent does not retry, so the
  // turn fails in seconds, as `rate_limited` naming the provider and the model people know.
  const onlyQuota = process.env.COREHUB_REAL_GATEWAY_ONLY?.split(',').filter(Boolean);
  const quotaAgents = [
    'claude-code',
    'codex',
    'gemini-cli',
    'goose',
    'opencode',
    'qwen-code',
    'kimi-code',
    'grok-build',
    'pi',
  ].filter((id) => !onlyQuota || onlyQuota.includes(id));
  it.each(quotaAgents)(
    '%s fails within seconds, and plainly, when the provider’s quota is spent, and the chat goes on',
    async (id) => {
      if (id !== 'claude-code' && process.env.COREHUB_REAL_GATEWAY_ALL !== '1') return;
      await withRunner(id, async (turn) => {
        const before = provider.seen.length;
        exhausted = true;
        const started = Date.now();
        const events = await turn(`run-quota-${id}`, 'Say hello.');
        const took = Date.now() - started;
        exhausted = false;
        expect(events.at(-1)).toMatchObject({
          type: 'failed',
          code: 'rate_limited',
          message:
            'The provider ran out of quota for Fake Coder. Pick another model for this chat.',
          details: { reason: 'quota_exhausted', model: 'Fake Coder', model_id: MODEL },
        });
        // No retries with backoff against a spent quota: one call reached the provider, at most
        // a side call (a title) too, and the turn was over in seconds, not minutes.
        expect(provider.seen.length - before).toBeLessThanOrEqual(2);
        expect(took, `took ${took} ms`).toBeLessThan(30_000);
        expect(JSON.stringify(events)).not.toMatch(/h01kgateway/i);
        // The quota back (or another model picked), the same conversation answers again — an
        // agent the hub had to stop included.
        const next = await turn(`run-after-${id}`, 'Say pong.');
        expect(next.at(-1)).toMatchObject({ type: 'completed' });
        expect(saidIn(next)).toContain('pong from the fake provider');
      });
    },
    5 * 60_000,
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

  // Every other wired agent, each writing the proof file with its own tool on the provider's
  // streamed tool call (`COREHUB_REAL_GATEWAY_ALL=1`; CI sets it). `COREHUB_REAL_GATEWAY_ONLY`
  // (a comma-separated list) narrows the list when running it by hand.
  const only = process.env.COREHUB_REAL_GATEWAY_ONLY?.split(',').filter(Boolean);
  const roundTrips = [
    'gemini-cli',
    'goose',
    'opencode',
    'qwen-code',
    'kimi-code',
    'grok-build',
    'pi',
  ].filter((id) => !only || only.includes(id));
  it
    .skipIf(process.env.COREHUB_REAL_GATEWAY_ALL !== '1' || roundTrips.length === 0)
    .each(roundTrips)(
    '%s round-trips a tool call through the gateway',
    async (id) => {
      const before = provider.seen.length;
      const result = await runAgent(
        id,
        `Create the file ${PROOF_FILE} in the working directory, containing exactly: ${PROOF_TEXT}`,
      );
      const calls = provider.seen.slice(before);
      const offered = [
        ...new Set(
          calls.flatMap((call) =>
            ((call.body.tools ?? []) as ChatTool[]).map((tool) => tool.function?.name),
          ),
        ),
      ];
      const proof = path.join(result.home, PROOF_FILE);
      expect(existsSync(proof), `tools offered: ${offered.join(', ')}`).toBe(true);
      expect(readFileSync(proof, 'utf8').trimEnd()).toBe(PROOF_TEXT);
      // The stream showed the tool (Gemini CLI announces it in its permission request, then
      // reports it done; the others start it first).
      const kinds = result.events.map((event) => event.type);
      expect(
        kinds.some((kind) => kind === 'tool.started' || kind === 'tool.completed'),
        kinds.join(', '),
      ).toBe(true);
      expect(result.said).toContain('The proof file is written.');
      // The next request carried the tool's result, in Chat Completions' own shape.
      expect(
        calls.some((call) =>
          ((call.body.messages ?? []) as { role: string }[]).some((m) => m.role === 'tool'),
        ),
      ).toBe(true);
      for (const call of calls) {
        expect(call.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
        expect(call.body.model).toBe(MODEL);
      }
      expect(result.reports.length).toBeGreaterThan(0);
      checkIsolation(result);
      checkPersonSettings(id, result.home);
      rmSync(result.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    15 * 60_000,
  );

  /** The person's own settings beside the hub's block came through unchanged. */
  function checkPersonSettings(id: string, home: string): void {
    if (id === 'grok-build') {
      const text = readFileSync(path.join(home, '.grok', 'config.toml'), 'utf8');
      expect(text.startsWith(PERSON_GROK)).toBe(true);
      expect(text).toContain('[model.corehub-gateway]');
      expect(text).not.toContain(PROVIDER_KEY);
    }
    if (id === 'pi') {
      const models = JSON.parse(
        readFileSync(path.join(home, '.pi', 'agent', 'models.json'), 'utf8'),
      ) as { providers: Record<string, unknown> };
      expect(models.providers.ollama).toEqual(
        (JSON.parse(PERSON_PI) as { providers: Record<string, unknown> }).providers.ollama,
      );
      expect(JSON.stringify(models)).not.toContain(PROVIDER_KEY);
      // Pi's saved default is the person's still: the session was switched, not the setting.
      const settings = path.join(home, '.pi', 'agent', 'settings.json');
      if (existsSync(settings)) {
        expect(readFileSync(settings, 'utf8')).not.toContain('corehub-gateway');
      }
    }
    if (id === 'gemini-cli') {
      const settings = readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8');
      expect(JSON.parse(settings)).toMatchObject(JSON.parse(PERSON_GEMINI) as object);
    }
  }

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
