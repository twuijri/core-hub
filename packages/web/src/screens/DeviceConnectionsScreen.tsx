// Device connections (NAVIGATION §1), one page since 2026-09-26 (it had tabs App / Devices, and
// a phone paired on App vanished from App once the page was left): at the top, pairing a phone
// or computer with a QR from `auth.createPairing`, waiting for `pairing.claimed` on
// `/rt/devices` (polling `auth.getPairing` as fallback); below it, every linked device as a
// card, loaded from the hub (an admin: everyone's, and the push senders folded at the bottom).
import { PRODUCT } from '@corehub/contracts';
import { useQueryClient } from '@tanstack/react-query';
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
import { Button, Card, Notice } from '../ui/index.js';
import { DevicesPanel } from '../devices/DevicesPanel.js';
import { deviceKeys } from '../devices/queries.js';

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

/**
 * The pairing as a `corehub://pair` link, for a computer: a desktop app cannot scan the
 * screen it is showing, but it opens its own links (apps/desktop, deep links). `null` when
 * the payload is not a pairing.
 */
export function pairingLinkOf(qrPayload: string): string | null {
  try {
    const value = JSON.parse(qrPayload) as Record<string, unknown>;
    if (
      typeof value.hub_url !== 'string' ||
      typeof value.pairing_id !== 'string' ||
      typeof value.code !== 'string'
    )
      return null;
    const query = new URLSearchParams({
      hub: value.hub_url,
      id: value.pairing_id,
      code: value.code,
    });
    return `${PRODUCT.id}://pair?${query.toString()}`;
  } catch {
    return null;
  }
}

function PairingLink({ qrPayload }: { qrPayload: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const link = pairingLinkOf(qrPayload);
  if (!link) return null;
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <p className="text-xs text-muted">{t('devices.pair_link')}</p>
      <a
        href={link}
        dir="ltr"
        className="break-all font-mono text-xs text-link"
        data-testid="pairing-link"
      >
        {link}
      </a>
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          void navigator.clipboard.writeText(link).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? t('devices.copied') : t('devices.copy_link')}
      </Button>
    </div>
  );
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

/** The address a pairing's QR gives the phone. */
function hubUrlOf(qrPayload: string): string | null {
  try {
    const url = (JSON.parse(qrPayload) as { hub_url?: unknown }).hub_url;
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

export function DeviceConnectionsScreen() {
  const { t } = useI18n();
  const { client, user } = useAuth();
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now());
  const title = t(termKey('device_connections'));
  const isAdmin = user?.role === 'admin' || user?.role === 'owner';

  // A claimed pairing is not shown as such: the device it made joins the list below (fetched
  // again from the hub) and is marked there.
  const claimed = (next: Pairing) => {
    setPairing(null);
    setJustPaired(next.device_id);
    void queryClient.invalidateQueries({ queryKey: deviceKeys.list });
  };

  const start = async () => {
    setError(null);
    setJustPaired(null);
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
      const payload = raw.payload as { pairing?: Pairing };
      if (payload.pairing?.id === pairing.id) {
        if (payload.pairing.status === 'claimed') claimed(payload.pairing);
        else setPairing(payload.pairing);
      }
    };
    socket.on('pairing.claimed', onClaimed);
    if (!socket.connected) socket.connect();
    const poll = setInterval(() => {
      setNow(Date.now());
      client
        .request('get', '/auth/pairings/{pairing_id}', { params: { pairing_id: pairing.id } })
        .then(({ data }) => {
          if (data.status === 'claimed') claimed(data);
          else if (data.status !== 'pending') setPairing(data);
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
      <div className="flex flex-col gap-8">
        <section
          className="flex flex-col items-start gap-3"
          data-testid="pairing-section"
          aria-labelledby="pair-heading"
        >
          <h2 id="pair-heading" className="text-base font-semibold">
            {t('devices.pair_heading')}
          </h2>
          <p className="text-sm text-muted">{t('devices.pair_intro')}</p>
          <Button variant="primary" onClick={() => void start()} data-testid="start-pairing">
            {pairing ? t('devices.pair_again') : t('devices.pair')}
          </Button>
          {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
          {pairing && (
            <Card
              tone="raised"
              className="mt-2 items-center self-stretch sm:self-start"
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
                  <PairingLink qrPayload={pairing.qr_payload} />
                  {pairing.connection === 'relay' && (
                    <p className="text-xs text-muted" data-testid="pairing-relay">
                      {t('devices.pair_through_relay', {
                        url: `⁨${hubUrlOf(pairing.qr_payload) ?? '—'}⁩`,
                      })}
                    </p>
                  )}
                </>
              ) : (
                <Notice tone="warning">
                  {t(`devices.pairing_${pairing.status === 'cancelled' ? 'cancelled' : 'expired'}`)}
                </Notice>
              )}
            </Card>
          )}
        </section>
        <DevicesPanel isAdmin={isAdmin} justPaired={justPaired} />
      </div>
    </AppShell>
  );
}
