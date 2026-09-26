/**
 * One linked device as a card (the owner's request of 2026-09-25: a pill that said only
 * "iPhone" told two phones apart by nothing). What it is — an icon for its kind, the name the
 * device gave or a person chose, its model, its system and app versions — then when it was
 * last active (relative, the exact time on hover and focus) and paired, where its push
 * stands, and the three things a person does to it: rename, test, remove.
 *
 * Removing is the one act that cannot be taken back from here (a phone must be paired again),
 * so it asks first, in our own dialog.
 */
import type { components } from '@corehub/contracts';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Button, Card, Notice, Tooltip, useConfirm, usePrompt } from '../ui/index.js';
import { IconDisplay, IconGlobe, IconPhone, IconTablet } from '../ui/icons.js';
import { browserEnvironment, knownDeviceKey } from './browserPush.js';
import {
  exactTime,
  modelLine,
  osKey,
  pushView,
  relativeTime,
  shortDate,
  type PushView,
} from './format.js';
import { useRenameDevice, useTestPush, useUnlinkDevice, type Device } from './queries.js';

type PushProvider = components['schemas']['PushProvider'];

/** Re-renders once a minute, so "2 minutes ago" does not stay "now". */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function DeviceIcon({ device, label }: { device: Device; label: string }) {
  const props = { size: 22, label };
  if (device.kind === 'browser') return <IconGlobe {...props} />;
  if (device.kind === 'computer') return <IconDisplay {...props} />;
  if (device.kind === 'tablet') return <IconTablet {...props} />;
  return <IconPhone {...props} platform={device.platform === 'ios' ? 'ios' : 'android'} />;
}

const PUSH_TONE: Record<PushView['state'], 'success' | 'warning' | 'neutral'> = {
  on: 'success',
  permission_pending: 'warning',
  permission_denied: 'warning',
  no_sender: 'neutral',
  not_in_build: 'neutral',
  off: 'neutral',
};

export function DeviceCard({
  device,
  readyProviders,
  justPaired = false,
  isAdmin = false,
  onSetUpPush,
  now: fixedNow,
}: {
  device: Device;
  /** The hub's senders that can deliver now; null while unknown. */
  readyProviders: readonly PushProvider[] | null;
  /** The device this page's pairing just made. */
  justPaired?: boolean;
  isAdmin?: boolean;
  /** Opens the push senders (an admin only). */
  onSetUpPush?: () => void;
  /** The clock, for tests. */
  now?: number;
}) {
  const { t, language } = useI18n();
  const { user } = useAuth();
  const clock = useMinuteClock();
  const now = fixedNow ?? clock;
  const rename = useRenameDevice();
  const unlink = useUnlinkDevice();
  const test = useTestPush();
  const { ask: askName, dialog: nameDialog } = usePrompt();
  const { ask: askRemove, dialog: confirmDialog } = useConfirm();
  const [error, setError] = useState<unknown>(null);
  const [tested, setTested] = useState<{ ok: boolean; error: string | null } | null>(null);
  const thisBrowser =
    device.kind === 'browser' && device.device_key === knownDeviceKey(browserEnvironment().storage);
  const mine = device.user_id === user?.id;
  const push = pushView(device, readyProviders);
  const model = modelLine(device);
  const os = osKey(device);

  const onRename = async () => {
    const name = await askName({
      title: t('devices.rename_title'),
      label: t('devices.name_label'),
      initialValue: device.name,
      confirmLabel: t('devices.rename'),
    });
    if (!name || name === device.name) return;
    setError(null);
    rename.mutate({ id: device.id, name }, { onError: setError });
  };
  const onRemove = async () => {
    const yes = await askRemove({
      title: t('devices.revoke_title', { name: device.name }),
      body: t('devices.revoke_body'),
      confirmLabel: t('devices.revoke'),
    });
    if (!yes) return;
    setError(null);
    unlink.mutate(device.id, { onError: setError });
  };
  const onTest = () => {
    setTested(null);
    test.mutate(device.id, {
      onSuccess: (result) => setTested({ ok: result.status === 'sent', error: result.error }),
      onError: setError,
    });
  };

  const provider = (name: PushProvider) => t(`devices.push.provider.${name}`);
  const pushLabel =
    push.state === 'on' || push.state === 'no_sender'
      ? t(`devices.push_state.${push.state}`, { provider: provider(push.provider) })
      : t(`devices.push_state.${push.state}`);

  return (
    <li>
      <Card
        tone="raised"
        testId="device-row"
        data-device={device.id}
        data-kind={device.kind}
        className="h-full"
      >
        {/* The kit's card stacks its children; the icon sits beside the text instead. */}
        <div className="flex items-start gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-md bg-sunken text-muted"
            data-testid="device-icon"
            data-icon={device.kind === 'phone' ? `${device.kind}-${device.platform}` : device.kind}
          >
            <DeviceIcon device={device} label={t(`devices.kind.${device.kind}`)} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium" dir="auto" data-testid="device-name">
                {device.name}
              </span>
              {justPaired && (
                <Badge tone="accent" testId="device-just-paired">
                  {t('devices.just_paired')}
                </Badge>
              )}
              {(device.this_device || thisBrowser) && (
                <Badge tone="accent" testId="device-this">
                  {t(thisBrowser ? 'devices.this_browser' : 'devices.this_device')}
                </Badge>
              )}
              {!mine && <Badge tone="info">{t('devices.owner_other')}</Badge>}
              {device.online && (
                <Badge tone="success" dot>
                  {t('devices.online')}
                </Badge>
              )}
            </div>
            {model && model !== device.name && (
              <p className="text-sm" dir="auto" data-testid="device-model">
                {model}
              </p>
            )}
            {(os || device.app_version) && (
              <p className="text-xs text-muted" data-testid="device-versions">
                {os && (
                  <span>
                    {t(os)}
                    {device.os_version && (
                      <>
                        {' '}
                        <bdi dir="ltr">{device.os_version}</bdi>
                      </>
                    )}
                  </span>
                )}
                {os && device.app_version && <span aria-hidden> · </span>}
                {device.app_version && (
                  <span>
                    {t('app.name')} <bdi dir="ltr">{device.app_version}</bdi>
                  </span>
                )}
              </p>
            )}
            <p className="text-xs text-muted" data-testid="device-seen">
              {device.last_seen_at ? (
                <>
                  {t('devices.last_active')}{' '}
                  <Tooltip label={exactTime(device.last_seen_at, language)}>
                    <time
                      dateTime={device.last_seen_at}
                      tabIndex={0}
                      className="underline decoration-dotted underline-offset-2"
                      data-testid="device-seen-time"
                    >
                      {relativeTime(device.last_seen_at, now, language)}
                    </time>
                  </Tooltip>
                </>
              ) : (
                t('devices.never_seen')
              )}
              {device.paired_at && (
                <>
                  <span aria-hidden> · </span>
                  <span data-testid="device-paired">
                    {t(device.kind === 'browser' ? 'devices.added_on' : 'devices.paired_on', {
                      date: shortDate(device.paired_at, language),
                    })}
                  </span>
                </>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={PUSH_TONE[push.state]} testId="device-push">
                <span data-state={push.state}>{pushLabel}</span>
              </Badge>
              {push.state === 'no_sender' && isAdmin && onSetUpPush && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onSetUpPush}
                  data-testid="device-set-up-push"
                >
                  {t('devices.push_set_up')}
                </Button>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onRename()}
                data-testid="device-rename"
              >
                {t('devices.rename')}
              </Button>
              {device.push && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={test.isPending}
                  onClick={onTest}
                  data-testid="device-test"
                >
                  {t('devices.test_push')}
                </Button>
              )}
              <Button
                size="sm"
                variant="danger-quiet"
                disabled={unlink.isPending}
                onClick={() => void onRemove()}
                data-testid="device-revoke"
              >
                {t('devices.revoke')}
              </Button>
            </div>
            {tested && (
              <Notice tone={tested.ok ? 'success' : 'warning'}>
                {tested.ok
                  ? t('devices.test_sent')
                  : t('devices.test_failed', { error: tested.error ?? '' })}
              </Notice>
            )}
            {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
          </div>
        </div>
      </Card>
      {nameDialog}
      {confirmDialog}
    </li>
  );
}
