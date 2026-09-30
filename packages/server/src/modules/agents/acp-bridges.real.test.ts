/**
 * The renamed ACP bridges (DECISIONS §139) against **the real packages from npm**: each old
 * bridge is installed as a hub from before the rename has it, the hub's own installer takes the
 * update to the pinned successor, and the hub's ACP adapter then starts a session with it
 * (`initialize`, `session/new`) and runs one turn against a local fake provider — an Anthropic
 * Messages endpoint for Claude Code, an OpenAI Responses endpoint for Codex — named only through
 * the environment. The fake provider seeing the key the hub handed proves the variables reach the
 * model call through the allow-list (the base of the model gateway). That none of the hub's own
 * variables reach a bridge is `adapters/child-env.test.ts`'s.
 *
 * It needs npm and the network (about 750 MB of packages), so it is skipped unless asked for:
 *
 *   COREHUB_REAL_ACP_BRIDGES=1 COREHUB_REAL_ACP_DATA=~/.cache/corehub-agent/acp-data \
 *     pnpm --filter @corehub/server exec vitest run src/modules/agents/acp-bridges.real.test.ts
 *
 * `COREHUB_REAL_ACP_DATA` is kept between runs (a fresh temporary folder otherwise).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAcpAdapter } from './adapters/acp.js';
import type { AgentEvent, AgentTarget } from './adapters/types.js';
import { catalogEntry, type CatalogEntry } from './catalog/index.js';
import { agentBinDir, agentPrefix, createNpmInstaller, installedVersion } from './installer.js';

const enabled = process.env.COREHUB_REAL_ACP_BRIDGES === '1';
const dataDir = process.env.COREHUB_REAL_ACP_DATA
  ? path.resolve(process.env.COREHUB_REAL_ACP_DATA)
  : mkdtempSync(path.join(tmpdir(), 'corehub-acp-real-'));

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  apiKey: string | undefined;
}

/** A provider that answers every model call with "pong" and records what reached it. */
async function fakeProvider(kind: 'anthropic' | 'openai'): Promise<{
  server: Server;
  url: string;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    request.resume();
    request.on('end', () => {
      const url = request.url ?? '';
      seen.push({
        method: request.method ?? '',
        url,
        authorization: request.headers.authorization,
        apiKey: request.headers['x-api-key'] as string | undefined,
      });
      if (kind === 'anthropic' && /^\/v1\/messages(\?|$)/.test(url)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (name: string, data: unknown) =>
          response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        event('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-fake',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        });
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'pong' },
        });
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        event('message_stop', { type: 'message_stop' });
        response.end();
        return;
      }
      if (kind === 'openai' && url.endsWith('/responses')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (data: { type: string } & Record<string, unknown>) =>
          response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
        const item = {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'pong', annotations: [] }],
        };
        event({ type: 'response.created', response: { id: 'resp_1' } });
        event({
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, status: 'in_progress', content: [] },
        });
        event({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'msg_1',
          delta: 'pong',
        });
        event({ type: 'response.output_item.done', output_index: 0, item });
        event({
          type: 'response.completed',
          response: {
            id: 'resp_1',
            usage: {
              input_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 1,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 2,
            },
          },
        });
        response.end();
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"not here"}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, seen };
}

const entryOf = (id: string): CatalogEntry => {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`no catalog entry ${id}`);
  return entry;
};

/** The hub's own variables, set on the host: none may reach a bridge. */
const HUB_SECRETS = {
  DATABASE_URL: 'postgres://hub:secret@db/hub',
  HUB_ADMIN_PASSWORD: 'first-owner-password',
  COREHUB_APNS_KEY: 'apns-private-key',
};

const CASES = [
  {
    id: 'claude-code',
    old: '@zed-industries/claude-code-acp@0.16.2',
    provider: 'anthropic' as const,
    key: 'ANTHROPIC_API_KEY',
    host: (url: string, home: string) => ({
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_MODEL: 'claude-fake',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    }),
  },
  {
    id: 'codex',
    old: '@zed-industries/codex-acp@0.16.0',
    provider: 'openai' as const,
    key: 'OPENAI_API_KEY',
    host: (url: string) => ({
      CODEX_CONFIG: JSON.stringify({
        model_provider: 'fake',
        model: 'gpt-fake',
        model_providers: {
          fake: {
            name: 'Fake',
            base_url: `${url}/v1`,
            env_key: 'OPENAI_API_KEY',
            wire_api: 'responses',
          },
        },
      }),
      // codex-acp asks for a sign-in before a session unless told to use the key it is given.
      DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key' }),
    }),
  },
];

describe.skipIf(!enabled)('the renamed ACP bridges, for real (COREHUB_REAL_ACP_BRIDGES=1)', () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
    if (!process.env.COREHUB_REAL_ACP_DATA) rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(CASES)(
    '$id: an old install is updated to the successor, which starts a session and reaches the provider',
    async (spec) => {
      const entry = entryOf(spec.id);
      const pinned = entry.install.kind === 'npm' ? entry.install.version : '';
      const prefix = agentPrefix(dataDir, spec.id);
      const home = mkdtempSync(path.join(tmpdir(), `corehub-acp-home-${spec.id}-`));
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      const inherited = { ...process.env, HOME: home, ...HUB_SECRETS };
      const installer = createNpmInstaller({
        dataDir,
        host: { pathValue: process.env.PATH, inherited },
      });

      // A hub from before the rename installed the old bridge.
      rmSync(prefix, { recursive: true, force: true });
      execFileSync(
        'npm',
        ['install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', spec.old],
        { stdio: 'ignore', timeout: 10 * 60_000 },
      );
      const oldVersion = spec.old.slice(spec.old.lastIndexOf('@') + 1);
      expect(installer.isPresent(entry)).toBe(true);
      expect((await installer.health(entry)).version).toBe(oldVersion);

      // Until the update, the hub still starts the old bridge under its old program name. (The
      // old codex-acp, like the new one, asks for a sign-in before `session/new` when it is only
      // handed a key, so the session itself is opened with Claude Code's.)
      const legacyPath = installer.executablePath?.(entry) ?? null;
      expect(legacyPath && path.basename(legacyPath)).toBe(
        entry.install.kind === 'npm' ? entry.install.legacy?.[0]?.binary : null,
      );
      if (spec.id === 'claude-code') {
        const before = createAcpAdapter({
          host: {
            pathValue: process.env.PATH,
            inherited: { ...inherited, ...spec.host('http://127.0.0.1:9', home) },
          },
        });
        const old = await before.start({
          slug: spec.id,
          name: entry.name,
          command: [entry.binary],
          executablePath: legacyPath,
          endpoint: null,
          cwd: home,
          env: { [spec.key]: 'sk-fake-legacy' },
        });
        expect(old.id).toBeTruthy();
        await old.close();
      }

      // The person takes the update.
      const outcome = await installer.install(entry, async () => {});
      expect(outcome.version).toBe(pinned);
      expect(outcome.executablePath).toBe(path.join(agentBinDir(dataDir, spec.id), entry.binary));
      expect(installedVersion(dataDir, entry, { current: true })).toBe(pinned);
      expect(readdirSync(path.dirname(prefix)).filter((name) => name.startsWith('.'))).toEqual([]);

      // The hub starts it over ACP, handing it the key under the name it reads.
      const provider = await fakeProvider(spec.provider);
      servers.push(provider.server);
      const adapter = createAcpAdapter({
        host: {
          pathValue: `${agentBinDir(dataDir, spec.id)}${path.delimiter}${process.env.PATH ?? ''}`,
          inherited: { ...inherited, ...spec.host(provider.url, home) },
        },
      });
      const target = {
        slug: spec.id,
        name: entry.name,
        command: [entry.binary],
        executablePath: outcome.executablePath,
        endpoint: null,
        cwd: home,
        env: { [spec.key]: `sk-fake-${spec.id}` },
      } satisfies AgentTarget;
      const session = await adapter.start(target);
      const events: AgentEvent[] = [];
      const reading = (async () => {
        for await (const event of session.stream()) events.push(event);
      })();
      try {
        const done = await session.send({ text: 'Say pong.' });
        expect(done.stopReason).toBe('end_turn');
      } finally {
        await session.close();
        await reading;
      }
      const said = events
        .filter(
          (event): event is Extract<AgentEvent, { type: 'message.delta' }> =>
            event.type === 'message.delta',
        )
        .map((event) => event.text)
        .join('');
      expect(said).toContain('pong');
      const calls = provider.seen.filter((call) => call.method === 'POST');
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.apiKey ?? call.authorization).toContain(`sk-fake-${spec.id}`);
      }
      // Codex may still be writing its session files as it exits.
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // A temporary folder left behind is harmless.
      }
    },
    15 * 60_000,
  );
});
