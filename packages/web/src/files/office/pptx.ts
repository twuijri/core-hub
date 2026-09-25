/**
 * A PPTX deck as an outline: each slide's title and the text of its other boxes, paragraph
 * by paragraph. No small renderer with a permissive licence draws slides faithfully, so the
 * preview says it is an outline and offers the file itself for the real thing.
 */
import { OfficeFileError, all, attr, kid, readParts, relationships, xml } from './zip.js';

export interface Slide {
  number: number;
  title: string | null;
  paragraphs: string[];
}

function paragraphsOf(shape: Element): string[] {
  return all(shape, 'p')
    .map((p) =>
      all(p, 't')
        .map((t) => t.textContent ?? '')
        .join(''),
    )
    .filter((text) => text.trim() !== '');
}

export function readPptx(bytes: Uint8Array): Slide[] {
  const first = readParts(
    bytes,
    (name) => name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels',
  );
  const presentation = xml(first.text('ppt/presentation.xml'));
  if (!presentation) throw new OfficeFileError('not_office');
  const rels = relationships(first.text('ppt/_rels/presentation.xml.rels'), 'ppt');
  const order = all(presentation, 'sldId')
    .map((slide) => rels.get(attr(slide, 'id') ?? '') ?? '')
    .filter(Boolean);
  const wanted = new Set(order);
  const slides = readParts(bytes, (name) => wanted.has(name));

  return order.map((part, index) => {
    const doc = xml(slides.text(part));
    let title: string | null = null;
    const paragraphs: string[] = [];
    for (const shape of doc ? all(doc, 'sp') : []) {
      const placeholder = all(shape, 'ph')[0];
      const kind = placeholder?.getAttribute('type') ?? '';
      const text = paragraphsOf(kid(shape, 'txBody') ?? shape);
      if (title === null && (kind === 'title' || kind === 'ctrTitle') && text.length > 0) {
        title = text.join(' ');
      } else paragraphs.push(...text);
    }
    return { number: index + 1, title, paragraphs };
  });
}
