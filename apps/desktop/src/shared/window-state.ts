/**
 * Where the window opens: where it was, unless that place is gone.
 *
 * A laptop that was on an external monitor yesterday opens today without it; a window
 * restored at x=2400 would be invisible. The saved bounds are kept only when enough of the
 * title bar lands on a display that still exists; otherwise the window is centred on the
 * primary display, at the saved size shrunk to fit.
 */
import { DEFAULT_WINDOW, MIN_WINDOW, type WindowBounds } from './config.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement extends Rect {
  maximized: boolean;
  /** False when the window should be centred by the OS (no usable position). */
  positioned: boolean;
}

/** How much of the top strip must be on screen for the window to count as reachable. */
const GRAB = { width: 120, height: 40 };

function overlap(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function placeWindow(
  saved: WindowBounds | null,
  workAreas: readonly Rect[],
  primary: Rect,
): Placement {
  const width = Math.min(saved?.width ?? DEFAULT_WINDOW.width, primary.width);
  const height = Math.min(saved?.height ?? DEFAULT_WINDOW.height, primary.height);
  const size = {
    width: Math.max(Math.min(MIN_WINDOW.width, primary.width), width),
    height: Math.max(Math.min(MIN_WINDOW.height, primary.height), height),
  };
  const maximized = saved?.maximized ?? false;
  if (saved && saved.x !== null && saved.y !== null) {
    const strip = { x: saved.x, y: saved.y, width: saved.width, height: GRAB.height };
    const reachable = workAreas.some((area) => {
      const o = overlap(strip, area);
      return o.width >= GRAB.width && o.height >= GRAB.height / 2;
    });
    if (reachable)
      return {
        x: saved.x,
        y: saved.y,
        width: saved.width,
        height: saved.height,
        maximized,
        positioned: true,
      };
  }
  return {
    x: Math.round(primary.x + (primary.width - size.width) / 2),
    y: Math.round(primary.y + (primary.height - size.height) / 2),
    ...size,
    maximized,
    positioned: false,
  };
}
