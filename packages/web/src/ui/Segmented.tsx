/**
 * The segmented control: one soft track, the chosen option lifted onto its own surface,
 * and — when the list outgrows the track — a trailing "More" that holds the rest.
 *
 * This is the shape the whole client uses whenever a small, fixed set of options switches
 * something in place: the agent above the composer, the sidebar's section row, the tabs of
 * a screen, the display preferences, the session filter. There is exactly one of these,
 * and every size and state it has is a token (`control.*` and `shadow.*` in
 * packages/ui-tokens), so the product stays one product.
 *
 * **Why the keyboard is ours and not Radix's.** The track began on Radix `ToggleGroup`,
 * whose roving focus covers only its own items — and the owner's requirement is that the
 * options *and* the More button share one tab stop. There is no exported roving-focus
 * primitive in the single `radix-ui` package we allow, and a second implementation for the
 * overflow case would have meant two controls wearing one skin. So the track owns its
 * keyboard, and `src/ui/Menu.tsx` (Radix) still owns the overflow menu. What that buys:
 *
 * - one tab stop for the whole control — the chosen option, or the first one;
 * - arrows move across the visible options and onto More, Home/End jump to the ends;
 * - the arrows follow the UI language: in Arabic, ArrowLeft moves to the *next* option;
 * - Enter or Space chooses an option, or opens More; Escape closes it and returns focus;
 * - `disabled` options are skipped rather than trapping the keyboard.
 *
 * **Two densities, chosen by the control itself.** With `overflow`, the track renders each
 * option twice into a hidden measuring row — with its label and as its icon alone — asks
 * `segmented-fit.ts` what the real container width affords, and gives up comfort in one
 * fixed order: comfortable (icon + label everywhere) → compact (only the selected option
 * keeps its label, the rest are icon-only with a hairline between them) → compact plus a
 * trailing More. The selected option is always hoisted into the visible set, so what is
 * active is never out of sight, and in compact it is the one that still reads as a word.
 * Recomputed on resize and whenever the list changes: no hard-coded count, no scrollbar,
 * no second line. An icon-only option keeps its `aria-label` and gains our tooltip, so it
 * is never a mystery to the keyboard or to a screen reader.
 *
 * Two shapes, one control:
 *
 * - `<Segmented options=… />` for the ordinary case — a list of values;
 * - `<SegmentedTrack>` + `<SegmentedItem>` when each option needs hooks of its own (the
 *   agent row calls dnd-kit's `useSortable` per option, and a hook cannot run inside a
 *   `map` that builds an array of props).
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useI18n } from '../i18n/context.js';
import { directionOf } from '../i18n/index.js';
import { IconChevron } from './icons.js';
import { Menu, MenuChoice } from './Menu.js';
import { Tooltip } from './Tooltip.js';
import { layoutSegments, type SegmentedDensity } from './segmented-fit.js';

export type SegmentedSize = 'sm' | 'md' | 'lg';

export interface SegmentedOption {
  value: string;
  /** What the option says. A node, so an option may carry an avatar or a badge. */
  label: ReactNode;
  /** Drawn before the label, at the size the control's size implies. */
  icon?: ReactNode;
  disabled?: boolean;
  /** Shown in our tooltip when the label alone is not enough; never a native `title`. */
  title?: string;
  /**
   * Anything the caller must put on the button itself: a `data-testid`, or the listeners a
   * drag library needs.
   */
  itemProps?: Record<string, unknown>;
  /** For a drag library that needs the node (dnd-kit's `setNodeRef`). */
  ref?: Ref<HTMLButtonElement>;
}

/** What an item tells the track about itself, so the track can build the More menu. */
interface Registered {
  value: string;
  label: ReactNode;
  icon?: ReactNode | undefined;
  disabled?: boolean | undefined;
}

interface TrackContext {
  value: string | null;
  choose(value: string): void;
  register(entry: Registered): () => void;
  /** `null` while nothing overflows: every item renders. */
  hidden: ReadonlySet<string> | null;
  tabStop: string | null;
  density: SegmentedDensity;
}

const Track = createContext<TrackContext | null>(null);

export interface SegmentedTrackProps {
  value: string | null;
  onChange(value: string): void;
  /** Accessible name of the group; required — a nameless group of buttons says nothing. */
  label: string;
  size?: SegmentedSize;
  /** Fill the available inline size, each option an equal share. */
  stretch?: boolean;
  /** Let the track wrap onto more lines instead of overflowing into a menu. */
  wrap?: boolean;
  /** Keep the track one line: give up labels, then move the rest into a "More" menu. */
  overflow?: boolean;
  /**
   * A trailing action after the options — adding one, not choosing one. It sits apart,
   * keeps its own tab stop, and is never part of the radio group.
   */
  action?: {
    label: string;
    icon: ReactNode;
    onSelect(): void;
    testId?: string;
  };
  className?: string;
  testId?: string;
  children: ReactNode;
}

export function SegmentedTrack({
  value,
  onChange,
  label,
  size = 'md',
  stretch = false,
  wrap = false,
  overflow = false,
  action,
  className = '',
  testId,
  children,
}: SegmentedTrackProps) {
  const { t, language } = useI18n();
  const rtl = directionOf(language) === 'rtl';
  const trackRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Registered[]>([]);
  const [width, setWidth] = useState(0);

  const register = useCallback((entry: Registered) => {
    setEntries((current) =>
      current.some((e) => e.value === entry.value) ? current : [...current, entry],
    );
    return () => setEntries((current) => current.filter((e) => e.value !== entry.value));
  }, []);

  // The container's real inline size, and every change of it.
  useLayoutEffect(() => {
    const node = trackRef.current;
    if (!node || !overflow || typeof ResizeObserver === 'undefined') return;
    const read = () => setWidth(node.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [overflow]);

  // Natural widths, from the hidden row that holds every option at both densities.
  const [sizes, setSizes] = useState<{
    comfortable: number[];
    compact: number[];
    more: number;
    action: number;
  }>({ comfortable: [], compact: [], more: 0, action: 0 });
  useLayoutEffect(() => {
    const node = measureRef.current;
    if (!node || !overflow) return;
    const width = (selector: string) =>
      [...node.querySelectorAll<HTMLElement>(selector)].map((el) => el.offsetWidth);
    setSizes({
      comfortable: width('[data-measure="comfortable"]'),
      compact: width('[data-measure="compact"]'),
      more: width('[data-measure="more"]')[0] ?? 0,
      action: width('[data-measure="action"]')[0] ?? 0,
    });
  }, [overflow, entries, size, language, action?.label]);

  const order = useMemo(() => entries.map((e) => e.value), [entries]);
  const layout = useMemo(() => {
    if (!overflow || order.length === 0) return null;
    return layoutSegments({
      available: width,
      comfortable: sizes.comfortable.length === order.length ? sizes.comfortable : [],
      compact: sizes.compact.length === order.length ? sizes.compact : [],
      moreWidth: sizes.more,
      actionWidth: action ? sizes.action : 0,
      // The hairline between icon-only options plus the flex gap.
      gap: 2,
      selected: value === null ? -1 : order.indexOf(value),
    });
  }, [overflow, order, width, sizes, value, action]);

  const density: SegmentedDensity = layout?.density ?? 'comfortable';
  const hidden = useMemo(
    () =>
      layout && layout.overflow.length > 0
        ? new Set(layout.overflow.map((i) => order[i] as string))
        : null,
    [layout, order],
  );
  const overflowEntries =
    layout && layout.overflow.length > 0
      ? layout.overflow.map((i) => entries[i] as Registered)
      : [];

  // One tab stop: the chosen option when it is on screen, otherwise the first one that is.
  const visibleValues = order.filter((v) => !hidden?.has(v));
  const tabStop =
    value !== null && visibleValues.includes(value) ? value : (visibleValues[0] ?? null);

  /** Focusable things in the track, in DOM order: the options, then More. */
  const focusables = (): HTMLElement[] =>
    trackRef.current
      ? [...trackRef.current.querySelectorAll<HTMLElement>('[data-segment-item]')].filter(
          (el) => !el.hasAttribute('disabled'),
        )
      : [];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const items = focusables();
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next = index;
    if (event.key === forward || event.key === 'ArrowDown') next = index + 1;
    else if (event.key === back || event.key === 'ArrowUp') next = index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    // The ends are ends: a segmented control does not wrap around.
    next = Math.max(0, Math.min(items.length - 1, next));
    if (next === index) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  const context: TrackContext = { value, choose: onChange, register, hidden, tabStop, density };

  return (
    <div
      className={`mj-segmented ${className}`}
      role="radiogroup"
      aria-label={label}
      dir={rtl ? 'rtl' : 'ltr'}
      data-size={size}
      data-stretch={stretch ? 'true' : undefined}
      data-wrap={wrap ? 'true' : undefined}
      data-density={density}
      data-overflowing={hidden ? 'true' : undefined}
      data-testid={testId}
      ref={trackRef}
      onKeyDown={onKeyDown}
    >
      <Track.Provider value={context}>
        {children}
        {hidden && (
          <Menu
            testId={testId ? `${testId}-more-menu` : undefined}
            align="end"
            trigger={
              <button
                type="button"
                className="mj-segment mj-segment-more"
                data-segment-item="more"
                data-testid={testId ? `${testId}-more` : 'segmented-more'}
                tabIndex={-1}
                aria-haspopup="menu"
              >
                <span className="mj-segment-label">{t('common.more')}</span>
                <IconChevron size={12} />
              </button>
            }
          >
            {overflowEntries.map((entry) => (
              <MenuChoice
                key={entry.value}
                checked={entry.value === value}
                disabled={entry.disabled}
                icon={entry.icon}
                onSelect={() => onChange(entry.value)}
              >
                {entry.label}
              </MenuChoice>
            ))}
          </Menu>
        )}
        {action && (
          // An action, not a choice: outside the radio group, with its own tab stop.
          <Tooltip label={action.label}>
            <button
              type="button"
              className="mj-segment-action"
              aria-label={action.label}
              onClick={action.onSelect}
              data-testid={action.testId ?? (testId ? `${testId}-action` : undefined)}
            >
              {action.icon}
            </button>
          </Tooltip>
        )}
        {overflow && (
          // The measuring row: every option at both densities, off the screen and out of
          // the accessibility tree. It is the only honest way to know what fits.
          <div className="mj-segmented-measure" aria-hidden ref={measureRef}>
            {entries.map((entry) => (
              <span key={entry.value} className="mj-segment" data-measure="comfortable">
                {entry.icon}
                <span className="mj-segment-label">{entry.label}</span>
              </span>
            ))}
            {entries.map((entry) => (
              <span
                key={`${entry.value}-icon`}
                className="mj-segment mj-segment-icon-only"
                data-measure="compact"
              >
                {entry.icon}
              </span>
            ))}
            <span className="mj-segment mj-segment-more" data-measure="more">
              <span className="mj-segment-label">{t('common.more')}</span>
              <IconChevron size={12} />
            </span>
            {action && (
              <span className="mj-segment-action" data-measure="action">
                {action.icon}
              </span>
            )}
          </div>
        )}
      </Track.Provider>
    </div>
  );
}

export interface SegmentedItemProps {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  /** Merged onto the button: test ids, drag listeners, inline transforms. */
  itemProps?: Record<string, unknown>;
}

export const SegmentedItem = forwardRef<HTMLButtonElement, SegmentedItemProps>(
  function SegmentedItem({ value, label, icon, disabled, title, itemProps }, ref) {
    const track = useContext(Track);
    if (!track) throw new Error('SegmentedItem outside SegmentedTrack');
    const { register } = track;
    useEffect(
      () => register({ value, label, ...(icon === undefined ? {} : { icon }), disabled }),
      [register, value, label, icon, disabled],
    );

    const selected = track.value === value;
    if (track.hidden?.has(value)) return null;
    // Compact: only the chosen option still reads as a word. The others keep their name
    // in `aria-label` and in the tooltip, so nobody has to guess what an icon means.
    const iconOnly = track.density === 'compact' && !selected;
    const name = title ?? (typeof label === 'string' ? label : undefined);
    const { className: extraClass, ...extra } = (itemProps ?? {}) as {
      className?: string;
    } & Record<string, unknown>;
    return (
      <Tooltip label={iconOnly ? (name ?? title) : title}>
        <button
          type="button"
          ref={ref}
          role="radio"
          aria-checked={selected}
          disabled={disabled}
          tabIndex={track.tabStop === value ? 0 : -1}
          data-segment-item={value}
          // The caller's classes are added to ours, never instead of them: the density
          // class has to survive whatever a drag library wants on the same element.
          className={`mj-segment ${iconOnly ? 'mj-segment-icon-only' : ''} ${extraClass ?? ''}`}
          onClick={() => !disabled && track.choose(value)}
          {...extra}
          {...(iconOnly && extra['aria-label'] === undefined && name !== undefined
            ? { 'aria-label': name }
            : {})}
        >
          {icon}
          {!iconOnly && <span className="mj-segment-label">{label}</span>}
        </button>
      </Tooltip>
    );
  },
);

export function Segmented({
  options,
  ...track
}: Omit<SegmentedTrackProps, 'children'> & { options: readonly SegmentedOption[] }) {
  return (
    <SegmentedTrack {...track}>
      {options.map((option) => (
        <SegmentedItem
          key={option.value}
          ref={option.ref}
          value={option.value}
          label={option.label}
          {...(option.icon === undefined ? {} : { icon: option.icon })}
          {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
          {...(option.title === undefined ? {} : { title: option.title })}
          {...(option.itemProps === undefined ? {} : { itemProps: option.itemProps })}
        />
      ))}
    </SegmentedTrack>
  );
}
