/**
 * «الملفات» / "Files" in the conversation's bar: every file of the conversation — what its agent
 * wrote, what is in its folder, what was attached — with its size and when it changed. A
 * file opens beside the chat.
 */
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Translator } from '../i18n/index.js';
import { Notice, Sheet, Spinner, Tooltip } from '../ui/index.js';
import { IconFile, IconFolder } from '../ui/icons.js';
import { useOpenFile, useSessionFilesContext } from './context.js';
import { formatBytes } from './kinds.js';

/**
 * The Files control in the conversation's bar: a folder-less icon with the count beside it.
 * The words ("Files (3)") are its accessible name and its tooltip.
 */
export function FilesButton({ onOpen }: { onOpen(): void }) {
  const { t } = useI18n();
  const count = useSessionFilesContext().files.length;
  const label = filesLabel(count, t);
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className="btn btn-ghost relative px-1.5"
        onClick={onOpen}
        aria-label={label}
        data-testid="chat-files"
        data-count={count}
      >
        <IconFile size={18} />
        {count > 0 && (
          <span className="ch-pending-count" aria-hidden>
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/** "Files" or "Files (3)", in the reader's language. */
export function filesLabel(count: number, t: Translator): string {
  return count > 0 ? t('files.button_count', { count }) : t('files.button');
}

/** The conversation's files, as a sheet; the chosen one opens beside the chat. */
export function FilesSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t, language } = useI18n();
  const files = useSessionFilesContext();
  const openFile = useOpenFile();
  const count = files.files.length;
  const setOpen = onOpenChange;

  return (
    <>
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
