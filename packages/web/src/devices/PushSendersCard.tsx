/**
 * The admin's view of push: which senders can deliver, where their credentials come from,
 * and — for the ones that cannot — exactly what is missing. Web Push is ready on every hub
 * (its keys are the hub's own); FCM and APNs wait for the owner's credentials, entered here
 * (sealed with the hub's data key) or given by the environment, which then wins. Nothing
 * secret is shown: a stored key reads `[stored]`, and the form never fills it back in.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Notice,
  Segmented,
  Skeleton,
  SkeletonGroup,
  Switch,
  Textarea,
  type BadgeTone,
} from '../ui/index.js';
import {
  useDeletePushSender,
  usePushSenders,
  useSetPushSender,
  type PushSender,
  type PushSenderUpdate,
} from './queries.js';

const TONE: Record<PushSender['state'], BadgeTone> = {
  ready: 'success',
  disabled: 'neutral',
  not_configured: 'warning',
  error: 'danger',
};

/** Names typed into a compose file: shown left to right, whatever the page's language. */
const ENV_HINTS = [
  'FCM: COREHUB_FCM_SERVICE_ACCOUNT',
  'APNs: COREHUB_APNS_KEY_ID, COREHUB_APNS_TEAM_ID, COREHUB_APNS_BUNDLE_ID, COREHUB_APNS_KEY, COREHUB_APNS_ENVIRONMENT',
];

export function PushSendersCard() {
  const { t } = useI18n();
  const senders = usePushSenders(true);
  const [editing, setEditing] = useState<PushSender | null>(null);
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
        <ul className="flex flex-col gap-3">
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
                {sender.provider !== 'webpush' && sender.source !== 'environment' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ms-auto"
                    onClick={() => setEditing(sender)}
                    data-testid={`push-sender-edit-${sender.provider}`}
                  >
                    {t(
                      sender.source === 'settings' ? 'devices.push.change' : 'devices.push.set_up',
                    )}
                  </Button>
                )}
              </div>
              {sender.missing.length > 0 && (
                <p className="text-xs text-muted">
                  {t('devices.push.missing')}{' '}
                  <span dir="ltr" className="font-mono">
                    {sender.missing.join(', ')}
                  </span>
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
      <ul dir="ltr" className="flex flex-col gap-1 font-mono text-xs text-muted">
        {ENV_HINTS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {editing && <SenderDialog sender={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function SenderDialog({ sender, onClose }: { sender: PushSender; onClose(): void }) {
  const { t } = useI18n();
  const save = useSetPushSender();
  const forget = useDeletePushSender();
  const stored = sender.source === 'settings';
  const [enabled, setEnabled] = useState(sender.state !== 'disabled');
  const [serviceAccount, setServiceAccount] = useState('');
  const [keyId, setKeyId] = useState(sender.details.key_id ?? '');
  const [teamId, setTeamId] = useState(sender.details.team_id ?? '');
  const [bundleId, setBundleId] = useState(sender.details.bundle_id ?? '');
  const [environment, setEnvironment] = useState<'production' | 'sandbox'>(
    sender.details.environment === 'sandbox' ? 'sandbox' : 'production',
  );
  const [privateKey, setPrivateKey] = useState('');

  // A secret left empty keeps what is stored; the hub reads `[stored]` as "unchanged".
  const body: PushSenderUpdate =
    sender.provider === 'fcm'
      ? { enabled, service_account: serviceAccount.trim() || '[stored]' }
      : {
          enabled,
          key_id: keyId.trim(),
          team_id: teamId.trim(),
          bundle_id: bundleId.trim(),
          environment,
          ...(privateKey.trim() ? { private_key: privateKey.trim() } : {}),
        };
  const ready =
    sender.provider === 'fcm'
      ? stored || serviceAccount.trim() !== ''
      : keyId.trim() !== '' && teamId.trim() !== '' && bundleId.trim() !== '';
  const error = save.error ?? forget.error;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(`devices.push.provider.${sender.provider}`)}
      description={t(`devices.push.form.${sender.provider}_intro`)}
      closeLabel={t('common.cancel')}
      testId="push-sender-dialog"
      footer={
        <>
          {stored && (
            <Button
              variant="danger"
              disabled={forget.isPending}
              onClick={() => forget.mutate(sender.provider, { onSuccess: onClose })}
            >
              {t('devices.push.form.forget')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ready || save.isPending}
            onClick={() => save.mutate({ provider: sender.provider, body }, { onSuccess: onClose })}
            data-testid="push-sender-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Switch checked={enabled} onChange={setEnabled} label={t('devices.push.form.enabled')} />
        {sender.provider === 'fcm' ? (
          <Field
            label={t('devices.push.form.service_account')}
            hint={t(
              stored ? 'devices.push.form.secret_kept' : 'devices.push.form.service_account_hint',
            )}
          >
            {(props) => (
              <Textarea
                {...props}
                rows={8}
                dir="ltr"
                value={serviceAccount}
                onChange={(event) => setServiceAccount(event.target.value)}
              />
            )}
          </Field>
        ) : (
          <>
            {(
              [
                ['key_id', keyId, setKeyId],
                ['team_id', teamId, setTeamId],
                ['bundle_id', bundleId, setBundleId],
              ] as const
            ).map(([field, value, set]) => (
              <Field key={field} label={t(`devices.push.form.${field}`)}>
                {(props) => (
                  <Input
                    {...props}
                    dir="ltr"
                    value={value}
                    onChange={(event) => set(event.target.value)}
                  />
                )}
              </Field>
            ))}
            <Segmented
              label={t('devices.push.form.environment')}
              value={environment}
              onChange={(value) => setEnvironment(value as 'production' | 'sandbox')}
              options={[
                { value: 'production', label: t('devices.push.form.production') },
                { value: 'sandbox', label: t('devices.push.form.sandbox') },
              ]}
            />
            <Field
              label={t('devices.push.form.private_key')}
              hint={t(
                stored ? 'devices.push.form.secret_kept' : 'devices.push.form.private_key_hint',
              )}
            >
              {(props) => (
                <Textarea
                  {...props}
                  rows={6}
                  dir="ltr"
                  value={privateKey}
                  onChange={(event) => setPrivateKey(event.target.value)}
                />
              )}
            </Field>
          </>
        )}
        {error && <Notice tone="danger">{describeError(error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
