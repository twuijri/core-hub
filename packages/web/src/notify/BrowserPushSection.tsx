/**
 * "Enable browser notifications": this browser becomes one of the person's devices and
 * receives what reaches their inbox by Web Push, even with the page closed (DECISIONS §66).
 *
 * The state is the browser's own (permission, subscription), read on mount and after each
 * change; the hub only learns of it through `devices.registerPush`. "Send a test" writes a
 * real notice through the same path every other notice takes, preferences included.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Button, Notice } from '../ui/index.js';
import {
  BrowserPushError,
  browserEnvironment,
  browserPushState,
  disableBrowserPush,
  enableBrowserPush,
  type BrowserPushState,
  type PushEnvironment,
} from '../devices/browserPush.js';
import { usePushConfig, useTestNotice } from '../devices/queries.js';

export function BrowserPushSection({ environment }: { environment?: PushEnvironment }) {
  const { t, language } = useI18n();
  const { client, user } = useAuth();
  const userId = user?.id ?? null;
  const env = useMemo(() => environment ?? browserEnvironment(), [environment]);
  const config = usePushConfig();
  const testNotice = useTestNotice();
  const [state, setState] = useState<BrowserPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(() => {
    void browserPushState(env, userId)
      .then(setState)
      .catch(() => setState('off'));
  }, [env, userId]);
  useEffect(refresh, [refresh]);

  const webPushKey = config.data?.webpush_public_key ?? null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const reason = error instanceof BrowserPushError ? error.reason : null;
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="browser-push-heading"
      data-testid="browser-push"
      data-state={state ?? 'loading'}
    >
      <h3 id="browser-push-heading" className="text-sm font-semibold">
        {t('notify.browser.title')}
      </h3>
      {state === 'unsupported' ? (
        <Notice tone="warning">{t('notify.browser.unsupported')}</Notice>
      ) : state === 'denied' ? (
        <Notice tone="warning">{t('notify.browser.denied')}</Notice>
      ) : config.data && !webPushKey ? (
        <Notice tone="warning">{t('notify.browser.no_key')}</Notice>
      ) : (
        <p className="text-sm text-muted">
          {t(state === 'on' ? 'notify.browser.on' : 'notify.browser.off')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {state === 'on' ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => disableBrowserPush(client, env))}
            data-testid="browser-push-disable"
          >
            {t('notify.browser.disable')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={busy || state === 'unsupported' || state === null || !webPushKey}
            onClick={() =>
              void run(() =>
                enableBrowserPush(client, env, {
                  publicKey: webPushKey,
                  locale: language === 'en' ? 'en' : 'ar',
                  userId,
                }),
              )
            }
            data-testid="browser-push-enable"
          >
            {t('notify.browser.enable')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={testNotice.isPending}
          onClick={() => testNotice.mutate()}
          data-testid="send-test-notice"
        >
          {t('notify.test')}
        </Button>
      </div>
      {testNotice.isSuccess && <Notice tone="success">{t('notify.test_sent')}</Notice>}
      {testNotice.isError && <Notice tone="danger">{describeError(testNotice.error, t)}</Notice>}
      {error !== null &&
        (reason ? (
          <Notice tone="warning">{t(`notify.browser.${reason}`)}</Notice>
        ) : (
          <Notice tone="danger">{describeError(error, t)}</Notice>
        ))}
    </section>
  );
}
