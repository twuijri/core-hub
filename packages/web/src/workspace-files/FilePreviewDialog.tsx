/**
 * A look at one profile file without leaving the Files page.
 *
 * Pictures and PDFs are drawn from their bytes (fetched with the bearer header, shown from
 * an object URL); text is read as text and shown with colour, never rendered as a page. An
 * SVG or an HTML file an agent wrote is text here, on purpose: drawn as a document it could
 * run script in the hub's own origin. Anything else says so and offers the download.
 */
import { useEffect, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Button, Dialog, EmptyState, Notice, Skeleton } from '../ui/index.js';
import { IconDownload, IconFile, IconPaperclip } from '../ui/icons.js';
import { CodeEditor } from './CodeEditor.js';
import { formatBytes, previewKindOf } from './paths.js';
import { useWorkspaceBytes, useWorkspaceText, type WorkspaceFileEntry } from './queries.js';

export function FilePreviewDialog({
  entry,
  onClose,
  onEdit,
  onDownload,
  onAttach,
}: {
  entry: WorkspaceFileEntry;
  onClose(): void;
  onEdit(): void;
  onDownload(): void;
  onAttach(): void;
}) {
  const { t, language } = useI18n();
  const kind = previewKindOf(entry);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={<span dir="auto">{entry.name}</span>}
      description={
        entry.size_bytes === null
          ? entry.path
          : `${entry.path} · ${formatBytes(entry.size_bytes, language)}`
      }
      size="lg"
      closeLabel={t('files.close')}
      testId="files-preview"
      footer={
        <>
          <Button size="sm" onClick={onAttach}>
            <IconPaperclip size={14} />
            {t('files.attach')}
          </Button>
          <Button size="sm" onClick={onDownload}>
            <IconDownload size={14} />
            {t('files.download')}
          </Button>
          {entry.editable && (
            <Button size="sm" variant="primary" onClick={onEdit} data-testid="files-preview-edit">
              {t('common.edit')}
            </Button>
          )}
        </>
      }
    >
      {kind === 'text' && <TextPreview entry={entry} />}
      {(kind === 'image' || kind === 'pdf') && <BytesPreview entry={entry} kind={kind} />}
      {kind === 'none' && (
        <EmptyState
          size="sm"
          icon={<IconFile size={20} />}
          title={t('files.no_preview')}
          body={t('files.no_preview_body')}
        />
      )}
    </Dialog>
  );
}

function TextPreview({ entry }: { entry: WorkspaceFileEntry }) {
  const { t } = useI18n();
  const text = useWorkspaceText(entry.path);
  if (text.isPending) return <Skeleton height="12rem" radius="md" />;
  if (text.isError) return <Notice tone="warning">{describeError(text.error, t)}</Notice>;
  return (
    <div className="files-preview-frame">
      <CodeEditor
        value={text.data.content}
        fileName={entry.name}
        label={t('files.preview_of', { name: entry.name })}
        readOnly
        testId="files-preview-text"
      />
    </div>
  );
}

function BytesPreview({ entry, kind }: { entry: WorkspaceFileEntry; kind: 'image' | 'pdf' }) {
  const { t } = useI18n();
  const { fileBlob } = useWorkspaceBytes();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    fileBlob(entry, true)
      .then((blob) => {
        if (!alive) return;
        // The type is the hub's inline answer; the page never trusts a name for a picture.
        made = URL.createObjectURL(
          new Blob([blob], { type: kind === 'pdf' ? 'application/pdf' : blob.type }),
        );
        setUrl(made);
      })
      .catch((err: unknown) => {
        if (alive) setError(err);
      });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [entry, kind, fileBlob]);

  if (error) return <Notice tone="warning">{describeError(error, t)}</Notice>;
  if (!url) return <Skeleton height="16rem" radius="md" />;
  if (kind === 'image') {
    return (
      <div className="files-preview-frame files-preview-image">
        <img src={url} alt={entry.name} data-testid="files-preview-image" />
      </div>
    );
  }
  return (
    <object
      className="files-preview-pdf"
      data={url}
      type="application/pdf"
      aria-label={t('files.preview_of', { name: entry.name })}
      data-testid="files-preview-pdf"
    >
      <p className="p-3 text-sm">{t('files.pdf_fallback')}</p>
    </object>
  );
}
