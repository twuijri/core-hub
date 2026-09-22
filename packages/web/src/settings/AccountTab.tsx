import { useMe } from '../hub/queries.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Avatar, Card, CardHeader, Notice, Skeleton, SkeletonGroup, Table } from '../ui/index.js';

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
    </div>
  );
}
