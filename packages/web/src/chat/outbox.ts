/**
 * The messages this tab is holding back, and the rules for them. Pure, so the rules are
 * tested without a browser (`tests/outbox.test.ts`).
 */
import type { ContentBlock } from '../types.js';

export interface QueuedMessage {
  /** Stable across re-renders; not an id the hub ever sees. */
  key: string;
  blocks: ContentBlock[];
  /** The first line of text, for the row — never the whole message. */
  preview: string;
}

let counter = 0;

/** A few words of what was typed: enough to tell two waiting messages apart. */
export function previewOfBlocks(blocks: readonly ContentBlock[]): string {
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text !== '') return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  const other = blocks.find((block) => block.type !== 'text');
  return other && 'name' in other && typeof other.name === 'string' ? other.name : '';
}

export function queued(blocks: ContentBlock[]): QueuedMessage {
  counter += 1;
  return { key: `q${counter}`, blocks, preview: previewOfBlocks(blocks) };
}

/**
 * What "send" does while a run is alive, from `preferences.busy_input_mode`.
 *
 * `queue` is the only mode that holds anything back: the other two are the person saying
 * "now", and the hub is told so through `RunCreate.when` at the moment of sending.
 */
export function holdsBack(mode: string | undefined, busy: boolean): boolean {
  return busy && (mode ?? 'queue') === 'queue';
}
