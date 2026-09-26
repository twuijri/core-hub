/**
 * Updates, inside This device (DECISIONS §109): the app's version, whether it looks for a new
 * one on its own, and what it found. How it updates depends on how it was installed (`mode`):
 * - `install` (the Windows .exe, macOS, the Linux AppImage): a new version downloads in the
 *   background, and "Restart to update" installs it; otherwise it is installed on quit;
 * - `notify` (the Linux .deb): the new version is announced with the download page;
 * - the Microsoft Store build (`channel: 'store'`) only says the Store updates it.
 * The floating card over every page is `UpdateNotice.tsx`; this part is where the person looks.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { Button, Notice, Switch, buttonClass } from '../ui/index.js';
import type { DesktopBridge } from './bridge-types.js';
import { useDesktopUpdates } from './updates.js';

export function UpdatesSection({ bridge, version }: { bridge: DesktopBridge; version: string }) {
  const { t, language } = useI18n();
  const [state, setState] = useDesktopUpdates(bridge);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);

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
  const pending = state.pending ?? null;
  const busy = checking || state.checking === true;
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
      data-mode={state.mode ?? 'notify'}
    >
      <h3 id="updates-heading" className="text-sm font-semibold">
        {t('desktop_updates.title')}
      </h3>
      <p className="text-sm">{t('desktop_updates.current', { version: `⁨${version}⁩` })}</p>
      <Switch
        checked={state.auto}
        onChange={(next) => void bridge.updates.setAuto(next).then(setState)}
        label={t('desktop_updates.auto')}
        hint={t(
          state.mode === 'install'
            ? 'desktop_updates.auto_hint'
            : 'desktop_updates.auto_hint_notify',
        )}
        testId="updates-auto"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={busy}
          data-testid="updates-check"
          onClick={() => {
            setChecking(true);
            void bridge.updates
              .check()
              .then(setState)
              .finally(() => setChecking(false));
          }}
        >
          {busy ? t('desktop_updates.checking') : t('desktop_updates.check')}
        </Button>
        <a href={state.releasesPage} target="_blank" rel="noreferrer" className="text-sm text-link">
          {t('desktop_updates.all_releases')}
        </a>
      </div>
      {pending?.status === 'ready' && (
        <Notice tone="success">
          <span className="flex flex-col items-start gap-2">
            <span data-testid="updates-ready">
              {t('desktop_updates.ready', { version: `⁨${pending.version}⁩` })}{' '}
              {t('desktop_updates.ready_hint')}
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={restarting}
              data-testid="updates-restart"
              onClick={() => {
                setRestarting(true);
                void bridge.updates.restart?.().catch(() => setRestarting(false));
              }}
            >
              {t('desktop_updates.restart')}
            </Button>
          </span>
        </Notice>
      )}
      {pending?.status === 'downloading' && (
        <Notice>
          <span data-testid="updates-downloading">
            {pending.percent === null
              ? t('desktop_updates.downloading', { version: `⁨${pending.version}⁩` })
              : t('desktop_updates.downloading_percent', {
                  version: `⁨${pending.version}⁩`,
                  percent: String(pending.percent),
                })}
          </span>
        </Notice>
      )}
      {!pending && last?.status === 'available' && last.update && (
        <Notice tone="success">
          <span data-testid="updates-available">
            {t('desktop_updates.available', { version: `⁨${last.update.version}⁩` })}
          </span>{' '}
          {state.mode ? (
            // The .deb (and `install` when its feed could not be read) goes to the download page.
            <a
              href={state.downloadPage ?? last.update.download}
              target="_blank"
              rel="noreferrer"
              className={buttonClass('primary', 'sm')}
              data-testid="updates-download"
            >
              {t('desktop_updates.download_page')}
            </a>
          ) : (
            // An app from before the update modes: the installer itself.
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
            </a>
          )}{' '}
          ·{' '}
          <a href={last.update.page} target="_blank" rel="noreferrer" className="text-link">
            {t('desktop_updates.notes')}
          </a>
        </Notice>
      )}
      {!pending && last?.status === 'up_to_date' && (
        <Notice>
          <span data-testid="updates-latest">{t('desktop_updates.up_to_date')}</span>
        </Notice>
      )}
      {!pending && last?.status === 'failed' && (
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
