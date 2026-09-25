/**
 * Channel conversations (contract decision §55) against **the real Hermes** from the image:
 * conversations are written into Hermes's own session store with Hermes's own code (`SessionDB`,
 * as its gateway writes a Telegram or WhatsApp chat), `hermes serve` is started by the hub's
 * `HermesDashboard`, and the hub's reader — over the composition root's own source
 * (`hermesChannelSourceOver`) — must see exactly what the mapping expects: the channel ones only,
 * in the right profile, the other party's name and id, the latest message, and the transcript
 * without tool calls. A new message changes Hermes's store, and only then is Hermes asked again.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server exec \
 *     vitest run src/modules/sessions/channel-conversations.real.test.ts
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { capturingLogger } from '../../../tests/unit/helpers.js';
import { HermesDashboard, type DashboardSpawner, type SpawnedProcess } from '../agents/index.js';
import { hermesChannelSourceOver } from '../index.js';
import { ChannelConversations, type ChannelSource } from './channel-conversations.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';
const PYTHON = '/opt/hermes/.venv/bin/python';

/**
 * Written with Hermes's own store code, the way its gateway records a conversation: the row
 * with the channel's identity (`gateway/session_recovery.py` §_session_create_kwargs), then the
 * messages — a tool call and its result in between, as a real turn has.
 */
const SEED = String.raw`
import json, sys, time
from pathlib import Path
from hermes_state import SessionDB
home, which = sys.argv[1], sys.argv[2]
db = SessionDB(db_path=Path(home) / "state.db")
t0 = time.time() - 600
if which == "default":
    db.create_session("20260925_091500_aa11bb22", "telegram", user_id="5550001", chat_id="5550001",
        chat_type="dm", display_name="أحمد",
        origin_json=json.dumps({"platform": "telegram", "chat_id": "5550001", "user_id": "5550001",
                                "user_name": "ahmad_k", "chat_type": "dm"}))
    db.append_message("20260925_091500_aa11bb22", "user", "متى موعد التسليم؟", timestamp=t0)
    db.append_message("20260925_091500_aa11bb22", "assistant", None, timestamp=t0 + 1,
        tool_calls=[{"id": "c1", "type": "function", "function": {"name": "todo", "arguments": "{}"}}])
    db.append_message("20260925_091500_aa11bb22", "tool", '{"ok": true}', tool_call_id="c1",
        tool_name="todo", timestamp=t0 + 2)
    db.append_message("20260925_091500_aa11bb22", "assistant", "يوم **الخميس**.", timestamp=t0 + 3)
    db.create_session("20260925_080000_cc33dd44", "whatsapp", chat_id="966500000000@g.us",
        chat_type="group", display_name="مجموعة العائلة")
    db.append_message("20260925_080000_cc33dd44", "user", "نسافر الساعة كم؟", timestamp=t0 - 100)
    # The hub's own chat runs in Hermes too (the TUI): never a channel conversation.
    db.create_session("20260925_070000_ee55ff66", "tui")
    db.append_message("20260925_070000_ee55ff66", "user", "secret hub chat", timestamp=t0 + 5)
elif which == "designer":
    db.create_session("20260925_120000_99887766", "telegram", user_id="7770002", chat_id="7770002",
        chat_type="dm", display_name="سارة")
    db.append_message("20260925_120000_99887766", "user", "hello from designer", timestamp=t0)
elif which == "more":
    db.append_message("20260925_091500_aa11bb22", "user", "شكرًا!", timestamp=time.time())
db.close()
print("seeded", which)
`;

describe.skipIf(!image)(
  "channel conversations read from Hermes's own store (real Hermes; set COREHUB_HERMES_IMAGE to run)",
  () => {
    const home = mkdtempSync(path.join(tmpdir(), 'corehub-channels-home-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-channels-data-'));
    chmodSync(home, 0o777);
    const containers: string[] = [];

    /** A command in the image against the throwaway home. */
    const inImage = (entrypoint: string, argv: readonly string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          'docker',
          [
            'run',
            '--rm',
            '-v',
            `${home}:/hh`,
            '-e',
            'HERMES_HOME=/hh',
            '--entrypoint',
            entrypoint,
            image!,
            ...argv,
          ],
          { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) =>
            error
              ? reject(new Error(`${String(stderr)}\n${error.message}`))
              : resolve(String(stdout)),
        );
      });
    const seed = (which: string) =>
      inImage(PYTHON, ['-c', SEED, which === 'designer' ? '/hh/profiles/designer' : '/hh', which]);

    const spawnImpl: DashboardSpawner = (_command, args, options) => {
      const name = `corehub-channels-real-${process.pid}-${containers.length}`;
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
          '-v',
          `${home}:/hh`,
          '-e',
          'HERMES_HOME=/hh',
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
      );
      return child as unknown as SpawnedProcess;
    };

    const dashboard = new HermesDashboard({
      host: {
        status: () => ({ mode: 'managed', home }),
        executable: () => HERMES,
        cliEnv: () => ({}),
      },
      dataDir,
      log: capturingLogger().logger,
      spawnImpl,
      startTimeoutMs: 180_000,
    });

    // The composition root's source; a workspace is named after its Hermes profile here.
    const real = hermesChannelSourceOver(dashboard, home, (workspace) => workspace);
    const asked: string[] = [];
    const source: ChannelSource = {
      hermesProfile: (workspace) => real.hermesProfile(workspace),
      stamp: (profile) => real.stamp(profile),
      get: <T>(apiPath: string) => {
        asked.push(apiPath);
        return real.get<T>(apiPath);
      },
    };
    let now = Date.now();
    const reader = new ChannelConversations(() => source, { now: () => now });
    const scopes = [
      { workspace: 'default', profile: 'default' },
      { workspace: 'designer', profile: 'designer' },
      { workspace: 'nobody', profile: 'nobody' },
    ];

    afterAll(async () => {
      await dashboard.close();
      for (const name of containers) {
        try {
          execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
        } catch {
          // Already gone with --rm.
        }
      }
      // Files the container's user wrote: removed from inside, then the folders.
      try {
        execFileSync('docker', [
          'run',
          '--rm',
          '-v',
          `${home}:/hh`,
          '--entrypoint',
          '/bin/sh',
          image!,
          '-c',
          'rm -rf /hh/* /hh/.[!.]* 2>/dev/null; true',
        ]);
      } catch {
        // Best effort.
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('lists the channel conversations of each profile as the mapping expects', async () => {
      await inImage(HERMES, ['profile', 'create', 'designer', '--no-alias']);
      await seed('default');
      await seed('designer');

      const { items, unavailable } = await reader.list(scopes);
      expect(unavailable).toEqual([
        { profile: 'nobody', reason: 'profile_not_in_hermes', message: null },
      ]);
      expect(items.map((c) => [c.profile, c.id])).toEqual([
        ['default', '20260925_091500_aa11bb22'],
        ['designer', '20260925_120000_99887766'],
        ['default', '20260925_080000_cc33dd44'],
      ]);
      const telegram = items.find((c) => c.id === '20260925_091500_aa11bb22');
      expect(telegram).toMatchObject({
        channel: 'telegram',
        peer_name: 'أحمد',
        peer_id: '5550001',
        chat_type: 'dm',
        preview: 'متى موعد التسليم؟',
        last_message: { role: 'assistant', text: 'يوم **الخميس**.' },
      });
      expect(telegram?.message_count).toBeGreaterThanOrEqual(2);
      // Hermes's `last_active` is its latest message's time (the seed dates them before the row).
      expect(Math.abs(Date.parse(telegram!.last_message_at) - (Date.now() - 597_000))).toBeLessThan(
        120_000,
      );
      expect(items.find((c) => c.channel === 'whatsapp')).toMatchObject({
        peer_name: 'مجموعة العائلة',
        peer_id: '966500000000@g.us',
        chat_type: 'group',
        last_message: { role: 'user', text: 'نسافر الساعة كم؟' },
      });
      // The hub's own TUI chat was neither listed nor read.
      expect(items.some((c) => c.id === '20260925_070000_ee55ff66')).toBe(false);
      expect(asked.some((p) => p.includes('ee55ff66'))).toBe(false);
    }, 300_000);

    it('opens one conversation without its tool calls, and refuses the hub chat', async () => {
      const opened = await reader.messages(
        { workspace: 'default', profile: 'default' },
        '20260925_091500_aa11bb22',
      );
      expect(opened.items.map((m) => [m.role, m.text])).toEqual([
        ['user', 'متى موعد التسليم؟'],
        ['assistant', 'يوم **الخميس**.'],
      ]);
      expect(opened.has_more).toBe(false);
      await expect(
        reader.messages({ workspace: 'default', profile: 'default' }, '20260925_070000_ee55ff66'),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        reader.messages({ workspace: 'designer', profile: 'designer' }, '20260925_091500_aa11bb22'),
      ).rejects.toMatchObject({ code: 'not_found' });
    }, 120_000);

    it('asks Hermes again only once its store was written', async () => {
      const lists = () => asked.filter((p) => p.startsWith('/api/sessions?')).length;
      now += 10_000;
      const before = lists();
      await reader.list(scopes.slice(0, 1));
      expect(lists()).toBe(before); // nothing written since: what was read stands

      await seed('more');
      now += 10_000;
      const after = await reader.list(scopes.slice(0, 1));
      expect(lists()).toBe(before + 1);
      expect(after.items.find((c) => c.id === '20260925_091500_aa11bb22')?.last_message).toEqual({
        role: 'user',
        text: 'شكرًا!',
      });
    }, 120_000);
  },
);
