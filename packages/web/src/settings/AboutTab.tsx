/**
 * About: what this hub is, and what it is speaking.
 *
 * The versions are the two that matter and they are different things: the **server**'s
 * build, and the **contract** it implements. A client that talks to a hub whose contract
 * version it does not know is the one bug this page exists to make visible, so both are
 * shown side by side rather than one "version".
 *
 * Above them, this app's own version, and the connected hub's only when there is one (owner,
 * 2026-10-27: the sidebar's single number had mixed the two up).
 *
 * Below them, where Core Hub lives (owner, 2026-10-27): the download page and the repository,
 * so somebody who forgot can find the apps and the source again. The same two rows are in
 * About on the phones.
 */
import { PRODUCT_LINKS } from '@corehub/contracts';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { useMeta } from '../hub/queries.js';
import { useDesktopAppVersion } from '../shell/VersionLabel.js';
import { IconDownload } from '../ui/icons.js';
import { Badge, GitHubMark, Notice, Skeleton, SkeletonGroup, Table } from '../ui/index.js';

/**
 * The first rows of About (owner, 2026-10-27): this app's version first — the desktop app's in
 * its window, this web build in a browser — then the hub it is connected to, only when it is.
 */
export function aboutVersionRows(
  desktop: string | null,
  web: string,
  hub: string | null,
): { key: 'app' | 'server'; labelKey: string; value: string }[] {
  const app =
    desktop === null
      ? { key: 'app' as const, labelKey: 'about.web_app', value: web }
      : { key: 'app' as const, labelKey: 'about.desktop_app', value: desktop };
  return hub === null
    ? [app]
    : [app, { key: 'server' as const, labelKey: 'about.connected_hub', value: hub }];
}

export function AboutTab() {
  const { t } = useI18n();
  const meta = useMeta();
  const desktop = useDesktopAppVersion();

  if (meta.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="8rem" radius="md" />
      </SkeletonGroup>
    );
  const data = meta.isError ? null : meta.data;

  const rows = [
    ...aboutVersionRows(desktop, __APP_VERSION__, data?.server_version ?? null).map((row) => ({
      key: row.key,
      label: t(row.labelKey),
      value: row.value,
    })),
    ...(data
      ? [
          { key: 'name', label: t('about.name'), value: data.name },
          { key: 'contract', label: t('about.contract_version'), value: data.contract_version },
          // In the desktop window, what this very page was built from: in remote mode it is the
          // hub's bundle, not the app's, which is worth being able to see.
          ...(desktop === null
            ? []
            : [{ key: 'client', label: t('about.client_version'), value: __APP_VERSION__ }]),
          { key: 'locales', label: t('about.locales'), value: data.locales.join('، ') },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {meta.isError ? <Notice tone="danger">{describeError(meta.error, t)}</Notice> : null}
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
      <section className="flex flex-col gap-2" aria-labelledby="links-heading">
        <h3 id="links-heading" className="text-sm font-semibold">
          {t('about.links')}
        </h3>
        <ul className="flex flex-col gap-2" data-testid="about-links">
          {[
            {
              key: 'download',
              href: PRODUCT_LINKS.downloadPage,
              label: t('about.download_page'),
              note: t('about.download_page_note'),
              icon: <IconDownload size={16} />,
            },
            {
              key: 'repository',
              href: PRODUCT_LINKS.repository,
              label: t('about.repository'),
              note: t('about.repository_note'),
              icon: <GitHubMark size={16} />,
            },
          ].map((link) => (
            <li key={link.key}>
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 hover:underline"
                data-testid={`about-link-${link.key}`}
              >
                <span className="mt-0.5 text-muted">{link.icon}</span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{link.label}</span>
                  <span className="text-xs text-muted">{link.note}</span>
                  <span className="text-xs text-faint" dir="ltr">
                    {link.href.replace(/^https:\/\//, '').replace(/\/$/, '')}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
      {data ? (
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
      ) : null}
    </div>
  );
}
