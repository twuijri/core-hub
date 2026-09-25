/**
 * The admin's view of push: which senders can deliver, where their credentials come from,
 * and — for the ones that cannot — exactly what is missing. Web Push is ready on every hub
 * (its keys are the hub's own); FCM and APNs wait for the owner's credentials, which are
 * given by the environment (docs/DEPLOY.md) or `devices.setPushSender`. Nothing secret is
 * shown: a stored key reads `[stored]`.
 */
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Card, Notice, Skeleton, SkeletonGroup, type BadgeTone } from '../ui/index.js';
import { usePushSenders, type PushSender } from './queries.js';

const TONE: Record<PushSender['state'], BadgeTone> = {
  ready: 'success',
  disabled: 'neutral',
  not_configured: 'warning',
  error: 'danger',
};

export function PushSendersCard() {
  const { t } = useI18n();
  const senders = usePushSenders(true);
  return (
    <Card tone="flat" testId="push-senders" className="gap-3">
      <h3 className="text-sm font-semibold">{t('devices.push.title')}</h3>
      <p className="text-xs text-muted">{t('devices.push.intro')}</p>
      {senders.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="6rem" radius="md" />
        </SkeletonGroup>
      )}
      {senders.isError && <Notice tone="danger">{describeError(senders.error, t)}</Notice>}
      {senders.data && (
        <ul className="flex flex-col gap-2">
          {senders.data.items.map((sender) => (
            <li
              key={sender.provider}
              className="flex flex-col gap-1"
              data-testid={`push-sender-${sender.provider}`}
              data-state={sender.state}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {t(`devices.push.provider.${sender.provider}`)}
                </span>
                <Badge tone={TONE[sender.state]}>{t(`devices.push.state.${sender.state}`)}</Badge>
                {sender.source !== 'none' && (
                  <Badge>{t(`devices.push.source.${sender.source}`)}</Badge>
                )}
                <span className="text-xs text-muted">
                  {t('devices.push.devices', { count: sender.devices })}
                </span>
              </div>
              {sender.missing.length > 0 && (
                <p className="text-xs text-muted">
                  {t('devices.push.missing', { fields: sender.missing.join(', ') })}
                </p>
              )}
              {sender.last_error && (
                <p className="text-xs text-danger-soft-text" dir="auto">
                  {sender.last_error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">{t('devices.push.how')}</p>
    </Card>
  );
}
