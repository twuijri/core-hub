/**
 * Workspaces: the separate rooms this hub keeps — agents, models, sessions and settings
 * that do not see each other (ADR 0005).
 *
 * **The chip in the footer switches; this page decides what exists.** They are different
 * questions, and putting the second one on the chip is how a menu becomes a control panel.
 *
 * **Each one is a Hermes profile** (ADR 0014): made in Hermes, from scratch or as a copy of
 * one the person picks, and a profile Hermes already has is listed here.
 *
 * **Each one moves as Hermes's archive** (ADR 0014 stage 2): exported to a file that leaves
 * every credential behind, and imported from one as a new profile (`ProfileTransfer.tsx`).
 *
 * **Renaming one changes its name, never its id** (contract decision §44): any profile,
 * `default` included, can be called anything, in any language, and Hermes shows that name
 * too. The slug stays, because it is the Hermes folder chats, channels and schedules use.
 *
 * **Removing one archives it**, which is the hub's own word: the rows stay and only the
 * memberships go, and the Hermes profile stays as it is. The button says archive for that reason — a delete that archives is a
 * lie the person finds out later, and the opposite would be worse.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  Field,
  Input,
  Notice,
  Segmented,
  Select,
  Skeleton,
  SkeletonGroup,
  useConfirm,
} from '../ui/index.js';
import { ExportDialog, ImportDialog } from './ProfileTransfer.js';
import {
  PROFILE_NAME_MAX,
  useArchiveWorkspace,
  useCreateWorkspace,
  useUpdateWorkspace,
  useWorkspaces,
  type Workspace,
} from './queries.js';

/** The contract's `ProfileSlug`, checked here so the field says so before the hub does. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export function WorkspacesTab() {
  const { t } = useI18n();
  const workspaces = useWorkspaces();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <p className="text-xs text-muted">{t('workspaces.note')}</p>
        <Button
          className="ms-auto"
          size="sm"
          variant="secondary"
          onClick={() => setImporting(true)}
          data-testid="import-workspace"
        >
          {t('workspaces.import')}
        </Button>
        <Button size="sm" onClick={() => setAdding(true)} data-testid="add-workspace">
          {t('workspaces.add')}
        </Button>
      </div>
      {workspaces.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <Skeleton height="5rem" radius="md" />
          <Skeleton height="5rem" radius="md" />
        </SkeletonGroup>
      )}
      {workspaces.isError && <Notice tone="danger">{describeError(workspaces.error, t)}</Notice>}
      {workspaces.data && (
        <ul className="flex flex-col gap-2" data-testid="workspace-list">
          {workspaces.data.items.map((workspace) => (
            <li key={workspace.id}>
              <WorkspaceCard workspace={workspace} />
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddWorkspace existing={workspaces.data?.items ?? []} onClose={() => setAdding(false)} />
      )}
      {importing && (
        <ImportDialog existing={workspaces.data?.items ?? []} onClose={() => setImporting(false)} />
      )}
    </div>
  );
}

function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const { t } = useI18n();
  const { profile } = useAuth();
  const update = useUpdateWorkspace();
  const archive = useArchiveWorkspace();
  const { ask, dialog } = useConfirm();
  const [name, setName] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // `default` always exists and the hub refuses to archive it, so the button is absent.
  const isDefault = workspace.slug === 'default';
  const isCurrent = workspace.slug === profile;

  return (
    <Card tone="flat" padding="sm">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span dir="auto">{workspace.name}</span>
            <span className="text-xs text-muted" dir="ltr">
              {workspace.slug}
            </span>
            {isCurrent && <Badge tone="accent">{t('workspaces.current')}</Badge>}
            {isDefault && <Badge>{t('workspaces.default')}</Badge>}
          </span>
        }
        subtitle={t('workspaces.counts', {
          agents: String(workspace.agent_count),
          sessions: String(workspace.session_count),
        })}
        actions={
          <span className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              data-testid="rename-workspace"
              onClick={() => {
                update.reset();
                setName(workspace.name);
              }}
            >
              {t('common.rename')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="export-workspace"
              onClick={() => setExporting(true)}
            >
              {t('workspaces.export')}
            </Button>
            {!isDefault && (
              <Button
                size="sm"
                variant="danger"
                data-testid="archive-workspace"
                onClick={() => {
                  void ask({
                    title: t('workspaces.archive_title', { name: workspace.name }),
                    // The exact consequence, because "delete" would be the wrong word and
                    // "archive" alone does not say what happens to the people in it.
                    body: t('workspaces.archive_body', {
                      sessions: String(workspace.session_count),
                    }),
                    confirmLabel: t('workspaces.archive'),
                  }).then((yes) => {
                    if (yes) archive.mutate(workspace.id);
                  });
                }}
              >
                {t('workspaces.archive')}
              </Button>
            )}
          </span>
        }
      />
      {name !== null && (
        <Dialog
          open
          onOpenChange={(open) => !open && setName(null)}
          title={t('workspaces.rename_title', { name: workspace.name })}
          closeLabel={t('common.cancel')}
          testId="rename-workspace-dialog"
          footer={
            <>
              <Button variant="ghost" onClick={() => setName(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                disabled={name.trim().length === 0 || update.isPending}
                data-testid="save-workspace-name"
                onClick={() =>
                  update.mutate(
                    { id: workspace.id, patch: { name: name.trim() } },
                    { onSuccess: () => setName(null) },
                  )
                }
              >
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Field
              label={t('workspaces.name')}
              hint={t('workspaces.rename_hint', { slug: workspace.slug })}
            >
              {(props) => (
                <Input
                  {...props}
                  dir="auto"
                  maxLength={PROFILE_NAME_MAX}
                  value={name}
                  data-testid="workspace-name-input"
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            {update.isError && <Notice tone="danger">{refusal(update.error, t)}</Notice>}
          </div>
        </Dialog>
      )}
      {exporting && <ExportDialog workspace={workspace} onClose={() => setExporting(false)} />}
      {dialog}
      {archive.isError && <Notice tone="danger">{describeError(archive.error, t)}</Notice>}
    </Card>
  );
}

function AddWorkspace({ existing, onClose }: { existing: Workspace[]; onClose: () => void }) {
  const { t } = useI18n();
  const create = useCreateWorkspace();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  // Asked, not defaulted (owner, 2026-09-23): a Hermes profile starts either fresh or as a
  // copy of one the person picks — config, SOUL and skills, never memory or chats (ADR 0014).
  const [origin, setOrigin] = useState<'blank' | 'clone'>('blank');
  const [cloneFrom, setCloneFrom] = useState<string | null>(null);
  const taken = existing.some((workspace) => workspace.slug === slug);
  const badSlug = slug.length > 0 && !SLUG.test(slug);
  const ready =
    slug.length > 0 &&
    !badSlug &&
    !taken &&
    name.trim().length > 0 &&
    (origin === 'blank' || cloneFrom !== null);

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('workspaces.add')}
      closeLabel={t('common.cancel')}
      testId="add-workspace-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!ready || create.isPending}
            data-testid="save-workspace"
            onClick={() =>
              create.mutate(
                {
                  slug,
                  name: name.trim(),
                  ...(origin === 'clone' && cloneFrom ? { clone_from: cloneFrom } : {}),
                },
                { onSuccess: onClose },
              )
            }
          >
            {t('workspaces.add')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('workspaces.name')}>
          {(props) => (
            <Input
              {...props}
              maxLength={PROFILE_NAME_MAX}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                // The slug follows the name until somebody types one: two fields that
                // must agree, where only one is usually worth thinking about.
                if (slug === '' || slug === suggest(name)) setSlug(suggest(event.target.value));
              }}
            />
          )}
        </Field>
        <Field
          label={t('workspaces.slug')}
          hint={t('workspaces.slug_hint')}
          {...(badSlug
            ? { error: t('workspaces.slug_bad') }
            : taken
              ? { error: t('workspaces.slug_taken') }
              : {})}
        >
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={slug}
              invalid={badSlug || taken}
              onChange={(event) => setSlug(event.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1">
          <Segmented
            label={t('workspaces.origin')}
            value={origin}
            onChange={(value) => setOrigin(value === 'clone' ? 'clone' : 'blank')}
            size="sm"
            stretch
            testId="workspace-origin"
            options={[
              { value: 'blank', label: t('workspaces.origin_blank') },
              { value: 'clone', label: t('workspaces.origin_clone') },
            ]}
          />
          <p className="text-xs text-muted">
            {t(origin === 'blank' ? 'workspaces.origin_blank_what' : 'workspaces.clone_what')}
          </p>
        </div>
        {origin === 'clone' && (
          <Select
            label={t('workspaces.clone')}
            value={cloneFrom}
            placeholder={t('workspaces.clone_pick')}
            onValueChange={setCloneFrom}
            testId="workspace-clone-from"
            options={existing.map((workspace) => ({
              value: workspace.slug,
              label: workspace.name,
            }))}
          />
        )}
        {create.isError && <Notice tone="danger">{refusal(create.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}

/** Hermes's own words when it refused to make the profile; the hub's message otherwise. */
function refusal(
  error: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const details = (error as { body?: { details?: { reason?: string; message?: string } } })?.body
    ?.details;
  return details?.reason === 'hermes_refused' && details.message
    ? t('workspaces.refused', { message: details.message })
    : describeError(error, t);
}

/** A name turned into a slug: lowercase, dashes, nothing else. Latin names only — an
    Arabic name gives nothing usable, and the field then stays empty for the person to
    fill, which is better than a transliteration nobody asked for. */
function suggest(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
