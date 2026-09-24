// The first-run setup screen (ADR 0011, 0019): inside the open window it says setup is open to
// whoever arrives first, shows the time left and sends no token; after it, it explains where
// the token is and sends it. Either way it never puts the password anywhere but the request
// body, and steps aside for the sign-in screen once the hub has an owner.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { LOGIN_PATH, SETUP_PATH } from '../src/navigation/routes.js';
import { SetupScreen } from '../src/screens/SetupScreen.js';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

const USER = {
  id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
  username: 'tariq',
  display_name: 'طارق',
  role: 'owner',
  status: 'active',
  locale: 'ar',
  avatar: { kind: 'generated', url: null, seed: 'tariq' },
  profiles: ['default'],
  default_profile: 'default',
  last_login_at: '2026-09-22T08:00:00Z',
  created_at: '2026-09-22T08:00:00Z',
  updated_at: '2026-09-22T08:00:00Z',
};

function Probe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function mount(fetchImpl: typeof fetch, store = new SessionStore(memoryStorage())) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <I18nProvider language="ar">
        <QueryClientProvider client={queryClient}>
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <MemoryRouter initialEntries={[SETUP_PATH]}>
              <Probe />
              <Routes>
                <Route path={SETUP_PATH} element={<SetupScreen />} />
                <Route path={LOGIN_PATH} element={<p>sign in</p>} />
                <Route path="*" element={<p>signed in</p>} />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** `meta.get` of a hub with no owner: the window open until `until`, or closed. */
const meta = (until: number | null) =>
  json({
    name: 'Core Hub',
    server_version: '0.0.0',
    contract_version: '1.0.0',
    api_versions: ['v1'],
    realtime_namespaces: [],
    locales: ['ar', 'en'],
    setup_required: true,
    setup_open: until !== null,
    setup_open_until: until === null ? null : new Date(until).toISOString(),
  });

afterEach(cleanup);

describe('first-run setup screen', () => {
  it('inside the open window: says it is open to the first comer, shows the time left, sends no token', async () => {
    const calls: unknown[] = [];
    const until = Date.now() + 42 * 60_000 + 5_000;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/meta')) return meta(until);
      if (url.endsWith('/auth/setup') && (init?.method ?? 'GET') === 'GET')
        return json({ required: true });
      if (url.endsWith('/auth/setup')) {
        calls.push(JSON.parse(String(init?.body)) as unknown);
        return json({
          access_token: 'access',
          refresh_token: 'hub_rt_x',
          expires_in: 900,
          user: USER,
        });
      }
      return json({ items: [] });
    };
    const store = new SessionStore(memoryStorage());
    mount(fetchImpl, store);

    expect(
      await screen.findByText('التسجيل مفتوح لأول شخص يفتح هذه الصفحة — أكمله الآن'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('setup-remaining').textContent).toMatch(/42:0\d/);
    // No token field and no "where is the token" card in this mode.
    expect(screen.queryByLabelText('رمز التهيئة')).toBeNull();
    expect(screen.queryByText(/setup-token\.txt/)).toBeNull();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('اسم المستخدم'), 'tariq');
    await user.type(screen.getByLabelText('كلمة المرور'), 'a-good-owner-password');
    await user.type(screen.getByLabelText('تأكيد كلمة المرور'), 'a-good-owner-password');
    await user.click(screen.getByRole('button', { name: 'أنشئ الحساب وادخل' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ username: 'tariq', password: 'a-good-owner-password' });
    await waitFor(() => expect(store.read()?.user.username).toBe('tariq'));
  });

  it('when the countdown runs out the hub is asked again and the token field appears', async () => {
    let metaCalls = 0;
    const until = Date.now() + 1_200;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/meta')) {
        metaCalls += 1;
        return meta(metaCalls === 1 ? until : null);
      }
      if (url.endsWith('/auth/setup') && (init?.method ?? 'GET') === 'GET')
        return json({ required: true });
      return json({ items: [] });
    };
    mount(fetchImpl);
    expect(
      await screen.findByText('التسجيل مفتوح لأول شخص يفتح هذه الصفحة — أكمله الآن'),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('رمز التهيئة', {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText('التهيئة تحتاج الآن رمز التهيئة')).toBeInTheDocument();
    expect(screen.queryByText('التسجيل مفتوح لأول شخص يفتح هذه الصفحة — أكمله الآن')).toBeNull();
    expect(metaCalls).toBeGreaterThanOrEqual(2);
  });

  it('after the window: says where the token is, sends it with the account, and lands signed in', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/meta')) return meta(null);
      if (url.endsWith('/auth/setup') && (init?.method ?? 'GET') === 'GET')
        return json({ required: true });
      if (url.endsWith('/auth/setup')) {
        calls.push({ url, body: JSON.parse(String(init?.body)) as unknown });
        return json({
          access_token: 'access',
          refresh_token: 'hub_rt_x',
          expires_in: 900,
          user: USER,
        });
      }
      return json({ items: [] });
    };
    const store = new SessionStore(memoryStorage());
    mount(fetchImpl, store);

    // The screen itself tells the operator where to read the token.
    expect(
      await screen.findByText(/docker compose exec hub cat \/data\/setup-token\.txt/),
    ).toBeInTheDocument();
    expect(screen.getByText(/docker compose logs hub/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('رمز التهيئة'), TOKEN);
    await user.type(screen.getByLabelText('اسم المستخدم'), 'tariq');
    await user.type(screen.getByLabelText('الاسم الظاهر (اختياري)'), 'طارق');
    await user.type(screen.getByLabelText('اسم البروفايل (اختياري)'), 'بروفايلي');
    await user.type(screen.getByLabelText('كلمة المرور'), 'a-good-owner-password');
    await user.type(screen.getByLabelText('تأكيد كلمة المرور'), 'a-good-owner-password');
    await user.click(screen.getByRole('button', { name: 'أنشئ الحساب وادخل' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      token: TOKEN,
      username: 'tariq',
      password: 'a-good-owner-password',
      display_name: 'طارق',
      workspace_name: 'بروفايلي',
    });
    // Signed in exactly like `auth.login` does: the session is stored, the route moves on.
    await waitFor(() => expect(store.read()?.user.username).toBe('tariq'));
    expect(store.read()?.profile).toBe('default');
    // The password is nowhere but the request body.
    expect(JSON.stringify(store.read())).not.toContain('a-good-owner-password');
    await waitFor(() => expect(screen.getByTestId('path').textContent).not.toBe(SETUP_PATH));
  });

  it('the password fields are password fields and a mismatch never reaches the hub', async () => {
    let posts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/meta')) return meta(null);
      if (url.endsWith('/auth/setup') && (init?.method ?? 'GET') === 'GET')
        return json({ required: true });
      if (url.endsWith('/auth/setup')) {
        posts += 1;
        return json({ error: 'nope', code: 'unauthorized' }, 401);
      }
      return json({ items: [] });
    };
    mount(fetchImpl);
    const password = await screen.findByLabelText('كلمة المرور');
    expect(password).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('تأكيد كلمة المرور')).toHaveAttribute('type', 'password');

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('رمز التهيئة'), TOKEN);
    await user.type(screen.getByLabelText('اسم المستخدم'), 'tariq');
    await user.type(password, 'a-good-owner-password');
    await user.type(screen.getByLabelText('تأكيد كلمة المرور'), 'a-good-owner-passwrd');
    await user.click(screen.getByRole('button', { name: 'أنشئ الحساب وادخل' }));

    expect(await screen.findByText('كلمتا المرور غير متطابقتين.')).toBeInTheDocument();
    expect(posts).toBe(0);
  });

  it('a wrong token shows the hub error and keeps the form; the token is never stored', async () => {
    const store = new SessionStore(memoryStorage());
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/meta')) return meta(null);
      if (url.endsWith('/auth/setup') && (init?.method ?? 'GET') === 'GET')
        return json({ required: true });
      if (url.endsWith('/auth/setup'))
        return json({ error: 'رمز التهيئة غير صحيح.', code: 'unauthorized' }, 401);
      return json({ items: [] });
    };
    mount(fetchImpl, store);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('رمز التهيئة'), TOKEN);
    await user.type(screen.getByLabelText('اسم المستخدم'), 'tariq');
    await user.type(screen.getByLabelText('كلمة المرور'), 'a-good-owner-password');
    await user.type(screen.getByLabelText('تأكيد كلمة المرور'), 'a-good-owner-password');
    await user.click(screen.getByRole('button', { name: 'أنشئ الحساب وادخل' }));

    expect(await screen.findByText('رمز التهيئة غير صحيح.')).toBeInTheDocument();
    expect(screen.getByTestId('path').textContent).toBe(SETUP_PATH);
    expect(store.read()).toBeNull();
  });

  it('a hub that is already set up sends the person to sign in', async () => {
    const fetchImpl: typeof fetch = async (input) =>
      String(input).endsWith('/auth/setup')
        ? json({ required: false })
        : String(input).endsWith('/meta')
          ? meta(null)
          : json({ items: [] });
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(LOGIN_PATH));
    expect(screen.getByText('sign in')).toBeInTheDocument();
  });
});
