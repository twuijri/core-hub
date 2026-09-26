/**
 * The desktop app's "a new version is here" card, floating at the page's lower end corner
 * (DECISIONS §109). It looks like a toast (the same surface, border and shadow) but stays until
 * the person answers, because it asks for something: "Restart to update" or "Later". "Later"
 * hides it for that version until the app starts again; the downloaded version is installed
 * when the app quits anyway. Nothing renders in a browser or the Store build.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { Button, buttonClass } from '../ui/index.js';
import { desktopBridge } from './desktop.js';
import { updateNoticeOf, useDesktopUpdates } from './updates.js';

export function DesktopUpdateNotice() {
  const { t } = useI18n();
  const bridge = desktopBridge();
  const [state, setState] = useDesktopUpdates(bridge);
  const [restarting, setRestarting] = useState(false);
  const notice = updateNoticeOf(state);
  if (!bridge || !notice) return null;

  const version = `⁨${notice.version}⁩`;
  const later = () => {
    // The app remembers it for this run, so another page or a reload keeps the card away.
    if (state) setState({ ...state, dismissed: notice.version });
    void bridge.updates
      .dismiss?.(notice.version)
      .then((next) => next && setState(next))
      .catch(() => {});
  };

  return (
    <section
      className="ch-toast ch-update-notice"
      data-tone="success"
      role="status"
      aria-live="polite"
      aria-label={t('desktop_updates.notice_label')}
      data-testid="update-notice"
      data-kind={notice.kind}
    >
      <div className="ch-toast-text">
        <p className="ch-toast-title">
          {notice.kind === 'ready'
            ? t('desktop_updates.ready', { version })
            : t('desktop_updates.available', { version })}
        </p>
        <p className="ch-toast-body">
          {notice.kind === 'ready'
            ? t('desktop_updates.ready_hint')
            : t('desktop_updates.available_hint')}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {notice.kind === 'ready' ? (
            <Button
              variant="primary"
              size="sm"
              disabled={restarting}
              data-testid="update-restart"
              onClick={() => {
                setRestarting(true);
                void bridge.updates.restart?.().catch(() => setRestarting(false));
              }}
            >
              {t('desktop_updates.restart')}
            </Button>
          ) : (
            <a
              href={notice.href}
              target="_blank"
              rel="noreferrer"
              className={buttonClass('primary', 'sm')}
              data-testid="update-get"
            >
              {t('desktop_updates.download_page')}
            </a>
          )}
          <Button variant="ghost" size="sm" data-testid="update-later" onClick={later}>
            {t('desktop_updates.later')}
          </Button>
        </div>
      </div>
    </section>
  );
}
