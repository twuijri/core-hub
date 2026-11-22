/**
 * The model gateway's external entrance (DECISIONS §156, ADR 0033 §3): the hub's models for a
 * person's own programs on their computer — DeepSeek Harness through the Core Hub plugin — with
 * their own app token. Off until an admin switches it on here; one switch for the whole hub.
 *
 * Shown to an owner or admin only. Where the hub has no model gateway the switch is disabled and
 * the hub's reason is said; the addresses are shown with this hub's own origin in front, each
 * with a copy button, left to right whatever the interface language.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { Button, Card, CardHeader, Notice, Switch } from '../ui/index.js';
import { IconCopy } from '../ui/icons.js';
import { useExternalGateway, useSetExternalGateway } from './queries.js';

export function ExternalGatewayCard() {
  const { user } = useAuth();
  const admin = user?.role === 'owner' || user?.role === 'admin';
  const gateway = useExternalGateway(admin);
  const save = useSetExternalGateway();
  const { t } = useI18n();
  // A member, or a hub that answers nothing: no card at all.
  if (!admin || !gateway.data) return null;
  const data = gateway.data;
  const origin = window.location.origin;
  return (
    <Card tone="raised" className="mb-3" testId="external-gateway-card" data-enabled={data.enabled}>
      <CardHeader
        title={t('models.external_gateway.title')}
        subtitle={t('models.external_gateway.hint')}
      />
      <Switch
        checked={data.enabled}
        disabled={!data.available || save.isPending}
        onChange={(next) => save.mutate(next)}
        label={t('models.external_gateway.switch')}
        hint={t('models.external_gateway.switch_hint', { limit: data.rate_limit_per_minute })}
        testId="external-gateway-switch"
      />
      {data.reason && (
        <Notice tone="warning" className="mt-2">
          {data.reason}
        </Notice>
      )}
      {save.isError && (
        <Notice tone="danger" className="mt-2">
          {describeError(save.error, t)}
        </Notice>
      )}
      {data.enabled && (
        <div className="mt-3 flex flex-col gap-2">
          <Address
            label={t('models.external_gateway.openai')}
            value={`${origin}${data.openai_base_path}`}
            testId="external-gateway-openai"
          />
          <Address
            label={t('models.external_gateway.anthropic')}
            value={`${origin}${data.anthropic_base_path}`}
            testId="external-gateway-anthropic"
          />
          <p className="text-xs text-muted">{t('models.external_gateway.key_hint')}</p>
        </div>
      )}
    </Card>
  );
}

function Address({ label, value, testId }: { label: string; value: string; testId: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted">{label}</span>
      <code className="min-w-0 flex-1 truncate text-xs" dir="ltr" data-testid={testId}>
        {value}
      </code>
      <Button
        size="sm"
        variant="ghost"
        icon={<IconCopy size={14} />}
        aria-label={t('models.external_gateway.copy_named', { name: label })}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        data-testid={`${testId}-copy`}
      >
        {copied ? t('models.external_gateway.copied') : t('models.external_gateway.copy')}
      </Button>
    </div>
  );
}
