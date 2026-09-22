/**
 * The UI direction, published to the primitives.
 *
 * Radix reads direction from its own context, not from `<html dir>`: without this, a menu's
 * arrow keys and a popover's alignment would stay left-to-right while the page is Arabic.
 * It lives in `src/ui/` because that is the one place allowed to touch a primitive
 * (docs/clients/DESIGN.md §UI policy); `src/i18n/context.tsx` mounts it beside the language
 * that decides it.
 */
import { Direction } from 'radix-ui';
import type { ReactNode } from 'react';

export function UiDirection({ dir, children }: { dir: 'rtl' | 'ltr'; children: ReactNode }) {
  return <Direction.DirectionProvider dir={dir}>{children}</Direction.DirectionProvider>;
}
