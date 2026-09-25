/**
 * Updates, inside This device (ADR 0023): the app's version, whether it looks for a new one
 * once a day, and — when there is one — a link to its installer. The app never downloads or
 * installs anything by itself; the person clicks Download and installs it as they installed
 * this one. The Microsoft Store build (`channel: 'store'`) only says the Store updates it.
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { Button, Notice, Switch } from '../ui/index.js';
import type { DesktopBridge, DesktopUpdatesState } from './bridge-types.js';

export function UpdatesSection({ bridge, version }: { bridge: DesktopBridge; version: string }) {
  const { t, language } = useI18n();
  const [state, setState] = useState<DesktopUpdatesState | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    void bridge.updates
      .get()
      .then((next) => live && setState(next))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bridge]);

  if (!state) return null;
  if (state.channel === 'store')
    return (
      <section
        className="flex flex-col gap-3"
        aria-labelledby="updates-heading"
        data-testid="desktop-updates"
      >
        <h3 id="updates-heading" className="text-sm font-semibold">
          {t('desktop_updates.title')}
        </h3>
        <p className="text-sm">{t('desktop_updates.current', { version: `⁨${version}⁩` })}</p>
        <Notice>
          <span data-testid="updates-store">{t('desktop_updates.from_store')}</span>{' '}
          <a href={state.releasesPage} target="_blank" rel="noreferrer" className="text-link">
            {t('desktop_updates.store_page')}
          </a>
        </Notice>
      </section>
    );
  const last = state.last;
  const when = last
    ? new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(last.checkedAt))
    : null;

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="updates-heading"
      data-testid="desktop-updates"
    >
      <h3 id="updates-heading" className="text-sm font-semibold">
        {t('desktop_updates.title')}
      </h3>
      <p className="text-sm">{t('desktop_updates.current', { version: `⁨${version}⁩` })}</p>
      <Switch
        checked={state.auto}
        onChange={(next) => void bridge.updates.setAuto(next).then(setState)}
        label={t('desktop_updates.auto')}
        hint={t('desktop_updates.auto_hint')}
        testId="updates-auto"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={checking}
          data-testid="updates-check"
          onClick={() => {
            setChecking(true);
            void bridge.updates
              .check()
              .then(setState)
              .finally(() => setChecking(false));
          }}
        >
          {checking ? t('desktop_updates.checking') : t('desktop_updates.check')}
        </Button>
        <a href={state.releasesPage} target="_blank" rel="noreferrer" className="text-sm text-link">
          {t('desktop_updates.all_releases')}
        </a>
      </div>
      {last?.status === 'available' && last.update && (
        <Notice tone="success">
          <span data-testid="updates-available">
            {t('desktop_updates.available', { version: `⁨${last.update.version}⁩` })}
          </span>{' '}
          <a
            href={last.update.download}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-link"
            data-testid="updates-download"
          >
            {t('desktop_updates.download')}
            {last.update.size
              ? ` (${t('desktop_updates.size', { size: (last.update.size / 1_000_000).toFixed(0) })})`
              : ''}
          </a>{' '}
          ·{' '}
          <a href={last.update.page} target="_blank" rel="noreferrer" className="text-link">
            {t('desktop_updates.notes')}
          </a>
        </Notice>
      )}
      {last?.status === 'up_to_date' && (
        <Notice>
          <span data-testid="updates-latest">{t('desktop_updates.up_to_date')}</span>
        </Notice>
      )}
      {last?.status === 'failed' && (
        <Notice tone="danger">
          {t('desktop_updates.failed', { message: last.message ?? '' })}
        </Notice>
      )}
      {when && (
        <p className="text-xs text-muted">{t('desktop_updates.checked_at', { time: when })}</p>
      )}
    </section>
  );
}
