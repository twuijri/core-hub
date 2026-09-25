/**
 * The `/` menu above the composer (decision §57): the commands the session's agent takes,
 * or the skills after `/skill `, each with a line saying what it does.
 *
 * Focus never leaves the textarea — the person keeps typing to filter — so the list is a
 * listbox the textarea points at (`aria-activedescendant`), and the arrow keys, Enter, Tab
 * and Escape are read by the composer. Pointer: hover moves the highlight, a press picks.
 */
import { useEffect, useRef } from 'react';

export interface SlashMenuItem {
  key: string;
  /** What is typed: `/compress`, or a skill's name. */
  label: string;
  description: string;
}

export function slashOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`;
}

export function SlashMenu({
  id,
  title,
  items,
  active,
  empty,
  onPick,
  onHover,
}: {
  id: string;
  title: string;
  items: readonly SlashMenuItem[];
  active: number;
  /** Said when nothing matches, so an empty list is never a silent dead end. */
  empty: string;
  onPick(index: number): void;
  onHover(index: number): void;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // The highlighted row stays in view while the arrows walk a list taller than the menu.
    const node = list.current?.children.item(active) as HTMLElement | null | undefined;
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <div className="slash-menu glass" data-testid="slash-menu">
      <p className="slash-menu-title" id={`${id}-title`}>
        {title}
      </p>
      {items.length === 0 ? (
        <p className="slash-menu-empty" role="status">
          {empty}
        </p>
      ) : (
        <ul ref={list} id={id} role="listbox" aria-labelledby={`${id}-title`}>
          {items.map((item, index) => (
            <li
              key={item.key}
              id={slashOptionId(id, index)}
              role="option"
              aria-selected={index === active}
              data-active={index === active ? 'true' : undefined}
              data-testid={`slash-option-${item.key}`}
              className="slash-option"
              onMouseMove={() => {
                if (index !== active) onHover(index);
              }}
              // A press, not a click: the textarea must not lose focus before the pick lands.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(index);
              }}
            >
              <span className="slash-option-label" dir="ltr">
                {item.label}
              </span>
              <span className="slash-option-description" dir="auto">
                {item.description}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
