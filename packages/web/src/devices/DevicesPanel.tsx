/**
 * The Devices tab of Device connections: every phone, computer and browser linked to the
 * person (an admin sees everyone's), with when each was last seen, whether it gets push,
 * and the three things a person does to one — rename it, test it, revoke it.
 *
 * Revoking is the one act that cannot be taken back from here (a phone must be paired
 * again), so it asks first, in our own dialog.
 */
import { useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Notice,
  Skeleton,
  SkeletonGroup,
  useConfirm,
  usePrompt,
} from '../ui/index.js';
import { IconDevices } from '../ui/icons.js';
import { browserEnvironment, knownDeviceKey } from './browserPush.js';
import {
  useDeviceStream,
  useDevices,
  useRenameDevice,
  useTestPush,
  useUnlinkDevice,
  type Device,
} from './queries.js';
import { PushSendersCard } from './PushSendersCard.js';

export function DevicesPanel({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const devices = useDevices();
  useDeviceStream();
  return (
    <section className="flex flex-col gap-4" data-testid="devices-panel">
      {devices.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="4rem" radius="md" />
          <Skeleton height="4rem" radius="md" />
        </SkeletonGroup>
      )}
      {devices.isError && <Notice tone="danger">{describeError(devices.error, t)}</Notice>}
      {devices.data &&
        (devices.data.items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<IconDevices size={20} />}
            title={t('devices.list_empty_title')}
            body={t('devices.list_empty_body')}
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="device-list">
            {devices.data.items.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
          </ul>
        ))}
      {isAdmin && <PushSendersCard />}
    </section>
  );
}

function DeviceRow({ device }: { device: Device }) {
  const { t, language } = useI18n();
  const { user } = useAuth();
  const rename = useRenameDevice();
  const unlink = useUnlinkDevice();
  const test = useTestPush();
  const { ask: askName, dialog: nameDialog } = usePrompt();
  const { ask: askRevoke, dialog: confirmDialog } = useConfirm();
  const [error, setError] = useState<unknown>(null);
  const [tested, setTested] = useState<{ ok: boolean; error: string | null } | null>(null);
  const thisBrowser =
    device.kind === 'browser' && device.device_key === knownDeviceKey(browserEnvironment().storage);
  const mine = device.user_id === user?.id;
  const seen = device.last_seen_at
    ? new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(device.last_seen_at))
    : null;

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
  const onRevoke = async () => {
    const yes = await askRevoke({
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

  return (
    <li>
      <Card tone="raised" testId="device-row" data-device={device.id} className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium" dir="auto">
            {device.name}
          </span>
          <Badge>{t(`devices.kind.${device.kind}`)}</Badge>
          {(device.this_device || thisBrowser) && (
            <Badge tone="accent">
              {t(thisBrowser ? 'devices.this_browser' : 'devices.this_device')}
            </Badge>
          )}
          {!mine && <Badge tone="info">{t('devices.owner_other')}</Badge>}
          {device.online && <Badge tone="success">{t('devices.online')}</Badge>}
          <Badge tone={device.push ? 'success' : 'neutral'} testId="device-push">
            {device.push
              ? t('devices.push_on', {
                  provider: t(`devices.push.provider.${device.push.provider}`),
                })
              : t('devices.push_off')}
          </Badge>
        </div>
        <p className="text-xs text-muted" data-testid="device-seen">
          {seen ? t('devices.last_seen', { time: seen }) : t('devices.never_seen')}
          {device.app_version ? ` · ${device.app_version}` : ''}
        </p>
        <div className="flex flex-wrap gap-2">
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
            variant="danger"
            disabled={unlink.isPending}
            onClick={() => void onRevoke()}
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
      </Card>
      {nameDialog}
      {confirmDialog}
    </li>
  );
}
