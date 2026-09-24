import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMeta, useSetupState } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useTheme } from '../design/theme.js';
import { useI18n } from '../i18n/context.js';
import { HOME_PATH, SETUP_PATH } from '../navigation/routes.js';
import { Button, Field, Input, Notice, Separator, CoreHubMark } from '../ui/index.js';
import { IconGlobe } from '../ui/icons.js';

/** Signing in: one card, two fields, and nothing else on the page to look at. */
export function LoginScreen() {
  const { t, language } = useI18n();
  const { session, signIn } = useAuth();
  const { update } = useTheme();
  const meta = useMeta();
  const setup = useSetupState();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (session) return <Navigate to={HOME_PATH} replace />;
  // A hub with no owner cannot be signed in to: first run happens on the setup screen (ADR 0011).
  if (setup.data?.required) return <Navigate to={SETUP_PATH} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? HOME_PATH, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="gate-card glass"
        aria-labelledby="login-title"
      >
        <header className="gate-head">
          <span className="gate-mark" aria-hidden>
            <CoreHubMark size={36} />
          </span>
          <div className="gate-headings">
            <h1 id="login-title" className="gate-title">
              {t('login.title')}
            </h1>
            {meta.data && (
              <p className="gate-sub">
                {t('login.hub', { name: meta.data.name, version: meta.data.server_version })}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconGlobe size={14} />}
            aria-label={t('shell.language_chip')}
            onClick={() => update({ language: language === 'ar' ? 'en' : 'ar' })}
          >
            {language === 'ar' ? 'English' : 'العربية'}
          </Button>
        </header>
        <Separator />
        {setup.isError && <Notice tone="warning">{t('login.setup_unknown')}</Notice>}
        <Field label={t('login.username')}>
          {({ id }) => (
            <Input
              id={id}
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          )}
        </Field>
        <Field label={t('login.password')}>
          {({ id }) => (
            <Input
              id={id}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1">
          {busy ? t('login.signing_in') : t('login.submit')}
        </Button>
      </form>
    </main>
  );
}
