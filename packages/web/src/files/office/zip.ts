/**
 * Reading an Office file (a ZIP of XML parts) without trusting it.
 *
 * The file came from an agent or an attachment, so it may be a ZIP bomb. Three limits hold
 * before anything is inflated, from the archive's own directory: how many entries it has,
 * how large any one part claims to be, and how large all of them together claim to be.
 * Only the parts asked for are inflated, each into a buffer of exactly its declared size —
 * a part that lies about its size cannot grow past it (fflate writes into that buffer and
 * no further).
 */
import { unzipSync } from 'fflate';

export const ZIP_MAX_ENTRIES = 5000;
export const ZIP_MAX_PART_BYTES = 30 * 1024 * 1024;
export const ZIP_MAX_TOTAL_BYTES = 120 * 1024 * 1024;

export class OfficeFileError extends Error {
  constructor(readonly reason: 'too_many_entries' | 'too_large' | 'not_office' | 'damaged') {
    super(reason);
    this.name = 'OfficeFileError';
  }
}

export interface Parts {
  /** The names in the archive. */
  names: string[];
  /** Read one part as text; `null` when it is not in the archive or was not asked for. */
  text(name: string): string | null;
}

/**
 * Inflate the parts `wanted` accepts. `names` lists every entry, so a caller can choose the
 * next parts from the first ones (a workbook names its sheets).
 */
export function readParts(bytes: Uint8Array, wanted: (name: string) => boolean): Parts {
  const names: string[] = [];
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        names.push(file.name);
        if (names.length > ZIP_MAX_ENTRIES) throw new OfficeFileError('too_many_entries');
        total += file.originalSize;
        if (file.originalSize > ZIP_MAX_PART_BYTES || total > ZIP_MAX_TOTAL_BYTES) {
          throw new OfficeFileError('too_large');
        }
        return wanted(file.name);
      },
    });
  } catch (error) {
    if (error instanceof OfficeFileError) throw error;
    throw new OfficeFileError('damaged');
  }
  const decoder = new TextDecoder();
  return {
    names,
    text: (name) => {
      const part = files[name];
      return part ? decoder.decode(part) : null;
    },
  };
}

/** Parse one XML part; a part that is not XML is a damaged file. */
export function xml(text: string | null): Document | null {
  if (text === null) return null;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new OfficeFileError('damaged');
  return doc;
}

/** The descendants of `node` with this local name, whatever their namespace prefix. */
export function all(node: Document | Element, localName: string): Element[] {
  return Array.from(node.getElementsByTagNameNS('*', localName));
}

/** The direct children of `node` with this local name. */
export function kids(node: Element, localName: string): Element[] {
  return Array.from(node.children).filter((child) => child.localName === localName);
}

export function kid(node: Element, localName: string): Element | undefined {
  return kids(node, localName)[0];
}

/**
 * An attribute by local name (`r:id`, `w:val`), whatever its prefix. A prefixed one wins
 * over a bare one of the same name: a slide's `<p:sldId id="256" r:id="rId2">` means `r:id`.
 */
export function attr(node: Element, localName: string): string | null {
  let bare: string | null = null;
  for (const attribute of Array.from(node.attributes)) {
    if (attribute.localName !== localName) continue;
    if (attribute.namespaceURI !== null) return attribute.value;
    bare ??= attribute.value;
  }
  return bare;
}

/** `Target` of each relationship in a `.rels` part, by `Id`, resolved against `base`. */
export function relationships(text: string | null, base: string): Map<string, string> {
  const out = new Map<string, string>();
  const doc = xml(text);
  if (!doc) return out;
  for (const rel of all(doc, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target) continue;
    out.set(id, resolvePart(base, target));
  }
  return out;
}

function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').filter(Boolean);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}
