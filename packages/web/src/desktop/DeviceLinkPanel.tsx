/**
 * How a hub on a server reaches this computer (ADR 0025): the app's own device connection.
 *
 * Linking makes a pairing with the person's own sign-in (`auth.createPairing`) and hands it to
 * the app, which claims it and keeps the device token itself — the page never holds it. Once
 * linked, the app answers the hub from its main process, window or not, and the person picks
 * which of their profiles may use this computer (all of them until they narrow it).
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { deviceKeys, useDevices } from '../devices/queries.js';
import { useProfiles } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Button, Checkbox, Notice, type BadgeTone } from '../ui/index.js';
import type { DesktopBridge, DesktopDeviceState, DesktopDeviceStatus } from './bridge-types.js';
import { Fold } from './HelperSection.js';

const TONE: Record<DesktopDeviceStatus, BadgeTone> = {
  connected: 'success',
  connecting: 'info',
  offline: 'warning',
  refused: 'danger',
  stopped: 'neutral',
  unlinked: 'neutral',
};

export function DeviceLinkPanel({ bridge }: { bridge: DesktopBridge }) {
  const { t } = useI18n();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [state, setState] = useState<DesktopDeviceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const devices = useDevices();
  const profiles = useProfiles();

  useEffect(() => {
    let live = true;
    const load = () =>
      bridge.device
        .get()
        .then((next) => live && setState(next))
        .catch(() => {});
    load();
    const timer = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bridge]);

  if (!state) return null;
  const device = devices.data?.items.find((d) => d.id === state.deviceId) ?? null;
  const all = (profiles.data ?? []).map((p) => ({ slug: p.slug, name: p.name }));
  const allowed: string[] | null = device?.profiles ?? null;

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await client.request('post', '/auth/pairings', {
        body: { connection: 'lan', ttl_seconds: 300 },
      });
      const next = await bridge.device.link(data.id, data.code);
      setState(next);
      if (!next.linked && next.detail) setError(new Error(next.detail));
      void queryClient.invalidateQueries({ queryKey: deviceKeys.list });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    setError(null);
    try {
      if (state.deviceId)
        await client
          .request('delete', '/devices/{device_id}', { params: { device_id: state.deviceId } })
          .catch(() => undefined);
      setState(await bridge.device.forget());
      void queryClient.invalidateQueries({ queryKey: deviceKeys.list });
    } finally {
      setBusy(false);
    }
  };

  const setProfiles = async (next: string[] | null) => {
    if (!state.deviceId) return;
    setError(null);
    try {
      await client.request('patch', '/devices/{device_id}', {
        params: { device_id: state.deviceId },
        body: { profiles: next },
      });
      void queryClient.invalidateQueries({ queryKey: deviceKeys.list });
    } catch (err) {
      setError(err);
    }
  };

  const status = state.linked ? state.status : 'unlinked';
  return (
    <Fold
      title={t('device_link.title')}
      badge={
        <Badge tone={TONE[status]} dot testId="device-link-status">
          {t(`device_link.status_${status}`)}
        </Badge>
      }
      open={!state.linked || status === 'refused'}
      testId="device-link"
    >
      <p className="text-sm text-muted">{t('device_link.intro')}</p>
      {!state.linked || status === 'refused' ? (
        <div className="flex flex-col items-start gap-2">
          {status === 'refused' && <Notice tone="warning">{t('device_link.refused')}</Notice>}
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void link()}
            data-testid="device-link-button"
          >
            {t('device_link.link')}
          </Button>
        </div>
      ) : (
        <>
          {state.detail && status !== 'connected' && (
            <p className="text-xs text-muted" dir="auto">
              {state.detail}
            </p>
          )}
          <h4 className="text-sm font-semibold">{t('device_link.profiles')}</h4>
          <p className="text-xs text-muted">{t('device_link.profiles_hint')}</p>
          <ul className="flex flex-col gap-1" data-testid="device-link-profiles">
            {all.map((profile) => (
              <li key={profile.slug}>
                <Checkbox
                  checked={allowed === null || allowed.includes(profile.slug)}
                  label={profile.name}
                  testId={`device-link-profile-${profile.slug}`}
                  onChange={(on) => {
                    const current = allowed ?? all.map((p) => p.slug);
                    const next = on
                      ? [...new Set([...current, profile.slug])]
                      : current.filter((slug) => slug !== profile.slug);
                    // Every one of them again: back to "all my profiles", which follows new ones.
                    void setProfiles(next.length === all.length ? null : next);
                  }}
                />
              </li>
            ))}
          </ul>
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void unlink()}
              data-testid="device-link-unlink"
            >
              {t('device_link.unlink')}
            </Button>
          </div>
        </>
      )}
      {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
    </Fold>
  );
}
