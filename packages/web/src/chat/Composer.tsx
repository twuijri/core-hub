/**
 * The composer: one rounded surface that holds everything about the next message
 * (ADOPTION-BACKLOG 2.6, 2.7, 2.12).
 *
 *   [ agent chips ]                                   — passed in, above the surface
 *   ┌───────────────────────────────────────────────┐
 *   │ attachments · error · the growing textarea    │
 *   │ [+]  [model]  [approvals]        [mic] [send] │
 *   └───────────────────────────────────────────────┘
 *   [ starters, on an empty chat ]
 *
 * Seven states, each deliberate and named by `composer-state.ts`, on `data-state`:
 * empty · typing · sending · streaming (send becomes stop) · error · dragging · disabled
 * (always with the reason on screen — TEAM-RULES §4 forbids a silent dead end).
 *
 * The textarea grows without moving anything: the surface is a grid whose invisible
 * `::after` twin carries the same text, so the row's height is already correct when the
 * character lands (`.composer-grow` in styles/app.css). No measuring, no jump.
 *
 * Glass belongs to floating chrome, which this is (DESIGN §Glass); the intensity is the
 * one token scale, so `prefers-reduced-transparency` flattens it with everything else.
 */
import {
  useCallback,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import type { Attachment, ContentBlock } from '../types.js';
import {
  IconClose,
  IconMic,
  IconPaperclip,
  IconPlus,
  IconSend,
  IconShield,
  IconStop,
  IconUpload,
} from '../ui/icons.js';
import { Menu, MenuItem, MenuNote } from '../ui/Menu.js';
import { Notice } from '../ui/Notice.js';
import { Tooltip } from '../ui/Tooltip.js';
import { Combobox } from '../ui/Combobox.js';
import { Select } from '../ui/Select.js';
import type { ComboboxOption } from '../ui/Combobox.js';
import type { SelectOption } from '../ui/Select.js';
import { canSend, composerState } from './composer-state.js';

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

export interface ComposerProps {
  busy: boolean;
  disabled: boolean;
  /** Why it is disabled. Required whenever `disabled` is true; shown, never implied. */
  disabledReason?: string | null;
  onSend(blocks: ContentBlock[]): Promise<void>;
  onCancel(): Promise<void>;
  /** The agent chips row; rendered above the surface so it reads as part of the composer. */
  chips?: ReactNode;
  /** The model this message runs on. `null` = the workspace default. */
  model?: string | null;
  models?: readonly ComboboxOption[];
  /** Model values chosen most recently in this workspace, newest first. */
  recentModels?: readonly string[];
  onModel?: ((value: string | null) => void) | undefined;
  /** `agent_settings.approval_mode` (or the adapter's own field, ADR 0002). */
  approvalMode?: string | null;
  /** The modes the agent's descriptor declares; the client invents none. */
  approvalOptions?: readonly SelectOption[];
  onApprovalMode?: ((value: string) => void) | undefined;
  /** Disabled when the agent adapter does not declare the setting. */
  approvalDisabledReason?: string | null;
  /** Three suggestions, shown only while the chat is empty. */
  starters?: readonly string[];
}

export const APPROVAL_MODES = ['ask', 'auto_safe', 'auto_all'] as const;

export function Composer({
  busy,
  disabled,
  disabledReason,
  onSend,
  onCancel,
  chips,
  model = null,
  models = [],
  recentModels = [],
  onModel,
  approvalMode = null,
  approvalOptions,
  onApprovalMode,
  approvalDisabledReason = null,
  starters = [],
}: ComposerProps) {
  const { t } = useI18n();
  const { client } = useAuth();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();

  const hasContent = text.trim() !== '' || pending.some((p) => p.status === 'done');
  const input = { disabled, dragging, busy, sending, error: error !== null, hasContent };
  const state = composerState(input);
  const sendable = canSend(input);

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
    if (!canSend({ ...input, error: false })) return;
    setSending(true);
    setError(null);
    try {
      await onSend(blocksFor(text, pending));
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

  const useStarter = (suggestion: string) => {
    setText(suggestion);
    textarea.current?.focus();
  };

  return (
    <div className="composer-dock" data-testid="composer-dock">
      {chips}
      <form
        className="composer glass"
        data-state={state}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        aria-label={t('composer.label')}
        aria-describedby={disabled && disabledReason ? reasonId : undefined}
        data-testid="composer"
      >
        {dragging && (
          <p className="composer-drop" role="status">
            {t('composer.drop_here')}
          </p>
        )}
        {pending.length > 0 && (
          <ul className="flex flex-wrap gap-1 pb-1" data-testid="composer-attachments">
            {pending.map((item) => (
              <li
                key={item.key}
                className={`chip ${item.status === 'error' ? 'bg-danger-soft text-danger-soft-text' : ''}`}
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
                  onClick={() => setPending((c) => c.filter((p) => p.key !== item.key))}
                >
                  <IconClose size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <Notice tone="danger" className="mb-2">
            {error}
          </Notice>
        )}

        <div className="composer-grow" data-value={text}>
          <textarea
            ref={textarea}
            rows={1}
            placeholder={disabled ? t('composer.disabled') : t('composer.placeholder')}
            aria-label={t('composer.placeholder')}
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            dir="auto"
            data-testid="composer-input"
          />
        </div>

        <div className="composer-tools">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => event.target.files && void upload(event.target.files)}
          />
          <Menu
            testId="composer-menu"
            tooltip={t('composer.more')}
            trigger={
              <button
                type="button"
                className="composer-btn"
                aria-label={t('composer.more')}
                disabled={disabled}
                data-testid="composer-plus"
              >
                <IconPlus />
              </button>
            }
          >
            <MenuItem
              icon={<IconPaperclip size={16} />}
              onSelect={() => fileInput.current?.click()}
            >
              {t('composer.attach')}
            </MenuItem>
            <MenuItem icon={<IconUpload size={16} />} onSelect={() => fileInput.current?.click()}>
              {t('composer.upload')}
            </MenuItem>
            <MenuNote>{t('composer.drop_hint')}</MenuNote>
          </Menu>

          <Combobox
            value={model}
            onChange={(value) => onModel?.(value)}
            options={models}
            label={t('composer.model')}
            placeholder={t('composer.model_default')}
            disabled={disabled || !onModel}
            recent={recentModels}
            testId="composer-model"
          />

          <Select
            value={approvalMode ?? 'ask'}
            onValueChange={(value) => value && onApprovalMode?.(value)}
            options={
              approvalOptions ??
              APPROVAL_MODES.map((mode) => ({
                value: mode,
                label: t(`composer.approval_mode.${mode}`),
              }))
            }
            label={t('composer.approval')}
            // A disabled selector must say why; `Select` shows it in our tooltip.
            title={approvalDisabledReason ?? t('composer.approval')}
            icon={<IconShield size={14} />}
            disabled={disabled || !onApprovalMode || approvalDisabledReason !== null}
            testId="composer-approval"
          />

          <span className="composer-spacer" />

          {/* Disabled, and the reason is in the tooltip rather than left to be guessed.
              A disabled button takes no pointer events, so the tooltip hangs off a
              focusable wrapper — otherwise the explanation would never appear. */}
          <Tooltip label={t('composer.dictate_unavailable')}>
            <span tabIndex={0} aria-describedby={undefined} data-testid="composer-mic-wrap">
              <button
                type="button"
                className="composer-btn"
                disabled
                aria-label={t('composer.dictate')}
                data-testid="composer-mic"
              >
                <IconMic />
              </button>
            </span>
          </Tooltip>

          {busy ? (
            <Tooltip label={t('composer.stop')}>
              <button
                type="button"
                className="composer-btn composer-btn-stop"
                onClick={() => void onCancel()}
                aria-label={t('composer.stop')}
                data-testid="stop-run"
              >
                <IconStop />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label={t('composer.send')}>
              <button
                type="submit"
                className="composer-btn composer-btn-send"
                aria-label={t('composer.send')}
                disabled={!sendable}
                data-busy={sending ? 'true' : undefined}
                data-testid="send"
              >
                <IconSend />
              </button>
            </Tooltip>
          )}
        </div>
      </form>

      {disabled && disabledReason && (
        <p id={reasonId} className="composer-reason" role="status" data-testid="composer-reason">
          {disabledReason}
        </p>
      )}
      {busy && <p className="composer-reason">{t('composer.busy_hint')}</p>}
      {!disabled && !busy && !hasContent && starters.length > 0 && (
        <ul className="composer-starters" data-testid="composer-starters">
          {starters.map((suggestion) => (
            <li key={suggestion}>
              <button type="button" className="starter" onClick={() => useStarter(suggestion)}>
                <span dir="auto">{suggestion}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
