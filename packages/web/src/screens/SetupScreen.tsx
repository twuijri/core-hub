// First run (ADR 0011): the owner account is created here, in the browser, proving with the
// hub's setup token that the person can read the server's log or its data directory. The hub
// is reachable on a public domain, so "no owner exists" is never on its own permission to
// create one. The password is typed into a password field, never echoed and never logged.
import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { HubApiError } from '@majlis/contracts';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useTheme } from '../design/theme.js';
import { useSetupState } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { HOME_PATH, LOGIN_PATH } from '../navigation/routes.js';
import { Notice, Spinner } from '../ui/Notice.js';

const MIN_PASSWORD = 8;

export function SetupScreen() {
  const { t, language } = useI18n();
  const { session, completeSetup } = useAuth();
  const { update } = useTheme();
  const setup = useSetupState();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={HOME_PATH} replace />;
  // Somebody already created the owner (or this hub was installed with HUB_ADMIN_PASSWORD).
  if (setup.data && !setup.data.required) return <Navigate to={LOGIN_PATH} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setBusy(true);
    try {
      await completeSetup({ token, username, password, displayName, workspaceName });
      navigate(HOME_PATH, { replace: true });
    } catch (err) {
      // A 409 means the hub was set up while this form was open: send the person to sign in.
      if (err instanceof HubApiError && err.status === 409) {
        await setup.refetch();
        navigate(LOGIN_PATH, { replace: true });
        return;
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 text-ink">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="glass flex w-full max-w-md flex-col gap-3 rounded-xl p-6"
        aria-labelledby="setup-title"
      >
        <div className="flex items-center justify-between gap-2">
          <h1 id="setup-title" className="text-xl font-semibold">
            {t('setup.title')}
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
        <p className="text-sm text-muted">{t('setup.intro')}</p>

        {setup.isPending && <Spinner label={t('setup.checking')} />}
        {setup.isError && <Notice tone="danger">{describeError(setup.error, t)}</Notice>}

        <section
          className="card flex flex-col gap-2 p-3 text-sm"
          aria-labelledby="setup-where-title"
        >
          <h2 id="setup-where-title" className="font-semibold">
            {t('setup.where_title')}
          </h2>
          <p className="text-muted">{t('setup.where_body')}</p>
          <pre dir="ltr" className="overflow-x-auto rounded-md bg-surface-2 p-2 text-xs">
            <code>{'docker compose logs hub\ndocker compose exec hub cat /data/setup-token.txt'}</code>
          </pre>
          <p className="text-muted">{t('setup.where_local')}</p>
        </section>

        <Field id="setup-token" label={t('setup.token')} hint={t('setup.token_hint')}>
          <input
            id="setup-token"
            className="field font-mono"
            name="setup-token"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoFocus
            aria-describedby="setup-token-hint"
          />
        </Field>

        <Field id="setup-username" label={t('setup.username')} hint={t('setup.username_hint')}>
          <input
            id="setup-username"
            className="field"
            name="username"
            dir="ltr"
            autoComplete="username"
            pattern="[a-z0-9._\-]{2,40}"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            aria-describedby="setup-username-hint"
          />
        </Field>

        <Field id="setup-display-name" label={t('setup.display_name')}>
          <input
            id="setup-display-name"
            className="field"
            name="display-name"
            dir="auto"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>

        <Field
          id="setup-workspace-name"
          label={t('setup.workspace_name')}
          hint={t('setup.workspace_hint')}
        >
          <input
            id="setup-workspace-name"
            className="field"
            name="workspace-name"
            dir="auto"
            autoComplete="off"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            aria-describedby="setup-workspace-name-hint"
          />
        </Field>

        <Field
          id="setup-password"
          label={t('setup.password')}
          hint={t('setup.password_hint', { min: MIN_PASSWORD })}
        >
          <input
            id="setup-password"
            className="field"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            aria-describedby="setup-password-hint"
          />
        </Field>

        <Field id="setup-confirm" label={t('setup.confirm')}>
          <input
            id="setup-confirm"
            className="field"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>

        {mismatch && <Notice tone="danger">{t('setup.mismatch')}</Notice>}
        {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t('setup.creating') : t('setup.submit')}
        </button>
        <p className="text-xs text-muted">{t('setup.unattended')}</p>
      </form>
    </main>
  );
}

/** One labelled control: the label text is the label, the hint is described-by, not part of it. */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint !== undefined && (
        <span id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </span>
      )}
    </div>
  );
}
