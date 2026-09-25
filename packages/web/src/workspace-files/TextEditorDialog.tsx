/**
 * Edit one plain-text profile file, or write a new one.
 *
 * The save sends back the `etag` the editor read (`knowledge.writeWorkspaceText`). When the
 * file changed on disk in between — an agent wrote it, another tab saved it — the hub
 * refuses with `409` and the current etag, nothing is lost on either side, and the person
 * chooses: take the file as it is now (their edits go), or keep their text and overwrite.
 * A new file is saved with `etag: null`, which the hub refuses if one appeared meanwhile.
 */
import { HubApiError } from '@corehub/contracts';
import { useEffect, useRef, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Button, Dialog, Notice, Skeleton, useConfirm, useToast } from '../ui/index.js';
import { CodeEditor } from './CodeEditor.js';
import { baseName } from './paths.js';
import { useWorkspaceFileActions, useWorkspaceText } from './queries.js';

/** What a `409` from a save says. */
export function conflictOf(error: unknown): { reason: string; etag: string | null } | null {
  if (!(error instanceof HubApiError) || error.status !== 409) return null;
  const details = (error.body as { details?: { reason?: unknown; etag?: unknown } } | null)
    ?.details;
  return {
    reason: typeof details?.reason === 'string' ? details.reason : 'changed',
    etag: typeof details?.etag === 'string' ? details.etag : null,
  };
}

export function TextEditorDialog({
  path,
  isNew,
  onClose,
}: {
  path: string;
  isNew: boolean;
  onClose(): void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const loaded = useWorkspaceText(isNew ? null : path);
  const { save } = useWorkspaceFileActions();
  const [content, setContent] = useState('');
  const [etag, setEtag] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [ready, setReady] = useState(isNew);
  const [conflict, setConflict] = useState<{ etag: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = baseName(path);
  const dirty = content !== saved;
  // The text on disk replaces the editor's only when it first arrives or when the person
  // asked for it after a conflict — never behind their back while they type.
  const reloading = useRef(false);

  useEffect(() => {
    if (!loaded.data) return;
    if (ready && !reloading.current) return;
    reloading.current = false;
    setContent(loaded.data.content);
    setSaved(loaded.data.content);
    setEtag(loaded.data.etag);
    setConflict(null);
    setReady(true);
    // `ready` is read, not watched: it only gates the first arrival.
  }, [loaded.data]);

  const write = async (against: string | null) => {
    setError(null);
    try {
      const result = await save.mutateAsync({ path, content, etag: against });
      setEtag(result.etag);
      setSaved(content);
      setConflict(null);
      toast({ title: t('workspace_files.saved', { name }), tone: 'success' });
    } catch (err) {
      const refused = conflictOf(err);
      if (refused?.reason === 'changed') setConflict({ etag: refused.etag });
      else setError(describeError(err, t));
    }
  };

  const close = async () => {
    if (dirty) {
      const leave = await confirm.ask({
        title: t('workspace_files.discard_title'),
        body: t('workspace_files.discard_body', { name }),
        confirmLabel: t('workspace_files.discard'),
        tone: 'danger',
      });
      if (!leave) return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
      title={
        <span dir="auto">
          {t(
            isNew && etag === null
              ? 'workspace_files.new_file_title'
              : 'workspace_files.edit_title',
            { name },
          )}
        </span>
      }
      description={path}
      size="lg"
      closeLabel={t('workspace_files.close')}
      testId="files-editor"
      footer={
        <>
          <span className="me-auto text-xs text-muted" role="status">
            {dirty ? t('workspace_files.unsaved') : t('workspace_files.all_saved')}
          </span>
          <Button size="sm" onClick={() => void close()}>
            {t('workspace_files.close')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!ready || save.isPending || (!dirty && etag !== null)}
            onClick={() => void write(etag)}
            data-testid="files-editor-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      {loaded.isError && !ready && <Notice tone="danger">{describeError(loaded.error, t)}</Notice>}
      {!ready && loaded.isPending && <Skeleton height="16rem" radius="md" />}
      {conflict && (
        <div className="mb-2" data-testid="files-editor-conflict">
          <Notice tone="warning">
            <span className="flex flex-col gap-2">
              <span>{t('workspace_files.conflict')}</span>
              <span className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    reloading.current = true;
                    void loaded.refetch();
                  }}
                  data-testid="files-editor-reload"
                >
                  {t('workspace_files.conflict_reload')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void write(conflict.etag)}
                  data-testid="files-editor-overwrite"
                >
                  {t('workspace_files.conflict_overwrite')}
                </Button>
              </span>
            </span>
          </Notice>
        </div>
      )}
      {error && (
        <div className="mb-2">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
      {ready && (
        <div className="files-editor-frame">
          <CodeEditor
            value={content}
            onChange={setContent}
            fileName={name}
            label={t('workspace_files.editor_label', { name })}
            onSave={() => void write(etag)}
            testId="files-editor-text"
          />
        </div>
      )}
      {confirm.dialog}
    </Dialog>
  );
}
