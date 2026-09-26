/**
 * The admin's push setup, folded at the bottom of Device connections (the owner, 2026-09-25:
 * a big block of senders under the devices distracted from them). Folded, one line says how
 * each sender stands; open, one row per sender with its state and a Set up / Edit button that
 * opens the dialog with its fields. Web Push is ready on every hub (its keys are the hub's
 * own); FCM and APNs wait for the owner's credentials, entered in the dialog (sealed with the
 * hub's data key) or given by the environment, which then wins — that is explained inside the
 * dialog, not on the page. Nothing secret is shown: a stored key reads `[stored]`, and the
 * form never fills it back in.
 */
import { PRODUCT } from '@corehub/contracts';
import { useRef, useState, type ReactNode, type Ref } from 'react';
import { HubApiError } from '@corehub/contracts';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
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
import { IconChevron } from '../ui/icons.js';
import {
  useDeletePushSender,
  usePushSenders,
  useSetPushSender,
  type PushSender,
  type PushSenderUpdate,
} from './queries.js';
import { ending, inspectP8, inspectServiceAccount } from './senderFiles.js';

const TONE: Record<PushSender['state'], BadgeTone> = {
  ready: 'success',
  disabled: 'neutral',
  not_configured: 'warning',
  error: 'danger',
};

/** Names typed into a compose file: shown left to right, whatever the page's language. */
const ENV_HINTS: Record<'fcm' | 'apns', string[]> = {
  fcm: ['COREHUB_FCM_SERVICE_ACCOUNT'],
  apns: [
    'COREHUB_APNS_KEY_ID',
    'COREHUB_APNS_TEAM_ID',
    'COREHUB_APNS_BUNDLE_ID',
    'COREHUB_APNS_KEY',
    'COREHUB_APNS_ENVIRONMENT',
  ],
};

const DEPLOY_DOC = `https://github.com/${PRODUCT.repository}/blob/main/docs/DEPLOY.md`;

export function PushSendersSection({
  open,
  onOpenChange,
  ref,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  ref?: Ref<HTMLDetailsElement>;
}) {
  const { t } = useI18n();
  const senders = usePushSenders(true);
  const [editing, setEditing] = useState<PushSender | null>(null);
  /** What the hub made of the last save: the key looks valid, or why not. */
  const [saved, setSaved] = useState<PushSender | null>(null);
  return (
    <details
      ref={ref}
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className="ch-card ch-card-flat ch-card-pad-sm mt-2"
      data-testid="push-senders"
    >
      <summary
        className="flex cursor-pointer list-none flex-wrap items-center gap-2"
        data-testid="push-senders-summary"
      >
        <IconChevron size={14} className={open ? 'rotate-180' : ''} />
        <span className="text-sm font-semibold">{t('devices.push.title')}</span>
        {senders.data?.items.map((sender) => (
          <Badge key={sender.provider} tone={TONE[sender.state]} dot>
            {t(`devices.push.provider.${sender.provider}`)}
          </Badge>
        ))}
        <span className="ms-auto text-xs text-link">
          {t(open ? 'devices.push.hide' : 'devices.push.manage')}
        </span>
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-xs text-muted">{t('devices.push.intro')}</p>
        {senders.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="6rem" radius="md" />
          </SkeletonGroup>
        )}
        {senders.isError && <Notice tone="danger">{describeError(senders.error, t)}</Notice>}
        {senders.data && (
          <ul className="flex flex-col divide-y divide-line">
            {senders.data.items.map((sender) => (
              <li
                key={sender.provider}
                className="flex flex-col gap-1 py-2"
                data-testid={`push-sender-${sender.provider}`}
                data-state={sender.state}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    {t(`devices.push.provider.${sender.provider}`)}
                  </span>
                  <Badge tone={TONE[sender.state]}>{t(`devices.push.state.${sender.state}`)}</Badge>
                  {(sender.source === 'environment' || sender.source === 'relay') && (
                    <Badge>{t(`devices.push.source.${sender.source}`)}</Badge>
                  )}
                  <span className="text-xs text-muted">
                    {t('devices.push.devices', { count: sender.devices })}
                  </span>
                  {sender.provider !== 'webpush' && sender.source !== 'environment' && (
                    <Button
                      size="sm"
                      variant={sender.source === 'settings' ? 'ghost' : 'secondary'}
                      className="ms-auto"
                      onClick={() => {
                        setSaved(null);
                        setEditing(sender);
                      }}
                      data-testid={`push-sender-edit-${sender.provider}`}
                    >
                      {t(
                        sender.source === 'settings'
                          ? 'devices.push.change'
                          : 'devices.push.set_up',
                      )}
                    </Button>
                  )}
                </div>
                <SavedLine sender={sender} />
                {saved?.provider === sender.provider && (
                  <Notice
                    tone={
                      saved.state === 'ready' || saved.state === 'disabled' ? 'success' : 'warning'
                    }
                    testId="push-sender-saved"
                  >
                    {saved.state === 'ready' || saved.state === 'disabled'
                      ? t(`devices.push.valid.${saved.provider}`)
                      : saved.state === 'not_configured'
                        ? t('devices.push.saved_incomplete')
                        : t('devices.push.form.refused', { detail: saved.last_error ?? '' })}
                  </Notice>
                )}
                {sender.last_error && saved?.provider !== sender.provider && (
                  <p className="text-xs text-danger-soft-text" dir="auto">
                    {sender.last_error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && (
        <SenderDialog sender={editing} onClose={() => setEditing(null)} onSaved={setSaved} />
      )}
    </details>
  );
}

/**
 * What is stored, said without a secret: the project a service account belongs to; the APNs
 * key's last characters and the team. A secret itself never comes back from the hub.
 */
function SavedLine({ sender }: { sender: PushSender }) {
  const { t } = useI18n();
  if (sender.source === 'none' || sender.provider === 'webpush') return null;
  const d = sender.details;
  const parts =
    sender.provider === 'fcm'
      ? d.project_id
        ? [t('devices.push.saved_project', { project: d.project_id })]
        : []
      : [
          ...(d.key_id ? [t('devices.push.saved_key', { ending: ending(d.key_id) })] : []),
          ...(d.team_id ? [t('devices.push.saved_team', { team: d.team_id })] : []),
          ...(d.environment === 'sandbox' ? [t('devices.push.form.sandbox')] : []),
        ];
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-muted" data-testid={`push-sender-stored-${sender.provider}`}>
      {t('devices.push.saved')} — <bdi>{parts.join(' · ')}</bdi>
    </p>
  );
}

/** Inside the dialog: the same sender can come from the hub's environment instead. */
function EnvironmentNote({ provider }: { provider: 'fcm' | 'apns' }) {
  const { t } = useI18n();
  return (
    <details className="text-xs text-muted" data-testid="push-sender-env">
      <summary className="cursor-pointer">{t('devices.push.env_title')}</summary>
      <div className="mt-2 flex flex-col gap-1">
        <p>
          {t('devices.push.env_body')}{' '}
          <a href={DEPLOY_DOC} target="_blank" rel="noreferrer" className="text-link" dir="ltr">
            docs/DEPLOY.md
          </a>
        </p>
        <ul dir="ltr" className="flex flex-col gap-0.5 font-mono">
          {ENV_HINTS[provider].map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * A file chosen with the button or dropped on the zone, read as text. The zone is the
 * button's surroundings: a person who drags the file from Finder drops it anywhere near.
 */
function FileDrop({
  label,
  accept,
  testId,
  onFile,
  chosen,
}: {
  label: string;
  accept: string;
  testId: string;
  onFile(name: string, text: string): void;
  chosen: string | null;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const read = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => onFile(file.name, text));
  };
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3 ${
        over ? 'border-accent bg-sunken' : 'border-line-strong'
      }`}
      data-testid={`${testId}-drop`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        read(event.dataTransfer.files[0]);
      }}
    >
      <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
        {label}
      </Button>
      <span className="text-xs text-muted" dir="auto">
        {chosen ?? t('devices.push.form.drop_here')}
      </span>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        data-testid={testId}
        onChange={(event) => {
          read(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}

/** The hub's reason for refusing a save, when it gave one; the generic message otherwise. */
function refusal(
  error: unknown,
  t: (key: string, p?: Record<string, string | number>) => string,
): string {
  const detail =
    error instanceof HubApiError
      ? (error.body as { details?: { message?: unknown } } | undefined)?.details?.message
      : undefined;
  return typeof detail === 'string' && detail
    ? t('devices.push.form.refused', { detail })
    : describeError(error, t);
}

function SenderDialog({
  sender,
  onClose,
  onSaved,
}: {
  sender: PushSender;
  onClose(): void;
  onSaved(result: PushSender): void;
}) {
  const { t } = useI18n();
  const save = useSetPushSender();
  const forget = useDeletePushSender();
  const stored = sender.source === 'settings';
  const [enabled, setEnabled] = useState(sender.state !== 'disabled');
  const [serviceAccount, setServiceAccount] = useState('');
  const [keyId, setKeyId] = useState(sender.details.key_id ?? '');
  const [teamId, setTeamId] = useState(sender.details.team_id ?? '');
  // The hub offers its own app's bundle id (APP_IDS in the contract); the page never types it.
  const [bundleId, setBundleId] = useState(sender.details.bundle_id ?? '');
  const [environment, setEnvironment] = useState<'production' | 'sandbox'>(
    sender.details.environment === 'sandbox' ? 'sandbox' : 'production',
  );
  const [privateKey, setPrivateKey] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [fileProblem, setFileProblem] = useState<string | null>(null);

  const account = serviceAccount.trim() ? inspectServiceAccount(serviceAccount) : null;
  const key = privateKey.trim() ? inspectP8(fileName, privateKey) : null;

  const onServiceAccount = (name: string, text: string) => {
    setFileName(name);
    const check = inspectServiceAccount(text);
    if (check.ok) {
      setServiceAccount(text);
      setFileProblem(null);
    } else {
      setServiceAccount('');
      setFileProblem(t(`devices.push.form.fcm_${check.reason}`));
    }
  };
  const onP8 = (name: string, text: string) => {
    setFileName(name);
    const check = inspectP8(name, text);
    if (check.ok) {
      setPrivateKey(text);
      setFileProblem(null);
      if (check.keyId) setKeyId(check.keyId);
    } else {
      setPrivateKey('');
      setFileProblem(t(`devices.push.form.apns_${check.reason}`));
    }
  };

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
      ? (stored && !serviceAccount.trim()) || account?.ok === true
      : keyId.trim() !== '' &&
        teamId.trim() !== '' &&
        bundleId.trim() !== '' &&
        (privateKey.trim() ? key?.ok === true : stored);
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
              variant="danger-quiet"
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
            onClick={() =>
              save.mutate(
                { provider: sender.provider, body },
                {
                  onSuccess: (result) => {
                    onSaved(result);
                    onClose();
                  },
                },
              )
            }
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
          <>
            <FileDrop
              label={t('devices.push.form.fcm_upload')}
              accept=".json,application/json"
              testId="push-sender-file"
              onFile={onServiceAccount}
              chosen={fileName}
            />
            {account?.ok && (
              <Notice tone="success" testId="push-sender-file-ok">
                {t('devices.push.form.fcm_ok', { project: account.projectId })}
              </Notice>
            )}
            {account && !account.ok && pasting && (
              <Notice tone="warning">{t(`devices.push.form.fcm_${account.reason}`)}</Notice>
            )}
            {stored && !serviceAccount && (
              <p className="text-xs text-muted">{t('devices.push.form.secret_kept')}</p>
            )}
            <PasteToggle open={pasting} onToggle={setPasting}>
              <Field
                label={t('devices.push.form.service_account')}
                hint={t('devices.push.form.service_account_hint')}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    rows={8}
                    dir="ltr"
                    value={serviceAccount}
                    onChange={(event) => {
                      setFileName(null);
                      setFileProblem(null);
                      setServiceAccount(event.target.value);
                    }}
                  />
                )}
              </Field>
            </PasteToggle>
          </>
        ) : (
          <>
            <FileDrop
              label={t('devices.push.form.apns_upload')}
              accept=".p8"
              testId="push-sender-file"
              onFile={onP8}
              chosen={fileName}
            />
            {key?.ok && fileName && (
              <Notice tone="success" testId="push-sender-file-ok">
                {t('devices.push.form.apns_ok')}
              </Notice>
            )}
            {key && !key.ok && pasting && (
              <Notice tone="warning">{t(`devices.push.form.apns_${key.reason}`)}</Notice>
            )}
            {stored && !privateKey && (
              <p className="text-xs text-muted">{t('devices.push.form.secret_kept')}</p>
            )}
            <PasteToggle open={pasting} onToggle={setPasting}>
              <Field
                label={t('devices.push.form.private_key')}
                hint={t('devices.push.form.private_key_hint')}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    rows={6}
                    dir="ltr"
                    value={privateKey}
                    onChange={(event) => {
                      setFileName(null);
                      setFileProblem(null);
                      setPrivateKey(event.target.value);
                    }}
                  />
                )}
              </Field>
            </PasteToggle>
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
                    data-testid={`push-sender-${field}`}
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
          </>
        )}
        {fileProblem && (
          <Notice tone="danger" testId="push-sender-file-problem">
            {fileProblem}
          </Notice>
        )}
        {sender.provider !== 'webpush' && <EnvironmentNote provider={sender.provider} />}
        {error && <Notice tone="danger">{refusal(error, t)}</Notice>}
      </div>
    </Dialog>
  );
}

/** "Paste instead": the text field behind the file, for a key copied from elsewhere. */
function PasteToggle({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle(open: boolean): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        data-testid="push-sender-paste"
      >
        {t(open ? 'devices.push.form.paste_hide' : 'devices.push.form.paste_instead')}
      </Button>
      {open && children}
    </div>
  );
}
