/**
 * Where this chat's work lives (`SessionCreate.working_dir`).
 *
 * Before the first message a person may pick a folder that already exists under the hub's
 * workspace root, or name a new one; choosing nothing lets the hub generate a collision-free
 * one. The list and the root come from the server (`sessions.listWorkingDirs`) — the client
 * never guesses a path, and the server refuses anything outside the root with the contract's
 * envelope, which is shown here as-is.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { useWorkingDirs } from '../hub/queries.js';
import { IconChevron, IconFolder } from '../ui/icons.js';
import { Popover } from '../ui/Popover.js';

/** The part of a path worth reading in a header: the folder itself. */
export function shortDir(full: string | null, root?: string | null): string {
  if (!full) return '';
  if (root && full.startsWith(root)) {
    const rest = full.slice(root.length).replace(/^[/\\]/, '');
    return rest === '' ? '.' : rest;
  }
  return full.split(/[/\\]/).filter(Boolean).pop() ?? full;
}

/** A folder the hub generated is named by a ULID: say "Automatic folder" instead of the id. */
const GENERATED = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The folder as a person reads it: its own name, or "Automatic folder" for a generated one. */
export function folderName(
  value: string | null,
  root: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!value) return t('working_dir.automatic');
  const short = shortDir(value, root);
  return GENERATED.test(short) ? t('working_dir.automatic') : short;
}

interface PickerProps {
  value: string | null;
  onChange(next: string | null): void;
  /** A session that has already run cannot move; the reason is shown, not implied. */
  lockedReason?: string | null;
}

/**
 * The folder picker. `chip` (the new-chat screen) shows the folder's name in a chip; `bar` (the
 * conversation's bar in the top bar) is a folder icon whose popover says the name, the whole
 * path and, once the chat has run, why it no longer moves.
 */
export function WorkingDirPicker({
  value,
  onChange,
  lockedReason = null,
  variant = 'chip',
}: PickerProps & { variant?: 'chip' | 'bar' }) {
  const { t } = useI18n();
  const dirs = useWorkingDirs();
  const [open, setOpen] = useState(false);
  const root = dirs.data?.root ?? null;
  const locked = lockedReason !== null;

  if (variant === 'bar') {
    const label = t('working_dir.button', { name: folderName(value, root, t) });
    return (
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        tooltip={label}
        testId="working-dir-sheet"
        trigger={
          <button
            type="button"
            className="btn btn-ghost px-1.5"
            data-testid="working-dir-button"
            data-locked={locked ? 'true' : undefined}
          >
            <IconFolder size={18} />
            <span className="sr-only">{label}</span>
          </button>
        }
      >
        <WorkingDirPanel
          value={value}
          onChange={onChange}
          lockedReason={lockedReason}
          onDone={() => setOpen(false)}
        />
      </Popover>
    );
  }

  const trigger = (
    <button
      type="button"
      className="chip working-dir-chip"
      disabled={locked}
      data-testid="working-dir-button"
    >
      <IconFolder size={14} />
      <span className="truncate" dir="ltr">
        {value ? shortDir(value, root) : t('working_dir.automatic')}
      </span>
      {!locked && <IconChevron size={12} />}
    </button>
  );

  return (
    <div className="working-dir" data-testid="working-dir">
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={trigger}
        tooltip={locked ? (lockedReason ?? '') : (value ?? t('working_dir.hint'))}
        testId="working-dir-sheet"
      >
        <WorkingDirPanel
          value={value}
          onChange={onChange}
          lockedReason={lockedReason}
          onDone={() => setOpen(false)}
          showCurrent={false}
        />
      </Popover>
      {locked && (
        <span className="text-xs text-muted" data-testid="working-dir-locked">
          {lockedReason}
        </span>
      )}
    </div>
  );
}

/**
 * What the folder control opens: the folder now (its name, its whole path, and why it is fixed
 * once the chat has run), and — while it may still move — the folders to choose from and a new
 * one to name. Also the Folder part of the conversation's "More" panel on a narrow screen.
 */
export function WorkingDirPanel({
  value,
  onChange,
  lockedReason = null,
  onDone,
  showCurrent = true,
}: PickerProps & { onDone(): void; showCurrent?: boolean }) {
  const { t } = useI18n();
  const dirs = useWorkingDirs();
  const [name, setName] = useState('');
  const root = dirs.data?.root ?? null;
  const locked = lockedReason !== null;

  return (
    <>
      {showCurrent && (
        <div className="working-dir-current" data-testid="working-dir-current">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <IconFolder size={14} />
            <span className="min-w-0 truncate" dir="auto">
              {folderName(value, root, t)}
            </span>
          </p>
          <p className="working-dir-path" dir="ltr" data-testid="working-dir-path">
            {value ?? t('working_dir.automatic_note')}
          </p>
          {locked && (
            <p className="text-xs text-muted" data-testid="working-dir-locked">
              {lockedReason}
            </p>
          )}
        </div>
      )}
      {!locked && (
        <>
          <p className="working-dir-root" dir="ltr">
            {root ?? t('common.loading')}
          </p>
          {dirs.isError && (
            <p className="text-xs text-danger-soft-text">{describeError(dirs.error, t)}</p>
          )}
          <ul className="working-dir-list">
            <li>
              <button
                type="button"
                aria-pressed={value === null}
                onClick={() => {
                  onChange(null);
                  onDone();
                }}
                data-testid="working-dir-auto"
              >
                {t('working_dir.automatic')}
                <span className="working-dir-note">{t('working_dir.automatic_note')}</span>
              </button>
            </li>
            {(dirs.data?.items ?? []).map((item) => (
              <li key={item.path}>
                <button
                  type="button"
                  aria-pressed={value === item.path}
                  onClick={() => {
                    onChange(item.path);
                    onDone();
                  }}
                  data-testid="working-dir-item"
                >
                  <span dir="ltr">{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
          <form
            className="working-dir-new"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (trimmed === '') return;
              onChange(trimmed);
              setName('');
              onDone();
            }}
          >
            <input
              className="field py-1 text-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('working_dir.new_placeholder')}
              aria-label={t('working_dir.new')}
              dir="ltr"
              data-testid="working-dir-new"
            />
            <button type="submit" className="btn" disabled={name.trim() === ''}>
              {t('working_dir.create')}
            </button>
          </form>
        </>
      )}
    </>
  );
}
