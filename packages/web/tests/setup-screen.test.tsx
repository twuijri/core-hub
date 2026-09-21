// The first-run setup screen (ADR 0011): it explains where the token is, sends the typed
// values to `auth.completeSetup`, never puts the password anywhere but the request body, and
// steps aside for the sign-in screen once the hub has an owner.
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

afterEach(cleanup);

describe('first-run setup screen', () => {
  it('says where the token is, sends it with the account, and lands signed in', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
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
    await user.type(screen.getByLabelText('اسم مساحة العمل (اختياري)'), 'مساحتي');
    await user.type(screen.getByLabelText('كلمة المرور'), 'a-good-owner-password');
    await user.type(screen.getByLabelText('تأكيد كلمة المرور'), 'a-good-owner-password');
    await user.click(screen.getByRole('button', { name: 'أنشئ الحساب وادخل' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      token: TOKEN,
      username: 'tariq',
      password: 'a-good-owner-password',
      display_name: 'طارق',
      workspace_name: 'مساحتي',
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
    await user.type(screen.getByLabelText('رمز التهيئة'), TOKEN);
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
      String(input).endsWith('/auth/setup') ? json({ required: false }) : json({ items: [] });
    mount(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(LOGIN_PATH));
    expect(screen.getByText('sign in')).toBeInTheDocument();
  });
});
