/**
 * «الوصول من خارج البيت» / "Reach from outside", inside This device (DECISIONS §92, proposed —
 * owner to confirm): a folded part shown in local mode to an admin.
 *
 * The hub on this computer listens on this computer only. To reach it from a phone away from
 * home, the person opens a way in on an account of their own — a Cloudflare Tunnel whose token
 * they paste, or their Tailscale network — and the app does the rest (`devices.getRelay` /
 * `devices.setRelay`, answered by the desktop app through the hub). The token is written once
 * and never shown again; the page says plainly that the hub becomes reachable from the internet,
 * still behind its own sign-in. Phones then pair on Device connections as usual, and are given
 * the way in's address.
 */
import { HubApiError } from '@corehub/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import type { Schemas } from '../types.js';
import { Badge, Button, Field, Input, Notice, Radio } from '../ui/index.js';
import { Fold } from './HelperSection.js';

type Relay = Schemas['Relay'];
type RelayUpdate = Schemas['RelayUpdate'];

export const relayKey = ['relay'] as const;

/** Why the hub or the app refused a change, each in its own words. */
const REFUSALS = [
  'token_invalid',
  'token_required',
  'route_required',
  'hostname_invalid',
  'relay_unavailable',
  'relay_host_not_answering',
] as const;

function refusalOf(
  error: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const reason =
    error instanceof HubApiError
      ? (error.body as { details?: { reason?: unknown } } | null)?.details?.reason
      : null;
  return REFUSALS.includes(reason as (typeof REFUSALS)[number])
    ? t(`outside.refused.${String(reason)}`)
    : describeError(error, t);
}

export function useRelay() {
  const { client } = useAuth();
  return useQuery({
    queryKey: relayKey,
    queryFn: async () => (await client.request('get', '/relay')).data as Relay,
    // While it is on, the page follows it connecting (the app reports every few seconds).
    refetchInterval: (query) => ((query.state.data as Relay | undefined)?.enabled ? 3_000 : false),
  });
}

function StatusBadge({ relay }: { relay: Relay }) {
  const { t } = useI18n();
  if (!relay.enabled) return <Badge>{t('outside.state_off')}</Badge>;
  if (relay.connected) return <Badge tone="success">{t('outside.state_connected')}</Badge>;
  if (relay.error) return <Badge tone="danger">{t('outside.state_error')}</Badge>;
  return <Badge tone="info">{t('outside.state_connecting')}</Badge>;
}

export function OutsideAccessSection() {
  const { t } = useI18n();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const relay = useRelay();
  const [route, setRoute] = useState<'cloudflare' | 'tailscale' | null>(null);
  const [token, setToken] = useState('');
  const [hostname, setHostname] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const save = useMutation({
    mutationFn: async (body: RelayUpdate) =>
      (await client.request('put', '/relay', { body })).data as Relay,
    onSuccess: (next) => {
      queryClient.setQueryData(relayKey, next);
      setToken('');
    },
  });

  const data = relay.data;
  if (!data || !data.available) return null;
  const chosen = route ?? data.route ?? 'cloudflare';
  const host = hostname ?? data.hostname ?? '';
  const service = data.hub_port ? `http://localhost:${data.hub_port}` : null;
  const turnOn = () =>
    save.mutate({
      enabled: true,
      route: chosen,
      ...(chosen === 'cloudflare'
        ? {
            hostname: host.trim() === '' ? null : host.trim(),
            ...(token.trim() ? { token: token.trim() } : {}),
          }
        : {}),
    });
  const busy = save.isPending;

  return (
    <Fold title={t('outside.title')} badge={<StatusBadge relay={data} />} testId="outside-access">
      <p className="text-sm text-muted">{t('outside.intro')}</p>
      <Notice tone="warning" testId="outside-warning">
        {t('outside.warning')}
      </Notice>

      <Radio
        label={t('outside.route')}
        value={chosen}
        disabled={data.enabled}
        onChange={(next) => setRoute(next as 'cloudflare' | 'tailscale')}
        testId="outside-route"
        options={[
          {
            value: 'cloudflare',
            label: t('outside.cloudflare'),
            hint: t('outside.cloudflare_hint'),
          },
          { value: 'tailscale', label: t('outside.tailscale'), hint: t('outside.tailscale_hint') },
        ]}
      />

      {chosen === 'cloudflare' ? (
        <div className="flex flex-col gap-3" data-testid="outside-cloudflare">
          <ol className="list-decimal ps-5 text-sm flex flex-col gap-1">
            <li>{t('outside.cf_step_create')}</li>
            <li>
              {t('outside.cf_step_route')}{' '}
              {service && (
                <>
                  <code dir="ltr" className="font-mono" data-testid="outside-service">
                    {service}
                  </code>{' '}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void navigator.clipboard.writeText(service).then(() => setCopied(true))
                    }
                  >
                    {copied ? t('outside.copied') : t('outside.copy')}
                  </Button>
                </>
              )}
            </li>
            <li>{t('outside.cf_step_token')}</li>
          </ol>
          {data.token_set ? (
            <div
              className="flex flex-wrap items-center gap-2 text-sm"
              data-testid="outside-token-kept"
            >
              <span>{t('outside.token_kept', { tunnel: `⁨${data.tunnel_id ?? '—'}⁩` })}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="outside-forget"
                onClick={() => save.mutate({ forget_token: true, enabled: false })}
              >
                {t('outside.forget_token')}
              </Button>
            </div>
          ) : null}
          <Field
            label={data.token_set ? t('outside.token_replace') : t('outside.token')}
            hint={t('outside.token_hint')}
          >
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="eyJhIjoi…"
                value={token}
                data-testid="outside-token"
                onChange={(event) => setToken(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('outside.hostname')} hint={t('outside.hostname_hint')}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                placeholder="hub.example.com"
                value={host}
                data-testid="outside-hostname"
                onChange={(event) => setHostname(event.target.value)}
              />
            )}
          </Field>
          {data.hostnames.length > 0 && (
            <ul className="text-sm flex flex-col gap-1" data-testid="outside-routes">
              {data.hostnames.map((route) => (
                <li key={`${route.hostname}-${route.service}`}>
                  <span dir="ltr" className="font-mono">
                    {route.hostname} → {route.service}
                  </span>{' '}
                  {!route.matches && (
                    <Badge tone="warning">
                      {t('outside.route_elsewhere', { service: `⁨${service ?? '—'}⁩` })}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm" data-testid="outside-tailscale">
          {data.tailnet ? (
            <p>
              {t('outside.tailnet_found')}{' '}
              <span dir="ltr" className="font-mono" data-testid="outside-tailnet">
                {data.tailnet.address}
                {data.tailnet.dns_name ? ` (${data.tailnet.dns_name})` : ''}
              </span>
            </p>
          ) : (
            <Notice>{t('outside.tailnet_missing')}</Notice>
          )}
          <p className="text-muted">{t('outside.tailscale_phone')}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {data.enabled ? (
          <Button
            variant="secondary"
            disabled={busy}
            data-testid="outside-off"
            onClick={() => save.mutate({ enabled: false })}
          >
            {t('outside.turn_off')}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={
              busy ||
              (chosen === 'cloudflare' && !data.token_set && token.trim() === '') ||
              (chosen === 'tailscale' && !data.tailnet)
            }
            data-testid="outside-on"
            onClick={turnOn}
          >
            {t('outside.turn_on')}
          </Button>
        )}
        {data.enabled &&
          chosen === 'cloudflare' &&
          (token.trim() !== '' || host !== (data.hostname ?? '')) && (
            <Button variant="secondary" disabled={busy} data-testid="outside-save" onClick={turnOn}>
              {t('outside.save')}
            </Button>
          )}
      </div>

      {save.error && (
        <Notice tone="danger" testId="outside-refused">
          {refusalOf(save.error, t)}
        </Notice>
      )}
      {data.enabled && data.connected && data.relay_url && (
        <Notice tone="success" testId="outside-connected">
          {t('outside.connected', { url: `⁨${data.relay_url}⁩` })}{' '}
          <Link to={routeOf('device_connections')} className="text-link">
            {t('outside.pair_phone')}
          </Link>
        </Notice>
      )}
      {data.enabled && data.connected && !data.relay_url && (
        <Notice tone="warning">{t('outside.no_hostname')}</Notice>
      )}
      {data.enabled && data.error && (
        <Notice tone="danger" testId="outside-error">
          {t(`outside.error.${data.error}`)}
          {data.error_detail ? (
            <span dir="ltr" className="block font-mono text-xs">
              {data.error_detail}
            </span>
          ) : null}
        </Notice>
      )}
    </Fold>
  );
}
