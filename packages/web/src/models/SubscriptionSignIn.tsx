/**
 * A subscription picked in "Add a provider" (DECISIONS §143, §146): what its sign-in is like —
 * a short code, or a link whose landing address is pasted back — and whether its usage and reset
 * times show, one neutral sentence about the vendors' terms, «Continue to sign in», and then the
 * sign-in itself, in the same dialog.
 *
 * The subscriptions are listed in the dialog's one provider list, each with a «Subscription»
 * tag (owner, 2026-09-30: one list, no tab of their own). The sign-in adds an account to the
 * provider; signing in again under the same provider adds another account (or renews the same
 * one). Its models then serve every agent through the gateway.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Provider, SubscriptionVendor } from '../types.js';
import { Button, Notice } from '../ui/index.js';
import { SignInPanel } from './SignInPanel.js';
import { useCreateProvider } from './queries.js';

/** The detail line of a subscription: how its sign-in goes, and whether usage shows. */
export function subscriptionDetail(
  vendor: Pick<SubscriptionVendor, 'flow' | 'usage_windows'>,
  t: (key: string) => string,
): string {
  const how = t(
    vendor.flow === 'device' ? 'models.subscription.flow_device' : 'models.subscription.flow_link',
  );
  return vendor.usage_windows ? `${how} · ${t('models.subscription.has_windows')}` : how;
}

export function SubscriptionSignIn({
  vendor,
  available,
  reason,
  note,
  scope,
  providers,
  onClose,
  onSigningIn,
}: {
  /** The subscription picked in the provider list. */
  vendor: SubscriptionVendor;
  /** Whether this hub's gateway can sign in at all, and why not. */
  available: boolean;
  reason: string | null;
  /** The hub's one neutral sentence about the vendors' terms. */
  note: string | null;
  scope: 'all' | 'profile';
  /** The providers already added: a subscription added before is signed in to again. */
  providers: readonly Provider[];
  /** The sign-in itself has started (the dialog hides the choices above it). */
  onSigningIn?(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const create = useCreateProvider();
  const [signingIn, setSigningIn] = useState<Pick<Provider, 'id' | 'label'> | null>(null);

  if (signingIn) {
    return (
      <div className="flex flex-col gap-3" data-testid="subscription-sign-in">
        <SignInPanel provider={signingIn} autoStart onDone={onClose} />
      </div>
    );
  }

  const begin = () => {
    const existing = providers.find(
      (provider) => provider.slug === vendor.preset && provider.scope === scope,
    );
    if (existing) {
      setSigningIn(existing);
      onSigningIn?.();
      return;
    }
    create.mutate(
      // The address is the preset's own; an empty one tells the hub to use it.
      { preset: vendor.preset, label: vendor.label, kind: 'llm', base_url: '', scope },
      {
        onSuccess: (provider) => {
          setSigningIn(provider);
          onSigningIn?.();
        },
      },
    );
  };

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="subscription-vendors"
      data-vendor={vendor.vendor}
    >
      <p className="text-sm text-muted">{t('models.subscription.intro')}</p>
      <p className="text-sm" data-testid="subscription-detail">
        {subscriptionDetail(vendor, t)}
      </p>
      {!available && (
        <Notice tone="warning">
          <span data-testid="subscription-unavailable">
            {t('models.subscription.unavailable', { reason: reason ?? '—' })}
          </span>
        </Notice>
      )}
      {note && (
        <p className="text-xs text-muted" data-testid="subscription-note">
          {note}
        </p>
      )}
      {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}
      <div className="ch-dialog-actions">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={!available || create.isPending}
          loading={create.isPending}
          onClick={begin}
          data-testid="subscription-continue"
        >
          {t('models.subscription.continue')}
        </Button>
      </div>
    </div>
  );
}
