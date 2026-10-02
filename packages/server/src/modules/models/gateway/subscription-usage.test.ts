/**
 * "Check now" against the vendors' recorded answer shapes (the owner's first real sign-in,
 * 2026-10-01: Google Antigravity answered 403 "You do not have a valid license of this product",
 * and the dialog showed Google's raw JSON).
 *
 * - The requests are the ones CLIProxyAPI's management console makes (CPAMC, verified against
 *   its source): Antigravity's quota summary on the daily, sandbox and production hosts with the
 *   account's project and Antigravity's client name, then the per-model quota of
 *   `fetchAvailableModels`; ChatGPT's `wham/usage`; Claude's `api/oauth/usage`; xAI's weekly
 *   credits, then its monthly bill; Kimi's `coding/v1/usages`.
 * - Each answer shape as the vendors send it becomes usage windows with what is left and when it
 *   resets.
 * - When nothing can be read, the dialog says one short sentence in the person's language, and
 *   the vendor's own words go only to the log, redacted.
 */
import { describe, expect, it } from 'vitest';
import { GATEWAY_SUBSCRIPTIONS, type GatewaySignIn } from '../catalogue.js';
import { accountMarker, readUsage, Subscriptions } from '../subscriptions.js';
import { credentialOf, type ManagementClient } from './cliproxy-management.js';

const NOW = Date.parse('2026-10-01T09:00:00Z');
const ROW = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

const signInOf = (vendor: GatewaySignIn['vendor']): GatewaySignIn =>
  GATEWAY_SUBSCRIPTIONS.find((entry) => entry.signIn.vendor === vendor)!.signIn;

/** The 403 Google gave the owner's consumer account, recorded (trimmed, token-free). */
const GOOGLE_LICENSE_403 = JSON.stringify({
  error: {
    code: 403,
    message:
      'You do not have a valid license of this product. Please contact your administrator to request a license. If you are not an enterprise user and believe you should have access, ya29.a0AfB_byTOKENLOOKINGTHING1234567890',
    status: 'PERMISSION_DENIED',
  },
});

/** `v1internal:fetchAvailableModels` for a consumer account, recorded shape. */
const ANTIGRAVITY_MODELS = {
  models: {
    'gemini-3.8-flash-high': {
      displayName: 'Gemini 3.8 Flash (High)',
      quotaInfo: { remainingFraction: 0.75, resetTime: '2026-10-01T13:00:00Z' },
    },
    'claude-sonnet-4-5': {
      displayName: 'Claude Sonnet 4.5',
      quotaInfo: { resetTime: '2026-10-02T09:00:00Z' },
    },
    'tab-complete': { displayName: 'Tab' },
  },
  webSearchModelIds: ['gemini-3.8-flash-high'],
};

/** `v1internal:retrieveUserQuotaSummary`, recorded shape (CPAMC `AntigravityQuotaSummaryPayload`). */
const ANTIGRAVITY_SUMMARY = {
  groups: [
    {
      displayName: 'Gemini',
      buckets: [
        {
          bucketId: 'gemini-5h',
          displayName: '5-hour',
          window: '5h',
          remainingFraction: 0.4,
          resetTime: '2026-10-01T12:00:00Z',
        },
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly',
          window: 'weekly',
          remainingFraction: '90%',
          resetTime: '2026-10-06T00:00:00Z',
        },
      ],
    },
  ],
};

interface Call {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: string;
}

function harness(
  vendor: GatewaySignIn['vendor'],
  answer: (call: Call) => { statusCode: number; body: string } | Error,
  account: Record<string, unknown> = {},
) {
  const calls: Call[] = [];
  const logged: unknown[] = [];
  const credential = credentialOf({
    name: `${vendor}-person@example.com.json`,
    auth_index: 'idx-1',
    provider: vendor,
    email: 'person@example.com',
    status: 'active',
    note: accountMarker(ROW),
    ...account,
  })!;
  const client = {
    credentials: async () => [credential],
    drainErrors: async () => [],
    apiCall: async (call: Call) => {
      calls.push(call);
      const result = answer(call);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as ManagementClient;
  const subscriptions = new Subscriptions({
    backend: () => ({
      unavailable: () => null,
      open: async () => ({ client, done: () => undefined }),
      codexDeviceLogin: () => null,
      models: async () => [],
    }),
    now: () => NOW,
    log: { warn: (object: unknown) => void logged.push(object) } as never,
  });
  return { subscriptions, calls, logged, name: credential.name };
}

describe('"Check now": Google Antigravity', () => {
  it('asks the summary as CPAMC does, then reads each model’s quota when the summary is refused', async () => {
    const h = harness(
      'antigravity',
      (call) =>
        call.url.endsWith(':retrieveUserQuotaSummary')
          ? { statusCode: 403, body: GOOGLE_LICENSE_403 }
          : { statusCode: 200, body: JSON.stringify(ANTIGRAVITY_MODELS) },
      { project_id: 'bright-owl-1234' },
    );
    await h.subscriptions.check(ROW, h.name, signInOf('antigravity'));
    // The summary on the daily, sandbox and production hosts, with the project and the client's
    // name; then the per-model list on the daily host, which answered.
    expect(h.calls.map((call) => call.url)).toEqual([
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    ]);
    for (const call of h.calls) {
      expect(call.method).toBe('POST');
      expect(call.data).toBe('{"project":"bright-owl-1234"}');
      expect(call.header['user-agent']).toMatch(/^antigravity\/cli\//);
    }
    const view = h.subscriptions.accountView(ROW, h.name, 'en');
    expect(view.check_error).toBeNull();
    expect(view.windows.map((w) => [w.id, w.label, w.used_percent, w.resets_at, w.source])).toEqual(
      [
        ['claude-sonnet-4-5', 'Claude Sonnet 4.5', 100, '2026-10-02T09:00:00.000Z', 'checked'],
        [
          'gemini-3.8-flash-high',
          'Gemini 3.8 Flash (High)',
          25,
          '2026-10-01T13:00:00.000Z',
          'checked',
        ],
      ],
    );
  });

  it('reads the quota summary’s buckets when Google answers it', async () => {
    const h = harness('antigravity', () => ({
      statusCode: 200,
      body: JSON.stringify(ANTIGRAVITY_SUMMARY),
    }));
    await h.subscriptions.check(ROW, h.name, signInOf('antigravity'));
    // No project on the account: an empty body, as CLIProxyAPI's own model list sends.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.data).toBe('{}');
    const view = h.subscriptions.accountView(ROW, h.name, 'en');
    expect(view.windows.map((w) => [w.label, w.window_minutes, w.used_percent])).toEqual([
      ['Gemini · 5-hour', 300, 60],
      ['Gemini · Weekly', 10_080, 10],
    ]);
  });

  it('says in the person’s language that Google does not share usage, and keeps Google’s words out of the dialog', async () => {
    const h = harness('antigravity', () => ({ statusCode: 403, body: GOOGLE_LICENSE_403 }));
    await h.subscriptions.check(ROW, h.name, signInOf('antigravity'));
    expect(h.calls).toHaveLength(5);
    const english = h.subscriptions.accountView(ROW, h.name, 'en');
    expect(english.check_error).toBe("Google doesn't share usage for this account type.");
    expect(english.windows).toEqual([]);
    expect(h.subscriptions.accountView(ROW, h.name, 'ar').check_error).toBe(
      'لا يشارك Google الاستهلاك لهذا النوع من الحسابات.',
    );
    // Google's own answer is in the log, without anything that looks like a token.
    const log = JSON.stringify(h.logged);
    expect(log).toContain('valid license');
    expect(log).not.toContain('ya29.a0AfB_byTOKENLOOKINGTHING1234567890');
    expect(JSON.stringify(english)).not.toContain('license');
  });
});

describe('"Check now": the other vendors, as CPAMC reads them', () => {
  it('ChatGPT: the plan’s and code review’s windows, with Codex’s client name and the account id', async () => {
    const h = harness(
      'codex',
      () => ({
        statusCode: 200,
        body: JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            limit_reached: true,
            primary_window: { limit_window_seconds: 18_000, reset_after_seconds: 600 },
            secondary_window: {
              used_percent: 55,
              limit_window_seconds: 604_800,
              reset_at: 1_791_000_000,
            },
          },
          code_review_rate_limit: {
            primary_window: { used_percent: 5, limit_window_seconds: 18_000 },
          },
        }),
      }),
      { id_token: { chatgpt_account_id: 'acct-1' } },
    );
    await h.subscriptions.check(ROW, h.name, signInOf('codex'));
    expect(h.calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/wham/usage',
      header: { 'chatgpt-account-id': 'acct-1' },
    });
    expect(h.calls[0]!.header['user-agent']).toMatch(/^codex-tui\//);
    const view = h.subscriptions.accountView(ROW, h.name, 'en');
    expect(view.limit_reached).toBe(true);
    expect(view.windows.map((w) => [w.id, w.label, w.used_percent])).toEqual([
      ['primary', '5 hours', 100],
      ['secondary', 'Weekly', 55],
      ['code_review_primary', 'Code review (5 hours)', 5],
    ]);
  });

  it('Claude: every window it names, the weekly Fable limit among them', () => {
    const read = readUsage(
      'claude',
      {
        five_hour: { utilization: 12, resets_at: '2026-10-01T11:00:00Z' },
        seven_day: { utilization: 40, resets_at: '2026-10-05T00:00:00Z' },
        iguana_necktie: { utilization: 3, resets_at: '2026-10-05T00:00:00Z' },
        extra_usage: { is_enabled: false },
      },
      NOW,
    );
    expect(read.windows.map((w) => [w.id, w.window_minutes, w.used_percent])).toEqual([
      ['five_hour', 300, 12],
      ['seven_day', 10_080, 40],
      ['seven_day_fable', 10_080, 3],
    ]);
  });

  it('xAI: the weekly credits first, the monthly bill when they carry nothing', async () => {
    const h = harness('xai', (call) =>
      call.url.endsWith('?format=credits')
        ? { statusCode: 200, body: JSON.stringify({ config: {} }) }
        : {
            statusCode: 200,
            body: JSON.stringify({
              config: {
                monthlyLimit: { val: 2000 },
                used: { val: 500 },
                billingPeriodEnd: '2026-11-01T00:00:00Z',
              },
            }),
          },
    );
    await h.subscriptions.check(ROW, h.name, signInOf('xai'));
    expect(h.calls.map((call) => call.url)).toEqual([
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      'https://cli-chat-proxy.grok.com/v1/billing',
    ]);
    expect(h.calls[0]!.header).toMatchObject({
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-client-version': '0.2.91',
    });
    const view = h.subscriptions.accountView(ROW, h.name, 'en');
    expect(view.windows.map((w) => [w.id, w.used_percent, w.resets_at])).toEqual([
      ['monthly', 25, '2026-11-01T00:00:00.000Z'],
    ]);
    // A weekly SuperGrok answer, as recorded.
    const weekly = readUsage(
      'xai',
      {
        config: {
          currentPeriod: { type: 'WEEKLY', end: '2026-10-06T00:00:00Z' },
          creditUsagePercent: 18.5,
        },
      },
      NOW,
    );
    expect(weekly.windows).toMatchObject([
      { id: 'weekly', window_minutes: 10_080, used_percent: 18.5 },
    ]);
  });

  it('Kimi: the plan total and each limit, in its own time units, names and countdowns', () => {
    const read = readUsage(
      'kimi',
      {
        usage: { limit: '100', used: '25', resetTime: '2026-10-08T00:00:00.123456789Z' },
        limits: [
          {
            name: '5h window',
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: { limit: '50', remaining: '40', reset_in: 3600 },
          },
          {
            window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' },
            detail: { limit: '500', used: '100' },
          },
        ],
      },
      NOW,
    );
    expect(
      read.windows.map((w) => [w.id, w.label, w.window_minutes, w.used_percent, w.resets_at]),
    ).toEqual([
      ['total', null, null, 25, '2026-10-08T00:00:00.123Z'],
      ['limit_1', '5h window', 300, 20, '2026-10-01T10:00:00.000Z'],
      ['limit_2', null, 10_080, 20, null],
    ]);
  });

  it('says the other reasons in words too: signed out, rate limited, a vendor error, unreachable, nothing readable', async () => {
    const cases: [number | Error | 'empty', string][] = [
      [401, "Anthropic refused this account's sign-in. Renew the sign-in, then check again."],
      [429, 'Anthropic is limiting requests right now. Try again in a few minutes.'],
      [502, 'Anthropic could not answer right now (502). Try again later.'],
      [
        new Error('ECONNREFUSED'),
        "Core Hub could not reach Anthropic. Check the hub's connection, then try again.",
      ],
      ['empty', 'Anthropic answered, but without usage Core Hub can read.'],
    ];
    for (const [answer, sentence] of cases) {
      const h = harness('claude', () =>
        answer instanceof Error
          ? answer
          : answer === 'empty'
            ? { statusCode: 200, body: '{"extra_usage":{}}' }
            : { statusCode: answer, body: '{"type":"error","error":{"message":"raw words"}}' },
      );
      await h.subscriptions.check(ROW, h.name, signInOf('claude'));
      const view = h.subscriptions.accountView(ROW, h.name, 'en');
      expect(view.check_error).toBe(sentence);
      expect(view.check_error).not.toContain('raw words');
    }
  });
});
