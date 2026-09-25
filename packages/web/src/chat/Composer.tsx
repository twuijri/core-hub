/**
 * The composer: one rounded surface that holds everything about the next message
 * (ADOPTION-BACKLOG 2.6, 2.7, 2.12).
 *
 *   [ agent chips ]                                   — passed in, above the surface
 *   ┌───────────────────────────────────────────────┐
 *   │ attachments · error · the growing textarea    │
 *   │ [+]  [model]  [approvals]    [mic][▾] [send] │
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
 * The mic dictates into the text (contract decision §63, `voice/`): pressed once it records,
 * pressed again the take is transcribed by the hub and the words land here for the person to
 * read before sending. The small menu beside it holds the dictation language, reading replies
 * aloud, and voice mode where the screen offers it.
 *
 * Glass belongs to floating chrome, which this is (DESIGN §Glass); the intensity is the
 * one token scale, so `prefers-reduced-transparency` flattens it with everything else.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { describeError } from '../auth/client.js';
import { blocksFor as toContentBlocks, useUploadAttachment } from '../attachments/queries.js';
import { takeHandOff } from '../attachments/handoff.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import type { Attachment, ContentBlock } from '../types.js';
import {
  IconClose,
  IconPaperclip,
  IconPlus,
  IconSend,
  IconAlert,
  IconShield,
  IconSpark,
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
import {
  filterCommands,
  moveActive,
  parseCommand,
  skillQuery,
  slashQuery,
  type SlashCommand,
  type SlashCommandId,
} from './slashCommands.js';
import { SlashMenu, slashOptionId, type SlashMenuItem } from './SlashMenu.js';

/** A skill offered after `/skill `. */
export interface SlashSkill {
  key: string;
  name: string;
  description: string;
}
import { DictationNotice, MicButton, VoiceMenu } from '../voice/DictationControls.js';
import { useVoicePreferences } from '../voice/context.js';
import { dictationHint } from '../voice/recorder.js';
import { useDictation } from '../voice/useDictation.js';

interface Pending {
  key: string;
  file: File;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
  /** 0…1 while it is uploading; the surface may or may not draw it. */
  progress?: number;
  /** Cancels this upload; the attachment row is dropped with it. */
  cancel?: () => void;
}

/** The blocks `sessions.createRun` takes, from what finished uploading. */
export function blocksFor(text: string, pending: readonly Pending[]): ContentBlock[] {
  return toContentBlocks(
    text,
    pending
      .filter((item) => item.status === 'done' && item.attachment)
      .map((item) => item.attachment as Attachment),
  );
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
  /** "Replying to …", above the surface: the message the next run answers. */
  reply?: ReactNode;
  /** The messages this tab is holding back while a run is alive. */
  queue?: ReactNode;
  /** A question the agent is waiting on (`QuestionCard`), above everything else. */
  question?: ReactNode;
  /** How full the model's window is, beside the mic. */
  context?: ReactNode;
  /**
   * The live run indicator (`RunStatus.tsx`). It rides in the docked composer rather than
   * in the transcript so it stays on screen while the person scrolls back through the
   * conversation — the whole point is that they can see the agent is alive.
   */
  status?: ReactNode;
  /** The model this message runs on. `null` = the workspace default. */
  model?: string | null;
  models?: readonly ComboboxOption[];
  /** Model values chosen most recently in this workspace, newest first. */
  recentModels?: readonly string[];
  onModel?: ((value: string | null) => void) | undefined;
  /**
   * How hard the model should think for the next turn (`RunCreate.reasoning_effort`).
   * `null` means "let the agent decide", which is what the contract's null means too.
   */
  reasoningEffort?: string | null;
  onReasoningEffort?: (value: string | null) => void;
  /** `agent_settings.approval_mode` (or the adapter's own field, ADR 0002). */
  approvalMode?: string | null;
  /** The modes the agent's descriptor declares; the client invents none. */
  approvalOptions?: readonly SelectOption[];
  onApprovalMode?: ((value: string) => void) | undefined;
  /** Disabled when the agent adapter does not declare the setting. */
  approvalDisabledReason?: string | null;
  /** Three suggestions, shown only while the chat is empty. */
  starters?: readonly string[];
  /**
   * The `/` commands the session's agent takes (`slashCommands.ts`, decision §57). Empty:
   * no menu, and every `/text` is an ordinary message.
   */
  commands?: readonly SlashCommand[];
  /** The skills offered after `/skill `. */
  skills?: readonly SlashSkill[];
  /**
   * Carries out a `hub` or `action` command. Resolves with text to send as an ordinary
   * message instead — `/steer` with no run to steer — or with nothing once it is done.
   * Throws to keep the text in the composer and show why.
   */
  onCommand?: (id: SlashCommandId, arg: string) => Promise<string | void>;
  /** Opens the full-screen voice stage; the voice menu offers it only when given. */
  onVoiceMode?: (() => void) | undefined;
}

export const APPROVAL_MODES = ['ask', 'auto_safe', 'auto_all'] as const;

/** The contract's `ReasoningEffort`, least to most; `null` (the placeholder) is "let it decide". */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'max'] as const;

export function Composer({
  busy,
  disabled,
  disabledReason,
  onSend,
  onCancel,
  chips,
  reply,
  queue,
  question,
  context,
  status,
  model = null,
  models = [],
  recentModels = [],
  onModel,
  reasoningEffort = null,
  onReasoningEffort,
  approvalMode = null,
  approvalOptions,
  onApprovalMode,
  approvalDisabledReason = null,
  starters = [],
  commands = [],
  skills = [],
  onCommand,
  onVoiceMode,
}: ComposerProps) {
  const { t, language: uiLanguage } = useI18n();
  const { upload: uploadAttachment } = useUploadAttachment();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const { profile } = useAuth();
  // Files the Files page handed over ("Attach to chat"): already on the hub, so they join
  // the tray as finished uploads. A stand-in `File` carries the name the chip shows.
  useEffect(() => {
    const handed = takeHandOff(profile);
    if (handed.length === 0) return;
    setPending((current) => [
      ...current,
      ...handed.map((attachment) => ({
        key: `handoff-${attachment.id}`,
        file: new File([], attachment.name, { type: attachment.mime }),
        status: 'done' as const,
        attachment,
        progress: 1,
      })),
    ]);
  }, [profile]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();

  // Dictated words join what is already typed, for the person to read before sending.
  const voicePreferences = useVoicePreferences();
  const dictation = useDictation({
    language: dictationHint(voicePreferences.dictationLanguage, uiLanguage),
    languageLoading: voicePreferences.loading,
    onText: (words) => {
      setText((current) => (current.trim() ? `${current.replace(/\s+$/, '')} ${words}` : words));
      textarea.current?.focus();
    },
  });

  const hasContent = text.trim() !== '' || pending.some((p) => p.status === 'done');
  const input = { disabled, dragging, busy, sending, error: error !== null, hasContent };
  const state = composerState(input);
  const sendable = canSend(input);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      // The data layer lives in `attachments/queries.ts`; this only tracks the rows.
      const items: Pending[] = Array.from(files).map((file) => ({
        key: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        file,
        status: 'uploading',
        progress: 0,
      }));
      setPending((current) => [...current, ...items]);
      const patch = (key: string, next: Partial<Pending>) =>
        setPending((current) => current.map((p) => (p.key === key ? { ...p, ...next } : p)));
      for (const item of items) {
        const controller = new AbortController();
        patch(item.key, { cancel: () => controller.abort() });
        try {
          const attachment = await uploadAttachment({
            file: item.file,
            onProgress: ({ ratio }) => patch(item.key, { progress: ratio }),
            signal: controller.signal,
          });
          patch(item.key, { status: 'done', attachment, progress: 1 });
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

  /**
   * The `/` menu: the commands while the command word is typed, the skills while a skill's
   * name is. Escape closes it for the text it was closed on; typing opens it again.
   */
  const menuId = useId();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const commandWord = commands.length > 0 ? slashQuery(text) : null;
  const skillWord = commands.some((command) => command.id === 'skill') ? skillQuery(text) : null;
  const menu = useMemo((): { title: string; items: SlashMenuItem[] } | null => {
    // Closed while a picked command is being carried out: the text is still in the box.
    if (disabled || sending || dismissed === text) return null;
    if (skillWord !== null) {
      const found = filterCommands(
        skills.map((skill) => ({ ...skill, name: skill.key, label: skill.name })),
        skillWord,
        (skill) => `${skill.label} ${skill.description}`,
      );
      return {
        title: t('slash.skills_title'),
        items: found.map((skill) => ({
          key: `skill:${skill.key}`,
          label: skill.key,
          description: skill.description || skill.label,
        })),
      };
    }
    if (commandWord === null) return null;
    const describe = (command: SlashCommand) => t(`slash.describe.${command.id}`);
    return {
      title: t('slash.title'),
      items: filterCommands(commands, commandWord, describe).map((command) => ({
        key: command.id,
        label: `/${command.name}`,
        description: describe(command),
      })),
    };
  }, [disabled, sending, dismissed, text, skillWord, commandWord, commands, skills, t]);
  const menuSize = menu?.items.length ?? 0;
  useEffect(() => setActive(0), [commandWord, skillWord]);
  const activeIndex = Math.min(active, Math.max(0, menuSize - 1));

  const clearComposer = () => {
    setText('');
    setPending((current) => current.filter((p) => p.status === 'error'));
    textarea.current?.focus();
  };

  /**
   * A `hub` or `action` command: carried out, or handed back as text to send. `typed` is
   * what was in the box when the command was picked from the menu: it leaves at once, and
   * comes back only if the command fails.
   */
  const runCommand = async (id: SlashCommandId, arg: string, typed?: string) => {
    if (!onCommand) return;
    setSending(true);
    setError(null);
    if (typed !== undefined) setText('');
    try {
      const instead = await onCommand(id, arg);
      if (typeof instead === 'string' && instead.trim() !== '') {
        await onSend(blocksFor(instead, pending));
      }
      clearComposer();
    } catch (err) {
      if (typed !== undefined) setText(typed);
      setError(describeError(err, t));
    } finally {
      setSending(false);
    }
  };

  const pick = (index: number) => {
    const item = menu?.items[index];
    if (!item) return;
    setError(null);
    if (item.key.startsWith('skill:')) {
      setText(`/skill ${item.label} `);
      textarea.current?.focus();
      return;
    }
    const command = commands.find((candidate) => candidate.id === item.key);
    if (!command) return;
    if (command.argument !== 'required' && command.kind !== 'message') {
      // Picked from the menu, `/compress` and `/model` act at once; typed with words after
      // them (`/compress the API`), Enter carries the words.
      void runCommand(command.id, '', text);
      return;
    }
    // A command that needs words waits for them; `/skill ` opens the skills.
    setText(`/${command.name} `);
    textarea.current?.focus();
  };

  const send = async () => {
    if (!canSend({ ...input, error: false })) return;
    const parsed = parseCommand(text, commands);
    if (parsed && parsed.command.kind !== 'message' && onCommand) {
      if (parsed.command.argument === 'required' && parsed.arg === '') {
        setError(t('slash.needs_argument', { command: `/${parsed.command.name}` }));
        return;
      }
      await runCommand(parsed.command.id, parsed.arg);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend(blocksFor(text, pending));
      clearComposer();
    } catch (err) {
      setError(describeError(err, t));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing;
    if (menu && !composing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(moveActive(activeIndex, event.key === 'ArrowDown' ? 1 : -1, menuSize));
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(text);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        if (menuSize > 0) {
          event.preventDefault();
          pick(activeIndex);
          return;
        }
        // Nothing matches: an unknown `/word` is an ordinary message.
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
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
      {question}
      {status}
      {chips}
      {queue}
      {reply}
      {menu && (
        <SlashMenu
          id={menuId}
          title={menu.title}
          items={menu.items}
          active={activeIndex}
          empty={t('slash.no_match')}
          onPick={pick}
          onHover={setActive}
        />
      )}
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
        <DictationNotice dictation={dictation} />

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
            {...(menu
              ? {
                  role: 'combobox',
                  'aria-expanded': true,
                  'aria-controls': menuId,
                  'aria-autocomplete': 'list' as const,
                  ...(menuSize > 0
                    ? { 'aria-activedescendant': slashOptionId(menuId, activeIndex) }
                    : {}),
                }
              : {})}
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

          {/* Effort sits beside the model because both are "how the next turn runs", and
              both are soft pills of the same height (owner, 2026-09-22). */}
          <Select
            value={reasoningEffort}
            onValueChange={(value) => onReasoningEffort?.(value)}
            options={REASONING_EFFORTS.map((effort) => ({
              value: effort,
              label: t(`composer.effort.${effort}`),
            }))}
            placeholder={t('composer.effort.default')}
            label={t('composer.effort.label')}
            title={t('composer.effort.label')}
            icon={<IconSpark size={14} />}
            disabled={disabled || !onReasoningEffort}
            testId="composer-effort"
          />

          <Select
            value={approvalMode ?? 'ask'}
            onValueChange={(value) => value && onApprovalMode?.(value)}
            options={(
              approvalOptions ??
              APPROVAL_MODES.map((mode) => ({
                value: mode,
                label: t(`composer.approval_mode.${mode}`),
              }))
            ).map((option) => ({ ...option, icon: approvalIcon(option.value) }))}
            label={t('composer.approval')}
            // A disabled selector must say why; `Select` shows it in our tooltip.
            title={approvalDisabledReason ?? t('composer.approval')}
            icon={<IconShield size={14} />}
            disabled={disabled || !onApprovalMode || approvalDisabledReason !== null}
            testId="composer-approval"
          />

          <span className="composer-spacer" />

          {context}

          <MicButton dictation={dictation} disabled={disabled} />
          <VoiceMenu disabled={disabled} onVoiceMode={onVoiceMode} />

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
      {busy && status === undefined && <p className="composer-reason">{t('composer.busy_hint')}</p>}
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

/**
 * The face of an approval mode. A mode that gives something away wears the warning glyph,
 * so the risk is visible before the sentence is read (owner, 2026-09-22).
 */
function approvalIcon(mode: string) {
  if (mode === 'auto_all' || mode === 'off') return <IconAlert size={14} />;
  if (mode === 'auto_safe') return <IconSpark size={14} />;
  return <IconShield size={14} />;
}
