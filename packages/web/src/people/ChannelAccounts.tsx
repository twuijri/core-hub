/**
 * Messaging accounts linked to a person (contract decision §79).
 *
 * A person links their own Telegram or WhatsApp account by proving it: the hub gives a one-time
 * code, the person sends `/start <code>` to their agent's bot from that account, and the hub's
 * hook in Hermes's gateway links the sender the platform named. A message from a linked
 * account then runs with the person's permissions, so the agent's Core Hub tools act as them;
 * a message from an account nobody linked gets none of them.
 *
 * `MyChannelAccounts` is the person's own card (Settings → Account); `AllChannelAccounts` is the
 * admin's list of everyone's links (Settings → People), each removable.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Button, Card, CardHeader, EmptyState, Notice, Table, useConfirm } from '../ui/index.js';
import { IconTrash } from '../ui/icons.js';
import type { HubUser } from './queries.js';
import { intlLocale } from '../i18n/index.js';

export interface ChannelIdentity {
  id: string;
  user_id: string;
  platform: 'telegram' | 'whatsapp';
  sender_id: string;
  linked_at: string;
  last_used_at: string | null;
}

interface LinkCode {
  code: string;
  command: string;
  expires_at: string;
}

const keys = {
  mine: () => ['channel-identities', 'mine'] as const,
  all: () => ['channel-identities', 'all'] as const,
};

function useMyIdentities(poll: boolean) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: keys.mine(),
    queryFn: async () =>
      (await client.request('get', '/auth/me/channel-identities', {})).data as unknown as {
        items: ChannelIdentity[];
      },
    enabled: !!session,
    // While a code waits to be sent, the list is asked again until the link shows up.
    refetchInterval: poll ? 3000 : false,
  });
}

function day(iso: string | null, language: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(intlLocale(language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function MyChannelAccounts() {
  const { t, language } = useI18n();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { ask, dialog } = useConfirm();
  const [code, setCode] = useState<LinkCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [linked, setLinked] = useState(false);
  const mine = useMyIdentities(code !== null);
  const before = useRef<number | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      (await client.request('post', '/auth/me/channel-identities/link-codes', {}))
        .data as unknown as LinkCode,
    onSuccess: (issued) => {
      before.current = mine.data?.items.length ?? 0;
      setLinked(false);
      setCopied(false);
      setCode(issued);
    },
  });
  const unlink = useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/auth/me/channel-identities/{identity_id}', {
        params: { identity_id: id },
      });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.mine() }),
  });

  // A new link while a code waits: it was that code, sent from the account.
  const count = mine.data?.items.length ?? 0;
  useEffect(() => {
    if (code && before.current !== null && count > before.current) {
      setCode(null);
      setLinked(true);
    }
  }, [code, count]);

  const rows = mine.data?.items ?? [];
  return (
    <Card tone="flat" padding="md" testId="channel-accounts">
      <CardHeader title={t('channel_accounts.title')} subtitle={t('channel_accounts.subtitle')} />
      {mine.isError && <Notice tone="danger">{describeError(mine.error, t)}</Notice>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted" data-testid="channel-accounts-empty">
          {t('channel_accounts.none')}
        </p>
      ) : (
        <Table
          caption={t('channel_accounts.title')}
          testId="channel-accounts-table"
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'platform',
              header: t('channel_accounts.platform'),
              cell: (row) => t(`channel_accounts.platform_${row.platform}`),
            },
            {
              key: 'account',
              header: t('channel_accounts.account'),
              cell: (row) => (
                <span dir="ltr" className="font-mono text-xs">
                  {row.sender_id}
                </span>
              ),
            },
            {
              key: 'linked',
              header: t('channel_accounts.linked_at'),
              cell: (row) => day(row.linked_at, language),
            },
            {
              key: 'used',
              header: t('channel_accounts.last_used'),
              cell: (row) => day(row.last_used_at, language),
            },
            {
              key: 'actions',
              header: t('channel_accounts.actions'),
              cell: (row) => (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconTrash size={14} />}
                  disabled={unlink.isPending}
                  onClick={() =>
                    void ask({
                      title: t('channel_accounts.unlink_title'),
                      body: t('channel_accounts.unlink_body'),
                      confirmLabel: t('channel_accounts.unlink'),
                    }).then((yes) => {
                      if (yes) unlink.mutate(row.id);
                    })
                  }
                  data-testid={`unlink-${row.id}`}
                >
                  {t('channel_accounts.unlink')}
                </Button>
              ),
            },
          ]}
        />
      )}
      {linked && (
        <div data-testid="channel-accounts-linked">
          <Notice tone="success">{t('channel_accounts.linked')}</Notice>
        </div>
      )}
      {code ? (
        <div className="flex flex-col gap-2" data-testid="channel-link-code">
          <p className="text-sm">{t('channel_accounts.send_this')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="select-all rounded-md px-2 py-1 font-mono text-sm"
              dir="ltr"
              data-testid="channel-link-command"
            >
              {code.command}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard?.writeText(code.command).then(() => setCopied(true))
              }
              data-testid="channel-link-copy"
            >
              {copied ? t('channel_accounts.copied') : t('channel_accounts.copy')}
            </Button>
          </div>
          <p className="text-xs text-muted">
            {t('channel_accounts.expires', { time: day(code.expires_at, language) })}
          </p>
          <p className="text-xs text-muted">{t('channel_accounts.must_answer')}</p>
          <p className="text-xs text-muted">{t('channel_accounts.waiting')}</p>
          <Button
            className="self-start"
            size="sm"
            variant="ghost"
            onClick={() => setCode(null)}
            data-testid="channel-link-cancel"
          >
            {t('common.cancel')}
          </Button>
        </div>
      ) : (
        <Button
          className="self-start"
          size="sm"
          loading={create.isPending}
          onClick={() => create.mutate()}
          data-testid="channel-link-start"
        >
          {t('channel_accounts.link')}
        </Button>
      )}
      {(create.isError || unlink.isError) && (
        <Notice tone="danger">{describeError(create.error ?? unlink.error, t)}</Notice>
      )}
      {dialog}
    </Card>
  );
}

/** Everyone's links, for an owner or an admin (Settings → People). */
export function AllChannelAccounts({ users }: { users: readonly HubUser[] }) {
  const { t, language } = useI18n();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const { ask, dialog } = useConfirm();
  const all = useQuery({
    queryKey: keys.all(),
    queryFn: async () =>
      (await client.request('get', '/auth/channel-identities', {})).data as unknown as {
        items: ChannelIdentity[];
      },
    enabled: !!session,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await client.request('delete', '/auth/channel-identities/{identity_id}', {
        params: { identity_id: id },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.all() });
      void queryClient.invalidateQueries({ queryKey: keys.mine() });
    },
  });
  const nameOf = (id: string) => {
    const user = users.find((entry) => entry.id === id);
    return user ? user.display_name || user.username : id;
  };
  const rows = all.data?.items ?? [];

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="channel-links-heading"
      data-testid="all-channel-accounts"
    >
      <h3 id="channel-links-heading" className="text-sm font-semibold">
        {t('channel_accounts.all_title')}
      </h3>
      <p className="text-xs text-muted">{t('channel_accounts.all_subtitle')}</p>
      {all.isError && <Notice tone="danger">{describeError(all.error, t)}</Notice>}
      {rows.length === 0 ? (
        <EmptyState size="sm" title={t('channel_accounts.all_none')} />
      ) : (
        <Table
          caption={t('channel_accounts.all_title')}
          testId="all-channel-accounts-table"
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'who',
              header: t('people.person'),
              cell: (row) => <span dir="auto">{nameOf(row.user_id)}</span>,
            },
            {
              key: 'platform',
              header: t('channel_accounts.platform'),
              cell: (row) => t(`channel_accounts.platform_${row.platform}`),
            },
            {
              key: 'account',
              header: t('channel_accounts.account'),
              cell: (row) => (
                <span dir="ltr" className="font-mono text-xs">
                  {row.sender_id}
                </span>
              ),
            },
            {
              key: 'used',
              header: t('channel_accounts.last_used'),
              cell: (row) => day(row.last_used_at, language),
            },
            {
              key: 'actions',
              header: t('channel_accounts.actions'),
              cell: (row) => (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconTrash size={14} />}
                  disabled={remove.isPending}
                  onClick={() =>
                    void ask({
                      title: t('channel_accounts.remove_title', { name: nameOf(row.user_id) }),
                      body: t('channel_accounts.unlink_body'),
                      confirmLabel: t('channel_accounts.remove'),
                    }).then((yes) => {
                      if (yes) remove.mutate(row.id);
                    })
                  }
                  data-testid={`remove-link-${row.id}`}
                >
                  {t('channel_accounts.remove')}
                </Button>
              ),
            },
          ]}
        />
      )}
      {remove.isError && <Notice tone="danger">{describeError(remove.error, t)}</Notice>}
      {dialog}
    </section>
  );
}
