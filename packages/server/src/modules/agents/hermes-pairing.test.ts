/**
 * Pairing approvals in a profile (`hermes-pairing.ts`) against a scripted Hermes API: the
 * list as Hermes answers it, approve and revoke in Hermes's words, and Deny, which is the
 * hub's own edit of Hermes's pending file because Hermes has no verb for one request.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HubError } from '../../lib/errors.js';
import { HermesDashboardRefusal } from './hermes-dashboard.js';
import {
  approvePairing,
  denyPairing,
  listPairing,
  pairingDir,
  revokePairing,
} from './hermes-pairing.js';
import type { HermesApiCall } from './hermes-tools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'majlis-pairing-'));
  dirs.push(dir);
  return dir;
}

function scripted(answers: (method: string, route: string, body: unknown) => unknown) {
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  const api: HermesApiCall = async <T>(method: string, route: string, body?: unknown) => {
    calls.push({ method, route, body });
    const answer = answers(method, route, body);
    if (answer instanceof Error) throw answer;
    return answer as T;
  };
  return { api, calls };
}

describe('the list', () => {
  it("is Hermes's, in the profile asked for, newest request first, codes never shown", async () => {
    const { api, calls } = scripted(() => ({
      pending: [
        {
          platform: 'whatsapp',
          request_id: 'aaaaaaaaaaaaaaaa',
          user_id: '1@s.whatsapp.net',
          user_name: 'Old',
          age_minutes: 40,
        },
        {
          platform: 'whatsapp',
          request_id: 'bbbbbbbbbbbbbbbb',
          user_id: '2@s.whatsapp.net',
          user_name: '',
          age_minutes: 2,
        },
        // A request from before Hermes hashed its codes cannot be approved by id.
        { platform: 'whatsapp', request_id: '', user_id: '3@s.whatsapp.net', age_minutes: 1 },
      ],
      approved: [
        {
          platform: 'whatsapp',
          user_id: '9@s.whatsapp.net',
          user_name: 'Khalid',
          approved_at: 1_790_000_000,
        },
      ],
    }));
    const now = Date.parse('2026-09-24T12:00:00Z');
    const list = await listPairing(api, 'manger', () => now);
    expect(calls[0]).toMatchObject({ method: 'GET', route: '/api/pairing?profile=manger' });
    expect(list.pending).toEqual([
      {
        platform: 'whatsapp',
        request_id: 'bbbbbbbbbbbbbbbb',
        user_id: '2@s.whatsapp.net',
        user_name: null,
        requested_at: '2026-09-24T11:58:00.000Z',
      },
      {
        platform: 'whatsapp',
        request_id: 'aaaaaaaaaaaaaaaa',
        user_id: '1@s.whatsapp.net',
        user_name: 'Old',
        requested_at: '2026-09-24T11:20:00.000Z',
      },
    ]);
    expect(list.approved).toEqual([
      {
        platform: 'whatsapp',
        user_id: '9@s.whatsapp.net',
        user_name: 'Khalid',
        approved_at: new Date(1_790_000_000_000).toISOString(),
      },
    ]);
  });

  it('says Hermes is not there rather than an empty list', async () => {
    const { api } = scripted(() => new HermesDashboardRefusal('GET', 500, 'boom'));
    await expect(listPairing(api, 'default')).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('approve and revoke', () => {
  it('ask Hermes in the profile, and a request Hermes no longer has is 404', async () => {
    const { api, calls } = scripted((_method, route, body) => {
      const { request_id: id, user_id: user } = body as { request_id?: string; user_id?: string };
      if (route.endsWith('/approve')) {
        return id === 'bbbbbbbbbbbbbbbb'
          ? { ok: true, user: { user_id: '2@s.whatsapp.net', user_name: 'Sara' } }
          : new HermesDashboardRefusal('POST', 404, 'Pairing request or code not found or expired');
      }
      return user === '2@s.whatsapp.net'
        ? { ok: true }
        : new HermesDashboardRefusal('POST', 404, 'not found');
    });
    const approved = await approvePairing(api, {
      profile: 'manger',
      platform: 'whatsapp',
      requestId: 'bbbbbbbbbbbbbbbb',
    });
    expect(approved).toMatchObject({
      platform: 'whatsapp',
      user_id: '2@s.whatsapp.net',
      user_name: 'Sara',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      route: '/api/pairing/approve',
      body: { platform: 'whatsapp', request_id: 'bbbbbbbbbbbbbbbb', profile: 'manger' },
    });
    await expect(
      approvePairing(api, {
        profile: 'manger',
        platform: 'whatsapp',
        requestId: 'cccccccccccccccc',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await revokePairing(api, {
      profile: 'manger',
      platform: 'whatsapp',
      userId: '2@s.whatsapp.net',
    });
    expect(calls.at(-1)).toMatchObject({
      route: '/api/pairing/revoke',
      body: { platform: 'whatsapp', user_id: '2@s.whatsapp.net', profile: 'manger' },
    });
    await expect(
      revokePairing(api, { profile: 'manger', platform: 'whatsapp', userId: 'nobody' }),
    ).rejects.toBeInstanceOf(HubError);
  });
});

describe('deny', () => {
  it("removes that one request from Hermes's pending file and nothing else", () => {
    const dir = home();
    const folder = pairingDir(dir);
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'whatsapp-pending.json');
    writeFileSync(
      file,
      JSON.stringify({
        aaaaaaaaaaaaaaaa: { hash: 'h1', salt: 's1', user_id: '1', created_at: 1 },
        bbbbbbbbbbbbbbbb: { hash: 'h2', salt: 's2', user_id: '2', created_at: 2 },
      }),
    );
    denyPairing(dir, 'whatsapp', 'AAAAAAAAAAAAAAAA');
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['bbbbbbbbbbbbbbbb']);
    expect(() => denyPairing(dir, 'whatsapp', 'aaaaaaaaaaaaaaaa')).toThrow(HubError);
    expect(() => denyPairing(dir, 'telegram', 'bbbbbbbbbbbbbbbb')).toThrow(HubError);
    expect(() => denyPairing(dir, '../x', 'bbbbbbbbbbbbbbbb')).toThrow(HubError);
  });

  it('uses the older pairing folder while it still holds anything', () => {
    const dir = home();
    mkdirSync(path.join(dir, 'pairing'), { recursive: true });
    writeFileSync(path.join(dir, 'pairing', 'whatsapp-approved.json'), '{}');
    expect(pairingDir(dir)).toBe(path.join(dir, 'pairing'));
    expect(pairingDir(home())).toMatch(/platforms\/pairing$/);
  });
});
