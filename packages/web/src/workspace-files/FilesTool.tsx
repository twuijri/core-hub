/**
 * Files («الملفات»): the selected profile's working folder, for its owner and admins.
 *
 * Agents work in `/data/workspaces/<profile>/…` — a folder per conversation, one per task.
 * This page is a file manager over that folder and nothing more (DECISIONS §65): browse
 * with breadcrumbs, drop files to upload, download a file or a folder as a zip, make a
 * folder or a text file, rename, move, copy, delete (after a confirm), preview text,
 * pictures and PDFs, edit text with colour and a save-conflict check, and hand a file to a
 * conversation. There is no terminal and nothing here runs a command.
 *
 * The folder shown is in the address (`?path=`), so the back button walks back up and a
 * folder can be linked to. The profile is the top chip's: switching it shows that profile's
 * folder from its top.
 */
import { HubApiError } from '@corehub/contracts';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { useProfileName } from '../shell/profiles.js';
import {
  Badge,
  Breadcrumb,
  Button,
  EmptyState,
  Menu,
  MenuItem,
  MenuSeparator,
  Notice,
  Skeleton,
  SkeletonGroup,
  Table,
  Tooltip,
  useConfirm,
  usePrompt,
  useToast,
  type Column,
} from '../ui/index.js';
import {
  IconCopy,
  IconDownload,
  IconFile,
  IconFolder,
  IconMore,
  IconPaperclip,
  IconPlus,
  IconTrash,
  IconUpload,
} from '../ui/icons.js';
import { AttachToChatDialog } from './AttachToChatDialog.js';
import { FilePreviewDialog } from './FilePreviewDialog.js';
import { TextEditorDialog } from './TextEditorDialog.js';
import { baseName, crumbsOf, formatBytes, joinPath, normalisePath, parentOf } from './paths.js';
import {
  saveBlob,
  useWorkspaceBytes,
  useWorkspaceFileActions,
  useWorkspaceFolder,
  type WorkspaceFileEntry,
} from './queries.js';

/** The page's own address for a folder. */
export function filesHref(path: string): string {
  const base = routeOf('files');
  return path === '' ? base : `${base}?path=${encodeURIComponent(path)}`;
}

export function FilesTool() {
  const { t, language } = useI18n();
  const { profile } = useAuth();
  const profileName = useProfileName();
  const [params, setParams] = useSearchParams();
  const folder = normalisePath(params.get('path') ?? '');
  const listing = useWorkspaceFolder(folder);
  const actions = useWorkspaceFileActions();
  const bytes = useWorkspaceBytes();
  const confirm = useConfirm();
  const ask = usePrompt();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [preview, setPreview] = useState<WorkspaceFileEntry | null>(null);
  const [editing, setEditing] = useState<{ path: string; isNew: boolean } | null>(null);
  const [attaching, setAttaching] = useState<WorkspaceFileEntry | null>(null);

  // Another profile's folder starts at its top: the path of this one means nothing there.
  const shownProfile = useRef(profile);
  useEffect(() => {
    if (shownProfile.current === profile) return;
    shownProfile.current = profile;
    setParams({}, { replace: true });
  }, [profile, setParams]);

  const open = (path: string) => setParams(path === '' ? {} : { path });
  const fail = (error: unknown) =>
    toast({ title: t('files.failed'), body: describeError(error, t), tone: 'danger' });

  // ---------------------------------------------------------------- uploads

  const uploadAll = async (files: readonly File[]) => {
    let done = 0;
    for (const file of files) {
      setUploading((current) => [...current, file.name]);
      try {
        try {
          await actions.upload.mutateAsync({ folder, file });
        } catch (error) {
          if (!(error instanceof HubApiError) || error.status !== 409) throw error;
          const replace = await confirm.ask({
            title: t('files.replace_title', { name: file.name }),
            body: t('files.replace_body'),
            confirmLabel: t('files.replace'),
          });
          if (!replace) continue;
          await actions.upload.mutateAsync({ folder, file, overwrite: true });
        }
        done += 1;
      } catch (error) {
        fail(error);
      } finally {
        setUploading((current) => current.filter((name) => name !== file.name));
      }
    }
    if (done > 0) toast({ title: t('files.uploaded', { count: done }), tone: 'success' });
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void uploadAll(files);
  };

  // ------------------------------------------------------------ row actions

  const rename = async (entry: WorkspaceFileEntry) => {
    const name = await ask.ask({
      title: t('files.rename_title', { name: entry.name }),
      label: t('files.new_name'),
      initialValue: entry.name,
      confirmLabel: t('common.rename'),
    });
    if (!name || name === entry.name) return;
    try {
      await actions.move.mutateAsync({
        from: entry.path,
        to: joinPath(parentOf(entry.path), name),
      });
    } catch (error) {
      fail(error);
    }
  };

  const relocate = async (entry: WorkspaceFileEntry, mode: 'move' | 'copy') => {
    const typed = await ask.ask({
      title: t(mode === 'move' ? 'files.move_title' : 'files.copy_title', { name: entry.name }),
      label: t('files.destination'),
      description: t('files.destination_hint'),
      initialValue:
        mode === 'copy' ? joinPath(parentOf(entry.path), copyName(entry.name)) : entry.path,
      confirmLabel: t(mode === 'move' ? 'files.move' : 'files.copy'),
    });
    const to = typed === null ? '' : normalisePath(typed);
    if (!to || to === entry.path) return;
    try {
      await (mode === 'move' ? actions.move : actions.copy).mutateAsync({ from: entry.path, to });
      toast({ title: t(mode === 'move' ? 'files.moved' : 'files.copied', { path: to }) });
    } catch (error) {
      fail(error);
    }
  };

  const remove = async (entry: WorkspaceFileEntry) => {
    const yes = await confirm.ask({
      title: t('files.delete_title', { name: entry.name }),
      body: t(entry.kind === 'directory' ? 'files.delete_folder_body' : 'files.delete_body'),
      tone: 'danger',
    });
    if (!yes) return;
    try {
      await actions.remove.mutateAsync(entry.path);
      toast({ title: t('files.deleted', { name: entry.name }) });
    } catch (error) {
      fail(error);
    }
  };

  const download = async (entry: WorkspaceFileEntry) => {
    try {
      if (entry.kind === 'directory')
        saveBlob(await bytes.zipBlob(entry.path), `${entry.name}.zip`);
      else saveBlob(await bytes.fileBlob(entry), entry.name);
    } catch (error) {
      fail(error);
    }
  };

  const downloadFolder = async () => {
    try {
      const name = folder === '' ? profile : baseName(folder);
      saveBlob(await bytes.zipBlob(folder), `${name}.zip`);
    } catch (error) {
      fail(error);
    }
  };

  const newFolder = async () => {
    const name = await ask.ask({
      title: t('files.new_folder'),
      label: t('files.new_name'),
      confirmLabel: t('files.create'),
    });
    if (!name) return;
    try {
      await actions.mkdir.mutateAsync(joinPath(folder, normalisePath(name)));
    } catch (error) {
      fail(error);
    }
  };

  const newFile = async () => {
    const name = await ask.ask({
      title: t('files.new_file'),
      label: t('files.new_name'),
      confirmLabel: t('files.create'),
    });
    if (!name) return;
    setEditing({ path: joinPath(folder, normalisePath(name)), isNew: true });
  };

  const activate = (entry: WorkspaceFileEntry) => {
    if (entry.kind === 'directory') open(entry.path);
    else if (entry.kind === 'file') setPreview(entry);
  };

  // ------------------------------------------------------------------ table

  const columns: Array<Column<WorkspaceFileEntry>> = [
    {
      key: 'name',
      header: t('files.name'),
      cell: (entry) => (
        <span className="files-name-cell">
          <span className="files-icon" aria-hidden>
            {entry.kind === 'directory' ? <IconFolder size={16} /> : <IconFile size={16} />}
          </span>
          {entry.kind === 'link' ? (
            <Tooltip label={t('files.link_outside_hint')}>
              <span className="files-name files-name-disabled" dir="auto" tabIndex={0}>
                {entry.name}
              </span>
            </Tooltip>
          ) : (
            <button
              type="button"
              className="files-name"
              dir="auto"
              onClick={() => activate(entry)}
              data-testid="files-entry"
              data-kind={entry.kind}
            >
              {entry.name}
            </button>
          )}
          {entry.link && entry.kind !== 'link' && <Badge>{t('files.link')}</Badge>}
          {entry.kind === 'link' && <Badge tone="warning">{t('files.link_outside')}</Badge>}
        </span>
      ),
    },
    {
      key: 'size',
      header: t('files.size'),
      numeric: true,
      secondary: true,
      cell: (entry) =>
        entry.size_bytes === null ? (
          <span className="text-faint">—</span>
        ) : (
          formatBytes(entry.size_bytes, language)
        ),
    },
    {
      key: 'modified',
      header: t('files.modified'),
      secondary: true,
      cell: (entry) =>
        entry.modified_at ? (
          <time dateTime={entry.modified_at}>
            {new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(entry.modified_at))}
          </time>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('files.actions')}</span>,
      cell: (entry) => (
        <Menu
          align="end"
          tooltip={t('files.actions_for', { name: entry.name })}
          testId="files-row-menu"
          trigger={
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<IconMore size={16} />}
              aria-label={t('files.actions_for', { name: entry.name })}
              data-testid="files-row-actions"
            />
          }
        >
          <RowActions
            entry={entry}
            onPreview={() => setPreview(entry)}
            onEdit={() => setEditing({ path: entry.path, isNew: false })}
            onDownload={() => void download(entry)}
            onAttach={() => setAttaching(entry)}
            onRename={() => void rename(entry)}
            onMove={() => void relocate(entry, 'move')}
            onCopy={() => void relocate(entry, 'copy')}
            onDelete={() => void remove(entry)}
          />
        </Menu>
      ),
    },
  ];

  const crumbs = [
    {
      label: t('files.root', { profile: profileName(profile) }),
      href: filesHref(''),
      render: renderLink,
    },
    ...crumbsOf(folder).map((crumb) => ({
      label: crumb.name,
      href: filesHref(crumb.path),
      render: renderLink,
    })),
  ];
  const limits = listing.data?.limits;

  return (
    <div className="flex flex-col gap-3" data-testid="files-tool">
      <p className="text-sm text-muted">{t('files.intro', { profile: profileName(profile) })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Breadcrumb label={t('files.breadcrumb')} items={crumbs} testId="files-breadcrumb" />
        <span className="ms-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<IconFolder size={14} />}
            onClick={() => void newFolder()}
            data-testid="files-new-folder"
          >
            {t('files.new_folder')}
          </Button>
          <Button
            size="sm"
            icon={<IconPlus size={14} />}
            onClick={() => void newFile()}
            data-testid="files-new-file"
          >
            {t('files.new_file')}
          </Button>
          <Button
            size="sm"
            icon={<IconDownload size={14} />}
            onClick={() => void downloadFolder()}
            data-testid="files-zip"
          >
            {t('files.download_zip')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<IconUpload size={14} />}
            onClick={() => fileInput.current?.click()}
            data-testid="files-upload"
          >
            {t('files.upload')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label={t('files.upload')}
            data-testid="files-upload-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length > 0) void uploadAll(files);
            }}
          />
        </span>
      </div>

      <section
        className="files-drop"
        data-dragging={dragging ? 'true' : undefined}
        aria-label={t('files.drop_zone')}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="files-drop"
      >
        {dragging && (
          <p className="files-drop-hint" role="status">
            {t('files.drop_here')}
          </p>
        )}
        {uploading.length > 0 && (
          <div data-testid="files-uploading">
            <Notice className="mb-2">
              {t('files.uploading', { names: uploading.join(', ') })}
            </Notice>
          </div>
        )}
        {listing.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="2.5rem" radius="md" />
            <Skeleton height="2.5rem" radius="md" />
            <Skeleton height="2.5rem" radius="md" />
          </SkeletonGroup>
        )}
        {listing.isError && (
          <FolderError error={listing.error} onTop={() => open('')} atTop={folder === ''} />
        )}
        {listing.data && (
          <>
            {folder !== '' && (
              <Link className="files-up" to={filesHref(parentOf(folder))} data-testid="files-up">
                {t('files.up')}
              </Link>
            )}
            <Table
              caption={t('files.caption', { folder: folder || profileName(profile) })}
              columns={columns}
              rows={listing.data.entries}
              rowKey={(entry) => entry.path}
              testId="files-table"
              empty={
                <EmptyState
                  size="sm"
                  icon={<IconFolder size={20} />}
                  title={t('files.empty')}
                  body={t('files.empty_body')}
                />
              }
            />
            {listing.data.truncated && <Notice tone="warning">{t('files.truncated')}</Notice>}
          </>
        )}
      </section>
      {limits && (
        <p className="text-xs text-faint">
          {t('files.limits', {
            upload: formatBytes(limits.max_upload_bytes, language),
            edit: formatBytes(limits.max_edit_bytes, language),
            zip: formatBytes(limits.max_archive_bytes, language),
          })}
        </p>
      )}

      {confirm.dialog}
      {ask.dialog}
      {preview && (
        <FilePreviewDialog
          entry={preview}
          onClose={() => setPreview(null)}
          onEdit={() => {
            setEditing({ path: preview.path, isNew: false });
            setPreview(null);
          }}
          onDownload={() => void download(preview)}
          onAttach={() => {
            setAttaching(preview);
            setPreview(null);
          }}
        />
      )}
      {editing && (
        <TextEditorDialog
          path={editing.path}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
        />
      )}
      {attaching && <AttachToChatDialog entry={attaching} onClose={() => setAttaching(null)} />}
    </div>
  );
}

function RowActions({
  entry,
  onPreview,
  onEdit,
  onDownload,
  onAttach,
  onRename,
  onMove,
  onCopy,
  onDelete,
}: {
  entry: WorkspaceFileEntry;
  onPreview(): void;
  onEdit(): void;
  onDownload(): void;
  onAttach(): void;
  onRename(): void;
  onMove(): void;
  onCopy(): void;
  onDelete(): void;
}) {
  const { t } = useI18n();
  const openable = entry.kind !== 'link';
  return (
    <>
      {entry.kind === 'file' && (
        <MenuItem icon={<IconFile size={14} />} onSelect={onPreview}>
          {t('files.preview')}
        </MenuItem>
      )}
      {entry.kind === 'file' && entry.editable && (
        <MenuItem icon={<IconFile size={14} />} onSelect={onEdit}>
          {t('common.edit')}
        </MenuItem>
      )}
      {openable && (
        <MenuItem icon={<IconDownload size={14} />} onSelect={onDownload}>
          {t(entry.kind === 'directory' ? 'files.download_zip' : 'files.download')}
        </MenuItem>
      )}
      {entry.kind === 'file' && (
        <MenuItem icon={<IconPaperclip size={14} />} onSelect={onAttach}>
          {t('files.attach')}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem onSelect={onRename}>{t('common.rename')}</MenuItem>
      <MenuItem onSelect={onMove}>{t('files.move')}</MenuItem>
      {openable && (
        <MenuItem icon={<IconCopy size={14} />} onSelect={onCopy}>
          {t('files.copy')}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon={<IconTrash size={14} />} tone="danger" onSelect={onDelete}>
        {t('common.delete')}
      </MenuItem>
    </>
  );
}

/** A folder that cannot be listed: say why, and offer the way back to the top. */
function FolderError({ error, onTop, atTop }: { error: unknown; onTop(): void; atTop: boolean }) {
  const { t } = useI18n();
  return (
    <div data-testid="files-error">
      <Notice tone="danger">
        <span className="flex flex-wrap items-center gap-2">
          <span>{describeError(error, t)}</span>
          {!atTop && (
            <Button size="sm" onClick={onTop}>
              {t('files.back_to_top')}
            </Button>
          )}
        </span>
      </Notice>
    </div>
  );
}

function renderLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className: string;
}): ReactNode {
  return (
    <Link to={href} className={className}>
      {children}
    </Link>
  );
}

/** `notes.md` → `notes copy.md`: the suggested name of a copy beside the original. */
export function copyName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} copy`;
  return `${name.slice(0, dot)} copy${name.slice(dot)}`;
}
