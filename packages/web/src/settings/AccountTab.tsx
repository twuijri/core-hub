import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useMe } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { MyChannelAccounts } from '../people/ChannelAccounts.js';
import {
  Avatar,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Notice,
  Skeleton,
  SkeletonGroup,
  Table,
} from '../ui/index.js';

/** Who you are on this hub: the avatar and name up top, the facts in one table. */
export function AccountTab() {
  const { t } = useI18n();
  const me = useMe();
  if (me.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="3rem" radius="md" />
        <Skeleton height="8rem" radius="md" />
      </SkeletonGroup>
    );
  if (me.isError) return <Notice tone="danger">{describeError(me.error, t)}</Notice>;
  const user = me.data;
  const rows = [
    { key: 'username', label: t('account.username'), value: user.username },
    { key: 'display_name', label: t('account.display_name'), value: user.display_name },
    { key: 'role', label: t('account.role'), value: t(`roles.${user.role}`) },
    { key: 'workspaces', label: t('account.workspaces'), value: user.profiles.join(', ') || '—' },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card tone="flat" padding="sm">
        <CardHeader
          title={user.display_name || user.username}
          subtitle={t(`roles.${user.role}`)}
          media={<Avatar name={user.display_name || user.username} size="lg" />}
        />
      </Card>
      <Table
        caption={t('nav.account')}
        testId="account-facts"
        rows={rows}
        rowKey={(row) => row.key}
        columns={[
          { key: 'label', header: t('account.field'), cell: (row) => row.label },
          {
            key: 'value',
            header: t('account.value'),
            cell: (row) => <span dir="auto">{row.value}</span>,
          },
        ]}
      />
      <MyChannelAccounts />
      <ChangePassword />
    </div>
  );
}

/**
 * Your own password, the one thing only you may change about your account — the owner's
 * included (an admin can set anyone else's from People, never the owner's). The hub keeps
 * this device signed in and signs out every other one (`auth.changePassword`).
 */
function ChangePassword() {
  const { t } = useI18n();
  const { client } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const change = useMutation({
    mutationFn: async () => {
      await client.request('post', '/auth/me/password', {
        body: { current_password: current, new_password: next },
      });
    },
    onSuccess: () => {
      // Emptied the moment the hub has them: nothing on the page keeps a password.
      setCurrent('');
      setNext('');
      setAgain('');
    },
  });
  const short = next.length > 0 && next.length < 8;
  const mismatch = again.length > 0 && again !== next;
  const ready = current.length > 0 && next.length >= 8 && again === next && !change.isPending;

  return (
    <Card tone="flat" padding="md" testId="change-password">
      <CardHeader title={t('account.password')} subtitle={t('account.password_hint')} />
      <form
        className="flex max-w-sm flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) change.mutate();
        }}
      >
        <Field label={t('account.current_password')}>
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              data-testid="current-password"
            />
          )}
        </Field>
        <Field
          label={t('account.new_password')}
          {...(short ? { error: t('people.password_short') } : {})}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              value={next}
              invalid={short}
              onChange={(event) => setNext(event.target.value)}
              data-testid="new-password"
            />
          )}
        </Field>
        <Field
          label={t('account.confirm_password')}
          {...(mismatch ? { error: t('account.password_mismatch') } : {})}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              value={again}
              invalid={mismatch}
              onChange={(event) => setAgain(event.target.value)}
              data-testid="confirm-password"
            />
          )}
        </Field>
        {change.isSuccess && <Notice tone="success">{t('account.password_changed')}</Notice>}
        {change.isError && <Notice tone="danger">{describeError(change.error, t)}</Notice>}
        <Button
          type="submit"
          className="self-start"
          disabled={!ready}
          loading={change.isPending}
          data-testid="save-own-password"
        >
          {t('account.change_password')}
        </Button>
      </form>
    </Card>
  );
}
