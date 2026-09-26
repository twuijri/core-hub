/**
 * The room's composer: the chat composer's surface, and `@` for addressing a seat.
 *
 * Typing `@` opens the room's seats (and `@all` when the room allows it) under the field;
 * arrows move, Enter or Tab picks, Escape closes. What is sent is the text and the seats it
 * names as structured mentions (`mentions.ts`) — the hub never reads names out of text.
 * A message that names nobody goes to the room's lead seat, which the hint under the field
 * says, so nobody wonders who will answer.
 *
 * Pictures and files go with the words (contract decision §99): the paperclip, a drop onto the
 * composer or a paste, uploaded and shown as the chat composer's chips (`attachments/tray.tsx`).
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { PendingFilesTray, roomBlocks, usePendingFiles } from '../attachments/tray.js';
import { useI18n } from '../i18n/context.js';
import type { ContentBlock } from '../types.js';
import { IconPaperclip, IconSend } from '../ui/icons.js';
import { Tooltip } from '../ui/index.js';
import {
  insertMention,
  mentionQuery,
  mentionsIn,
  suggest,
  type Mention,
  type MentionSeat,
} from './mentions.js';

const ALL: MentionSeat = { id: '__all__', name: 'all' };

export function RoomComposer({
  seats,
  allowAll,
  leadName,
  disabledReason,
  sending,
  onSend,
  onTyping,
}: {
  seats: readonly MentionSeat[];
  allowAll: boolean;
  /** The seat that answers a message naming nobody; `null` when nobody does. */
  leadName: string | null;
  /** Why nothing can be sent right now (an archived room); `null` when it can. */
  disabledReason: string | null;
  sending: boolean;
  /** The blocks (words, then pictures and files) and the seats the words name. */
  onSend(content: ContentBlock[], mentions: Mention[]): Promise<boolean>;
  onTyping(on: boolean): void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [placeCaret, setPlaceCaret] = useState<number | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const typingSince = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const files = usePendingFiles();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const query = mentionQuery(text, caret);
  const options = useMemo(() => {
    if (!query || query.start === dismissed) return [];
    return suggest(allowAll ? [...seats, ALL] : seats, query.query).slice(0, 8);
  }, [query?.start, query?.query, dismissed, seats, allowAll]);
  useEffect(() => setActive(0), [options.length, query?.query]);

  const stopTyping = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    if (typingSince.current) onTyping(false);
    typingSince.current = 0;
  };
  useEffect(() => stopTyping, []);

  const noteTyping = () => {
    const now = Date.now();
    // Say it once every few seconds while typing goes on, and stop after a quiet spell.
    if (now - typingSince.current > 3_000) {
      typingSince.current = now;
      onTyping(true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 4_000);
  };

  const pick = (seat: MentionSeat) => {
    if (!query) return;
    const next = insertMention(text, query.start, caret, seat.name);
    setText(next.text);
    setCaret(next.caret);
    setPlaceCaret(next.caret);
  };
  // The caret goes after the picked name in the same commit as the new text — later (a
  // frame later) it would pull back characters typed in between.
  useLayoutEffect(() => {
    if (placeCaret === null) return;
    field.current?.focus();
    field.current?.setSelectionRange(placeCaret, placeCaret);
    setPlaceCaret(null);
  }, [placeCaret]);

  const hasContent = text.trim() !== '' || files.ready;
  const send = async () => {
    const trimmed = text.trim();
    if (!hasContent || files.uploading || disabledReason || sending) return;
    const mentions = trimmed ? mentionsIn(trimmed, seats, allowAll) : [];
    stopTyping();
    if (await onSend(roomBlocks(trimmed, files.pending), mentions)) {
      setText('');
      setCaret(0);
      files.clearSent();
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabledReason) return;
    if (event.dataTransfer.files.length > 0) void files.add(event.dataTransfer.files);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabledReason || event.clipboardData.files.length === 0) return;
    event.preventDefault();
    void files.add(event.clipboardData.files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((current) => (current + step + options.length) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const chosen = options[active];
        if (chosen) pick(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(query?.start ?? null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const hint = disabledReason
    ? disabledReason
    : leadName
      ? t('rooms.composer.lead_hint', { name: leadName })
      : t('rooms.composer.no_lead_hint');

  return (
    <div className="composer-dock" data-testid="room-composer-dock">
      {options.length > 0 && (
        <ul
          className="room-mentions glass"
          role="listbox"
          aria-label={t('rooms.composer.mentions')}
          data-testid="mention-options"
        >
          {options.map((seat, index) => (
            <li
              key={seat.id}
              role="option"
              aria-selected={index === active}
              data-active={index === active ? 'true' : 'false'}
              className="room-mention"
              onMouseDown={(event) => {
                event.preventDefault();
                pick(seat);
              }}
              data-testid="mention-option"
            >
              <span dir="auto">@{seat.name}</span>
              {seat === ALL && (
                <span className="text-xs text-muted">{t('rooms.composer.all')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="composer glass"
        data-state={disabledReason ? 'disabled' : 'idle'}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabledReason) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        aria-label={t('rooms.composer.label')}
        data-testid="room-composer"
      >
        {dragging && (
          <p className="composer-drop" role="status">
            {t('composer.drop_here')}
          </p>
        )}
        <PendingFilesTray
          pending={files.pending}
          onRemove={files.remove}
          testId="room-composer-attachments"
        />
        <div className="composer-grow" data-value={text}>
          <textarea
            ref={field}
            dir="auto"
            rows={1}
            value={text}
            disabled={!!disabledReason}
            placeholder={t('rooms.composer.placeholder')}
            aria-label={t('rooms.composer.label')}
            aria-autocomplete="list"
            aria-expanded={options.length > 0}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setDismissed(null);
              if (event.target.value) noteTyping();
              else stopTyping();
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={stopTyping}
            data-testid="room-input"
          />
        </div>
        <div className="composer-tools">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="room-file-input"
            onChange={(event) => {
              if (event.target.files) void files.add(event.target.files);
              event.target.value = '';
            }}
          />
          <Tooltip label={t('composer.attach')}>
            <button
              type="button"
              className="composer-btn"
              aria-label={t('composer.attach')}
              disabled={!!disabledReason}
              onClick={() => fileInput.current?.click()}
              data-testid="room-attach"
            >
              <IconPaperclip />
            </button>
          </Tooltip>
          <span
            className="composer-reason min-w-0 flex-1 truncate"
            data-testid="room-composer-hint"
          >
            {hint}
          </span>
          <Tooltip label={t('composer.send')}>
            <button
              type="submit"
              className="composer-btn composer-btn-send"
              aria-label={t('composer.send')}
              disabled={!hasContent || files.uploading || !!disabledReason || sending}
              data-busy={sending ? 'true' : undefined}
              data-testid="room-send"
            >
              <IconSend />
            </button>
          </Tooltip>
        </div>
      </form>
    </div>
  );
}
