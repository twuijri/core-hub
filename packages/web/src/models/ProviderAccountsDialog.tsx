/**
 * A subscription provider's dialog (DECISIONS §143, the owner: a dialog, not a new page): every
 * account signed in under it through the hub's gateway, and for each one what the gateway's
 * translator knows —
 *
 * - who (e-mail, plan) and how it stands (active, waiting until a time, failing with the vendor's
 *   words, turned off);
 * - its usage windows with what is left and when each resets — read from the vendor's own answers
 *   (passive), or asked now with "Check now" (the vendors' undocumented usage addresses: best
 *   effort, and it says so when it reads nothing);
 * - its requests: totals, and 10-minute bars for the last 3 h 20 min;
 * - actions: check now, renew its sign-in, turn it off or on, sign it out; and "Sign in another
 *   account" (or the same one again), which is the sign-in in this same dialog.
 *
 * The provider's recent failed calls are listed underneath, newest first. It reads again every
 * 15 s while open. Nothing here carries a token.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { exactTime, relativeTime } from '../devices/format.js';
import { intlLocale } from '../i18n/index.js';
import type { Provider, ProviderAccount, UsageWindow } from '../types.js';
import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  Notice,
  Spinner,
  Switch,
  Tooltip,
} from '../ui/index.js';
import type { BadgeTone } from '../ui/index.js';
import { SignInPanel } from './SignInPanel.js';
import {
  useAccountAction,
  useProviderAccounts,
  useRemoveAccount,
  useSetAccountDisabled,
  useSubscriptionVendors,
} from './queries.js';

const STATUS_TONE: Record<ProviderAccount['status'], BadgeTone> = {
  active: 'success',
  cooling: 'warning',
  error: 'danger',
  disabled: 'neutral',
  refreshing: 'info',
  unknown: 'neutral',
};

export function ProviderAccountsDialog({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose(): void;
}) {
  const { t, language } = useI18n();
  const accounts = useProviderAccounts(provider.id, true);
  const vendors = useSubscriptionVendors();
  const [signingIn, setSigningIn] = useState(false);
  const data = accounts.data;
  const checkable =
    vendors.data?.items.find(
      (item) => item.vendor === (data?.vendor ?? provider.subscription?.vendor),
    )?.checkable ?? false;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={provider.label}
      description={t('models.accounts.description')}
      closeLabel={t('ui.close')}
      testId="provider-accounts-dialog"
      footer={
        signingIn ? undefined : (
          <>
            <Button onClick={() => void accounts.refetch()} disabled={accounts.isFetching}>
              {t('models.accounts.reload')}
            </Button>
            <Button
              variant="primary"
              onClick={() => setSigningIn(true)}
              data-testid="accounts-sign-in"
            >
              {t(
                (data?.accounts.length ?? provider.subscription?.accounts ?? 0) > 0
                  ? 'models.accounts.add_account'
                  : 'models.signin.action',
              )}
            </Button>
          </>
        )
      }
    >
      {signingIn ? (
        <SignInPanel
          provider={provider}
          autoStart
          onDone={() => {
            setSigningIn(false);
            void accounts.refetch();
          }}
          onApproved={() => void accounts.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {accounts.isPending && <Spinner label={t('common.loading')} />}
          {accounts.isError && <Notice tone="danger">{describeError(accounts.error, t)}</Notice>}
          {data && !data.available && (
            <Notice tone="warning">
              <span data-testid="accounts-unavailable">
                {t('models.accounts.unavailable', { reason: data.reason ?? '—' })}
              </span>
            </Notice>
          )}
          {data && data.available && data.accounts.length === 0 && (
            <Notice>
              <span data-testid="accounts-none">{t('models.accounts.none')}</span>
            </Notice>
          )}
          {data && data.accounts.length > 0 && (
            <ul className="flex flex-col gap-3" data-testid="accounts-list">
              {data.accounts.map((account) => (
                <li key={account.id}>
                  <AccountBlock providerId={provider.id} account={account} checkable={checkable} />
                </li>
              ))}
            </ul>
          )}
          {data && data.errors.length > 0 && (
            <section className="flex flex-col gap-2" data-testid="accounts-errors">
              <h4 className="text-sm font-medium">{t('models.accounts.errors')}</h4>
              <ul className="flex flex-col gap-1 text-xs">
                {data.errors.map((error, index) => (
                  <li key={`${error.at}-${index}`} className="flex flex-wrap gap-2">
                    <Tooltip label={exactTime(error.at, language)}>
                      <time dateTime={error.at} className="text-muted">
                        <RelativeTime iso={error.at} />
                      </time>
                    </Tooltip>
                    {error.status !== null && <Badge tone="danger">{String(error.status)}</Badge>}
                    {error.model && (
                      <span dir="ltr" className="text-muted">
                        {error.model}
                      </span>
                    )}
                    <span dir="auto" className="min-w-0 flex-1 break-words">
                      {error.message}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}

function RelativeTime({ iso, future = false }: { iso: string; future?: boolean }) {
  const { language } = useI18n();
  if (!future) return <>{relativeTime(iso, Date.now(), language)}</>;
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(intlLocale(language), { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return <>{format.format(Math.round(seconds / size), unit)}</>;
  }
  return <>{format.format(Math.max(0, seconds), 'second')}</>;
}

function AccountBlock({
  providerId,
  account,
  checkable,
}: {
  providerId: string;
  account: ProviderAccount;
  checkable: boolean;
}) {
  const { t, language } = useI18n();
  const check = useAccountAction('check');
  const renew = useAccountAction('refresh');
  const toggle = useSetAccountDisabled();
  const remove = useRemoveAccount();
  const [confirm, setConfirm] = useState(false);
  const ids = { providerId, accountId: account.id };
  const maxBucket = Math.max(1, ...account.requests.recent.map((b) => b.success + b.failed));

  return (
    <article
      className="provider-account flex flex-col gap-2"
      data-testid="account"
      data-account-id={account.id}
      data-status={account.status}
    >
      <header className="flex flex-wrap items-center gap-2">
        <strong dir="auto" className="min-w-0 flex-1 break-words">
          {account.label}
        </strong>
        {account.plan && <Badge tone="accent">{account.plan}</Badge>}
        <Badge tone={STATUS_TONE[account.status]} testId="account-status">
          {t(`models.accounts.status.${account.status}`)}
        </Badge>
        <Switch
          checked={!account.disabled}
          disabled={toggle.isPending}
          onChange={(on) => toggle.mutate({ ...ids, disabled: !on })}
          label={t('models.accounts.enabled')}
          testId="account-enabled"
        />
      </header>

      {account.status_message && (
        <p className="text-xs text-muted" dir="auto" data-testid="account-message">
          {account.status_message}
        </p>
      )}
      {account.next_retry_at && (
        <p className="text-xs" data-testid="account-retry">
          {t('models.accounts.retry_at')} <RelativeTime iso={account.next_retry_at} future />
        </p>
      )}

      {account.windows.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="account-windows">
          {account.windows.map((window) => (
            <li key={window.id}>
              <WindowRow window={window} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted" data-testid="account-no-windows">
          {t(checkable ? 'models.accounts.no_windows_check' : 'models.accounts.no_windows')}
        </p>
      )}
      {account.limit_reached === true && (
        <Notice tone="warning">{t('models.accounts.limit_reached')}</Notice>
      )}
      {account.check_error && (
        <Notice tone="warning">
          <span data-testid="account-check-error">
            {t('models.accounts.check_failed', { reason: account.check_error })}
          </span>
        </Notice>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted" data-testid="account-requests">
          {t('models.accounts.requests', {
            success: account.requests.success,
            failed: account.requests.failed,
          })}
        </span>
        {account.requests.recent.length > 0 && (
          <div
            className="account-buckets"
            role="img"
            aria-label={t('models.accounts.buckets')}
            data-testid="account-buckets"
          >
            {account.requests.recent.map((bucket) => (
              <Tooltip
                key={bucket.at}
                label={`${exactTime(bucket.at, language)} · ${bucket.success} / ${bucket.failed}`}
              >
                <span
                  className="account-bucket"
                  data-failed={bucket.failed > 0 ? 'true' : undefined}
                  style={{
                    blockSize: `${Math.round(((bucket.success + bucket.failed) / maxBucket) * 100)}%`,
                  }}
                />
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      <dl className="provider-facts">
        {account.last_refresh_at && (
          <>
            <dt>{t('models.accounts.last_refresh')}</dt>
            <dd>
              <RelativeTime iso={account.last_refresh_at} />
            </dd>
          </>
        )}
        {account.email && account.email !== account.label && (
          <>
            <dt>{t('models.accounts.email')}</dt>
            <dd dir="ltr">{account.email}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-wrap gap-2">
        {checkable && (
          <Button
            size="sm"
            loading={check.isPending}
            onClick={() => check.mutate(ids)}
            data-testid="account-check"
          >
            {t('models.accounts.check')}
          </Button>
        )}
        <Button
          size="sm"
          loading={renew.isPending}
          onClick={() => renew.mutate(ids)}
          data-testid="account-renew"
        >
          {t('models.accounts.renew')}
        </Button>
        <Button
          size="sm"
          variant="danger-quiet"
          disabled={remove.isPending}
          onClick={() => setConfirm(true)}
          data-testid="account-remove"
        >
          {t('models.accounts.remove')}
        </Button>
      </div>
      {(check.isError || renew.isError || toggle.isError || remove.isError) && (
        <Notice tone="danger">
          {describeError(check.error ?? renew.error ?? toggle.error ?? remove.error, t)}
        </Notice>
      )}
      <AlertDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('models.accounts.remove_confirm', { account: account.label })}
        body={t('models.accounts.remove_body')}
        confirmLabel={t('models.accounts.remove')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          setConfirm(false);
          remove.mutate(ids);
        }}
        testId="confirm-remove-account"
      />
    </article>
  );
}

function WindowRow({ window }: { window: UsageWindow }) {
  const { t } = useI18n();
  const used =
    window.used_percent === null ? null : Math.min(100, Math.max(0, window.used_percent));
  const level = used === null ? 'none' : used >= 90 ? 'high' : used >= 70 ? 'mid' : 'low';
  return (
    <div className="flex flex-col gap-1" data-testid="account-window" data-window={window.id}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{window.label ?? window.id}</span>
        {used !== null && (
          <span data-testid="window-left">
            {t('models.accounts.left', { percent: Math.round(100 - used) })}
          </span>
        )}
        {window.resets_at && (
          <span className="text-muted" data-testid="window-reset">
            {t('models.accounts.resets')} <RelativeTime iso={window.resets_at} future />
          </span>
        )}
        <Badge tone={window.source === 'checked' ? 'info' : 'neutral'}>
          {t(window.source === 'checked' ? 'models.accounts.checked' : 'models.accounts.observed')}
        </Badge>
      </div>
      {used !== null && (
        <div
          className="usage-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used)}
          aria-label={window.label ?? window.id}
        >
          <div className="usage-meter-bar" data-level={level} style={{ inlineSize: `${used}%` }} />
        </div>
      )}
    </div>
  );
}
