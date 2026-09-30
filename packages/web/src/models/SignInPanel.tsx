/**
 * Signing in to a provider account (contract decision §55; through the hub's gateway, DECISIONS
 * §143): on the provider's card and in "Sign in with a subscription".
 *
 * Two flows, as the sign-in says (`accepts_code`):
 * - a **code**: the page to open and the short code to enter there, then a quiet wait while the
 *   hub polls — it works from a phone and from a server with no browser;
 * - a **link**: the page to open; after signing in there the browser lands on a `localhost`
 *   address that may not load — the person copies that address and pastes it here.
 *
 * Then the outcome in words — signed in, declined, ran out, or did not finish with the runtime's
 * own reason. Nothing here holds a token.
 */
import { useEffect, useRef, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Provider, ProviderSignIn } from '../types.js';
import { Button, Field, Input } from '../ui/index.js';
import { IconCopy } from '../ui/icons.js';
import { Notice, Spinner } from '../ui/Notice.js';
import { useCompleteSignIn, useSignInStatus, useStartSignIn } from './queries.js';

export function SignInPanel({
  provider,
  onDone,
  initial = null,
  autoStart = false,
  onApproved,
}: {
  provider: Pick<Provider, 'id' | 'label'>;
  onDone(): void;
  /** A sign-in already started elsewhere ("move to the gateway"). */
  initial?: ProviderSignIn | null;
  /** Start at once, rather than on the person's click (a dialog that exists to sign in). */
  autoStart?: boolean;
  onApproved?(): void;
}) {
  const { t } = useI18n();
  const start = useStartSignIn();
  const complete = useCompleteSignIn();
  const [signInId, setSignInId] = useState<string | null>(initial?.id ?? null);
  const [pasted, setPasted] = useState('');
  const status = useSignInStatus(provider.id, signInId);
  const current = status.data ?? complete.data ?? start.data ?? initial ?? null;
  const begin = () => {
    setSignInId(null);
    setPasted('');
    complete.reset();
    start.mutate(provider.id, { onSuccess: (signIn) => setSignInId(signIn.id) });
  };
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || initial || started.current) return;
    started.current = true;
    begin();
    // Once, when the panel opens.
  }, []);
  const approved = current?.status === 'approved';
  const told = useRef(false);
  useEffect(() => {
    if (approved && !told.current) {
      told.current = true;
      onApproved?.();
    }
  }, [approved, onApproved]);

  // Not a <form>: the panel also sits inside "Add provider"'s own form, and forms do not nest.
  const submitPasted = () => {
    if (!current || !pasted.trim()) return;
    complete.mutate(
      { providerId: provider.id, signInId: current.id, code: pasted.trim() },
      // Ask at once rather than at the next poll: the hub may already have finished.
      { onSuccess: () => void status.refetch() },
    );
  };

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="sign-in-panel"
      aria-label={t('models.signin.title', { provider: provider.label })}
    >
      <h4 className="text-sm font-medium" dir="auto">
        {t('models.signin.title', { provider: provider.label })}
      </h4>
      {!current && !start.isPending && !start.isError && (
        <Button variant="primary" onClick={begin} data-testid="sign-in-start">
          {t('models.signin.action')}
        </Button>
      )}
      {start.isPending && <Spinner label={t('common.loading')} />}
      {start.isError && <Notice tone="danger">{describeError(start.error, t)}</Notice>}
      {current && (
        <>
          <p className="text-sm">
            {t(current.accepts_code ? 'models.signin.link_steps' : 'models.signin.steps')}
          </p>
          {current.user_code && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{t('models.signin.code')}</span>
              <code
                className="rounded-md px-2 py-1 text-lg font-semibold tracking-widest"
                dir="ltr"
                data-testid="sign-in-code"
              >
                {current.user_code}
              </code>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<IconCopy size={14} />}
                aria-label={t('models.signin.copy')}
                onClick={() => void navigator.clipboard?.writeText(current.user_code ?? '')}
              />
            </div>
          )}
          <a
            className="link underline"
            href={current.verification_url}
            target="_blank"
            rel="noreferrer noopener"
            dir="ltr"
            data-testid="sign-in-link"
          >
            {t('models.signin.open')}
          </a>
          {current.accepts_code && current.status === 'pending' && !complete.isSuccess && (
            <div className="flex flex-col gap-2">
              <Field
                label={t('models.signin.paste_label')}
                hint={
                  current.callback_hint
                    ? t('models.signin.paste_hint', { start: current.callback_hint })
                    : t('models.signin.paste_hint_any')
                }
              >
                {(props) => (
                  <Input
                    {...props}
                    dir="ltr"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={current.callback_hint ?? 'http://localhost/…'}
                    value={pasted}
                    onChange={(event) => setPasted(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      submitPasted();
                    }}
                    data-testid="sign-in-paste"
                  />
                )}
              </Field>
              <Button
                variant="primary"
                className="self-start"
                disabled={!pasted.trim() || complete.isPending}
                loading={complete.isPending}
                onClick={submitPasted}
                data-testid="sign-in-paste-submit"
              >
                {t('models.signin.paste_submit')}
              </Button>
              {complete.isError && (
                <Notice tone="danger">{describeError(complete.error, t)}</Notice>
              )}
            </div>
          )}
          {current.status === 'pending' && (!current.accepts_code || complete.isSuccess) && (
            <div data-testid="sign-in-waiting">
              <Spinner label={t('models.signin.waiting')} />
            </div>
          )}
          {current.status === 'approved' && (
            <Notice tone="success">
              <span data-testid="sign-in-approved">{t('models.signin.approved')}</span>
            </Notice>
          )}
          {(current.status === 'denied' ||
            current.status === 'expired' ||
            current.status === 'failed') && (
            <Notice tone="danger">
              <span data-testid="sign-in-ended">
                {t(`models.signin.${current.status}`)}
                {current.error ? ` ${current.error}` : ''}
              </span>
            </Notice>
          )}
          {status.isError && <Notice tone="danger">{describeError(status.error, t)}</Notice>}
        </>
      )}
      <div className="flex gap-2">
        {current && current.status !== 'pending' && current.status !== 'approved' && (
          <Button onClick={begin} data-testid="sign-in-retry">
            {t('models.signin.retry')}
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          {t('models.signin.close')}
        </Button>
      </div>
    </section>
  );
}
