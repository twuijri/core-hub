// Device connections (NAVIGATION §1): tab App pairs a phone with a QR from `auth.createPairing`
// and waits for `pairing.claimed` on `/rt/devices` (polling `auth.getPairing` as fallback);
// tab Devices (admin) lists linked devices once the devices module serves them.
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { useRealtime } from '../realtime/context.js';
import { isEnvelope } from '../realtime/envelope.js';
import { AppShell } from '../shell/AppShell.js';
import type { Pairing } from '../types.js';
import { Button, Card, EmptyState, Notice, TabPanel, Tabs } from '../ui/index.js';
import { IconDevices } from '../ui/icons.js';
import { phaseOf } from './PlaceholderScreen.js';

export function qrSvgPath(text: string): { path: string; size: number } {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let r = 0; r < size; r += 1)
    for (let c = 0; c < size; c += 1) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
  return { path, size };
}

export function QrCode({ text }: { text: string }) {
  const { path, size } = useMemo(() => qrSvgPath(text), [text]);
  return (
    <svg
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      className="size-56 rounded-md bg-white"
      role="img"
      aria-label="QR"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

export function DeviceConnectionsScreen() {
  const { t } = useI18n();
  const { client, user } = useAuth();
  const realtime = useRealtime();
  const [tab, setTab] = useState<'app' | 'devices'>('app');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [claimedName, setClaimedName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());
  const title = t(termKey('device_connections'));
  const isAdmin = user?.role === 'admin' || user?.role === 'owner';

  const start = async () => {
    setError(null);
    setClaimedName(null);
    try {
      const { data } = await client.request('post', '/auth/pairings', {
        body: { connection: 'lan', ttl_seconds: 300 },
      });
      setPairing(data);
    } catch (err) {
      setError(err);
    }
  };

  useEffect(() => {
    if (!pairing || pairing.status !== 'pending') return;
    const socket = realtime.socket('devices');
    const onClaimed = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      const payload = raw.payload as { pairing?: Pairing; device?: { name: string } };
      if (payload.pairing?.id === pairing.id) {
        setPairing(payload.pairing);
        setClaimedName(payload.device?.name ?? null);
      }
    };
    socket.on('pairing.claimed', onClaimed);
    if (!socket.connected) socket.connect();
    const poll = setInterval(() => {
      setNow(Date.now());
      client
        .request('get', '/auth/pairings/{pairing_id}', { params: { pairing_id: pairing.id } })
        .then(({ data }) => {
          if (data.status !== 'pending') setPairing(data);
        })
        .catch(() => undefined);
    }, 5_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      socket.off('pairing.claimed', onClaimed);
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [pairing?.id, pairing?.status, client, realtime.epoch]);

  const secondsLeft = pairing
    ? Math.max(0, Math.round((Date.parse(pairing.expires_at) - now) / 1000))
    : 0;

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      {/* Two sections of one page, switched in place: that is a tab set, and it carries
          the tab semantics (`role="tablist"`, arrow keys, `aria-controls`) a segmented
          control must not claim. */}
      <Tabs
        label={title}
        value={tab}
        onValueChange={(next) => setTab(next as 'app' | 'devices')}
        testId="devices-tabs"
        items={[
          { value: 'app', label: t('devices.tab.app') },
          ...(isAdmin ? [{ value: 'devices', label: t('devices.tab.devices') }] : []),
        ]}
      >
        <TabPanel value="app">
          <section className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted">{t('devices.pair_intro')}</p>
            <Button variant="primary" onClick={() => void start()} data-testid="start-pairing">
              {pairing ? t('devices.pair_again') : t('devices.pair')}
            </Button>
            {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
            {pairing && (
              <Card
                tone="raised"
                className="items-center self-stretch sm:self-start"
                testId="pairing"
                data-status={pairing.status}
              >
                {pairing.status === 'pending' && secondsLeft > 0 ? (
                  <>
                    <QrCode text={pairing.qr_payload} />
                    <p
                      className="font-mono text-2xl tracking-widest"
                      dir="ltr"
                      data-testid="pairing-code"
                    >
                      {pairing.code}
                    </p>
                    <p className="text-xs text-muted">
                      {t('devices.expires_in', { seconds: secondsLeft })}
                    </p>
                  </>
                ) : pairing.status === 'claimed' ? (
                  <Notice tone="success">
                    {t('devices.claimed', { name: claimedName ?? pairing.device_id ?? '' })}
                  </Notice>
                ) : (
                  <Notice tone="warning">
                    {t(
                      `devices.pairing_${pairing.status === 'cancelled' ? 'cancelled' : 'expired'}`,
                    )}
                  </Notice>
                )}
              </Card>
            )}
          </section>
        </TabPanel>
        {isAdmin && (
          <TabPanel value="devices">
            <EmptyState
              icon={<IconDevices size={20} />}
              title={t('devices.tab.devices')}
              body={t('placeholder.later', {
                name: t('devices.tab.devices'),
                phase: phaseOf('devices'),
              })}
            />
          </TabPanel>
        )}
      </Tabs>
    </AppShell>
  );
}
