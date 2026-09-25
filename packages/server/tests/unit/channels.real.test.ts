/**
 * Discord, Slack and Mattermost in a named profile, with **the real Hermes** from the image and no
 * network at all.
 *
 * The profile «desk» is made by Hermes; the hub's own code links the three platforms there (the
 * credentials into the profile's `.env`, each channel on, pairing on where Hermes pairs) and saves
 * settings from the panels. Then:
 *
 * 1. Hermes's own config loader, in the container, reads every value where the hub wrote it —
 *    Discord's mentions, threads, allowed channels and home channel; Slack's pairing for strangers
 *    and flat replies; the per-platform display settings;
 * 2. the gateway the hub would start for the profile, `hermes -p desk gateway run`, starts the
 *    Discord and Slack adapters from the image's own libraries — nothing is installed (there is no
 *    network to install from) — and reports each platform in its state file.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run tests/unit/channels.real.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activeChannels } from '../../src/modules/agents/channels.js';
import { linkCredentials, platformSpec } from '../../src/modules/agents/channel-platforms.js';
import { writeChannelSettings } from '../../src/modules/agents/channel-settings.js';
import { readGatewayRecord } from '../../src/modules/agents/hermes-gateways.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const HERMES = '/opt/hermes/.venv/bin/hermes';
const PYTHON = '/opt/hermes/.venv/bin/python';
const DISCORD = 'fake-discord-token-for-tests-only-0000000000000000000000000000001';

describe.skipIf(!image)('Discord, Slack and Mattermost in a named profile (real Hermes)', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-channels-real-'));
  const root = path.join(dataDir, 'hermes');
  const home = path.join(root, 'profiles', 'desk');
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const box = `corehub-channels-real-${process.pid}`;
  let gateway: ChildProcess | null = null;
  let log = '';

  beforeAll(() => {
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
      'none',
      '--user',
      user,
      '-e',
      'HOME=/tmp',
      '-e',
      `HERMES_LAZY_INSTALL_TARGET=${path.join(dataDir, 'hermes-packages')}`,
      '-v',
      `${dataDir}:${dataDir}`,
      '--entrypoint',
      'sleep',
      image!,
      'infinity',
    ]);
    execFileSync(
      'docker',
      ['exec', '-e', `HERMES_HOME=${root}`, box, HERMES, 'profile', 'create', 'desk', '--no-alias'],
      { encoding: 'utf8', timeout: 180_000 },
    );

    const identity = { id: '1', name: 'Desk', username: 'desk' };
    linkCredentials(home, platformSpec('discord')!, {
      values: { DISCORD_BOT_TOKEN: DISCORD },
      allowedUsers: ['111222333444555666'],
      identity,
    });
    linkCredentials(home, platformSpec('slack')!, {
      values: {
        SLACK_BOT_TOKEN: 'xoxb-fake-test-token-0001',
        SLACK_APP_TOKEN: 'xapp-fake-test-token-0001',
      },
      identity,
    });
    linkCredentials(home, platformSpec('mattermost')!, {
      values: {
        MATTERMOST_URL: 'https://mm.example.org',
        MATTERMOST_TOKEN: 'k9d8s7a6f5g4h3j2k1l0qwerty',
      },
      identity,
    });
    writeChannelSettings(home, 'discord', platformSpec('discord')!.settings!, {
      require_mention: false,
      auto_thread: false,
      allowed_channels: ['1111', '2222'],
      home_channel: '3333',
      show_reasoning: true,
    });
    writeChannelSettings(home, 'slack', platformSpec('slack')!.settings!, {
      reply_in_thread: false,
      require_mention: false,
    });
    writeChannelSettings(home, 'mattermost', platformSpec('mattermost')!.settings!, {
      reply_mode: 'thread',
    });
  }, 240_000);

  afterAll(() => {
    gateway?.kill('SIGTERM');
    try {
      execFileSync('docker', ['rm', '-f', box], { stdio: 'ignore' });
    } catch {
      // Gone already.
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is what Hermes’s own loader reads', () => {
    expect(activeChannels(home).sort()).toEqual(['discord', 'mattermost', 'slack']);
    const code = [
      'import json',
      'from gateway.config import load_gateway_config, Platform',
      'from gateway.display_config import resolve_display_setting',
      'from hermes_cli.config import load_config',
      'cfg = load_gateway_config()',
      'd = cfg.platforms[Platform.DISCORD]',
      's = cfg.platforms[Platform.SLACK]',
      'm = cfg.platforms[Platform.MATTERMOST]',
      'print(json.dumps({',
      '  "discord": [d.enabled, d.token == ' +
        JSON.stringify(DISCORD) +
        ', d.extra.get("require_mention"), d.extra.get("auto_thread"), d.extra.get("allowed_channels"), d.home_channel.chat_id if d.home_channel else None],',
      '  "slack": [s.enabled, s.extra.get("reply_in_thread"), s.extra.get("require_mention")],',
      '  "slack_dm": cfg.get_unauthorized_dm_behavior(Platform.SLACK),',
      '  "mattermost": [m.enabled, m.extra.get("url"), m.extra.get("reply_mode")],',
      '  "show_reasoning": resolve_display_setting(load_config(), "discord", "show_reasoning"),',
      '}))',
    ].join('\n');
    const out = execFileSync(
      'docker',
      [
        'exec',
        '--env-file',
        path.join(home, '.env'),
        '-e',
        `HERMES_HOME=${home}`,
        '-w',
        '/opt/hermes/src',
        box,
        PYTHON,
        '-c',
        code,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({
      // Discord's own YAML bridge hands the adapter its lists as comma-separated text.
      discord: [true, true, false, false, '1111,2222', '3333'],
      slack: [true, false, false],
      slack_dm: 'pair',
      mattermost: [true, 'https://mm.example.org', 'thread'],
      show_reasoning: true,
    });
  }, 150_000);

  it('runs Discord and Slack from the image’s own libraries, installing nothing', async () => {
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
        'desk',
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
        expect(Object.keys(record?.platforms ?? {}).sort(), log.slice(-3000)).toEqual(
          expect.arrayContaining(['discord', 'slack']),
        );
      },
      { timeout: 120_000, interval: 1000 },
    );
    // What the gateway says of each platform (no network: they cannot connect, and say why).
    const record = readGatewayRecord(home)!;
    console.log(
      Object.entries(record.platforms)
        .map(([name, entry]) => `${name}: ${entry.state} ${entry.errorMessage ?? ''}`)
        .join('\n'),
    );
    if (process.env.COREHUB_CHANNELS_REAL_LOG) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.COREHUB_CHANNELS_REAL_LOG, log);
    }
    expect(log).not.toMatch(/requirements not met|FeatureUnavailable|pip install|lazy.install/i);
  }, 150_000);
});
