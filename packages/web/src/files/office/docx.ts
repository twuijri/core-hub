/**
 * A DOCX document as blocks a React view draws: headings, paragraphs with bold, italic and
 * underlined runs, list items and tables. Pictures, footnotes and page layout are left out
 * — this is a reading preview, not a word processor. Nothing is turned into HTML markup, so
 * there is nothing to sanitise: every run is text.
 */
import { OfficeFileError, all, attr, kid, kids, readParts, xml } from './zip.js';

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export type Block =
  | { type: 'heading'; level: number; runs: Run[]; rtl: boolean }
  | { type: 'paragraph'; runs: Run[]; rtl: boolean; list: boolean }
  | { type: 'table'; rows: string[][] };

/** Word's own switch (`<w:b/>`, `<w:b w:val="false"/>`). */
function on(node: Element | undefined): boolean {
  if (!node) return false;
  const value = attr(node, 'val');
  return value === null || !['0', 'false', 'none'].includes(value);
}

function runsOf(paragraph: Element): Run[] {
  const runs: Run[] = [];
  for (const run of all(paragraph, 'r')) {
    const props = kid(run, 'rPr');
    let text = '';
    for (const child of Array.from(run.children)) {
      if (child.localName === 't') text += child.textContent ?? '';
      else if (child.localName === 'tab') text += '\t';
      else if (child.localName === 'br' || child.localName === 'cr') text += '\n';
    }
    if (text === '') continue;
    runs.push({
      text,
      bold: on(props && kid(props, 'b')),
      italic: on(props && kid(props, 'i')),
      underline: on(props && kid(props, 'u')),
    });
  }
  return runs;
}

function paragraphOf(paragraph: Element): Block {
  const props = kid(paragraph, 'pPr');
  const style = (props && kid(props, 'pStyle') && attr(kid(props, 'pStyle')!, 'val')) ?? '';
  const rtl = on(props && kid(props, 'bidi'));
  const runs = runsOf(paragraph);
  const heading = /^(?:heading|عنوان)\s*(\d)$/i.exec(style.replace(/\s+/g, ' '));
  if (heading) return { type: 'heading', level: Math.min(6, Number(heading[1])), runs, rtl };
  if (/^title$/i.test(style)) return { type: 'heading', level: 1, runs, rtl };
  const list = !!(props && kid(props, 'numPr')) || /list/i.test(style);
  return { type: 'paragraph', runs, rtl, list };
}

export function readDocx(bytes: Uint8Array): Block[] {
  const parts = readParts(bytes, (name) => name === 'word/document.xml');
  const doc = xml(parts.text('word/document.xml'));
  const body = doc ? all(doc, 'body')[0] : undefined;
  if (!body) throw new OfficeFileError('not_office');
  const blocks: Block[] = [];
  for (const child of Array.from(body.children)) {
    if (child.localName === 'p') blocks.push(paragraphOf(child));
    else if (child.localName === 'tbl') {
      const rows = kids(child, 'tr').map((row) =>
        kids(row, 'tc').map((cell) =>
          kids(cell, 'p')
            .map((p) =>
              runsOf(p)
                .map((run) => run.text)
                .join(''),
            )
            .join('\n'),
        ),
      );
      blocks.push({ type: 'table', rows });
    }
  }
  return blocks;
}
