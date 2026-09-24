/**
 * Majlis's own mark: a rounded "C" holding a square, drawn in one colour so it follows the
 * theme (`currentColor`, the accent where it is placed). The owner chose it on 2026-09-24 —
 * the mark of their Core Hub identity, carried over in Majlis's teal. It is drawn here from
 * three shapes read off the owner's artwork, not copied from any file: the outer rounded
 * square, the hole (a rounded ring whose right side opens to the edge) and the square
 * inside it. `evenodd` makes the hole and fills the square again.
 */
import type { SVGProps } from 'react';

const OUTER =
  'M230 0H665A230 230 0 0 1 895 230V615A230 230 0 0 1 665 845H230A230 230 0 0 1 0 615V230A230 230 0 0 1 230 0Z';
const HOLE =
  'M315 181H581A112 112 0 0 1 693 293V343H895V498H693V555A112 112 0 0 1 581 667H315A112 112 0 0 1 203 555V293A112 112 0 0 1 315 181Z';
const CORE =
  'M348 271H545A58 58 0 0 1 603 329V518A58 58 0 0 1 545 576H348A58 58 0 0 1 290 518V329A58 58 0 0 1 348 271Z';

/** The path, for places that draw the mark outside React (the favicon in index.html). */
export const MAJLIS_MARK_PATH = `${OUTER}${HOLE}${CORE}`;
export const MAJLIS_MARK_VIEWBOX = '0 -25 895 895';

export function MajlisMark({ size = 28, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={MAJLIS_MARK_VIEWBOX}
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden
      data-testid="majlis-mark"
      {...rest}
    >
      <path d={MAJLIS_MARK_PATH} />
    </svg>
  );
}
