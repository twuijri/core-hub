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

export function WorkingDirPicker({
  value,
  onChange,
  /** A session that has already run cannot move; the reason is shown, not implied. */
  lockedReason = null,
}: {
  value: string | null;
  onChange(next: string | null): void;
  lockedReason?: string | null;
}) {
  const { t } = useI18n();
  const dirs = useWorkingDirs();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const root = dirs.data?.root ?? null;
  const locked = lockedReason !== null;

  const label = value ? shortDir(value, root) : t('working_dir.automatic');

  const trigger = (
    <button
      type="button"
      className="chip working-dir-chip"
      disabled={locked}
      title={locked ? (lockedReason ?? '') : (value ?? t('working_dir.hint'))}
      data-testid="working-dir-button"
    >
      <IconFolder size={14} />
      <span className="truncate" dir="ltr">
        {label}
      </span>
      {!locked && <IconChevron size={12} />}
    </button>
  );

  return (
    <div className="working-dir" data-testid="working-dir">
      <Popover open={open} onOpenChange={setOpen} trigger={trigger} testId="working-dir-sheet">
        <p className="working-dir-root" dir="ltr" title={root ?? ''}>
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
                setOpen(false);
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
                  setOpen(false);
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
            setOpen(false);
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
      </Popover>
      {locked && (
        <span className="text-xs text-muted" data-testid="working-dir-locked">
          {lockedReason}
        </span>
      )}
    </div>
  );
}
