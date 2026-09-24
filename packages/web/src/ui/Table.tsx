/**
 * The one table.
 *
 * A real `<table>`, because a grid of divs is a table a screen reader cannot read. Headers
 * are `<th scope>`, every cell aligns to `start` so Arabic and English both read from their
 * own edge, and the whole thing scrolls inside its own box rather than pushing the page
 * sideways — a wide table must never make the column scroll.
 *
 * `numeric` columns are tabular-figure and aligned to `end`, which is what a column of
 * numbers wants in either direction.
 */
import type { ReactNode } from 'react';

export interface Column<Row> {
  key: string;
  header: ReactNode;
  /** Right-ish: aligned to the inline end, with tabular figures. */
  numeric?: boolean;
  /** A column that may be dropped on a narrow screen. */
  secondary?: boolean;
  cell(row: Row): ReactNode;
}

export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  testId,
}: {
  /** The table's accessible name. Visually hidden unless `captionVisible`. */
  caption: string;
  columns: ReadonlyArray<Column<Row>>;
  rows: readonly Row[];
  rowKey(row: Row): string;
  /** What stands in the table's place when there are no rows — never a blank box. */
  empty?: ReactNode;
  testId?: string;
}) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;
  return (
    <div className="ch-table-scroll">
      <table className="ch-table" data-testid={testId}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-numeric={column.numeric ? 'true' : undefined}
                data-secondary={column.secondary ? 'true' : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  data-numeric={column.numeric ? 'true' : undefined}
                  data-secondary={column.secondary ? 'true' : undefined}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
