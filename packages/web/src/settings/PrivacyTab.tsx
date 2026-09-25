/**
 * Privacy: who, besides you signing in, can act as you on this hub — and taking that away.
 *
 * **Hiding ids from the model** (contract decision §58, proposed — owner to confirm): the
 * switch here is Hermes's own `privacy.redact_pii` in the selected profile — read and written
 * through Hermes's settings (`agents.getSettings` / `agents.updateSettings`, section `privacy`),
 * so it does what it says: on WhatsApp, Telegram, Signal and BlueBubbles Hermes hashes the ids
 * and leaves phone numbers out of what the model is told. The hub's own
 * `ProfileSettings.privacy.redact_pii`, which nothing ever read, is deprecated and no longer
 * written from here.
 *
 * What the hub does answer, and what is a privacy question, is the list of **app tokens**:
 * the paired phones and the integrations that hold a key to your account. Each one can be
 * revoked here; a revoked device is unlinked (`auth.revokeAppToken`). Browser sign-ins are
 * not in that list — the contract has no operation that lists them — and changing your
 * password (Account) is what signs every other one out.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { useAgents, useAgentSettings, useSaveAgentSetting } from '../hub/queries.js';
import type { SettingsSection } from '../types.js';
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  Skeleton,
  SkeletonGroup,
  Switch,
  Table,
  useConfirm,
  type Column,
} from '../ui/index.js';
import { IconShield } from '../ui/icons.js';

export interface AppToken {
  id: string;
  name: string;
  scopes: string[];
  device_id: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

const tokenKeys = { all: () => ['app-tokens'] as const };

export function useAppTokens() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: tokenKeys.all(),
    queryFn: async () =>
      (await client.request('get', '/auth/app-tokens')).data as unknown as { items: AppToken[] },
    enabled: !!session,
  });
}

export function useRevokeAppToken() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/auth/app-tokens/{token_id}', {
        params: { token_id: id },
      });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: tokenKeys.all() }),
  });
}

export function PrivacyTab() {
  const { t, language } = useI18n();
  const tokens = useAppTokens();
  const revoke = useRevokeAppToken();
  const { ask, dialog } = useConfirm();

  const when = (iso: string | null, none: string) =>
    iso
      ? new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(new Date(iso))
      : none;

  const confirmRevoke = (token: AppToken) => {
    void ask({
      title: t('privacy.revoke_title', { name: token.name }),
      body: t(token.device_id ? 'privacy.revoke_device_body' : 'privacy.revoke_body'),
      confirmLabel: t('privacy.revoke'),
      tone: 'danger',
    }).then((yes) => {
      if (yes) revoke.mutate(token.id);
    });
  };

  const columns: Array<Column<AppToken>> = [
    {
      key: 'name',
      header: t('privacy.col_name'),
      cell: (token) => (
        <span className="flex flex-col">
          <span dir="auto">{token.name}</span>
          <span className="text-xs text-muted">
            {t(token.device_id ? 'privacy.kind_device' : 'privacy.kind_app')}
          </span>
        </span>
      ),
    },
    {
      key: 'scopes',
      header: t('privacy.col_scopes'),
      secondary: true,
      cell: (token) => (
        <span className="flex flex-wrap gap-1">
          {token.scopes.map((scope) => (
            <Badge key={scope}>{scope}</Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'used',
      header: t('privacy.col_used'),
      cell: (token) => when(token.last_used_at, t('privacy.never_used')),
    },
    {
      key: 'expires',
      header: t('privacy.col_expires'),
      secondary: true,
      cell: (token) => when(token.expires_at, t('privacy.no_expiry')),
    },
    {
      key: 'revoke',
      header: '',
      cell: (token) => (
        <Button
          size="sm"
          variant="danger"
          disabled={revoke.isPending}
          onClick={() => confirmRevoke(token)}
          data-testid="revoke-token"
        >
          {t('privacy.revoke')}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="privacy-tab">
      <section className="flex flex-col gap-3" aria-labelledby="privacy-access-heading">
        <h3 id="privacy-access-heading" className="text-sm font-semibold">
          {t('privacy.access')}
        </h3>
        <p className="max-w-prose text-sm text-muted">{t('privacy.access_hint')}</p>
        {tokens.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="5rem" radius="md" />
          </SkeletonGroup>
        )}
        {tokens.isError && <Notice tone="danger">{describeError(tokens.error, t)}</Notice>}
        {revoke.isError && <Notice tone="danger">{describeError(revoke.error, t)}</Notice>}
        {tokens.data && (
          <Table
            caption={t('privacy.access')}
            testId="app-token-table"
            columns={columns}
            rows={tokens.data.items}
            rowKey={(token) => token.id}
            empty={
              <EmptyState
                size="sm"
                icon={<IconShield size={20} />}
                title={t('privacy.none')}
                body={t('privacy.none_body')}
                testId="app-tokens-empty"
              />
            }
          />
        )}
      </section>
      <HermesPrivacy />
      <p className="max-w-prose text-xs text-muted" data-testid="privacy-browsers-note">
        {t('privacy.browsers_note')}
      </p>
      {dialog}
    </div>
  );
}

/**
 * Hermes's `privacy.redact_pii` in the selected profile. Nothing is shown where there is no
 * Hermes, or where the hub cannot reach its files — a switch there would change nothing.
 */
function HermesPrivacy() {
  const { t, language } = useI18n();
  const { user } = useAuth();
  const agents = useAgents();
  const hermes = (agents.data ?? []).find((agent) => agent.kind === 'hermes') ?? null;
  const settings = useAgentSettings(hermes?.id ?? null);
  const save = useSaveAgentSetting(hermes?.id ?? null);
  const section = (settings.data?.sections as SettingsSection[] | undefined)?.find(
    (candidate) => candidate.key === 'privacy',
  );
  const field = section?.fields.find((candidate) => candidate.key === 'redact_pii');
  if (!hermes || !section || !field) return null;
  const isAdmin = user?.role === 'admin' || user?.role === 'owner';
  const fallback = (field as { default?: unknown }).default === true;
  const checked =
    field.value === null || field.value === undefined ? fallback : field.value === true;
  const note = section.note ? (language === 'ar' ? section.note.ar : section.note.en) : null;
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="privacy-redact-heading"
      data-testid="privacy-redact"
    >
      <h3 id="privacy-redact-heading" className="text-sm font-semibold">
        {t('privacy.redact_title')}
      </h3>
      <Switch
        checked={checked}
        disabled={!isAdmin || save.isPending}
        onChange={(next) => save.mutate({ section: 'privacy', values: { redact_pii: next } })}
        label={language === 'ar' ? field.label.ar : field.label.en}
        hint={note ?? undefined}
        testId="privacy-redact-pii"
      />
      {!isAdmin && <p className="text-xs text-muted">{t('privacy.redact_admin_only')}</p>}
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
    </section>
  );
}
