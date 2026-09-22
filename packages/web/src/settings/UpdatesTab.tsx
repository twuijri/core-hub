/**
 * Updates: the builds this hub hands out to its own clients.
 *
 * **Not the web client.** The web is served by the hub and changes when the hub does, so
 * it is not in `ClientPlatform` and cannot be "checked" — the page says so once, at the
 * top, because "Updates" that does not update the thing you are looking at is exactly the
 * kind of page a person misreads.
 *
 * What it is, is the owner's release shelf for the phone and desktop clients: which
 * channel is the default, whether the hub fetches new releases from a source by itself,
 * and what is on the shelf now.
 *
 * **The source token never comes back.** It is written once and read as the fact that
 * there is one, exactly as the webhook signing secret is.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  Segmented,
  Skeleton,
  SkeletonGroup,
  Switch,
  Table,
  useConfirm,
} from '../ui/index.js';
import { IconUpload } from '../ui/icons.js';
import {
  useDeleteRelease,
  useReleases,
  useSaveUpdateSettings,
  useUpdateSettings,
  type Release,
} from './queries.js';

export function UpdatesTab() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <Notice>{t('updates.web_note')}</Notice>
      <Source />
      <Shelf />
    </div>
  );
}

function Source() {
  const { t } = useI18n();
  const settings = useUpdateSettings();
  const save = useSaveUpdateSettings();
  const [repo, setRepo] = useState<string | null>(null);
  const [token, setToken] = useState('');

  if (settings.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="8rem" radius="md" />
      </SkeletonGroup>
    );
  if (settings.isError) return <Notice tone="danger">{describeError(settings.error, t)}</Notice>;
  const current = settings.data;
  const fromSource = current.source.kind === 'github_release';

  return (
    <section className="flex flex-col gap-3" aria-labelledby="updates-source">
      <h3 id="updates-source" className="text-sm font-semibold">
        {t('updates.source')}
      </h3>
      <Segmented
        className="self-start"
        size="sm"
        label={t('updates.default_channel')}
        value={current.default_channel}
        onChange={(value) => save.mutate({ default_channel: value === 'test' ? 'test' : 'stable' })}
        options={[
          { value: 'stable', label: t('updates.channel_stable') },
          { value: 'test', label: t('updates.channel_test') },
        ]}
      />
      <Switch
        checked={fromSource}
        label={t('updates.from_source')}
        hint={t('updates.from_source_hint')}
        testId="updates-from-source"
        onChange={(next) => save.mutate({ source: { kind: next ? 'github_release' : 'manual' } })}
      />
      {fromSource && (
        <div className="flex flex-col gap-3" data-testid="updates-source-fields">
          <Field label={t('updates.repo')} hint={t('updates.repo_hint')}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                placeholder="owner/repo"
                value={repo ?? current.source.repo ?? ''}
                onChange={(event) => setRepo(event.target.value)}
                onBlur={() => {
                  if (repo !== null && repo !== current.source.repo)
                    save.mutate({ source: { kind: 'github_release', repo } });
                }}
              />
            )}
          </Field>
          <Field
            label={t('updates.token')}
            // The fact that one is stored, never the value: the hub answers `[stored]`.
            hint={current.source.token ? t('updates.token_stored') : t('updates.token_hint')}
          >
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="off"
                dir="ltr"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onBlur={() => {
                  if (token.length > 0) {
                    save.mutate({ source: { kind: 'github_release', token } });
                    setToken('');
                  }
                }}
              />
            )}
          </Field>
          <Switch
            checked={current.auto_publish}
            label={t('updates.auto_publish')}
            hint={t('updates.auto_publish_hint')}
            testId="updates-auto-publish"
            onChange={(next) => save.mutate({ auto_publish: next })}
          />
        </div>
      )}
      {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
    </section>
  );
}

function Shelf() {
  const { t, language } = useI18n();
  const releases = useReleases();
  const remove = useDeleteRelease();
  const { ask, dialog } = useConfirm();
  const rows = releases.data?.items ?? [];
  const mb = (bytes: number) =>
    `${new Intl.NumberFormat(language === 'ar' ? 'ar' : 'en').format(Math.round(bytes / 1_048_576))} MB`;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="updates-shelf">
      <h3 id="updates-shelf" className="text-sm font-semibold">
        {t('updates.shelf')}
      </h3>
      {releases.isError && <Notice tone="danger">{describeError(releases.error, t)}</Notice>}
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<IconUpload size={20} />}
          title={t('updates.empty')}
          body={t('updates.empty_body')}
        />
      ) : (
        <Table
          caption={t('updates.shelf')}
          testId="release-table"
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'what',
              header: t('updates.build'),
              cell: (row: Release) => (
                <span className="flex items-center gap-2">
                  <span dir="ltr">
                    {row.version} ({row.build})
                  </span>
                  <Badge>{t(`updates.platform_${row.platform}`)}</Badge>
                  <Badge tone={row.channel === 'test' ? 'warning' : 'success'}>
                    {t(`updates.channel_${row.channel}`)}
                  </Badge>
                  {row.mandatory && <Badge tone="danger">{t('updates.mandatory')}</Badge>}
                </span>
              ),
            },
            {
              key: 'size',
              header: t('updates.size'),
              cell: (row) => mb(row.size_bytes),
              numeric: true,
            },
            {
              key: 'when',
              header: t('updates.published'),
              cell: (row) => row.published_at.slice(0, 10),
            },
            {
              key: 'remove',
              header: '',
              cell: (row) => (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="delete-release"
                  onClick={() => {
                    void ask({
                      title: t('updates.delete_title', { version: row.version }),
                      // A build already downloaded keeps working; this is about the shelf.
                      body: t('updates.delete_body'),
                      confirmLabel: t('common.delete'),
                    }).then((yes) => {
                      if (yes) remove.mutate(row.id);
                    });
                  }}
                >
                  {t('common.delete')}
                </Button>
              ),
            },
          ]}
        />
      )}
      {dialog}
    </section>
  );
}
