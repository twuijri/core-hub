/**
 * An XLSX workbook as tables: every sheet's name and its cells as text, capped. Values are
 * shown as stored — a number is its digits, a date its serial number — because number
 * formats are presentation this preview does not reproduce.
 */
import { OfficeFileError, all, attr, kid, readParts, relationships, xml } from './zip.js';

export const SHEET_MAX_ROWS = 500;
export const SHEET_MAX_COLUMNS = 50;

export interface Sheet {
  name: string;
  rows: string[][];
  /** Rows in the sheet, counted past the cap. */
  totalRows: number;
  /** Columns cut at `SHEET_MAX_COLUMNS`. */
  clipped: boolean;
}

/** "BC12" → 54 (zero-based column index). */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref.toUpperCase())?.[0] ?? '';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function textOf(node: Element | undefined): string {
  if (!node) return '';
  return all(node, 't')
    .map((t) => t.textContent ?? '')
    .join('');
}

export function readXlsx(bytes: Uint8Array): Sheet[] {
  const first = readParts(
    bytes,
    (name) =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml',
  );
  const workbook = xml(first.text('xl/workbook.xml'));
  if (!workbook) throw new OfficeFileError('not_office');
  const rels = relationships(first.text('xl/_rels/workbook.xml.rels'), 'xl');
  const shared = (() => {
    const doc = xml(first.text('xl/sharedStrings.xml'));
    return doc ? all(doc, 'si').map((si) => textOf(si)) : [];
  })();

  const sheets = all(workbook, 'sheet').map((sheet) => ({
    name: sheet.getAttribute('name') ?? '',
    part: rels.get(attr(sheet, 'id') ?? '') ?? '',
  }));
  const wanted = new Set(sheets.map((sheet) => sheet.part));
  const second = readParts(bytes, (name) => wanted.has(name));

  return sheets.map(({ name, part }) => {
    const doc = xml(second.text(part));
    const rows: string[][] = [];
    let totalRows = 0;
    let clipped = false;
    for (const row of doc ? all(doc, 'row') : []) {
      totalRows += 1;
      if (rows.length >= SHEET_MAX_ROWS) continue;
      const cells: string[] = [];
      for (const cell of Array.from(row.children).filter((c) => c.localName === 'c')) {
        const column = columnIndex(cell.getAttribute('r') ?? '');
        const at = column >= 0 ? column : cells.length;
        if (at >= SHEET_MAX_COLUMNS) {
          clipped = true;
          continue;
        }
        const type = cell.getAttribute('t');
        const value = kid(cell, 'v')?.textContent ?? '';
        const text =
          type === 's'
            ? (shared[Number(value)] ?? '')
            : type === 'inlineStr'
              ? textOf(kid(cell, 'is'))
              : type === 'b'
                ? value === '1'
                  ? 'TRUE'
                  : 'FALSE'
                : value;
        while (cells.length < at) cells.push('');
        cells[at] = text;
      }
      rows.push(cells);
    }
    return { name, rows, totalRows, clipped };
  });
}
