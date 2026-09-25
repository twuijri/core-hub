/**
 * This device — the desktop app's own settings (NAVIGATION §2, `this_device`).
 *
 * Only the desktop and phone surfaces have this tab; in the desktop app the web client
 * learns about the computer through the bridge the app puts on `window`
 * (`desktop/desktop.ts`). What lives here belongs to this computer, not to the hub or the
 * person: which hub the window talks to and in which mode, the app's version, and whether
 * closing the window keeps it in the tray.
 *
 * Voice input, dictation language and spoken replies are listed by the navigation note too;
 * the desktop app does not do voice yet, and the page says so rather than showing switches
 * that do nothing.
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { useMeta } from '../hub/queries.js';
import { desktopBridge, type DesktopState } from '../desktop/desktop.js';
import { Button, Notice, Skeleton, SkeletonGroup, Switch, Table } from '../ui/index.js';

const PLATFORM_KEY: Record<string, string> = {
  darwin: 'this_device.platform_macos',
  win32: 'this_device.platform_windows',
  linux: 'this_device.platform_linux',
};

export function ThisDeviceTab() {
  const { t } = useI18n();
  const bridge = desktopBridge();
  const meta = useMeta();
  const [state, setState] = useState<DesktopState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge
      .getState()
      .then((next) => live && setState(next))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [bridge]);

  if (!bridge) return <Notice tone="warning">{t('this_device.not_desktop')}</Notice>;
  if (failed) return <Notice tone="danger">{t('this_device.unavailable')}</Notice>;
  if (!state)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="10rem" radius="md" />
      </SkeletonGroup>
    );

  const hubState = meta.isPending
    ? t('this_device.hub_checking')
    : meta.isError
      ? t('this_device.hub_unreachable')
      : t('this_device.hub_connected', { version: meta.data.server_version });

  const rows = [
    {
      key: 'mode',
      label: t('this_device.mode'),
      value: t(state.mode === 'local' ? 'this_device.mode_local' : 'this_device.mode_remote'),
      ltr: false,
    },
    { key: 'hub', label: t('this_device.hub'), value: state.hubUrl ?? '—', ltr: true },
    { key: 'hub-state', label: t('this_device.hub_state'), value: hubState, ltr: false },
    { key: 'version', label: t('this_device.app_version'), value: state.appVersion, ltr: true },
    {
      key: 'platform',
      label: t('this_device.platform'),
      value: PLATFORM_KEY[state.platform] ? t(PLATFORM_KEY[state.platform]!) : state.platform,
      ltr: false,
    },
  ];

  return (
    <div className="flex flex-col gap-6" data-testid="this-device">
      <section className="flex flex-col gap-3" aria-labelledby="this-device-connection">
        <h3 id="this-device-connection" className="text-sm font-semibold">
          {t('this_device.connection')}
        </h3>
        <Table
          caption={t('this_device.connection')}
          testId="this-device-facts"
          rows={rows}
          rowKey={(row) => row.key}
          columns={[
            { key: 'label', header: t('account.field'), cell: (row) => row.label },
            {
              key: 'value',
              header: t('account.value'),
              cell: (row) => (
                <span {...(row.ltr ? { dir: 'ltr' } : {})} data-testid={`this-device-${row.key}`}>
                  {row.value}
                </span>
              ),
            },
          ]}
        />
        <p className="text-sm text-muted">{t('this_device.change_hint')}</p>
        <div>
          <Button
            variant="secondary"
            onClick={() => void bridge.changeConnection()}
            data-testid="this-device-change"
          >
            {t('this_device.change')}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="this-device-window">
        <h3 id="this-device-window" className="text-sm font-semibold">
          {t('this_device.window')}
        </h3>
        <Switch
          checked={state.trayAvailable && state.closeToTray}
          disabled={!state.trayAvailable}
          onChange={(next) => void bridge.setCloseToTray(next).then((s) => s && setState(s))}
          label={t('this_device.close_to_tray')}
          hint={
            state.trayAvailable ? t('this_device.close_to_tray_hint') : t('this_device.no_tray')
          }
          testId="this-device-tray"
        />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="this-device-voice">
        <h3 id="this-device-voice" className="text-sm font-semibold">
          {t('this_device.voice')}
        </h3>
        <Notice>{t('this_device.voice_later')}</Notice>
      </section>
    </div>
  );
}
