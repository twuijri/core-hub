/**
 * The header over the agent's WhatsApp replies in self-chat (the owner, 2026-09-26), with **the
 * real Hermes** from the image and no network at all — no phone, no WhatsApp account.
 *
 * The phone's session is put where Hermes's bridge leaves it after a QR scan. The hub writes the
 * header with its own code; then, in a container of the image, Hermes's own readers say what a
 * reply would carry: its `.env` loader, its gateway config, its WhatsApp adapter (the prefix it
 * reserves room for, and the environment it starts the bridge with), and the bridge's own
 * `formatOutgoingMessage`, taken from `bridge.js` as the image ships it and run by the image's
 * Node on that environment.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run tests/unit/whatsapp-reply-header.real.test.ts
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultReplyTitle,
  getChannel,
  setWhatsAppMode,
  setWhatsAppReplyTitle,
  writeEnvValue,
} from '../../src/modules/agents/channels.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const PYTHON = '/opt/hermes/.venv/bin/python';
const PHONE = '966500000000';
const HERMES_HEADER = '☤ *Hermes Agent*\n────────────\n';

describe.skipIf(!image)(
  "WhatsApp's reply header, read by the real Hermes (set COREHUB_HERMES_IMAGE)",
  () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-wa-header-real-'));
    const root = path.join(dataDir, 'hermes');
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const box = `corehub-wa-header-real-${process.pid}`;

    /** What a reply "Hello" leaves the bridge as, and what Hermes's adapter reserves room for. */
    const hermesSends = () =>
      JSON.parse(
        execFileSync(
          'docker',
          [
            'exec',
            '-i',
            '-e',
            `HERMES_HOME=${root}`,
            '-w',
            '/opt/hermes/src',
            box,
            PYTHON,
            '-c',
            [
              'import json, subprocess',
              'from hermes_cli.env_loader import load_hermes_dotenv',
              'load_hermes_dotenv()',
              'from gateway.config import load_gateway_config, Platform',
              'from plugins.platforms.whatsapp.adapter import WhatsAppAdapter',
              'wa = load_gateway_config().platforms.get(Platform.WHATSAPP)',
              'adapter = WhatsAppAdapter(wa)',
              'env = adapter._bridge_env()',
              // The bridge's own lines: its prefix, and how a reply is formatted.
              'src = open("scripts/whatsapp-bridge/bridge.js").read()',
              'head = src[src.index("const DEFAULT_REPLY_PREFIX"):src.index("const MAX_MESSAGE_LENGTH")]',
              'fmt = src[src.index("function formatOutgoingMessage"):src.index("function splitLongMessage")]',
              'js = "const WHATSAPP_MODE = process.env.WHATSAPP_MODE || \'self-chat\';\\n" + head + fmt',
              'js += "process.stdout.write(JSON.stringify(formatOutgoingMessage(\'Hello\')))"',
              'node = subprocess.run(["node", "-e", js], env=env, capture_output=True, text=True, check=True)',
              'print(json.dumps({',
              '  "reserved": adapter._effective_reply_prefix(),',
              '  "sent": json.loads(node.stdout),',
              '}))',
            ].join('\n'),
          ],
          { encoding: 'utf8', timeout: 120_000 },
        )
          .trim()
          .split('\n')
          .pop()!,
      ) as { reserved: string; sent: string };

    beforeAll(() => {
      const session = path.join(root, 'platforms', 'whatsapp', 'session');
      mkdirSync(session, { recursive: true });
      // What Hermes's bridge leaves after the phone scanned the code.
      writeFileSync(
        path.join(session, 'creds.json'),
        JSON.stringify({ me: { id: `${PHONE}:3@s.whatsapp.net`, name: 'Me' } }),
      );
      writeFileSync(
        path.join(root, '.env'),
        `WHATSAPP_ENABLED=true\nWHATSAPP_MODE=self-chat\nWHATSAPP_ALLOWED_USERS=${PHONE}\n`,
      );
      for (const dir of [dataDir, root]) chmodSync(dir, 0o777);
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
        '-v',
        `${dataDir}:${dataDir}`,
        '--entrypoint',
        'sleep',
        image!,
        'infinity',
      ]);
    }, 120_000);

    afterAll(() => {
      try {
        execFileSync('docker', ['rm', '-f', box], { stdio: 'ignore' });
      } catch {
        // Gone already.
      }
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('a link made before, with nothing written, still carries Hermes’s own header', () => {
      expect(getChannel(root, 'whatsapp')?.link).toMatchObject({ replyTitle: null });
      expect(hermesSends()).toEqual({
        reserved: HERMES_HEADER,
        sent: `${HERMES_HEADER}Hello`,
      });
    }, 150_000);

    it('the agent’s name, written by the hub, is the header Hermes sends', () => {
      defaultReplyTitle(root, 'سارة');
      expect(getChannel(root, 'whatsapp')?.link).toMatchObject({ replyTitle: 'سارة' });
      expect(hermesSends()).toEqual({
        reserved: '*سارة*\n────────────\n',
        sent: '*سارة*\n────────────\nHello',
      });
    }, 150_000);

    it('a typed title with spaces and quotes survives the .env quoting', () => {
      setWhatsAppReplyTitle(root, 'Office "assistant" #1');
      expect(getChannel(root, 'whatsapp')?.link).toMatchObject({
        replyTitle: 'Office "assistant" #1',
      });
      expect(hermesSends().sent).toBe('*Office "assistant" #1*\n────────────\nHello');
    }, 150_000);

    it('an empty value is no way to drop the header: the bridge sends Hermes’s own', () => {
      // Hermes's adapter reads empty as "no header", but drops the empty variable before starting
      // the bridge, which then falls back to its default — why the hub offers no "no header".
      writeEnvValue(root, 'WHATSAPP_REPLY_PREFIX', '');
      expect(hermesSends()).toEqual({ reserved: '', sent: `${HERMES_HEADER}Hello` });
      expect(getChannel(root, 'whatsapp')?.link).toMatchObject({ replyTitle: null });
    }, 150_000);

    it('in bot mode no reply carries a header, whatever is written', () => {
      setWhatsAppReplyTitle(root, 'سارة');
      setWhatsAppMode(root, 'bot');
      expect(hermesSends()).toEqual({ reserved: '', sent: 'Hello' });
    }, 150_000);
  },
);
