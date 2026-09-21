import { useMe } from '../hub/queries.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Notice, Spinner } from '../ui/Notice.js';

export function AccountTab() {
  const { t } = useI18n();
  const me = useMe();
  if (me.isPending) return <Spinner label={t('common.loading')} />;
  if (me.isError) return <Notice tone="danger">{describeError(me.error, t)}</Notice>;
  const user = me.data;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted">{t('account.username')}</dt>
      <dd>{user.username}</dd>
      <dt className="text-muted">{t('account.display_name')}</dt>
      <dd dir="auto">{user.display_name}</dd>
      <dt className="text-muted">{t('account.role')}</dt>
      <dd>{t(`roles.${user.role}`)}</dd>
      <dt className="text-muted">{t('account.workspaces')}</dt>
      <dd>{user.profiles.join(', ') || '—'}</dd>
    </dl>
  );
}
