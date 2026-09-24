// First run (ADR 0011, amended by ADR 0019): the owner account is created here, in the browser.
// For a window after the hub started with no owner (`meta.setup_open`), setup is open to
// whoever arrives first and this screen says so, with the time left; after the window it asks
// for the hub's setup token and says where to read it. The password is typed into a password
// field, never echoed and never logged.
//
// Every control is the kit's (`src/ui/`): one `Field` owns each label, hint and error, so the
// ids and the `aria-describedby` are wired once instead of seven times.
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { HubApiError } from '@corehub/contracts';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useTheme } from '../design/theme.js';
import { useSetupState, useSetupWindow } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { HOME_PATH, LOGIN_PATH } from '../navigation/routes.js';
import {
  Button,
  Card,
  Field,
  Input,
  Notice,
  Separator,
  Spinner,
  CoreHubMark,
} from '../ui/index.js';
import { IconGlobe } from '../ui/icons.js';

const MIN_PASSWORD = 8;

/** `mm:ss` (or `h:mm:ss`) in Latin digits, isolated in the sentence by the locale string. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function SetupScreen() {
  const { t, language } = useI18n();
  const { session, completeSetup } = useAuth();
  const { update } = useTheme();
  const setup = useSetupState();
  const setupWindow = useSetupWindow();
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);

  const openUntil = setupWindow.data?.openUntil ? Date.parse(setupWindow.data.openUntil) : null;
  const remaining = openUntil === null ? 0 : openUntil - now;
  // The hub decides the mode; this browser's clock only drives the countdown, and asks the
  // hub again when it runs out (a skewed clock cannot switch the form by itself). Unknown
  // (still asking) is neither mode, and a hub that cannot answer gets the token field.
  const mode: 'open' | 'token' | 'unknown' = setupWindow.isPending
    ? 'unknown'
    : setupWindow.data?.open
      ? 'open'
      : 'token';

  // The countdown. When it reaches zero the hub is asked again, and the token field appears.
  const refetchWindow = setupWindow.refetch;
  useEffect(() => {
    if (openUntil === null) return undefined;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= openUntil) {
        window.clearInterval(timer);
        void refetchWindow();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [openUntil, refetchWindow]);

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
      await completeSetup({
        ...(mode === 'token' ? { token } : {}),
        username,
        password,
        displayName,
        workspaceName,
      });
      navigate(HOME_PATH, { replace: true });
    } catch (err) {
      // A 409 means the hub was set up while this form was open: send the person to sign in.
      if (err instanceof HubApiError && err.status === 409) {
        await setup.refetch();
        navigate(LOGIN_PATH, { replace: true });
        return;
      }
      // A 401 while the form was open without a token: the window closed meanwhile.
      if (err instanceof HubApiError && err.status === 401 && mode === 'open') {
        await setupWindow.refetch();
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <form
        onSubmit={(e) => void onSubmit(e)}
        className="gate-card gate-card-wide glass"
        aria-labelledby="setup-title"
      >
        <header className="gate-head">
          <span className="gate-mark" aria-hidden>
            <CoreHubMark size={36} />
          </span>
          <div className="gate-headings">
            <h1 id="setup-title" className="gate-title">
              {t('setup.title')}
            </h1>
            <p className="gate-sub">{t('setup.intro')}</p>
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

        {setup.isPending && <Spinner label={t('setup.checking')} />}
        {setup.isError && <Notice tone="danger">{describeError(setup.error, t)}</Notice>}

        {mode === 'open' && (
          <Notice tone="warning" role="status">
            <strong className="block font-semibold">{t('setup.open_title')}</strong>
            <span className="block text-xs">{t('setup.open_body')}</span>
            <span className="block text-xs font-semibold" data-testid="setup-remaining">
              {t('setup.open_remaining', { time: formatRemaining(remaining) })}
            </span>
          </Notice>
        )}

        {mode === 'token' && (
          <>
            {setupWindow.data?.openUntil !== undefined && (
              <Notice tone="info">
                <strong className="block font-semibold">{t('setup.closed_title')}</strong>
                <span className="block text-xs">{t('setup.closed_body')}</span>
              </Notice>
            )}
            <Card tone="flat" padding="sm" as="section" aria-labelledby="setup-where-title">
              <h2 id="setup-where-title" className="text-sm font-semibold">
                {t('setup.where_title')}
              </h2>
              <p className="text-xs text-muted">{t('setup.where_body')}</p>
              <pre dir="ltr" className="gate-code">
                <code>
                  {'docker compose logs hub\ndocker compose exec hub cat /data/setup-token.txt'}
                </code>
              </pre>
              <p className="text-xs text-muted">{t('setup.where_local')}</p>
            </Card>

            <Field label={t('setup.token')} hint={t('setup.token_hint')}>
              {(props) => (
                <Input
                  {...props}
                  name="setup-token"
                  className="font-mono"
                  dir="ltr"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  autoFocus
                />
              )}
            </Field>
          </>
        )}

        <div className="gate-grid">
          <Field label={t('setup.username')} hint={t('setup.username_hint')}>
            {(props) => (
              <Input
                {...props}
                name="username"
                dir="ltr"
                autoComplete="username"
                pattern="[a-z0-9._\-]{2,40}"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus={mode === 'open'}
              />
            )}
          </Field>

          <Field label={t('setup.display_name')}>
            {(props) => (
              <Input
                {...props}
                name="display-name"
                dir="auto"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
          </Field>
        </div>

        <Field label={t('setup.workspace_name')} hint={t('setup.workspace_hint')}>
          {(props) => (
            <Input
              {...props}
              name="workspace-name"
              dir="auto"
              autoComplete="off"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
            />
          )}
        </Field>

        <div className="gate-grid">
          <Field label={t('setup.password')} hint={t('setup.password_hint', { min: MIN_PASSWORD })}>
            {(props) => (
              <Input
                {...props}
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            )}
          </Field>

          <Field label={t('setup.confirm')} {...(mismatch ? { error: t('setup.mismatch') } : {})}>
            {(props) => (
              <Input
                {...props}
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                invalid={mismatch}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            )}
          </Field>
        </div>

        {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          disabled={mode === 'unknown'}
        >
          {busy ? t('setup.creating') : t('setup.submit')}
        </Button>
        <p className="text-xs text-muted">{t('setup.unattended')}</p>
      </form>
    </main>
  );
}
