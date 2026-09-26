/**
 * The page's own controls in the frame's top bar (owner, 2026-09-26: «لازم تكون كل هذي الأشياء
 * ثابتة» — then «بيطلع فوق كأنه شريطين»). A conversation's agent, folder, files and
 * Chat/Trajectory switch stay on screen while the messages scroll, and they do it inside the one
 * bar that is already pinned, rather than as a second bar under it.
 *
 * The top bar leaves an empty place after the title (`TopBar`), and a page fills it with
 * `TopBarActions`. The controls are rendered through a portal, so they stay in the page's React
 * tree: the conversation's profile (`ProfileScope`), its files and its tabs reach them, although
 * the bar around them speaks for the person (`ChromeScope`).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const TopBarSlotContext = createContext<HTMLElement | null>(null);

export const TopBarSlotProvider = TopBarSlotContext.Provider;

/** Renders its children in the top bar, after the title; nothing outside a frame. */
export function TopBarActions({ children }: { children: ReactNode }) {
  const slot = useContext(TopBarSlotContext);
  return slot ? createPortal(children, slot) : null;
}
