/**
 * A CSV (or TSV) as a table: RFC 4180 quoting, a header row, and a cap on the rows kept so a
 * large file never becomes a page the browser cannot draw.
 */
export const CSV_MAX_ROWS = 500;
export const CSV_MAX_COLUMNS = 100;

export interface Table {
  header: string[];
  rows: string[][];
  /** Data rows in the file (without the header), counted to the end even past the cap. */
  totalRows: number;
}

export function parseCsv(text: string, delimiter = ',', maxRows = CSV_MAX_ROWS): Table {
  const rows: string[][] = [];
  let totalRows = -1; // the header is not a data row
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a byte-order mark is not a field

  const endRow = () => {
    row.push(field);
    field = '';
    totalRows += 1;
    if (rows.length <= maxRows) rows.push(row.slice(0, CSV_MAX_COLUMNS));
    row = [];
  };

  for (; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRow();
    } else field += char;
  }
  if (field !== '' || row.length > 0) endRow();
  const [header = [], ...data] = rows;
  return { header, rows: data, totalRows: Math.max(0, totalRows) };
}

export function delimiterOf(name: string): string {
  return /\.tsv$/i.test(name) ? '\t' : ',';
}
