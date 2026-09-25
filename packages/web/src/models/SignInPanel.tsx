/**
 * Signing in to a provider account by device code (contract decision §50), on the provider's
 * card: the code Hermes was given and the page to enter it on, then a quiet wait while the hub
 * polls, and the outcome in words — signed in, declined, ran out, or did not finish with the
 * runtime's own reason. Nothing here holds a token: Hermes keeps the credential.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Provider } from '../types.js';
import { Button } from '../ui/index.js';
import { IconCopy } from '../ui/icons.js';
import { Notice, Spinner } from '../ui/Notice.js';
import { useSignInStatus, useStartSignIn } from './queries.js';

export function SignInPanel({ provider, onDone }: { provider: Provider; onDone(): void }) {
  const { t } = useI18n();
  const start = useStartSignIn();
  const [signInId, setSignInId] = useState<string | null>(null);
  const status = useSignInStatus(provider.id, signInId);
  const current = status.data ?? start.data ?? null;
  const begin = () => {
    setSignInId(null);
    start.mutate(provider.id, { onSuccess: (signIn) => setSignInId(signIn.id) });
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
          <p className="text-sm">{t('models.signin.steps')}</p>
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
          {current.status === 'pending' && (
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
