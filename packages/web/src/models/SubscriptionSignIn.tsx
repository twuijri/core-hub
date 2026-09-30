/**
 * "Add provider → Sign in with a subscription" (DECISIONS §143): the subscriptions the hub's
 * gateway signs in to — ChatGPT, Claude, xAI, Kimi, Meta, Google Antigravity, Devin — with how
 * each one's sign-in goes (a short code, or a link whose landing address is pasted back), one
 * neutral sentence about the vendors' terms, and then the sign-in itself, in the same dialog.
 *
 * The sign-in adds an account to the provider; signing in again under the same provider adds
 * another account (or renews the same one). Its models then serve every agent through the
 * gateway. A hub older than this answers 404 and the choice is not offered at all.
 */
import { useMemo, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Provider } from '../types.js';
import { Badge, Button, Notice, Radio, Spinner } from '../ui/index.js';
import { SignInPanel } from './SignInPanel.js';
import { useCreateProvider, useSubscriptionVendors } from './queries.js';

export function SubscriptionSignIn({
  scope,
  providers,
  onClose,
}: {
  scope: 'all' | 'profile';
  /** The providers already added: a subscription added before is signed in to again. */
  providers: readonly Provider[];
  onClose(): void;
}) {
  const { t } = useI18n();
  const vendors = useSubscriptionVendors();
  const create = useCreateProvider();
  const items = useMemo(() => vendors.data?.items ?? [], [vendors.data]);
  const [preset, setPreset] = useState<string>('');
  const chosen = items.find((item) => item.preset === preset) ?? items[0];
  const [signingIn, setSigningIn] = useState<Pick<Provider, 'id' | 'label'> | null>(null);

  if (vendors.isPending) return <Spinner label={t('common.loading')} />;
  if (vendors.isError) return <Notice tone="danger">{describeError(vendors.error, t)}</Notice>;
  const available = vendors.data.available;

  if (signingIn) {
    return (
      <div className="flex flex-col gap-3" data-testid="subscription-sign-in">
        <SignInPanel provider={signingIn} autoStart onDone={onClose} />
      </div>
    );
  }

  const begin = () => {
    if (!chosen) return;
    const existing = providers.find(
      (provider) => provider.slug === chosen.preset && provider.scope === scope,
    );
    if (existing) {
      setSigningIn(existing);
      return;
    }
    create.mutate(
      // The address is the preset's own; an empty one tells the hub to use it.
      { preset: chosen.preset, label: chosen.label, kind: 'llm', base_url: '', scope },
      { onSuccess: (provider) => setSigningIn(provider) },
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="subscription-vendors">
      <p className="text-sm text-muted">{t('models.subscription.intro')}</p>
      {!available && (
        <Notice tone="warning">
          <span data-testid="subscription-unavailable">
            {t('models.subscription.unavailable', { reason: vendors.data.reason ?? '—' })}
          </span>
        </Notice>
      )}
      <Radio
        label={t('models.subscription.pick')}
        value={chosen?.preset ?? null}
        onChange={setPreset}
        testId="subscription-vendor-list"
        options={items.map((item) => ({
          value: item.preset,
          label: (
            <span className="flex flex-wrap items-center gap-2" data-vendor={item.vendor}>
              <span dir="auto">{item.label}</span>
              {item.usage_windows && (
                <Badge tone="info">{t('models.subscription.has_windows')}</Badge>
              )}
            </span>
          ),
          hint: t(
            item.flow === 'device'
              ? 'models.subscription.flow_device'
              : 'models.subscription.flow_link',
          ),
        }))}
      />
      {vendors.data.note && (
        <p className="text-xs text-muted" data-testid="subscription-note">
          {vendors.data.note}
        </p>
      )}
      {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}
      <div className="ch-dialog-actions">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={!available || !chosen || create.isPending}
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
