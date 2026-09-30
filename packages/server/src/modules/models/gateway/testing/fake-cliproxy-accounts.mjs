// The subscription half of the CLIProxyAPI stand-in (`fake-cliproxy.mjs`): its management API as
// the hub uses it (DECISIONS §143), and its ChatGPT device sign-in flag. Accounts are files in the
// config's `oauth.auth-dir`, as the real one keeps them, so they outlive a process and a sign-in
// run as a child process lands where the server reads it.
//
//   FAKE_CLIPROXY_LOGIN          auto (default: a device code is approved ~1.2 s after it is
//                                shown), deny (the vendor says no), manual (only
//                                POST /fake/approve?state= approves)
//   FAKE_CLIPROXY_EMAIL          the account e-mail a sign-in gets (default person@example.com)
//   FAKE_CLIPROXY_ERRORS         1: the first usage-queue read carries one failed call
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEVICE_VENDORS = new Set(['xai', 'kimi', 'kimi-ai', 'meta']);
export const LINK_VENDORS = new Set(['claude', 'codex', 'antigravity', 'devin']);

/** What each vendor's accounts serve, as CLIProxyAPI's own catalogue would. */
export const VENDOR_MODELS = {
  codex: [
    { id: 'gpt-5.5', context_length: 400000 },
    { id: 'gpt-5.5-codex', context_length: 400000 },
  ],
  claude: [
    { id: 'claude-sonnet-4-5', context_length: 200000 },
    { id: 'claude-opus-4-1', context_length: 200000 },
  ],
  xai: [{ id: 'grok-4.5', context_length: 256000 }],
  kimi: [{ id: 'kimi-k2.6', context_length: 262144 }],
  'kimi-ai': [{ id: 'kimi-k2.6', context_length: 262144 }],
  meta: [{ id: 'muse-1', context_length: 128000 }],
  antigravity: [{ id: 'gemini-3-pro', context_length: 1000000 }],
  devin: [{ id: 'devin-1', context_length: 128000 }],
};

const nowIso = () => new Date().toISOString();

function fileName(vendor, email) {
  return `${vendor}-${email}.json`;
}

/** Writes one signed-in account as CLIProxyAPI would (tokens included — it is a fake). */
export function writeAccount(authDir, vendor, email) {
  mkdirSync(authDir, { recursive: true });
  const name = fileName(vendor, email);
  const full = path.join(authDir, name);
  const previous = existsSync(full) ? JSON.parse(readFileSync(full, 'utf8')) : {};
  const signals =
    vendor === 'codex'
      ? {
          'x-codex-primary-used-percent': '12.5',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3 * 3600),
          'x-codex-secondary-used-percent': '40',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-at': String(Math.floor(Date.now() / 1000) + 4 * 86400),
          'x-codex-plan-type': 'plus',
          'x-codex-limit-reached': 'false',
        }
      : vendor === 'claude'
        ? {
            'anthropic-ratelimit-unified-5h-utilization': '0.25',
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 7200),
            'anthropic-ratelimit-unified-7d-utilization': '0.5',
            'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 86400),
            'anthropic-ratelimit-unified-status': 'allowed',
          }
        : {};
  const account = {
    ...previous,
    type: vendor,
    email,
    access_token: `fake-access-${randomBytes(6).toString('hex')}`,
    refresh_token: `fake-refresh-${randomBytes(6).toString('hex')}`,
    created_at: previous.created_at ?? nowIso(),
    updated_at: nowIso(),
    last_refresh: nowIso(),
    fake_signals: signals,
  };
  writeFileSync(full, JSON.stringify(account, null, 2), { mode: 0o600 });
  return name;
}

export function readAccounts(authDir) {
  if (!existsSync(authDir)) return [];
  return readdirSync(authDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, ...JSON.parse(readFileSync(path.join(authDir, name), 'utf8')) }));
}

/** The prefixed models every account serves: `h<row>/<model>`. */
export function accountModels(authDir) {
  const out = [];
  for (const account of readAccounts(authDir)) {
    if (!account.prefix || account.disabled) continue;
    for (const model of VENDOR_MODELS[account.type] ?? []) {
      out.push({ ...model, id: `${account.prefix}/${model.id}`, vendor: account.type });
    }
  }
  return out;
}

/** `-codex-device-login`: prints a link and a code, then signs in (or does not). */
export async function codexDeviceLogin(authDir) {
  process.stdout.write('Starting Codex device authentication...\n');
  process.stdout.write('Codex device URL: https://auth.openai.com/codex/device\n');
  process.stdout.write('Codex device code: FAKE-CODEX1\n');
  const mode = process.env.FAKE_CLIPROXY_LOGIN ?? 'auto';
  await new Promise((resolve) => setTimeout(resolve, mode === 'auto' ? 1200 : 400));
  if (mode === 'deny') {
    process.stdout.write('Codex device authentication failed: access_denied by the user\n');
    return;
  }
  const saved = writeAccount(
    authDir,
    'codex',
    process.env.FAKE_CLIPROXY_EMAIL ?? 'person@example.com',
  );
  process.stdout.write(`Authentication saved to ${path.join(authDir, saved)}\n`);
  process.stdout.write('Codex device authentication successful!\n');
}

/** The management API, `/v8/management/*`. Answers true when it answered the request. */
export function managementApi(config) {
  const secret = config.management?.['secret-key'] ?? '';
  const authDir = config.oauth?.['auth-dir'] ?? '';
  const logins = new Map();
  const cooldowns = new Map();
  let errorsQueued = process.env.FAKE_CLIPROXY_ERRORS === '1';
  const indexOf = (name) => Buffer.from(name).toString('hex').slice(0, 16);

  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const approve = (login) => {
    login.status = 'ok';
    login.account = writeAccount(
      authDir,
      login.vendor,
      process.env.FAKE_CLIPROXY_EMAIL ?? 'person@example.com',
    );
  };

  const entryOf = (account) => {
    const cooling = cooldowns.get(account.name);
    const cools = cooling && cooling > Date.now();
    const buckets = Array.from({ length: 20 }, (_, i) => ({
      time: '00:00-00:10',
      success: i === 19 ? 3 : i % 5 === 0 ? 1 : 0,
      failed: i === 18 ? 1 : 0,
    }));
    return {
      id: account.name,
      auth_index: indexOf(account.name),
      name: account.name,
      type: account.type,
      provider: account.type,
      label: account.email,
      email: account.email,
      status: account.disabled ? 'disabled' : 'active',
      status_message: cools ? 'usage limit reached' : '',
      disabled: account.disabled === true,
      unavailable: Boolean(cools),
      ...(cools ? { next_retry_after: new Date(cooling).toISOString() } : {}),
      runtime_only: false,
      source: 'file',
      success: 7,
      failed: 1,
      recent_requests: buckets,
      quota: { observed_at: account.updated_at, signals: account.fake_signals ?? {} },
      created_at: account.created_at,
      updated_at: account.updated_at,
      modtime: account.updated_at,
      last_refresh: account.last_refresh,
      ...(account.note ? { note: account.note } : {}),
      ...(account.type === 'codex'
        ? { id_token: { chatgpt_account_id: 'acct-fake', plan_type: 'plus' } }
        : {}),
    };
  };

  const update = (name, change) => {
    const full = path.join(authDir, name);
    if (!existsSync(full)) return false;
    const account = JSON.parse(readFileSync(full, 'utf8'));
    writeFileSync(full, JSON.stringify({ ...account, ...change(account) }, null, 2));
    return true;
  };

  return (request, response, url, raw) => {
    if (url.pathname === '/fake/approve') {
      const login = logins.get(url.searchParams.get('state'));
      if (login) approve(login);
      json(response, 200, { ok: Boolean(login) });
      return true;
    }
    if (!url.pathname.startsWith('/v8/management/')) return false;
    if (!secret || request.headers.authorization !== `Bearer ${secret}`) {
      json(response, secret ? 401 : 404, { error: 'invalid management key' });
      return true;
    }
    const route = url.pathname.slice('/v8/management'.length);
    const body = raw ? JSON.parse(raw) : {};
    const method = request.method;

    if (method === 'GET' && route === '/oauth/auth-url') {
      const vendor = url.searchParams.get('provider') ?? '';
      const state = `${vendor}-${randomBytes(8).toString('hex')}`;
      if (DEVICE_VENDORS.has(vendor)) {
        const login = { vendor, status: 'wait', account: null, error: null };
        logins.set(state, login);
        const mode = process.env.FAKE_CLIPROXY_LOGIN ?? 'auto';
        if (mode === 'auto') setTimeout(() => approve(login), 1200);
        if (mode === 'deny')
          setTimeout(() => ((login.status = 'error'), (login.error = 'access_denied')), 400);
        json(response, 200, {
          status: 'ok',
          url: `https://login.example.test/${vendor}/device?user_code=FAKE-1234`,
          state,
          flow: 'device',
          user_code: 'FAKE-1234',
          expires_in: 900,
        });
        return true;
      }
      if (LINK_VENDORS.has(vendor)) {
        logins.set(state, { vendor, status: 'wait', account: null, error: null });
        json(response, 200, {
          status: 'ok',
          url: `https://login.example.test/${vendor}/authorize?state=${state}`,
          state,
        });
        return true;
      }
      json(response, 404, { error: 'provider_not_found' });
      return true;
    }
    if (method === 'GET' && route === '/oauth/status') {
      const login = logins.get(url.searchParams.get('state'));
      if (!login)
        return (json(response, 200, { status: 'error', error: 'unknown or expired state' }), true);
      if (login.status === 'ok') return (json(response, 200, { status: 'ok' }), true);
      if (login.status === 'error')
        return (json(response, 200, { status: 'error', error: login.error }), true);
      json(response, 200, { status: 'wait' });
      return true;
    }
    if (method === 'POST' && route === '/oauth/callback') {
      let state = body.state;
      let code = body.code;
      if (body.redirect_url) {
        const landed = new URL(body.redirect_url);
        state = landed.searchParams.get('state') ?? state;
        code = landed.searchParams.get('code');
      }
      const login = logins.get(state);
      if (!login) return (json(response, 400, { status: 'error', error: 'invalid state' }), true);
      if (!code || code === 'bad') {
        login.status = 'error';
        login.error = 'Bad request';
        json(response, 200, { status: 'ok' });
        return true;
      }
      setTimeout(() => approve(login), 150);
      json(response, 200, { status: 'ok' });
      return true;
    }
    if (method === 'DELETE' && route === '/oauth/session') {
      const state = url.searchParams.get('state');
      const login = logins.get(state);
      if (login && login.status === 'wait') {
        login.status = 'error';
        login.error = 'cancelled';
      }
      json(response, 200, { status: 'ok', cancelled: Boolean(login) });
      return true;
    }
    if (method === 'GET' && route === '/credentials') {
      // A failed call on the first account that serves a model: it waits from then on, as the
      // real one cools an account its vendor said is spent.
      const accounts = readAccounts(authDir);
      const failing = accounts.find((account) => account.prefix);
      if (errorsQueued && failing && !cooldowns.has(failing.name)) {
        cooldowns.set(failing.name, Date.now() + 3600_000);
      }
      json(response, 200, { observed_at: nowIso(), files: accounts.map(entryOf) });
      return true;
    }
    if (method === 'PATCH' && route === '/credentials/fields') {
      const { name, ...fields } = body;
      const ok = update(name, () => fields);
      json(response, ok ? 200 : 404, ok ? { status: 'ok' } : { error: 'auth file not found' });
      return true;
    }
    if (method === 'PATCH' && route === '/credentials/status') {
      const ok = update(body.name, () => ({ disabled: body.disabled === true }));
      json(response, ok ? 200 : 404, ok ? { status: 'ok' } : { error: 'auth file not found' });
      return true;
    }
    if (method === 'DELETE' && route === '/credentials') {
      const name = url.searchParams.get('name');
      const full = path.join(authDir, name ?? '');
      if (!name || !existsSync(full))
        return (json(response, 404, { error: 'auth file not found' }), true);
      rmSync(full);
      json(response, 200, { status: 'ok' });
      return true;
    }
    if (method === 'POST' && route === '/credentials/refresh') {
      const ok = update(body.name, () => ({ last_refresh: nowIso() }));
      json(response, ok ? 200 : 404, ok ? { status: 'ok' } : { error: 'auth file not found' });
      return true;
    }
    if (method === 'POST' && route === '/routing/cooldown/reset') {
      for (const account of readAccounts(authDir)) {
        if (indexOf(account.name) === body.auth_index) cooldowns.delete(account.name);
      }
      json(response, 200, { status: 'ok', auth_index: body.auth_index });
      return true;
    }
    if (method === 'POST' && route === '/requests/api-call') {
      const account = readAccounts(authDir).find((each) => indexOf(each.name) === body.auth_index);
      if (!account) return (json(response, 400, { error: 'auth not found' }), true);
      if (!String(body.header?.authorization ?? '').includes('$TOKEN$')) {
        return (json(response, 400, { error: 'no $TOKEN$' }), true);
      }
      const reset = Math.floor(Date.now() / 1000) + 5 * 86400;
      if (body.url === 'https://chatgpt.com/backend-api/wham/usage') {
        json(response, 200, {
          status_code: 200,
          header: {},
          body: JSON.stringify({
            plan_type: 'plus',
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18000,
                reset_after_seconds: 3600,
              },
              secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: reset },
            },
          }),
        });
        return true;
      }
      if (body.url === 'https://api.anthropic.com/api/oauth/usage') {
        json(response, 200, {
          status_code: 200,
          header: {},
          body: JSON.stringify({
            five_hour: {
              utilization: 30,
              resets_at: new Date(Date.now() + 7200_000).toISOString(),
            },
            seven_day: { utilization: 61, resets_at: new Date(reset * 1000).toISOString() },
          }),
        });
        return true;
      }
      json(response, 200, { status_code: 404, header: {}, body: '{"error":"not found"}' });
      return true;
    }
    if (method === 'GET' && route === '/observability/usage/queue') {
      const items = [];
      if (errorsQueued && readAccounts(authDir).some((account) => account.prefix)) {
        errorsQueued = false;
        const first = readAccounts(authDir).find((account) => account.prefix);
        if (first) {
          cooldowns.set(first.name, Date.now() + 3600_000);
          items.push({
            timestamp: nowIso(),
            provider: first.type,
            model: `${first.prefix ?? 'h'}/${VENDOR_MODELS[first.type]?.[0]?.id ?? 'model'}`,
            auth_index: indexOf(first.name),
            failed: true,
            fail: {
              status_code: 429,
              body: JSON.stringify({ error: { message: 'The usage limit has been reached' } }),
            },
          });
        }
      }
      json(response, 200, items);
      return true;
    }
    json(response, 404, { error: `no ${method} ${route}` });
    return true;
  };
}
