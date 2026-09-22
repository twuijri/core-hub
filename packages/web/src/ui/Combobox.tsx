/**
 * The searchable picker: a trigger, a popup with a text field at the top, and a list that
 * narrows as you type.
 *
 * It exists because a plain dropdown stops working at scale — the owner connected
 * OpenRouter, the fetch returned 443 models, and finding one became impossible. So:
 *
 * - **the field is the first thing focused**, and it never loses focus. The arrows move a
 *   highlighted row rather than the focus ring (`aria-activedescendant`), Enter picks,
 *   Home/End jump to the ends, Escape closes and hands focus back to the trigger. Typing
 *   and choosing are the same gesture;
 * - **hundreds of rows stay smooth.** `@tanstack/react-virtual` renders only the rows in
 *   view — this is the screen it was added for. 443 models is about a dozen elements in
 *   the DOM at any moment, and the group headers stay stuck to the top through the
 *   virtualizer's own range extractor rather than a second scroll listener;
 * - **which rows, in what order, with what highlighted** is decided by `combobox-filter.ts`,
 *   which has no DOM in it and is tested on its own.
 *
 * Every state the list can be in is drawn, and none of them is an empty box: loading,
 * never fetched (with the fetch action inside the popup, where the person already is), no
 * match for the query, and an error from the provider shown in its own words.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context.js';
import { IconChevron, IconSearch } from './icons.js';
import { Popover } from './Popover.js';
import {
  buildRows,
  highlightParts,
  moveActive,
  type ComboboxOption,
  type Range,
  type Row,
} from './combobox-filter.js';

export type { ComboboxOption } from './combobox-filter.js';

/** What the list is doing. Anything but `ready` replaces the rows with a sentence. */
export type ComboboxStatus = 'ready' | 'loading' | 'unfetched' | 'error';

export interface ComboboxProps {
  value: string | null;
  onChange(value: string | null): void;
  options: readonly ComboboxOption[];
  /** Accessible name of the control; also the field's placeholder fallback. */
  label: string;
  /** What the trigger says when nothing is chosen. */
  placeholder?: string;
  status?: ComboboxStatus;
  /** The provider's own words, shown verbatim when `status` is `error`. */
  errorMessage?: string | null;
  /** Offered inside the popup while the list has never been fetched. */
  fetchAction?: { label: string; onSelect(): void; disabled?: boolean } | undefined;
  /** Values chosen most recently in this workspace, newest first. */
  recent?: readonly string[];
  disabled?: boolean;
  testId?: string;
}

const ROW = 46;
const GROUP_ROW = 26;

export function Combobox({
  value,
  onChange,
  options,
  label,
  placeholder,
  status = 'ready',
  errorMessage = null,
  fetchAction,
  recent = [],
  disabled = false,
  testId,
}: ComboboxProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  // State, not a ref: the list is mounted inside the popup, so it does not exist on the
  // first render. A ref would leave the virtualizer measuring nothing until something
  // else happened to re-render; setting state is what tells it the scroller has arrived.
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  const rows = useMemo(
    () => buildRows({ options, query, recent, recentLabel: t('combobox.recent') }),
    [options, query, recent, t],
  );
  const chosen = options.find((option) => option.value === value) ?? null;

  // Opening starts clean, with the chosen row highlighted so Enter repeats the last answer.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const at = rows.findIndex((row) => row.kind === 'option' && row.option.value === value);
    setActive(at >= 0 ? at : moveActive(rows, -1, 'first'));
    // `rows` is deliberately not a dependency: this runs once per opening, not on every
    // keystroke — the next effect owns what typing does to the highlight.
  }, [open, value]);

  // A new query re-points the highlight at the first row that survived it. Keyed on the
  // query alone: `rows` changes identity on every render, which would reset the arrows.
  useEffect(() => {
    if (open) setActive(moveActive(rows, -1, 'first'));
  }, [query]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listEl,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? GROUP_ROW : ROW),
    overscan: 8,
    // The header of the group being scrolled through is always rendered, so it can stay
    // stuck to the top of the list instead of scrolling away with its rows.
    rangeExtractor: useCallback(
      (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        const start = Math.max(range.startIndex - range.overscan, 0);
        const end = Math.min(range.endIndex + range.overscan, range.count - 1);
        const keep = new Set<number>();
        for (let i = start; i <= end; i += 1) keep.add(i);
        for (let i = start; i >= 0; i -= 1) {
          if (rows[i]?.kind === 'group') {
            keep.add(i);
            break;
          }
        }
        return [...keep].sort((a, b) => a - b);
      },
      [rows],
    ),
  });

  useEffect(() => {
    if (open && active >= 0) virtualizer.scrollToIndex(active, { align: 'auto' });
  }, [active, open]);

  const pick = (row: Row | undefined) => {
    if (!row || row.kind !== 'option' || row.option.disabled) return;
    onChange(row.option.value);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const step =
      event.key === 'ArrowDown'
        ? 'down'
        : event.key === 'ArrowUp'
          ? 'up'
          : event.key === 'Home'
            ? 'first'
            : event.key === 'End'
              ? 'last'
              : null;
    if (step) {
      event.preventDefault();
      setActive((current) => moveActive(rows, current, step));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(rows[active]);
    }
  };

  const sticky = (() => {
    const first = virtualizer.getVirtualItems()[0];
    if (!first) return null;
    for (let i = first.index; i >= 0; i -= 1) {
      const row = rows[i];
      if (row?.kind === 'group') return row.label;
    }
    return null;
  })();

  const trigger = (
    <button
      type="button"
      className="mj-combo-trigger"
      disabled={disabled}
      aria-label={label}
      aria-haspopup="dialog"
      data-testid={testId}
    >
      <span className="mj-combo-value">
        <span className="mj-combo-name">{chosen?.label ?? placeholder ?? label}</span>
        {/* The provider, under the name: two models can share a name across providers. */}
        {chosen?.group !== undefined && <span className="mj-combo-sub">{chosen.group}</span>}
      </span>
      <IconChevron size={12} />
    </button>
  );

  const body = () => {
    if (status === 'loading') {
      return (
        <p className="mj-combo-state" data-testid="combobox-loading" role="status">
          {t('combobox.loading')}
        </p>
      );
    }
    if (status === 'error') {
      return (
        <p className="mj-combo-state mj-combo-error" data-testid="combobox-error" role="alert">
          {/* The provider's own sentence; the hub already localised what it could. */}
          {errorMessage ?? t('combobox.error')}
        </p>
      );
    }
    if (status === 'unfetched') {
      return (
        <div className="mj-combo-state" data-testid="combobox-unfetched">
          <p>{t('combobox.unfetched')}</p>
          {fetchAction && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={fetchAction.disabled ?? false}
              onClick={() => fetchAction.onSelect()}
              data-testid="combobox-fetch"
            >
              {fetchAction.label}
            </button>
          )}
        </div>
      );
    }
    if (rows.length === 0) {
      return (
        <p className="mj-combo-state" data-testid="combobox-empty" role="status">
          {query.trim() === '' ? t('combobox.none') : t('combobox.no_match', { query })}
        </p>
      );
    }
    return (
      <>
        {sticky !== null && (
          <div className="mj-combo-sticky" aria-hidden data-testid="combobox-sticky">
            {sticky}
          </div>
        )}
        <div className="mj-combo-list" ref={setListEl} data-testid="combobox-list">
          <div
            role="listbox"
            id={`${ids}-list`}
            aria-label={label}
            style={{ blockSize: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const style = {
                position: 'absolute' as const,
                insetInlineStart: 0,
                insetInlineEnd: 0,
                blockSize: item.size,
                transform: `translateY(${item.start}px)`,
              };
              if (row.kind === 'group') {
                return (
                  <div key={row.key} className="mj-combo-group" style={style} role="presentation">
                    {row.label}
                  </div>
                );
              }
              return (
                <div
                  key={row.key}
                  id={`${ids}-row-${item.index}`}
                  role="option"
                  aria-selected={row.option.value === value}
                  aria-disabled={row.option.disabled ?? false}
                  data-active={item.index === active ? 'true' : undefined}
                  data-testid="combobox-option"
                  className="mj-combo-option"
                  style={style}
                  // Choosing with the mouse must not pull focus out of the field.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(item.index)}
                  onClick={() => pick(row)}
                >
                  <span className="mj-combo-name">
                    <Marked text={row.option.label} ranges={row.labelHits} />
                  </span>
                  {/* An id is Latin inside an Arabic page: isolated so its characters read
                      left to right, but not `dir="ltr"`, which would also drag the line to
                      the wrong edge and leave the two lines ragged. */}
                  {row.option.detail !== undefined && (
                    <span className="mj-combo-sub">
                      <Marked text={row.option.detail} ranges={row.detailHits} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) window.setTimeout(() => fieldRef.current?.focus(), 0);
      }}
      trigger={trigger}
      testId={testId ? `${testId}-popup` : 'combobox-popup'}
      className="mj-combo-popup"
    >
      <div className="mj-combo-field">
        <IconSearch size={14} aria-hidden />
        <input
          ref={fieldRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={`${ids}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${ids}-row-${active}` : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('combobox.search')}
          aria-label={t('combobox.search')}
          data-testid="combobox-field"
          dir="auto"
        />
      </div>
      {body()}
      {status === 'ready' && rows.length > 0 && (
        <p className="mj-combo-count" role="status">
          {t('combobox.count', {
            count: options.filter((o) =>
              rows.some((r) => r.kind === 'option' && r.option.value === o.value),
            ).length,
          })}
        </p>
      )}
    </Popover>
  );
}

function Marked({ text, ranges }: { text: string; ranges: readonly Range[] }): ReactNode {
  return highlightParts(text, ranges).map((part, index) =>
    part.hit ? (
      <mark key={index} className="mj-combo-hit">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}
