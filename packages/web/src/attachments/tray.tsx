/**
 * Files waiting to be sent with a message, for a composer that is not the chat's: the room's
 * (contract decision §99). The same upload (`useUploadAttachment`) and the same chips as the
 * chat composer, so a file looks and behaves the same wherever it is attached.
 */
import { useCallback, useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Attachment, ContentBlock } from '../types.js';
import { IconClose } from '../ui/icons.js';
import { Tooltip } from '../ui/index.js';
import { useUploadAttachment } from './queries.js';

export interface PendingFile {
  key: string;
  file: File;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
  cancel?: () => void;
}

/**
 * A room message's blocks: its words, then a picture block for a picture and a file block for
 * anything else — a room takes no audio block (§99), so a recording goes as a file.
 */
export function roomBlocks(text: string, pending: readonly PendingFile[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const trimmed = text.trim();
  if (trimmed) blocks.push({ type: 'text', text: trimmed });
  for (const item of pending) {
    const attachment = item.status === 'done' ? item.attachment : undefined;
    if (!attachment) continue;
    const fields = {
      attachment_id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      size_bytes: attachment.size_bytes,
    };
    blocks.push(
      attachment.kind === 'image' ? { type: 'image', ...fields } : { type: 'file', ...fields },
    );
  }
  return blocks;
}

export function usePendingFiles() {
  const { t } = useI18n();
  const { upload: uploadAttachment } = useUploadAttachment();
  const [pending, setPending] = useState<PendingFile[]>([]);

  const add = useCallback(
    async (files: FileList | File[]) => {
      const items: PendingFile[] = Array.from(files).map((file) => ({
        key: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        file,
        status: 'uploading',
      }));
      setPending((current) => [...current, ...items]);
      const patch = (key: string, next: Partial<PendingFile>) =>
        setPending((current) => current.map((p) => (p.key === key ? { ...p, ...next } : p)));
      for (const item of items) {
        const controller = new AbortController();
        patch(item.key, { cancel: () => controller.abort() });
        try {
          const attachment = await uploadAttachment({ file: item.file, signal: controller.signal });
          patch(item.key, { status: 'done', attachment });
        } catch (err) {
          if (controller.signal.aborted) {
            setPending((current) => current.filter((p) => p.key !== item.key));
            continue;
          }
          patch(item.key, { status: 'error', error: describeError(err, t) });
        }
      }
    },
    [uploadAttachment, t],
  );

  const remove = useCallback((key: string) => {
    setPending((current) => {
      current.find((p) => p.key === key)?.cancel?.();
      return current.filter((p) => p.key !== key);
    });
  }, []);

  /** After a send: the files that went are gone; a failed one stays to be seen. */
  const clearSent = useCallback(
    () => setPending((current) => current.filter((p) => p.status === 'error')),
    [],
  );

  return {
    pending,
    add,
    remove,
    clearSent,
    uploading: pending.some((p) => p.status === 'uploading'),
    ready: pending.some((p) => p.status === 'done'),
  };
}

/** The chips of the files waiting to go, as the chat composer draws them. */
export function PendingFilesTray({
  pending,
  onRemove,
  testId,
}: {
  pending: readonly PendingFile[];
  onRemove: (key: string) => void;
  testId: string;
}) {
  const { t } = useI18n();
  if (pending.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1 pb-1" data-testid={testId}>
      {pending.map((item) => (
        <li
          key={item.key}
          className={`chip ${item.status === 'error' ? 'bg-danger-soft text-danger-soft-text' : ''}`}
          data-status={item.status}
        >
          <span dir="auto">{item.file.name}</span>
          {item.status === 'uploading' && <span aria-hidden>…</span>}
          {item.status === 'error' && (
            <Tooltip label={item.error}>
              <span tabIndex={0}>{t('composer.upload_failed')}</span>
            </Tooltip>
          )}
          <button
            type="button"
            className="ms-1"
            aria-label={t('composer.remove_attachment', { name: item.file.name })}
            onClick={() => onRemove(item.key)}
          >
            <IconClose size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}
