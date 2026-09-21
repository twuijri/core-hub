import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMeta } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useTheme } from '../design/theme.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { Notice } from '../ui/Notice.js';

export function LoginScreen() {
  const { t, language } = useI18n();
  const { session, signIn } = useAuth();
  const { update } = useTheme();
  const meta = useMeta();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (session) return <Navigate to={routeOf('chat').split('/:')[0] ?? '/'} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? routeOf('chat').split('/:')[0] ?? '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 text-ink">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="glass flex w-full max-w-sm flex-col gap-3 rounded-xl p-6"
        aria-labelledby="login-title"
      >
        <div className="flex items-center justify-between">
          <h1 id="login-title" className="text-xl font-semibold">
            {t('login.title')}
          </h1>
          <button
            type="button"
            className="chip"
            onClick={() => update({ language: language === 'ar' ? 'en' : 'ar' })}
            aria-label={t('shell.language_chip')}
          >
            {language === 'ar' ? 'English' : 'العربية'}
          </button>
        </div>
        {meta.data && (
          <p className="text-xs text-muted">
            {t('login.hub', { name: meta.data.name, version: meta.data.server_version })}
          </p>
        )}
        {meta.data?.setup_required && <Notice tone="warning">{t('login.setup_required')}</Notice>}
        <label className="flex flex-col gap-1 text-sm">
          {t('login.username')}
          <input
            className="field"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('login.password')}
          <input
            className="field"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t('login.signing_in') : t('login.submit')}
        </button>
      </form>
    </main>
  );
}
