/**
 * The MCP test and the WhatsApp pairing, against a scripted Hermes API: what is asked of
 * Hermes (the path, the profile, the timeout), and how each of Hermes's answers reads to the
 * person — Hermes's own words where it gave some, the hub's where Hermes was silent.
 */
import { describe, expect, it } from 'vitest';
import { HubError } from '../../lib/errors.js';
import type { JobHandle } from '../audit/index.js';
import { HermesDashboardRefusal, HermesDashboardUnavailable } from './hermes-dashboard.js';
import { pairWhatsApp, testMcpServer, type HermesApiCall } from './hermes-tools.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
  timeoutMs: number | undefined;
}

/** A Hermes that answers from a script, keyed by `METHOD path-without-query`. */
function scripted(answers: Record<string, Array<unknown | Error>>) {
  const calls: Call[] = [];
  const api: HermesApiCall = async <T>(
    method: string,
    route: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> => {
    calls.push({ method, path: route, body, timeoutMs: options?.timeoutMs });
    const key = `${method} ${route.split('?')[0]}`;
    const queue = answers[key];
    if (!queue || queue.length === 0) throw new Error(`unscripted call: ${key}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next as T;
  };
  return { api, calls };
}

function fakeHandle(cancelAfter = Infinity) {
  const progress: Array<{ percent: number | null; message: string | null; result: unknown }> = [];
  let asked = 0;
  const handle: JobHandle = {
    id: 'job',
    progress: (percent, message, result) => progress.push({ percent, message, result }),
    cancelRequested: () => ++asked > cancelAfter,
  };
  return { handle, progress };
}

const noSleep = () => Promise.resolve();

describe('testing an MCP server through Hermes', () => {
  it("asks Hermes in the profile, waits Hermes's timeout plus a margin, and relays the tools", async () => {
    const { api, calls } = scripted({
      'POST /api/mcp/servers/git%20hub/test': [
        {
          ok: true,
          tools: [
            { name: 'search_issues', description: 'Search issues', schema_chars: 120 },
            { name: 'bare', description: '' },
          ],
          prompts: 0,
        },
      ],
    });
    const result = await testMcpServer(api, {
      profile: 'work',
      name: 'git hub',
      config: { command: 'npx', connect_timeout: 12 },
      language: 'en',
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/mcp/servers/git%20hub/test?profile=work',
        body: undefined,
        timeoutMs: 27_000,
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      error: null,
      tools: [
        { name: 'search_issues', description: 'Search issues' },
        { name: 'bare', description: null },
      ],
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("keeps Hermes's words for a failed connection", async () => {
    const { api } = scripted({
      'POST /api/mcp/servers/x/test': [
        { ok: false, error: "[Errno 2] No such file or directory: 'nope'", tools: [] },
      ],
    });
    const result = await testMcpServer(api, {
      profile: 'default',
      name: 'x',
      config: {},
      language: 'en',
    });
    expect(result).toMatchObject({
      ok: false,
      tools: [],
      error: "[Errno 2] No such file or directory: 'nope'",
    });
  });

  it('names the silence when Hermes gives an empty reason (the server never answered)', async () => {
    const { api } = scripted({
      'POST /api/mcp/servers/x/test': [{ ok: false, error: '', tools: [] }],
    });
    const en = await testMcpServer(api, {
      profile: 'default',
      name: 'x',
      config: {},
      language: 'en',
    });
    expect(en.error).toBe('The server did not answer within 30 s (its connect_timeout).');
    const ar = await testMcpServer(api, {
      profile: 'default',
      name: 'x',
      config: { connect_timeout: 5 },
      language: 'ar',
    });
    expect(ar.error).toBe('لم يردّ الخادم خلال 5 ثانية (مهلة connect_timeout).');
  });

  it('answers ok:false in its own words when Hermes itself does not answer in time', async () => {
    const { api } = scripted({
      'POST /api/mcp/servers/x/test': [
        new HermesDashboardUnavailable(
          'did not answer: The operation was aborted due to timeout',
          true,
        ),
      ],
    });
    const result = await testMcpServer(api, {
      profile: 'default',
      name: 'x',
      config: {},
      language: 'en',
    });
    expect(result).toMatchObject({ ok: false, error: 'Hermes did not report back within 45 s.' });
  });

  it("turns Hermes's refusal and a missing Hermes into the hub's errors", async () => {
    const refused = scripted({
      'POST /api/mcp/servers/x/test': [
        new HermesDashboardRefusal(
          'POST /api/mcp/servers/x/test',
          404,
          "Profile 'nope' does not exist.",
        ),
      ],
    });
    const error = await testMcpServer(refused.api, {
      profile: 'nope',
      name: 'x',
      config: {},
      language: 'en',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HubError);
    expect(error).toMatchObject({
      code: 'conflict',
      details: { reason: 'hermes_refused', message: "Profile 'nope' does not exist." },
    });

    const gone = scripted({
      'POST /api/mcp/servers/x/test': [new HermesDashboardUnavailable('did not become ready')],
    });
    await expect(
      testMcpServer(gone.api, { profile: 'default', name: 'x', config: {}, language: 'en' }),
    ).rejects.toMatchObject({
      code: 'service_unavailable',
      details: { reason: 'hermes_api_unavailable' },
    });
  });
});

describe('pairing WhatsApp through Hermes', () => {
  const start = {
    pairing_id: 'p1',
    status: 'installing',
    qr_payload: null,
    expires_at: '2099-01-01T00:00:00Z',
  };

  it('publishes each new code, enables the channel in the profile, and forgets the pairing', async () => {
    const { api, calls } = scripted({
      'POST /api/messaging/whatsapp/onboarding/start': [start],
      'GET /api/messaging/whatsapp/onboarding/p1': [
        { ...start, status: 'waiting', qr_payload: 'QR-ONE' },
        { ...start, status: 'waiting', qr_payload: 'QR-ONE' },
        { ...start, status: 'waiting', qr_payload: 'QR-TWO' },
        { ...start, status: 'connected', account_name: 'Office', account_phone: '966500000000' },
      ],
      'PUT /api/messaging/platforms/whatsapp': [{ ok: true }],
      'DELETE /api/messaging/whatsapp/onboarding/p1': [{ ok: true }],
    });
    const { handle, progress } = fakeHandle();
    const outcome = await pairWhatsApp(api, handle, {
      profile: 'work',
      language: 'en',
      sleep: noSleep,
    });

    expect(outcome).toEqual({
      status: 'connected',
      account_name: 'Office',
      account_phone: '966500000000',
      mode: 'bot',
    });
    expect(calls[0]).toMatchObject({ body: { mode: 'bot', profile: 'work' } });
    // One progress per change, not per question: installing, QR-ONE, QR-TWO, saving, done.
    expect(
      progress.map((step) => (step.result as { qr?: unknown } | undefined)?.qr ?? null),
    ).toEqual([null, 'QR-ONE', 'QR-TWO', null, null]);
    expect(progress[1]).toMatchObject({
      percent: null,
      message: expect.stringContaining('Linked devices'),
      result: { status: 'waiting', qr: 'QR-ONE', expires_at: '2099-01-01T00:00:00Z' },
    });
    const enable = calls.find((call) => call.method === 'PUT')!;
    expect(enable.path).toBe('/api/messaging/platforms/whatsapp?profile=work');
    expect(enable.body).toEqual({
      enabled: true,
      env: { WHATSAPP_ENABLED: 'true', WHATSAPP_MODE: 'bot', WHATSAPP_DM_POLICY: 'pairing' },
      profile: 'work',
    });
    // Never Hermes's `apply`: that restarts the gateway this hub supervises.
    expect(calls.some((call) => call.path.includes('/apply'))).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('links a personal number in self-chat mode, with the owner on the allowlist', async () => {
    const { api, calls } = scripted({
      'POST /api/messaging/whatsapp/onboarding/start': [
        { ...start, status: 'connected', account_name: 'Me', account_phone: '966511111111' },
      ],
      'PUT /api/messaging/platforms/whatsapp': [{ ok: true }],
      'DELETE /api/messaging/whatsapp/onboarding/p1': [{ ok: true }],
    });
    const outcome = await pairWhatsApp(api, fakeHandle().handle, {
      profile: 'default',
      language: 'ar',
      sleep: noSleep,
      mode: 'self-chat',
      allowedUsers: '966522222222',
    });
    expect(outcome).toMatchObject({ status: 'connected', mode: 'self-chat' });
    expect(calls[0]).toMatchObject({ body: { mode: 'self-chat', profile: 'default' } });
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
      enabled: true,
      env: {
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_MODE: 'self-chat',
        WHATSAPP_DM_POLICY: 'pairing',
        // Whoever was allowed stays; the owner is added so Hermes does not pair them.
        WHATSAPP_ALLOWED_USERS: '966522222222,966511111111',
      },
      profile: 'default',
    });
  });

  it("fails in Hermes's words when the pairing fails, and when the code expires", async () => {
    const failed = scripted({
      'POST /api/messaging/whatsapp/onboarding/start': [start],
      'GET /api/messaging/whatsapp/onboarding/p1': [
        {
          ...start,
          status: 'error',
          error: 'npm was not found. WhatsApp setup needs Node.js and npm.',
        },
      ],
      'DELETE /api/messaging/whatsapp/onboarding/p1': [{ ok: true }],
    });
    await expect(
      pairWhatsApp(failed.api, fakeHandle().handle, {
        profile: 'default',
        language: 'en',
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({
      code: 'agent_error',
      message: 'npm was not found. WhatsApp setup needs Node.js and npm.',
    });

    const expired = scripted({
      'POST /api/messaging/whatsapp/onboarding/start': [start],
      'GET /api/messaging/whatsapp/onboarding/p1': [
        new HermesDashboardRefusal('GET', 410, 'WhatsApp QR setup expired. Start a new setup.'),
      ],
    });
    await expect(
      pairWhatsApp(expired.api, fakeHandle().handle, {
        profile: 'default',
        language: 'en',
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({
      code: 'state_invalid',
      message: 'WhatsApp QR setup expired. Start a new setup.',
    });
  });

  it('stops asking once the hub is past Hermes’s own expiry, and says the code expired', async () => {
    const stale = {
      ...start,
      status: 'waiting',
      qr_payload: 'Q',
      expires_at: '2026-01-01T00:00:00Z',
    };
    const { api } = scripted({
      'POST /api/messaging/whatsapp/onboarding/start': [stale],
      'DELETE /api/messaging/whatsapp/onboarding/p1': [{ ok: true }],
    });
    await expect(
      pairWhatsApp(api, fakeHandle().handle, {
        profile: 'default',
        language: 'ar',
        sleep: noSleep,
        now: () => Date.parse('2026-01-01T00:05:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'state_invalid' });
  });

  it('forgets the pairing in Hermes when the job is cancelled', async () => {
    const { api, calls } = scripted({
      'POST /api/messaging/whatsapp/onboarding/start': [start],
      'GET /api/messaging/whatsapp/onboarding/p1': [
        { ...start, status: 'waiting', qr_payload: 'Q' },
      ],
      'DELETE /api/messaging/whatsapp/onboarding/p1': [{ ok: true }],
    });
    const outcome = await pairWhatsApp(api, fakeHandle(2).handle, {
      profile: 'default',
      language: 'en',
      sleep: noSleep,
    });
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/api/messaging/whatsapp/onboarding/p1',
    });
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('a phone already linked in this profile skips straight to enabling the channel', async () => {
    const { api, calls } = scripted({
      'POST /api/messaging/whatsapp/onboarding/start': [
        { ...start, status: 'connected', account_name: 'Office' },
      ],
      'PUT /api/messaging/platforms/whatsapp': [{ ok: true }],
      'DELETE /api/messaging/whatsapp/onboarding/p1': [{ ok: true }],
    });
    const outcome = await pairWhatsApp(api, fakeHandle().handle, {
      profile: 'default',
      language: 'en',
      sleep: noSleep,
    });
    expect(outcome).toMatchObject({ status: 'connected', account_name: 'Office' });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });
});
