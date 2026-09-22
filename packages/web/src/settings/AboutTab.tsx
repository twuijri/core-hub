/**
 * About: what this hub is, and what it is speaking.
 *
 * The versions are the two that matter and they are different things: the **server**'s
 * build, and the **contract** it implements. A client that talks to a hub whose contract
 * version it does not know is the one bug this page exists to make visible, so both are
 * shown side by side rather than one "version".
 */
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { useMeta } from '../hub/queries.js';
import { Badge, Notice, Skeleton, SkeletonGroup, Table } from '../ui/index.js';

export function AboutTab() {
  const { t } = useI18n();
  const meta = useMeta();

  if (meta.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="8rem" radius="md" />
      </SkeletonGroup>
    );
  if (meta.isError) return <Notice tone="danger">{describeError(meta.error, t)}</Notice>;
  const data = meta.data;

  const rows = [
    { key: 'name', label: t('about.name'), value: data.name },
    { key: 'server', label: t('about.server_version'), value: data.server_version },
    { key: 'contract', label: t('about.contract_version'), value: data.contract_version },
    // What this very page was built from. When it differs from the server's build the
    // browser is holding an old bundle, which is worth being able to see.
    { key: 'client', label: t('about.client_version'), value: __APP_VERSION__ },
    { key: 'locales', label: t('about.locales'), value: data.locales.join('، ') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Table
        caption={t('nav.about')}
        testId="about-facts"
        rows={rows}
        rowKey={(row) => row.key}
        columns={[
          { key: 'label', header: t('account.field'), cell: (row) => row.label },
          {
            key: 'value',
            header: t('account.value'),
            cell: (row) => (
              <span dir="ltr" data-testid={`about-${row.key}`}>
                {row.value}
              </span>
            ),
          },
        ]}
      />
      <section className="flex flex-col gap-2" aria-labelledby="realtime-heading">
        <h3 id="realtime-heading" className="text-sm font-semibold">
          {t('about.realtime')}
        </h3>
        <p className="text-xs text-muted">{t('about.realtime_note')}</p>
        <span className="flex flex-wrap gap-1" data-testid="about-namespaces">
          {data.realtime_namespaces.map((namespace) => (
            <Badge key={namespace}>
              <span dir="ltr">{namespace}</span>
            </Badge>
          ))}
        </span>
      </section>
    </div>
  );
}
