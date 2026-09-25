/**
 * A few minutes of one number, drawn in plain SVG: no chart library for a line this small.
 * Time runs with the reading direction's start as the oldest point — the SVG is mirrored in
 * Arabic, so "now" is always at the end of the line, where the value beside it is read.
 */
import { sparklineRuns } from './live.js';

const WIDTH = 120;
const HEIGHT = 28;

export function Sparkline({
  values,
  label,
  max,
  testId,
}: {
  values: ReadonlyArray<number | null>;
  /** What the line shows, for a screen reader; the figure next to it says the value. */
  label: string;
  /** The top of the scale (100 for a percentage); the highest value otherwise. */
  max?: number;
  testId?: string;
}) {
  const runs = sparklineRuns(values, WIDTH, HEIGHT - 2, max);
  // The newest point gets a dot, so a line of one sample (the first look) still shows.
  const [x, y] = (runs.at(-1)?.split(' ').at(-1) ?? '').split(',').map(Number);
  return (
    <svg
      className="ch-sparkline"
      viewBox={`0 -1 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      data-testid={testId}
      data-points={values.length}
    >
      <line className="ch-sparkline-base" x1="0" y1={HEIGHT - 2} x2={WIDTH} y2={HEIGHT - 2} />
      {runs.map((points) => (
        <polyline key={points} className="ch-sparkline-line" points={points} />
      ))}
      {x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) && (
        <circle className="ch-sparkline-dot" cx={x} cy={y} r="2" />
      )}
    </svg>
  );
}
