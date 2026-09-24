/**
 * Privacy: who, besides you signing in, can act as you on this hub — and taking that away.
 *
 * **Proposed — owner to confirm (2026-09-24).** The contract's coverage table puts one
 * control here: the profile setting `privacy.redact_pii`. The hub stores it and nothing
 * reads it — Hermes has a setting of that name for its messaging channels, but the hub
 * never writes it into Hermes's configuration — so a switch for it would say something is
 * redacted when nothing is. It is left off this page until it does something.
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
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  Skeleton,
  SkeletonGroup,
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
      <p className="max-w-prose text-xs text-muted" data-testid="privacy-browsers-note">
        {t('privacy.browsers_note')}
      </p>
      {dialog}
    </div>
  );
}
