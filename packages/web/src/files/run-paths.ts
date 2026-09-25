/**
 * A reply names a file it left for the person by the hub's own folder for the run —
 * `/data/workspaces/…/.corehub/runs/<run id>/out/flying_cat.png` — because that is where the
 * hub told the agent to write it. The person has no use for that path: the file is on the reply
 * already. What is drawn is the part after `out/` (or `in/`, the person's own attachments), which
 * the reply's file mentions then turn into a link that opens the file (decision §48).
 *
 * Only the drawing changes: the stored text, what Copy copies and what other clients read keep
 * the agent's words. Fenced code blocks are left as written — a path in code is code.
 */
import { derived } from '@corehub/contracts';

/** The run folder's name now, and the one it had before the product was renamed. */
const RUN_DIR_NAMES = [derived.runFilesDir.replace(/^\./, ''), 'majlis'];

/**
 * Anything up to and including `<.corehub|corehub|.majlis|majlis>/runs/<ULID>/<in|out>/`, when a
 * file name follows. The leading part stops at whitespace, quotes, brackets and parentheses, so
 * a markdown link's text and its `(…)` stay apart.
 */
const RUN_PATH = new RegExp(
  String.raw`(?:[^\s\x60'"()<>\[\]«»]*\/)?\.?(?:${RUN_DIR_NAMES.join('|')})\/runs\/[0-9A-HJKMNP-TV-Z]{26}\/(?:in|out)\/(?=[^\s/\x60'"()<>\[\]«»])`,
  'giu',
);

const FENCE = /^\s{0,3}(```|~~~)/;

/** `text` with every run-folder path shortened to the file's own path inside that folder. */
export function hideRunPaths(text: string): string {
  if (!text.includes('/runs/')) return text;
  let fenced: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const fence = FENCE.exec(line)?.[1] ?? null;
      if (fence) {
        if (fenced === null) fenced = fence;
        else if (fence === fenced) fenced = null;
        return line;
      }
      return fenced === null ? line.replace(RUN_PATH, '') : line;
    })
    .join('\n');
}
