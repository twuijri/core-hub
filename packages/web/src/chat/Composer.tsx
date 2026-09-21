// The floating composer: text, Enter to send (Shift+Enter for a line), a drop zone for
// files and images (the paperclip button is the keyboard equivalent), and the stop button
// while a run is active.
import { useCallback, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Attachment, ContentBlock } from '../types.js';
import { IconClose, IconPaperclip, IconSend, IconStop } from '../ui/icons.js';
import { Notice } from '../ui/Notice.js';

interface Pending {
  key: string;
  file: File;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
}

export function blocksFor(text: string, pending: readonly Pending[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const trimmed = text.trim();
  if (trimmed) blocks.push({ type: 'text', text: trimmed });
  for (const item of pending) {
    if (item.status !== 'done' || !item.attachment) continue;
    const a = item.attachment;
    const fields = { attachment_id: a.id, name: a.name, mime: a.mime, size_bytes: a.size_bytes };
    if (a.kind === 'image') blocks.push({ type: 'image', ...fields });
    else if (a.kind === 'audio') blocks.push({ type: 'audio', ...fields });
    else blocks.push({ type: 'file', ...fields });
  }
  return blocks;
}

export function Composer({
  busy,
  disabled,
  onSend,
  onCancel,
}: {
  busy: boolean;
  disabled: boolean;
  onSend(blocks: ContentBlock[]): Promise<void>;
  onCancel(): Promise<void>;
}) {
  const { t } = useI18n();
  const { client } = useAuth();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const items: Pending[] = Array.from(files).map((file) => ({
        key: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        file,
        status: 'uploading',
      }));
      setPending((current) => [...current, ...items]);
      for (const item of items) {
        const form = new FormData();
        form.append('file', item.file, item.file.name);
        form.append('purpose', 'message');
        try {
          const { data } = await client.raw('post', '/attachments', { body: form });
          setPending((current) =>
            current.map((p) =>
              p.key === item.key ? { ...p, status: 'done', attachment: data as Attachment } : p,
            ),
          );
        } catch (err) {
          const message = describeError(err, t);
          setPending((current) =>
            current.map((p) =>
              p.key === item.key ? { ...p, status: 'error', error: message } : p,
            ),
          );
        }
      }
    },
    [client, t],
  );

  const send = async () => {
    const blocks = blocksFor(text, pending);
    if (blocks.length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(blocks);
      setText('');
      setPending((current) => current.filter((p) => p.status === 'error'));
      textarea.current?.focus();
    } catch (err) {
      setError(describeError(err, t));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void upload(event.dataTransfer.files);
  };

  return (
    <div className="sticky bottom-0 z-[var(--mj-z-sticky)] pb-3 pt-2">
      <form
        className={`glass rounded-xl p-2 ${dragging ? 'drop-target' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        aria-label={t('composer.label')}
        data-testid="composer"
      >
        {dragging && (
          <p className="px-2 pb-1 text-xs text-accent-soft-text">{t('composer.drop_here')}</p>
        )}
        {pending.length > 0 && (
          <ul className="flex flex-wrap gap-1 px-1 pb-1">
            {pending.map((item) => (
              <li
                key={item.key}
                className={`chip ${item.status === 'error' ? 'bg-danger-soft text-danger-soft-text' : ''}`}
                title={item.error}
              >
                <span dir="auto">{item.file.name}</span>
                {item.status === 'uploading' && <span>…</span>}
                {item.status === 'error' && <span>{t('composer.upload_failed')}</span>}
                <button
                  type="button"
                  className="ms-1"
                  aria-label={t('composer.remove_attachment', { name: item.file.name })}
                  onClick={() => setPending((c) => c.filter((p) => p.key !== item.key))}
                >
                  <IconClose size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <Notice tone="danger" className="mb-1">
            {error}
          </Notice>
        )}
        <div className="flex items-end gap-1">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => event.target.files && void upload(event.target.files)}
          />
          <button
            type="button"
            className="btn btn-ghost px-2"
            onClick={() => fileInput.current?.click()}
            aria-label={t('composer.attach')}
            title={t('composer.attach')}
            disabled={disabled}
          >
            <IconPaperclip />
          </button>
          <textarea
            ref={textarea}
            className="field max-h-48 min-h-10 flex-1 resize-none border-0 bg-transparent py-2"
            rows={1}
            placeholder={disabled ? t('composer.disabled') : t('composer.placeholder')}
            aria-label={t('composer.placeholder')}
            value={text}
            disabled={disabled}
            onChange={(event) => {
              setText(event.target.value);
              event.target.style.blockSize = 'auto';
              event.target.style.blockSize = `${Math.min(192, event.target.scrollHeight)}px`;
            }}
            onKeyDown={onKeyDown}
            dir="auto"
            data-testid="composer-input"
          />
          {busy ? (
            <button
              type="button"
              className="btn btn-danger px-2"
              onClick={() => void onCancel()}
              aria-label={t('composer.stop')}
              title={t('composer.stop')}
              data-testid="stop-run"
            >
              <IconStop />
            </button>
          ) : null}
          <button
            type="submit"
            className="btn btn-primary px-2"
            aria-label={t('composer.send')}
            title={t('composer.send')}
            disabled={
              disabled || sending || (!text.trim() && !pending.some((p) => p.status === 'done'))
            }
            data-testid="send"
          >
            <IconSend />
          </button>
        </div>
        {busy && <p className="px-2 pt-1 text-xs text-muted">{t('composer.busy_hint')}</p>}
      </form>
    </div>
  );
}
