/**
 * A message on Telegram and the hub's own tools, against **the real Hermes** from the image
 * (contract decision §79).
 *
 * The whole path a person takes: the hub switches its tools on (the `corehub` block, the key,
 * and now the hook in `hooks/corehub/`), the image's own `hermes gateway run` serves Telegram —
 * its real adapter, pointed at a fake Bot API on this machine through Hermes's own
 * `platforms.telegram.extra.base_url` — and the model is scripted here too:
 *
 * 1. the person asks the hub for a link code and "sends" `/start <code>` from Telegram account
 *    4242: Hermes's `command:start` hook hands it to the hub, the hub links the account, and
 *    Hermes replies with the hub's words instead of passing the command on;
 * 2. account 4242 asks for a task: Hermes's `agent:start` hook tells the hub who the turn is for,
 *    the model calls `mcp__corehub__tasks_create`, and the task is on the board as the person's;
 * 3. account 9999, which nobody linked, asks the same: the call is refused with
 *    `hub_tools_sender_not_linked`, and no task is made.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run src/modules/agents/hub-tools/channel-identity.real.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, signedInHub, type TestHub } from '../../../../tests/unit/helpers.js';
import { runLeasesFor } from '../index.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const TITLE = 'Filed from Telegram through Core Hub';
const BOT_TOKEN = '123456:TEST-token-for-the-fake-bot-api';
const LINKED = 4242;
const STRANGER = 9999;

/** Turn one calls the hub's `tasks.create`; turn two says what the tool answered. */
function scriptedModel(): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = raw
        ? (JSON.parse(raw) as {
            messages?: Array<{ role: string; content: unknown }>;
            stream?: boolean;
            tools?: Array<{ function?: { name?: string } }>;
          })
        : {};
      const names = (body.tools ?? []).map((tool) => tool.function?.name ?? '');
      const offered = JSON.stringify(body.tools ?? []);
      const tool = [...(body.messages ?? [])].reverse().find((m) => m.role === 'tool');
      const direct = names.includes('mcp__corehub__tasks_create');
      const bridged =
        !direct && names.includes('tool_call') && offered.includes('mcp__corehub__tasks_create');
      const asked = JSON.stringify(body.messages ?? []).includes('File a task');
      const call = !tool && asked && (direct || bridged);
      const reply = tool ? `tool said: ${String(tool.content).slice(0, 2000)}` : 'no tools here';
      const toolCall = {
        id: 'call_hub_1',
        type: 'function',
        function: direct
          ? { name: 'mcp__corehub__tasks_create', arguments: JSON.stringify({ title: TITLE }) }
          : {
              name: 'tool_call',
              arguments: JSON.stringify({
                calls: [{ name: 'mcp__corehub__tasks_create', arguments: { title: TITLE } }],
              }),
            },
      };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = call
          ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }
          : { role: 'assistant', content: reply };
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-1', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`,
        );
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
            {
              index: 0,
              message: call
                ? { role: 'assistant', content: null, tool_calls: [toolCall] }
                : { role: 'assistant', content: reply },
              finish_reason: call ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
}

interface Sent {
  chatId: string;
  text: string;
}

/**
 * Just enough of Telegram's Bot API for python-telegram-bot to poll and answer: `getMe`,
 * `getUpdates` (long poll, from a queue), `sendMessage` and edits (recorded), and `true` for
 * everything else it asks at start (webhook, commands, chat actions).
 */
class FakeTelegram {
  readonly sent: Sent[] = [];
  readonly methods: string[] = [];
  private readonly queue: Array<Record<string, unknown>> = [];
  private nextUpdate = 1;
  private nextMessage = 100;
  readonly server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const method = (req.url ?? '').split('?')[0]!.split('/').pop() ?? '';
        this.methods.push(method);
        const params = this.parse(req.headers['content-type'] ?? '', raw);
        void this.answer(method, params).then((result) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
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

  /** A text message from `userId` in their private chat. */
  say(userId: number, text: string): void {
    const command = text.startsWith('/') ? text.split(' ')[0]! : null;
    this.queue.push({
      update_id: this.nextUpdate++,
      message: {
        message_id: this.nextMessage++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private', first_name: `User ${userId}` },
        from: { id: userId, is_bot: false, first_name: `User ${userId}` },
        text,
        ...(command
          ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] }
          : {}),
      },
    });
  }

  private message(chatId: string, text: string) {
    return {
      message_id: this.nextMessage++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: 'private', first_name: 'User' },
      from: { id: 1111, is_bot: true, first_name: 'Hub Bot', username: 'hub_test_bot' },
      text,
    };
  }

  private async answer(method: string, params: Record<string, string>): Promise<unknown> {
    switch (method) {
      case 'getMe':
        return {
          id: 1111,
          is_bot: true,
          first_name: 'Hub Bot',
          username: 'hub_test_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        };
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0);
        for (let i = 0; i < 20 && !this.queue.some((u) => Number(u.update_id) >= offset); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return this.queue.filter((u) => Number(u.update_id) >= offset);
      }
      case 'sendMessage':
      case 'editMessageText': {
        const text = params.text ?? '';
        this.sent.push({ chatId: String(params.chat_id ?? ''), text });
        return this.message(String(params.chat_id ?? '0'), text);
      }
      case 'getMyCommands':
        return [];
      case 'getWebhookInfo':
        return { url: '', has_custom_certificate: false, pending_update_count: 0 };
      default:
        return true;
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

describe.skipIf(!image)(
  'channel identities (real Hermes gateway; set COREHUB_HERMES_IMAGE)',
  () => {
    let model: http.Server;
    const telegram = new FakeTelegram();
    let hub: TestHub & { token: string; userId: string };
    let gateway: ChildProcess | null = null;
    const log: string[] = [];
    const container = `corehub-channelid-real-${process.pid}`;

    beforeAll(async () => {
      model = scriptedModel();
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve) => telegram.server.listen(0, '127.0.0.1', resolve));
      const modelPort = (model.address() as AddressInfo).port;
      const telegramPort = (telegram.server.address() as AddressInfo).port;
      hub = await signedInHub(
        {},
        {
          agents: {
            adapterOptions: {
              hermes: {
                // A gateway that answers its probe: the runtime is `external` and has a home.
                fetchImpl: async () =>
                  new Response('{"status":"ok"}', {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                  }),
                ensureProfile: async () => undefined,
              },
            },
          },
        },
      );
      const home = path.join(hub.dataDir, 'hermes');
      mkdirSync(home, { recursive: true });
      chmodSync(hub.dataDir, 0o777);
      writeFileSync(
        path.join(home, 'config.yaml'),
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
          '',
        ].join('\n'),
      );
      await hub.app.listen({ port: 0, host: '127.0.0.1' });

      const agents = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' });
      const hermes = (agents.json().items as Array<{ id: string; kind: string }>).find(
        (agent) => agent.kind === 'hermes',
      )!.id;
      const on = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/agents/${hermes}/hub-tools`,
        payload: { enabled: true, groups: [{ id: 'tasks', allow_writes: true }] },
      });
      expect(on.statusCode, on.body).toBe(200);
      // The bot, and the two accounts Hermes lets through (its own allowlist).
      appendFileSync(
        path.join(home, '.env'),
        `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\nTELEGRAM_ALLOWED_USERS=${LINKED},${STRANGER}\n`,
      );

      const { uid, gid } = userInfo();
      gateway = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          container,
          '--network',
          'host',
          '--user',
          `${uid}:${gid}`,
          '-v',
          `${hub.dataDir}:${hub.dataDir}`,
          '-e',
          `HERMES_HOME=${home}`,
          '-e',
          'HOME=/tmp',
          '-e',
          'COREHUB_FAKE_KEY=fake-key-000000000000',
          // What the hub sets in every messaging gateway it starts.
          '-e',
          'COREHUB_MCP_ORIGIN=gateway',
          '-e',
          'HERMES_DASHBOARD=0',
          '-e',
          'PYTHONUNBUFFERED=1',
          '--entrypoint',
          '/opt/hermes/.venv/bin/hermes',
          image!,
          'gateway',
          'run',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [gateway.stdout, gateway.stderr]) {
        stream?.on('data', (chunk: Buffer) => log.push(...chunk.toString().split('\n')));
      }
      // Ready when python-telegram-bot starts polling the fake Bot API.
      for (let i = 0; i < 240 && !telegram.methods.includes('getUpdates'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(telegram.methods, log.slice(-60).join('\n')).toContain('getUpdates');
    }, 180_000);

    afterAll(async () => {
      try {
        execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
      } catch {
        // gone with --rm
      }
      gateway?.kill();
      await hub?.close().catch(() => undefined);
      model?.close();
      telegram.server.close();
      try {
        rmSync(hub?.dataDir ?? '', { recursive: true, force: true });
      } catch {
        // a temp directory
      }
    });

    it('links a Telegram account with /start <code>, then its turn acts as the person and a stranger’s does not', async () => {
      const hint = () =>
        `${telegram.sent.map((s) => `${s.chatId}: ${s.text}`).join('\n')}\n---\n${log.slice(-80).join('\n')}`;

      // 1. The code, sent from the account being linked.
      const code = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/auth/me/channel-identities/link-codes',
      });
      expect(code.statusCode, code.body).toBe(201);
      telegram.say(LINKED, code.json().command as string);
      const reply = await telegram.waitFor(
        (s) => s.chatId === String(LINKED) && /Linked|تم الربط/.test(s.text),
        90_000,
      );
      expect(reply, hint()).not.toBeNull();
      const links = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/auth/me/channel-identities',
      });
      expect(links.json().items).toEqual([
        expect.objectContaining({
          platform: 'telegram',
          sender_id: String(LINKED),
          user_id: hub.userId,
        }),
      ]);

      // 2. The linked account's turn: the task is the person's.
      telegram.say(LINKED, 'File a task for me, please.');
      const done = await telegram.waitFor(
        (s) => s.chatId === String(LINKED) && s.text.includes('tool said'),
        180_000,
      );
      expect(done, hint()).not.toBeNull();
      const board = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/tasks' });
      const tasks = (board.json().items as Array<{ title: string; owner_id: string }>).filter(
        (item) => item.title === TITLE,
      );
      expect(tasks, board.body).toHaveLength(1);
      expect(tasks[0]!.owner_id).toBe(hub.userId);

      // 3. A stranger's turn: refused, and nothing made — even while the person has a chat of
      // their own running in the hub. Hermes's gateway sends `X-Corehub-Origin: gateway` (the
      // variable the hub sets): without it the two could not be told apart and the call would be
      // `hub_tools_run_ambiguous` instead.
      const workspace = (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' }))
        .json()
        .items.find((p: { slug: string }) => p.slug === 'default').id as string;
      runLeasesFor(hub.app).open({
        runId: 'RUNREAL',
        sessionId: 'SESREAL',
        workspaceId: workspace,
        userId: hub.userId,
      });
      telegram.say(STRANGER, 'File a task for me, please.');
      const refused = await telegram.waitFor(
        (s) => s.chatId === String(STRANGER) && s.text.includes('tool said'),
        180_000,
      );
      expect(refused, hint()).not.toBeNull();
      // Telegram's Markdown escapes: read the words without the backslashes.
      expect(refused!.text.replace(/\\/g, '')).toContain('hub_tools_sender_not_linked');
      runLeasesFor(hub.app).close('RUNREAL');
      const after = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/tasks' });
      expect(
        (after.json().items as Array<{ title: string }>).filter((item) => item.title === TITLE),
      ).toHaveLength(1);

      // The card's last calls say the same: the person's call, then the stranger's refusal.
      const hermes = (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/agents' })).json()
          .items as Array<{ id: string; kind: string }>
      ).find((agent) => agent.kind === 'hermes')!.id;
      const card = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/agents/${hermes}/hub-tools`,
      });
      const calls = card.json().recent_calls as Array<{
        tool: string;
        ok: boolean;
        user_id: string | null;
        error_code: string | null;
      }>;
      expect(calls.slice(0, 2), card.body).toEqual([
        expect.objectContaining({
          tool: 'tasks.create',
          ok: false,
          error_code: 'hub_tools_sender_not_linked',
          user_id: null,
        }),
        expect.objectContaining({ tool: 'tasks.create', ok: true, user_id: hub.userId }),
      ]);
    }, 600_000);
  },
);
