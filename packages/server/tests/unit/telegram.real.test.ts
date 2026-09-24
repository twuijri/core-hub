/**
 * Telegram in a named profile, with **the real Hermes** from the image and a scripted Telegram.
 *
 * The profile «tgbot» is made by Hermes; the hub's own code links a bot there (the token into the
 * profile's `.env`, the channel on with pairing) and saves two settings from the panel («show the
 * model's thinking», «answer in groups only when mentioned»). Hermes's Telegram adapter is pointed
 * at a fake Bot API on this host (`platforms.telegram.extra.base_url`, Hermes's own key for a
 * local Bot API server — written by this test only). Then the gateway the hub would start for
 * the profile, `hermes -p tgbot gateway run`:
 *
 * 0. installs python-telegram-bot on first start, as it does in the hub's image (which ships no
 *    messaging extras): Hermes's lazy install into the data volume
 *    (`HERMES_LAZY_INSTALL_TARGET`) — so this test needs PyPI once;
 * 1. connects with the token from the profile's `.env` (Telegram sees `getMe` and `getUpdates`
 *    on that token) and reports Telegram `connected` in its own state file;
 * 2. answers a stranger's first message with a pairing code and writes the request into the
 *    profile's `telegram-pending.json` — pairing, although an allowlist is set, because the hub
 *    wrote `unauthorized_dm_behavior: pair`;
 * 3. reads the saved settings where the panel wrote them (Hermes's own config loader, in the
 *    container).
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server exec \
 *     vitest run tests/unit/telegram.real.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activeChannels, linkTelegram, writeEnvValue } from '../../src/modules/agents/channels.js';
import { readGatewayRecord } from '../../src/modules/agents/hermes-gateways.js';
import { writeTelegramSettings } from '../../src/modules/agents/telegram-settings.js';
import { isMap, parseDocument } from 'yaml';
import { writeFileSync } from 'node:fs';

const image = process.env.COREHUB_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';
const PYTHON = '/opt/hermes/.venv/bin/python';
const TOKEN = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const BOT = { id: 7012345678, is_bot: true, first_name: 'Office', username: 'office_helper_bot' };
const STRANGER = 555666777;

describe.skipIf(!image)(
  'Telegram in a named profile (real Hermes; set COREHUB_HERMES_IMAGE)',
  () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-tg-real-'));
    const root = path.join(dataDir, 'hermes');
    const home = path.join(root, 'profiles', 'tgbot');
    const packages = path.join(dataDir, 'hermes-packages');
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const box = `corehub-tg-real-${process.pid}`;
    const calls: Array<{ method: string; token: string; body: Record<string, unknown> }> = [];
    let telegram: Server;
    let gateway: ChildProcess | null = null;
    let log = '';
    let delivered = false;

    const hermesOnce = (args: string[]) =>
      execFileSync('docker', ['exec', '-e', `HERMES_HOME=${root}`, box, HERMES, ...args], {
        encoding: 'utf8',
        timeout: 180_000,
      });

    beforeAll(async () => {
      mkdirSync(root, { recursive: true });
      chmodSync(dataDir, 0o777);
      chmodSync(root, 0o777);
      execFileSync('docker', [
        'run',
        '-d',
        '--rm',
        '--name',
        box,
        '--network',
        'host',
        '--user',
        user,
        '-e',
        'HOME=/tmp',
        // The image's own switch for a sealed venv: Hermes installs an optional package (here
        // python-telegram-bot, the first time a gateway starts Telegram) into a folder in the
        // data volume. In production that is /data/hermes-packages.
        '-e',
        `HERMES_LAZY_INSTALL_TARGET=${packages}`,
        '-v',
        `${dataDir}:${dataDir}`,
        '--entrypoint',
        'sleep',
        image!,
        'infinity',
      ]);

      // Telegram's Bot API, scripted: the bot, one message from a stranger, then quiet polls.
      telegram = createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => (raw += String(chunk)));
        request.on('end', () => {
          const match = /^\/bot([^/]+)\/([A-Za-z]+)/.exec(request.url ?? '');
          const token = decodeURIComponent(match?.[1] ?? '');
          const method = match?.[2] ?? '';
          let body: Record<string, unknown>;
          try {
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            body = Object.fromEntries(new URLSearchParams(raw));
          }
          calls.push({ method, token, body });
          const reply = (result: unknown) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, result }));
          };
          if (token !== TOKEN) {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }),
            );
            return;
          }
          if (method === 'getMe') return reply(BOT);
          if (method === 'getUpdates') {
            if (!delivered) {
              delivered = true;
              return reply([
                {
                  update_id: 1001,
                  message: {
                    message_id: 1,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: STRANGER, type: 'private', first_name: 'Noura' },
                    from: { id: STRANGER, is_bot: false, first_name: 'Noura' },
                    text: 'hello',
                  },
                },
              ]);
            }
            setTimeout(() => reply([]), 500);
            return;
          }
          if (method === 'sendMessage') {
            return reply({
              message_id: calls.length + 100,
              date: Math.floor(Date.now() / 1000),
              chat: { id: Number(body.chat_id), type: 'private' },
              text: String(body.text ?? ''),
            });
          }
          if (method === 'getMyCommands') return reply([]);
          if (method === 'getWebhookInfo') return reply({ url: '', pending_update_count: 0 });
          return reply(true);
        });
      });
      await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
      const port = (telegram.address() as { port: number }).port;

      // Hermes's own profile, then what the hub writes when the bot is linked and two settings saved.
      hermesOnce(['profile', 'create', 'tgbot', '--no-alias']);
      linkTelegram(home, {
        token: TOKEN,
        bot: { id: String(BOT.id), username: BOT.username, name: BOT.first_name },
        allowedUsers: ['111222333'],
      });
      writeTelegramSettings(home, { show_reasoning: true, require_mention: true });
      // This test only: Telegram is the scripted one, reached directly.
      const file = path.join(home, 'config.yaml');
      const doc = parseDocument(readFileSync(file, 'utf8'));
      if (!isMap(doc.getIn(['platforms', 'telegram', 'extra'], true))) {
        doc.setIn(['platforms', 'telegram', 'extra'], doc.createNode({}));
      }
      doc.setIn(['platforms', 'telegram', 'extra', 'base_url'], `http://127.0.0.1:${port}/bot`);
      writeFileSync(file, doc.toString());
      writeEnvValue(home, 'HERMES_TELEGRAM_DISABLE_FALLBACK_IPS', 'true');
    }, 240_000);

    afterAll(async () => {
      if (process.env.COREHUB_TG_REAL_LOG) writeFileSync(process.env.COREHUB_TG_REAL_LOG, log);
      gateway?.kill('SIGTERM');
      try {
        execFileSync('docker', ['rm', '-f', box], { stdio: 'ignore' });
      } catch {
        // Gone already.
      }
      await new Promise<void>((resolve) => telegram?.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('is a channel the hub starts a gateway for, and the gateway connects with the profile’s token', async () => {
      expect(activeChannels(home)).toEqual(['telegram']);
      expect(readFileSync(path.join(home, '.env'), 'utf8')).toContain(
        `TELEGRAM_BOT_TOKEN=${TOKEN}`,
      );

      // What the hub's supervisor runs for a named profile (`hermes-gateways.ts`).
      gateway = spawn(
        'docker',
        [
          'exec',
          '-e',
          `HERMES_HOME=${root}`,
          '-e',
          'HERMES_KANBAN_DISPATCH_IN_GATEWAY=false',
          '-e',
          'PYTHONUNBUFFERED=1',
          '-w',
          home,
          box,
          HERMES,
          '-p',
          'tgbot',
          'gateway',
          'run',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      gateway.stdout?.on('data', (chunk) => (log += String(chunk)));
      gateway.stderr?.on('data', (chunk) => (log += String(chunk)));

      await vi.waitFor(
        () => {
          const record = readGatewayRecord(home);
          expect(record?.platforms.telegram?.state, log.slice(-3000)).toBe('connected');
        },
        { timeout: Number(process.env.COREHUB_TG_REAL_WAIT ?? 150_000), interval: 1000 },
      );
      expect(calls.some((call) => call.method === 'getMe' && call.token === TOKEN)).toBe(true);
      expect(calls.some((call) => call.method === 'getUpdates')).toBe(true);
      // No call ever went out on another token: the default profile has none.
      expect(calls.every((call) => call.token === TOKEN)).toBe(true);
    }, 200_000);

    it('answers a stranger with a pairing code and keeps the request in the profile', async () => {
      const pending = path.join(home, 'platforms', 'pairing', 'telegram-pending.json');
      await vi.waitFor(
        () => {
          expect(existsSync(pending), log.slice(-3000)).toBe(true);
          const requests = JSON.parse(readFileSync(pending, 'utf8')) as Record<
            string,
            { user_id: string }
          >;
          expect(Object.values(requests).map((entry) => String(entry.user_id))).toEqual([
            String(STRANGER),
          ]);
        },
        { timeout: 60_000, interval: 1000 },
      );
      await vi.waitFor(
        () =>
          expect(
            calls.some(
              (call) => call.method === 'sendMessage' && Number(call.body.chat_id) === STRANGER,
            ),
          ).toBe(true),
        { timeout: 30_000, interval: 500 },
      );
    }, 120_000);

    it('reads the saved settings where the panel wrote them', () => {
      const code = [
        'import json',
        'from gateway.config import load_gateway_config, Platform',
        'from gateway.display_config import resolve_display_setting',
        'from hermes_cli.config import load_config',
        'cfg = load_gateway_config()',
        'tg = cfg.platforms[Platform.TELEGRAM]',
        'print(json.dumps({',
        '  "enabled": tg.enabled,',
        '  "require_mention": tg.extra.get("require_mention"),',
        '  "dm": cfg.get_unauthorized_dm_behavior(Platform.TELEGRAM),',
        '  "show_reasoning": resolve_display_setting(load_config(), "telegram", "show_reasoning"),',
        '}))',
      ].join('\n');
      const out = execFileSync(
        'docker',
        [
          'exec',
          '-e',
          `HERMES_HOME=${home}`,
          '-e',
          `TELEGRAM_BOT_TOKEN=${TOKEN}`,
          '-w',
          '/opt/hermes/src',
          box,
          PYTHON,
          '-c',
          code,
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );
      const last = out.trim().split('\n').pop()!;
      expect(JSON.parse(last)).toEqual({
        enabled: true,
        require_mention: true,
        dm: 'pair',
        show_reasoning: true,
      });
    }, 150_000);
  },
);
