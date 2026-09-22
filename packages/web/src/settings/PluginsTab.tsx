/**
 * Plugins: what is installed on this hub.
 *
 * The hub answers this list and the list is empty, because **no installer exists yet**.
 * The page says that in as many words. The alternative — a marketplace of things that
 * cannot be installed — would be a promise, and this is a status.
 */
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, EmptyState, Notice, Skeleton, SkeletonGroup, Table } from '../ui/index.js';
import { IconTool } from '../ui/icons.js';
import { usePlugins, type HubPlugin } from './queries.js';

export function PluginsTab() {
  const { t } = useI18n();
  const plugins = usePlugins();
  const rows = plugins.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      {plugins.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="6rem" radius="md" />
        </SkeletonGroup>
      )}
      {plugins.isError && <Notice tone="danger">{describeError(plugins.error, t)}</Notice>}
      {plugins.data &&
        (rows.length === 0 ? (
          <EmptyState
            icon={<IconTool size={20} />}
            title={t('plugins.none')}
            body={t('plugins.none_body')}
          />
        ) : (
          <Table
            caption={t('nav.plugins')}
            testId="plugin-table"
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'name',
                header: t('plugins.name'),
                cell: (row: HubPlugin) => (
                  <span className="flex flex-col">
                    <span dir="auto">{row.name}</span>
                    <span className="text-xs text-muted" dir="ltr">
                      {row.slug} · {row.version}
                    </span>
                  </span>
                ),
              },
              { key: 'kind', header: t('plugins.kind'), cell: (row) => row.kind },
              {
                key: 'status',
                header: t('plugins.status'),
                cell: (row) => (
                  <Badge
                    dot
                    tone={
                      row.status === 'running'
                        ? 'success'
                        : row.status === 'error'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {t(`plugins.status_${row.status}`)}
                  </Badge>
                ),
              },
            ]}
          />
        ))}
    </div>
  );
}
