/**
 * WhatsApp's mode (the owner's report of 2026-09-26), with **the real Hermes** from the image and
 * no network at all — no phone, no WhatsApp account, no bridge talking to WhatsApp.
 *
 * The phone's session is put where Hermes's bridge leaves it after a QR scan (the only part played
 * here). Then, in a container of the image:
 *
 * 1. The hub pairs in «أنا (مراسلة نفسي)» mode: its write goes to **Hermes's own**
 *    `PUT /api/messaging/platforms/whatsapp` (the router, served in-process with FastAPI's test
 *    client), which accepts every variable the hub sends and stores them in the profile's `.env`.
 * 2. Hermes's own readers take it from there: its `.env` loader, its gateway config, and its
 *    WhatsApp adapter, whose bridge environment says `self-chat` (the bridge then drops every
 *    message but the owner's "Message yourself"); the account owner is on the allowlist Hermes's
 *    gateway authorizes against, and a stranger is not.
 * 3. «تغيير الوضع» back to «بوت» through the hub's code: Hermes reads `bot`, and replies lose the
 *    self-chat signature.
 *
 * Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=core-hub:local pnpm --filter @corehub/server exec \
 *     vitest run tests/unit/whatsapp-mode.real.test.ts
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobHandle } from '../../src/modules/audit/index.js';
import { getChannel, readEnv, setWhatsAppMode } from '../../src/modules/agents/channels.js';
import { HermesDashboardRefusal } from '../../src/modules/agents/hermes-dashboard.js';
import { pairWhatsApp, type HermesApiCall } from '../../src/modules/agents/hermes-tools.js';

const image = process.env.COREHUB_HERMES_IMAGE;
const PYTHON = '/opt/hermes/.venv/bin/python';
const PHONE = '966500000000';

describe.skipIf(!image)(
  "WhatsApp's mode, read by the real Hermes (set COREHUB_HERMES_IMAGE)",
  () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-wa-mode-real-'));
    const root = path.join(dataDir, 'hermes');
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const box = `corehub-wa-mode-real-${process.pid}`;

    /** Python in the container, in Hermes's source tree, with the default profile's home. */
    const python = (code: string, input?: string) =>
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
          code,
        ],
        { encoding: 'utf8', timeout: 120_000, ...(input === undefined ? {} : { input }) },
      )
        .trim()
        .split('\n')
        .pop()!;

    /** What Hermes's gateway makes of the profile, through Hermes's own readers. */
    const hermesReads = () =>
      JSON.parse(
        python(
          [
            'import json',
            'from hermes_cli.env_loader import load_hermes_dotenv',
            'load_hermes_dotenv()',
            'from gateway.config import load_gateway_config, Platform',
            'from gateway.session import SessionSource',
            'from gateway.authz_mixin import _principal_matches_allowlist',
            'from plugins.platforms.whatsapp.adapter import WhatsAppAdapter',
            'cfg = load_gateway_config()',
            'wa = cfg.platforms.get(Platform.WHATSAPP)',
            'adapter = WhatsAppAdapter(wa)',
            'env = adapter._bridge_env()',
            `owner = "${PHONE}@s.whatsapp.net"`,
            'stranger = "966511111111@s.whatsapp.net"',
            'allowed = {x for x in env.get("WHATSAPP_ALLOWED_USERS", "").split(",") if x}',
            'src = SessionSource(platform=Platform.WHATSAPP, chat_id=owner, user_id=owner)',
            'print(json.dumps({',
            '  "enabled": bool(wa and wa.enabled),',
            '  "mode": env.get("WHATSAPP_MODE"),',
            '  "dm_policy": env.get("WHATSAPP_DM_POLICY"),',
            '  "owner_allowed": _principal_matches_allowlist(src, owner, allowed),',
            '  "stranger_allowed": _principal_matches_allowlist(src, stranger, allowed),',
            '  "signed": adapter._effective_reply_prefix() != "",',
            '}))',
          ].join('\n'),
        ),
      ) as Record<string, unknown>;

    beforeAll(() => {
      const session = path.join(root, 'platforms', 'whatsapp', 'session');
      mkdirSync(session, { recursive: true });
      // What Hermes's bridge leaves after the phone scanned the code.
      writeFileSync(
        path.join(session, 'creds.json'),
        JSON.stringify({ me: { id: `${PHONE}:3@s.whatsapp.net`, name: 'Me' } }),
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

    it('the self-chat pairing write is one Hermes’s own API accepts and stores', async () => {
      // Hermes's pairing, up to the scan, is scripted; the write that follows is Hermes's.
      const api: HermesApiCall = async <T>(method: string, route: string, body?: unknown) => {
        if (route.endsWith('/onboarding/start')) {
          return {
            pairing_id: 'p1',
            status: 'connected',
            account_name: 'Me',
            account_phone: PHONE,
            expires_at: null,
          } as T;
        }
        if (method === 'DELETE') return { ok: true } as T;
        const answer = JSON.parse(
          python(
            [
              'import json, sys',
              'from fastapi import FastAPI',
              'from fastapi.testclient import TestClient',
              'from hermes_cli.web_routers.messaging import router',
              'app = FastAPI()',
              'app.include_router(router)',
              'req = json.load(sys.stdin)',
              'r = TestClient(app).request(req["method"], req["route"], json=req["body"])',
              'print(json.dumps({"status": r.status_code, "body": r.json()}))',
            ].join('\n'),
            JSON.stringify({ method, route, body }),
          ),
        ) as { status: number; body: { detail?: string } };
        if (answer.status >= 400) {
          throw new HermesDashboardRefusal(method, answer.status, String(answer.body.detail));
        }
        return answer.body as T;
      };
      const handle: JobHandle = {
        id: 'job',
        progress: () => undefined,
        cancelRequested: () => false,
      };
      const outcome = await pairWhatsApp(api, handle, {
        profile: 'default',
        language: 'en',
        mode: 'self-chat',
        sleep: () => Promise.resolve(),
      });
      expect(outcome).toMatchObject({ status: 'connected', mode: 'self-chat' });
      expect(readEnv(root)).toMatchObject({
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_MODE: 'self-chat',
        WHATSAPP_DM_POLICY: 'pairing',
        WHATSAPP_ALLOWED_USERS: PHONE,
      });
      expect(getChannel(root, 'whatsapp')).toMatchObject({
        enabled: true,
        configured: true,
        link: { linked: true, mode: 'self-chat', accountPhone: PHONE },
      });
    }, 150_000);

    it('Hermes’s gateway reads self-chat: the owner is allowed, a stranger is not', () => {
      expect(hermesReads()).toEqual({
        enabled: true,
        mode: 'self-chat',
        dm_policy: 'pairing',
        owner_allowed: true,
        stranger_allowed: false,
        // In self-chat the agent signs its replies, so the owner can tell them from their own.
        signed: true,
      });
    }, 150_000);

    it('changed back to bot through the hub, Hermes reads bot', () => {
      setWhatsAppMode(root, 'bot');
      expect(hermesReads()).toMatchObject({ enabled: true, mode: 'bot', signed: false });
    }, 150_000);
  },
);
