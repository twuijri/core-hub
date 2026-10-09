/**
 * Writing into a Telegram conversation from the hub (contract decision §153), against **the real
 * Hermes** from the image.
 *
 * The hub writes its plugin into each Hermes home (`plugins/corehub-bridge/`, switched on with
 * `allow_gateway_injection`), the image's own `hermes gateway run` serves Telegram — its real
 * adapter, pointed at a fake Bot API on this machine through Hermes's own
 * `platforms.telegram.extra.base_url` — the model is scripted here, and the hub reads the
 * conversations through `hermes serve` as it does in production (§61). Then, as an admin would:
 *
 * 1. a person writes to the bot; the plugin's hooks report the turn and the hub announces it as
 *    `channel_conversation.updated` — no polling;
 * 2. the admin writes into that conversation from the hub: the words are posted on the channel
 *    first («من كور هب (<their name>): …», by the hub through the Bot API), then the plugin puts them
 *    into the same Hermes conversation as a turn; the agent answers on Telegram; the transcript
 *    has the admin's message (`origin: hub`) and the reply, in the same conversation, whose
 *    source is still Telegram;
 * 3. when Telegram refuses the hub's post, nothing reaches the agent;
 * 4. a named profile's conversation is reached too — through the root gateway's plugin on a
 *    Hermes with one gateway per host, through the profile's own gateway on an older one;
 * 5. a message on the channel while the hub's turn runs: what Hermes does is recorded.
 *
 * On a Hermes that has it (v0.21.6 on), all of it again with `plugins.isolation: host`, where the
 * hub's plugin runs in Hermes's plugin-host process.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/sessions/channel-sends.real.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, capturingLogger, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import {
  imageHermesVersion,
  runsPluginsInAHost,
  servesEveryProfileFromOneGateway,
} from '../../../tests/unit/hermes-real.js';
import { requireSqlite } from '../../lib/db.js';
import { listWorkspacesFor } from '../auth/index.js';
import {
  HermesDashboard,
  channelBridgeFor,
  hermesRuntimeFor,
  type DashboardSpawner,
  type SpawnedProcess,
} from '../agents/index.js';
import { hermesChannelSourceOver } from '../index.js';
import { registerChannelSource } from './index.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';
const TOKEN_ROOT = '111111:corehub-root-bot-token-aaaaaaaa';
const TOKEN_WORK = '222222:corehub-work-bot-token-bbbbbbbb';
const PERSON = 4242;
const WORKER = 5151;

/** Answers `echo: <the last user words>`; words with SLOW are answered after ten seconds. */
function scriptedModel(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as {
        messages?: Array<{ role: string; content: unknown }>;
        stream?: boolean;
      };
      const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const words =
        typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      const reply = `echo: ${String(words).split('\n')[0]!.slice(0, 300)}`;
      const answer = () => {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const [delta, finish] of [
            [{ role: 'assistant', content: reply }, null],
            [{}, 'stop'],
          ] as const) {
            res.write(
              `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
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
            model: 'fake-1',
            choices: [
              { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      };
      if (String(words).includes('SLOW')) setTimeout(answer, 10_000);
      else answer();
    });
  });
}

interface Sent {
  via: 'hub' | 'hermes';
  bot: string;
  chatId: string;
  text: string;
  at: number;
}

/**
 * Telegram's Bot API for two bots: Hermes's adapters poll it (`/bot<token>/…`), the hub posts
 * through it (`/hub/bot<token>/sendMessage`, the hub's `COREHUB_TELEGRAM_API_BASE`). A chat can
 * be made to refuse the hub's posts, as Telegram does for a bot the person blocked.
 */
class FakeTelegram {
  readonly sent: Sent[] = [];
  readonly methods: string[] = [];
  readonly refusing = new Set<string>();
  private readonly queues = new Map<string, Array<Record<string, unknown>>>();
  private nextUpdate = 1;
  private nextMessage = 100;
  readonly server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const url = (req.url ?? '').split('?')[0]!;
        const parts = url.split('/');
        const method = parts.pop() ?? '';
        const bot = (parts.pop() ?? '').replace(/^bot/, '').split(':')[0] ?? '';
        const via = url.startsWith('/hub/') ? 'hub' : 'hermes';
        this.methods.push(`${bot}:${method}`);
        const params = this.parse(req.headers['content-type'] ?? '', raw);
        void this.answer(bot, via, method, params).then((answer) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(answer));
        });
      });
    });
  }

  private parse(type: string, raw: string): Record<string, string> {
    if (type.includes('application/json')) {
      const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
    if (type.includes('multipart/form-data')) {
      const out: Record<string, string> = {};
      for (const part of raw.split(/--[^\r\n]+/)) {
        const match = /name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n?$/.exec(part);
        if (match) out[match[1]!] = match[2]!.replace(/\r\n$/, '');
      }
      return out;
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }

  say(bot: string, userId: number, text: string): void {
    const queue = this.queues.get(bot) ?? [];
    this.queues.set(bot, queue);
    queue.push({
      update_id: this.nextUpdate++,
      message: {
        message_id: this.nextMessage++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private', first_name: `User ${userId}` },
        from: { id: userId, is_bot: false, first_name: `User ${userId}` },
        text,
      },
    });
  }

  private async answer(
    bot: string,
    via: 'hub' | 'hermes',
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const ok = (result: unknown) => ({ ok: true, result });
    switch (method) {
      case 'getMe':
        return ok({
          id: Number(bot),
          is_bot: true,
          first_name: `Bot ${bot}`,
          username: `bot_${bot}`,
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      case 'getUpdates': {
        const queue = this.queues.get(bot) ?? [];
        const offset = Number(params.offset ?? 0);
        for (let i = 0; i < 20 && !queue.some((u) => Number(u.update_id) >= offset); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return ok(queue.filter((u) => Number(u.update_id) >= offset));
      }
      case 'sendMessage':
      case 'editMessageText': {
        const chatId = String(params.chat_id ?? '');
        if (via === 'hub' && this.refusing.has(chatId)) {
          return {
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot was blocked by the user',
          };
        }
        this.sent.push({ via, bot, chatId, text: params.text ?? '', at: Date.now() });
        return ok({
          message_id: this.nextMessage++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chatId), type: 'private' },
          from: { id: Number(bot), is_bot: true, first_name: `Bot ${bot}` },
          text: params.text,
        });
      }
      case 'getMyCommands':
        return ok([]);
      case 'getWebhookInfo':
        return ok({ url: '', has_custom_certificate: false, pending_update_count: 0 });
      default:
        return ok(true);
    }
  }

  async waitFor(predicate: (sent: Sent) => boolean, timeoutMs: number): Promise<Sent | null> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const found = this.sent.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }
}

interface Updated {
  profile: string;
  payload: {
    conversation_id: string;
    channel: string;
    reason: string;
    outgoing: { id: string; status: string; error: unknown; session_id: string | null } | null;
  };
}

const plain = (text: string) => text.replace(/\\/g, '');

/**
 * Every case twice on a Hermes that can run a third-party plugin in its plugin host
 * (`plugins.isolation: host`, v0.21.6 on): once in-process, Hermes's default, and once there —
 * the hub's plugin is such a plugin. An older Hermes has no such setting: in-process only.
 */
const ISOLATIONS = ['in_process', 'host'] as const;

for (const isolation of ISOLATIONS)
  describe.skipIf(!image || (isolation === 'host' && !runsPluginsInAHost(image)))(
    `writing into a channel conversation from the hub (real Hermes, plugins ${isolation}; set COREHUB_HERMES_IMAGE)`,
    () => {
      const home = mkdtempSync(path.join(tmpdir(), 'corehub-twoway-home-'));
      const dashboardData = mkdtempSync(path.join(tmpdir(), 'corehub-twoway-dash-'));
      chmodSync(home, 0o777);
      const telegram = new FakeTelegram();
      let model: http.Server;
      let hub: TestHub & { token: string; userId: string };
      let socket: Socket;
      let previous: ReturnType<typeof registerChannelSource>;
      let dashboard: HermesDashboard;
      const updates: Updated[] = [];
      /** The admin's name as the channel shows it (their display name). */
      let NAME = '';
      const gateways: ChildProcess[] = [];
      const containers: string[] = [];
      const log: string[] = [];
      const { uid, gid } = userInfo();
      const onePerHost = image ? servesEveryProfileFromOneGateway(image) : false;

      const docker = (name: string, args: readonly string[]): ChildProcess => {
        containers.push(name);
        const child = spawn(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            name,
            '--network',
            'host',
            '--user',
            `${uid}:${gid}`,
            '-v',
            `${home}:${home}`,
            '-e',
            `HERMES_HOME=${home}`,
            '-e',
            'HOME=/tmp',
            '-e',
            'COREHUB_FAKE_KEY=fake-key-000000000000',
            '-e',
            'COREHUB_MCP_ORIGIN=gateway',
            '-e',
            'HERMES_DASHBOARD=0',
            '-e',
            'PYTHONUNBUFFERED=1',
            '--entrypoint',
            HERMES,
            image!,
            ...args,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on('data', (chunk: Buffer) =>
            log.push(
              ...chunk
                .toString()
                .split('\n')
                .map((line) => `${name}: ${line}`),
            ),
          );
        }
        return child;
      };
      const inImage = (argv: readonly string[]) =>
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--user',
            `${uid}:${gid}`,
            '-v',
            `${home}:${home}`,
            '-e',
            `HERMES_HOME=${home}`,
            '-e',
            'HOME=/tmp',
            '--entrypoint',
            HERMES,
            image!,
            ...argv,
          ],
          { encoding: 'utf8', timeout: 180_000 },
        );

      const hint = () =>
        [
          telegram.sent
            .map((s) => `${s.via} ${s.bot}→${s.chatId}: ${s.text.slice(0, 120)}`)
            .join('\n'),
          JSON.stringify(updates.slice(-20)),
          log
            .filter((line) => line.trim())
            .slice(-60)
            .join('\n'),
        ].join('\n---\n');

      const waitUntil = async <T>(probe: () => T | null | undefined | false, ms: number) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          const value = probe();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return null;
      };

      const configFor = (modelPort: number, telegramPort: number) =>
        [
          '# written by the real-Hermes test',
          'providers:',
          '  corehub-fake:',
          '    name: corehub-fake',
          `    base_url: http://127.0.0.1:${modelPort}/v1`,
          '    key_env: COREHUB_FAKE_KEY',
          '    api_mode: chat_completions',
          'model:',
          '  default: fake-1',
          '  provider: corehub-fake',
          'platforms:',
          '  telegram:',
          '    enabled: true',
          '    extra:',
          `      base_url: http://127.0.0.1:${telegramPort}/bot`,
          ...(isolation === 'host' ? ['plugins:', '  isolation: host'] : []),
          '',
        ].join('\n');

      beforeAll(async () => {
        model = scriptedModel();
        await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
        await new Promise<void>((resolve) => telegram.server.listen(0, '127.0.0.1', resolve));
        const modelPort = (model.address() as AddressInfo).port;
        const telegramPort = (telegram.server.address() as AddressInfo).port;

        // Hermes's homes: the root and a named profile, each with its own bot.
        inImage(['profile', 'create', 'work', '--no-alias']);
        const work = path.join(home, 'profiles', 'work');
        for (const [dir, token, allowed] of [
          [home, TOKEN_ROOT, PERSON],
          [work, TOKEN_WORK, WORKER],
        ] as const) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, 'config.yaml'), configFor(modelPort, telegramPort));
          writeFileSync(
            path.join(dir, '.env'),
            `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_ALLOWED_USERS=${String(allowed)}\n`,
          );
        }

        hub = await signedInHub(
          { COREHUB_TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}/hub` },
          {
            agents: {
              adapterOptions: {
                hermes: {
                  fetchImpl: async () =>
                    new Response('{"status":"ok"}', {
                      status: 200,
                      headers: { 'content-type': 'application/json' },
                    }),
                  ensureProfile: async () => undefined,
                },
              },
              channelBridgeRoot: home,
            },
          },
        );
        await hub.app.listen({ port: 0, host: '127.0.0.1' });
        const me = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/auth/me' });
        NAME = (me.json() as { display_name: string }).display_name;
        const made = await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/profiles',
          payload: { slug: 'work', name: 'work' },
        });
        expect(made.statusCode, made.body).toBe(201);
        // The hub knows which Hermes it runs: one gateway per host from 0.21.4 (§129).
        await hermesRuntimeFor(hub.app).profileGateways.noteVersion(imageHermesVersion(image!));

        // The conversations, read through `hermes serve` as in production (§61).
        const spawnImpl: DashboardSpawner = (_command, args, options) => {
          const name = `corehub-twoway-dash-${process.pid}-${isolation}-${containers.length}`;
          containers.push(name);
          return spawn(
            'docker',
            [
              'run',
              '--rm',
              '--name',
              name,
              '--network',
              'host',
              '--user',
              `${uid}:${gid}`,
              '-v',
              `${home}:${home}`,
              '-e',
              `HERMES_HOME=${home}`,
              '-e',
              'HOME=/tmp',
              '-e',
              'HERMES_DASHBOARD_SESSION_TOKEN',
              '--entrypoint',
              HERMES,
              image!,
              ...args,
            ],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: {
                ...process.env,
                HERMES_DASHBOARD_SESSION_TOKEN: options.env.HERMES_DASHBOARD_SESSION_TOKEN,
              },
            },
          ) as unknown as SpawnedProcess;
        };
        dashboard = new HermesDashboard({
          host: {
            status: () => ({ mode: 'managed', home }),
            executable: () => HERMES,
            cliEnv: () => ({}),
          },
          dataDir: dashboardData,
          log: capturingLogger().logger,
          spawnImpl,
          startTimeoutMs: 180_000,
        });
        const db = requireSqlite(hub.app.hub.database);
        const source = hermesChannelSourceOver(dashboard, home, (workspace) => {
          const row = listWorkspacesFor(db, { id: '', role: 'owner' }).find(
            (w) => w.id === workspace,
          );
          return row ? (row.isDefault ? 'default' : row.slug) : null;
        });
        previous = registerChannelSource(() => source);

        // The plugin, as the hub writes it into every home of the Hermes it runs.
        channelBridgeFor(hub.app).syncAll();

        const port = (hub.app.server.address() as AddressInfo).port;
        socket = connect(`http://127.0.0.1:${port}/rt/sessions`, {
          path: '/rt',
          transports: ['websocket'],
          auth: { token: hub.token, profile: 'default', profiles: 'all' },
        });
        socket.on('channel_conversation.updated', (envelope: Updated) => updates.push(envelope));
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => resolve());
          socket.once('connect_error', reject);
        });

        gateways.push(
          docker(`corehub-twoway-root-${process.pid}-${isolation}`, ['gateway', 'run']),
        );
        if (!onePerHost) {
          gateways.push(
            docker(`corehub-twoway-work-${process.pid}-${isolation}`, [
              '-p',
              'work',
              'gateway',
              'run',
            ]),
          );
        }
        const polling = await waitUntil(
          () =>
            telegram.methods.includes('111111:getUpdates') &&
            telegram.methods.includes('222222:getUpdates') &&
            channelBridgeFor(hub.app).connected('default') &&
            channelBridgeFor(hub.app).connected('work'),
          240_000,
        );
        expect(polling, hint()).toBeTruthy();
      }, 420_000);

      afterAll(async () => {
        socket?.disconnect();
        for (const name of containers) {
          try {
            execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
          } catch {
            // gone with --rm
          }
        }
        for (const gateway of gateways) gateway.kill();
        await dashboard?.close().catch(() => undefined);
        registerChannelSource(previous);
        await hub?.close().catch(() => undefined);
        model?.close();
        telegram.server.close();
        try {
          execFileSync('docker', [
            'run',
            '--rm',
            '-v',
            `${home}:${home}`,
            '--entrypoint',
            '/bin/sh',
            image!,
            '-c',
            `rm -rf ${home}/* ${home}/.[!.]* 2>/dev/null; true`,
          ]);
        } catch {
          // best effort
        }
        rmSync(home, { recursive: true, force: true });
        rmSync(dashboardData, { recursive: true, force: true });
      });

      const listIn = async (profile: string) => {
        const listed = await authed(hub, hub.token, {
          method: 'GET',
          url: '/api/v1/channel-conversations',
          profile,
        });
        expect(listed.statusCode, listed.body).toBe(200);
        return listed.json() as {
          items: Array<{ id: string; channel: string; can_send?: boolean; peer_id: string | null }>;
          live_updates?: boolean;
        };
      };
      const transcript = async (profile: string, id: string) => {
        const read = await authed(hub, hub.token, {
          method: 'GET',
          url: `/api/v1/channel-conversations/${id}/messages`,
          profile,
        });
        expect(read.statusCode, read.body).toBe(200);
        return read.json() as {
          conversation: { id: string; channel: string; can_send?: boolean };
          items: Array<{
            id: string;
            role: string;
            text: string;
            origin?: string;
            author_name?: string | null;
          }>;
          outgoing?: Array<{ id: string; status: string; message_id: string | null }>;
        };
      };
      const statusOf = (outgoingId: string) =>
        updates
          .filter((u) => u.payload.outgoing?.id === outgoingId)
          .map((u) => u.payload.outgoing!.status);

      let rootConversation = '';

      it('hears a Telegram turn as it happens, without polling', async () => {
        telegram.say('111111', PERSON, 'hello from Telegram');
        const reply = await telegram.waitFor(
          (s) =>
            s.via === 'hermes' &&
            s.chatId === String(PERSON) &&
            s.text.includes('hello from Telegram'),
          180_000,
        );
        expect(reply, hint()).not.toBeNull();
        const listed = await listIn('default');
        const conversation = listed.items.find((c) => c.peer_id === String(PERSON));
        expect(conversation, JSON.stringify(listed)).toMatchObject({
          channel: 'telegram',
          can_send: true,
        });
        expect(listed.live_updates).toBe(true);
        rootConversation = conversation!.id;
        const heard = await waitUntil(
          () =>
            updates.find(
              (u) =>
                u.profile === 'default' &&
                u.payload.conversation_id === rootConversation &&
                u.payload.reason === 'turn_ended',
            ),
          30_000,
        );
        expect(heard, hint()).toBeTruthy();
      }, 300_000);

      it('posts on Telegram first, then the agent answers there in the same conversation', async () => {
        const before = await transcript('default', rootConversation);
        const sent = await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/channel-conversations/${rootConversation}/messages`,
          payload: { text: 'ما آخر الأخبار؟', client_message_id: 'c-1' },
        });
        expect(sent.statusCode, sent.body).toBe(202);
        const outgoing = sent.json().outgoing as {
          id: string;
          status: string;
          author_name: string;
        };
        expect(outgoing).toMatchObject({
          status: 'posted',
          author_name: NAME,
          client_message_id: 'c-1',
        });

        const mirror = await telegram.waitFor(
          (s) =>
            s.via === 'hub' && s.chatId === String(PERSON) && s.text.includes('ما آخر الأخبار؟'),
          30_000,
        );
        expect(mirror?.text).toBe(`من كور هب (${NAME}): ما آخر الأخبار؟`);
        const reply = await telegram.waitFor(
          (s) =>
            s.via === 'hermes' &&
            s.chatId === String(PERSON) &&
            plain(s.text).includes(`من كور هب (${NAME}): ما آخر الأخبار؟`),
          180_000,
        );
        expect(reply, hint()).not.toBeNull();
        expect(mirror!.at).toBeLessThanOrEqual(reply!.at);

        const answered = await waitUntil(() => statusOf(outgoing.id).includes('answered'), 60_000);
        expect(answered, hint()).toBeTruthy();
        expect(statusOf(outgoing.id)).toEqual(['posted', 'delivered', 'answering', 'answered']);
        const ran = updates.find(
          (u) => u.payload.outgoing?.id === outgoing.id && u.payload.outgoing.session_id,
        );
        expect(ran?.payload.outgoing?.session_id).toBe(rootConversation);

        // The same conversation, still Telegram's: the admin's message and the agent's reply.
        let read = await transcript('default', rootConversation);
        for (let i = 0; i < 20 && !read.items.some((m) => m.origin === 'hub'); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          read = await transcript('default', rootConversation);
        }
        expect(read.conversation).toMatchObject({ id: rootConversation, channel: 'telegram' });
        const added = read.items.slice(before.items.length);
        expect(
          added.map((m) => [m.role, m.origin, m.author_name ?? null, m.text.split('\n')[0]]),
          JSON.stringify(read.items),
        ).toEqual([
          ['user', 'hub', NAME, 'ما آخر الأخبار؟'],
          ['assistant', 'channel', null, `echo: من كور هب (${NAME}): ما آخر الأخبار؟`],
        ]);
        // Matched to the transcript and done: the hub stops listing it as pending.
        expect(read.outgoing ?? []).toEqual([]);
        const listed = await listIn('default');
        expect(listed.items.find((c) => c.id === rootConversation)).toMatchObject({
          channel: 'telegram',
        });
      }, 300_000);

      it('does not hand anything to the agent when Telegram refuses the post', async () => {
        const turnsBefore = updates.filter((u) => u.payload.reason === 'turn_started').length;
        const before = await transcript('default', rootConversation);
        telegram.refusing.add(String(PERSON));
        try {
          const refused = await authed(hub, hub.token, {
            method: 'POST',
            url: `/api/v1/channel-conversations/${rootConversation}/messages`,
            payload: { text: 'this must not reach the agent' },
          });
          expect(refused.statusCode, refused.body).toBe(503);
          expect(refused.json()).toMatchObject({
            code: 'service_unavailable',
            details: {
              reason: 'channel_send_failed',
              message: 'Forbidden: bot was blocked by the user',
            },
          });
        } finally {
          telegram.refusing.delete(String(PERSON));
        }
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        expect(updates.filter((u) => u.payload.reason === 'turn_started').length).toBe(turnsBefore);
        const after = await transcript('default', rootConversation);
        expect(after.items.length).toBe(before.items.length);
        expect(telegram.sent.some((s) => s.text.includes('this must not reach the agent'))).toBe(
          false,
        );
      }, 120_000);

      it("reaches a named profile's conversation", async () => {
        telegram.say('222222', WORKER, 'hello from work');
        const first = await telegram.waitFor(
          (s) => s.via === 'hermes' && s.bot === '222222' && s.text.includes('hello from work'),
          180_000,
        );
        expect(first, hint()).not.toBeNull();
        const conversation = (await listIn('work')).items.find((c) => c.peer_id === String(WORKER));
        expect(conversation, hint()).toMatchObject({ channel: 'telegram', can_send: true });
        const sent = await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/channel-conversations/${conversation!.id}/messages`,
          profile: 'work',
          payload: { text: 'from the hub to work' },
        });
        expect(sent.statusCode, sent.body).toBe(202);
        const id = (sent.json().outgoing as { id: string }).id;
        const mirror = await telegram.waitFor(
          (s) =>
            s.via === 'hub' &&
            s.bot === '222222' &&
            s.text === `من كور هب (${NAME}): from the hub to work`,
          30_000,
        );
        expect(mirror, hint()).not.toBeNull();
        const reply = await telegram.waitFor(
          (s) =>
            s.via === 'hermes' &&
            s.bot === '222222' &&
            plain(s.text).includes('from the hub to work'),
          180_000,
        );
        expect(reply, hint()).not.toBeNull();
        expect(
          await waitUntil(() => statusOf(id).includes('answered'), 60_000),
          hint(),
        ).toBeTruthy();
        expect(updates.find((u) => u.payload.outgoing?.id === id)?.profile).toBe('work');
      }, 300_000);

      it('records what Hermes does with a channel message during the hub’s turn', async () => {
        const sent = await authed(hub, hub.token, {
          method: 'POST',
          url: `/api/v1/channel-conversations/${rootConversation}/messages`,
          payload: { text: 'SLOW question from the hub' },
        });
        expect(sent.statusCode, sent.body).toBe(202);
        const id = (sent.json().outgoing as { id: string }).id;
        expect(
          await waitUntil(() => statusOf(id).includes('answering'), 60_000),
          hint(),
        ).toBeTruthy();
        const startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        telegram.say('111111', PERSON, 'a message typed on Telegram meanwhile');
        // Whatever Hermes does, the hub's message ends, and the person on Telegram is answered.
        expect(
          await waitUntil(() => statusOf(id).includes('answered'), 120_000),
          hint(),
        ).toBeTruthy();
        const answer = await telegram.waitFor(
          (s) => s.via === 'hermes' && s.chatId === String(PERSON) && s.at > startedAt + 1_500,
          120_000,
        );
        expect(answer, hint()).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        const after = telegram.sent
          .filter((s) => s.via === 'hermes' && s.chatId === String(PERSON) && s.at > startedAt)
          .map((s) => plain(s.text).split('\n')[0]!.slice(0, 120));
        const read = await transcript('default', rootConversation);
        // Observed, for the change record: Hermes's default busy mode with a turn put in by a
        // plugin. Printed, not asserted beyond the above, so a Hermes that queues instead of
        // redirecting does not fail the suite.
        const report = [
          `[two-way mid-turn] Hermes ${String(imageHermesVersion(image!))}: replies after the channel message:`,
          JSON.stringify(after),
          'statuses:',
          JSON.stringify(statusOf(id)),
          'last transcript items:',
          JSON.stringify(read.items.slice(-4).map((m) => [m.role, m.origin, m.text.slice(0, 80)])),
        ].join('\n');
        console.log(report);
        if (process.env.COREHUB_TWOWAY_REPORT) {
          appendFileSync(process.env.COREHUB_TWOWAY_REPORT, `${report}\n`);
        }
      }, 300_000);
    },
  );
