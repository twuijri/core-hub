/**
 * «الملفات» / "Files" in the chat's header: every file of the conversation — what its agent
 * wrote, what is in its folder, what was attached — with its size and when it changed. A
 * file opens beside the chat.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Button, Notice, Sheet, Spinner } from '../ui/index.js';
import { IconFolder } from '../ui/icons.js';
import { useOpenFile, useSessionFilesContext } from './context.js';
import { formatBytes } from './kinds.js';

export function FilesButton() {
  const { t, language } = useI18n();
  const files = useSessionFilesContext();
  const openFile = useOpenFile();
  const [open, setOpen] = useState(false);
  const count = files.files.length;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconFolder size={14} />}
        onClick={() => setOpen(true)}
        data-testid="chat-files"
      >
        {count > 0 ? t('files.button_count', { count }) : t('files.button')}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('files.title')}
        closeLabel={t('files.close')}
        testId="files-sheet"
      >
        {files.status === 'loading' && <Spinner label={t('common.loading')} />}
        {files.status === 'error' && (
          <Notice tone="danger">
            {t('files.load_failed')} {describeError(files.error, t)}
          </Notice>
        )}
        {files.status === 'ready' && count === 0 && (
          <p className="text-sm text-muted">{t('files.empty')}</p>
        )}
        {files.truncated && (
          <p className="mb-2 text-xs text-muted" role="status">
            {t('files.truncated')}
          </p>
        )}
        {count > 0 && (
          <ul className="file-list" aria-label={t('files.list_label')}>
            {files.files.map((file) => (
              <li key={file.key}>
                <button
                  type="button"
                  className="file-row"
                  onClick={() => {
                    openFile?.(file.key);
                    setOpen(false);
                  }}
                  data-testid="file-row"
                  data-file-key={file.key}
                >
                  <IconFolder size={16} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" dir="auto">
                      {file.name}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {file.path && file.path !== file.name && (
                        <>
                          <span dir="ltr">{file.path}</span> ·{' '}
                        </>
                      )}
                      <span dir="ltr">{formatBytes(file.size_bytes)}</span>
                      {file.modified_at && (
                        <>
                          {' · '}
                          {new Date(file.modified_at).toLocaleString(language, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                        </>
                      )}
                      {' · '}
                      {file.sources
                        .map((source) => t(`files.source.${source}`))
                        .join(language === 'ar' ? '، ' : ', ')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </>
  );
}
