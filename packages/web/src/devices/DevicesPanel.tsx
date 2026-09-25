/**
 * The devices on Device connections: every phone, computer and browser linked to the person
 * (an admin sees everyone's), as cards grouped by kind — phones and tablets, computers,
 * browsers — always loaded from the hub, so a device paired a minute ago is still there when
 * the person comes back to the page.
 *
 * Push setup is not a device's business: for an admin it waits folded at the bottom
 * (`PushSendersSection`), and a card whose push cannot work because the hub has no sender
 * for its kind says so in one line, with a way there.
 */
import { useRef, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { EmptyState, Notice, Skeleton, SkeletonGroup } from '../ui/index.js';
import { IconDevices } from '../ui/icons.js';
import { DeviceCard } from './DeviceCard.js';
import { groupOf, type DeviceGroup } from './format.js';
import { useDeviceStream, useDevices, usePushConfig } from './queries.js';
import { PushSendersSection } from './PushSendersCard.js';

const GROUPS: readonly DeviceGroup[] = ['mobile', 'computer', 'browser'];

export function DevicesPanel({
  isAdmin,
  justPaired = null,
}: {
  isAdmin: boolean;
  /** The device a pairing on this page just made, marked until the page is left. */
  justPaired?: string | null;
}) {
  const { t } = useI18n();
  const devices = useDevices();
  const config = usePushConfig();
  useDeviceStream();
  const [sendersOpen, setSendersOpen] = useState(false);
  const senders = useRef<HTMLDetailsElement>(null);
  const ready = config.data?.providers ?? null;
  const openSenders = () => {
    setSendersOpen(true);
    requestAnimationFrame(() => senders.current?.scrollIntoView?.({ block: 'start' }));
  };
  const items = devices.data?.items ?? [];
  const grouped = GROUPS.map((group) => ({
    group,
    members: items.filter((device) => groupOf(device) === group),
  })).filter((entry) => entry.members.length > 0);

  return (
    <section className="flex flex-col gap-4" data-testid="devices-panel">
      <h2 className="text-base font-semibold">
        {t(isAdmin ? 'devices.list_title_admin' : 'devices.list_title')}
      </h2>
      {devices.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="6rem" radius="md" />
          <Skeleton height="6rem" radius="md" />
        </SkeletonGroup>
      )}
      {devices.isError && <Notice tone="danger">{describeError(devices.error, t)}</Notice>}
      {devices.data &&
        (items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<IconDevices size={20} />}
            title={t('devices.list_empty_title')}
            body={t('devices.list_empty_body')}
          />
        ) : (
          <div className="flex flex-col gap-5" data-testid="device-list">
            {grouped.map(({ group, members }) => (
              <section
                key={group}
                className="flex flex-col gap-2"
                data-testid={`device-group-${group}`}
                aria-labelledby={`device-group-${group}`}
              >
                <h3 id={`device-group-${group}`} className="text-sm font-medium text-muted">
                  {t(`devices.group.${group}`)}
                </h3>
                <ul className="grid gap-3 lg:grid-cols-2">
                  {members.map((device) => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      readyProviders={ready}
                      justPaired={device.id === justPaired}
                      isAdmin={isAdmin}
                      onSetUpPush={openSenders}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ))}
      {isAdmin && (
        <PushSendersSection ref={senders} open={sendersOpen} onOpenChange={setSendersOpen} />
      )}
    </section>
  );
}
