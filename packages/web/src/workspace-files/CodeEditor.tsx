/**
 * A plain-text editor with syntax colour, for the Files page.
 *
 * The classic two-layer editor: the highlighted text is drawn in a `<pre>`, and a
 * transparent `<textarea>` with the same font, padding and wrapping lies exactly on top of
 * it, so typing, selection, undo, the caret and the screen reader are all the browser's own.
 * Both sit in one grid cell and the textarea grows with the text, so there is one scroll
 * box (the frame) and nothing to keep in step.
 *
 * Colour comes from lowlight (highlight.js grammars) with the `hljs-*` classes the chat's
 * code blocks already paint. Past `HIGHLIGHT_LIMIT` characters the text is shown plain:
 * re-colouring a large file on every key would make typing lag, and the editor must stay an
 * editor first.
 */
import { common, createLowlight } from 'lowlight';
import { useDeferredValue, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { languageOf, textDirectionOf } from './paths.js';

const lowlight = createLowlight(common);

/** Above this many characters the text is not coloured (see above). */
export const HIGHLIGHT_LIMIT = 200_000;

interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  tagName: string;
  properties?: { className?: unknown };
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string };

function render(nodes: readonly HastNode[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}.${String(index)}`;
    if (node.type === 'text') return (node as HastText).value;
    if (node.type !== 'element') return null;
    const element = node as HastElement;
    const className = Array.isArray(element.properties?.className)
      ? (element.properties.className as string[]).join(' ')
      : undefined;
    return (
      <span key={key} className={className}>
        {render(element.children, key)}
      </span>
    );
  });
}

/** The text as coloured spans, or null when it should be shown plain. */
export function highlight(text: string, fileName: string): ReactNode[] | null {
  const language = languageOf(fileName);
  if (!language || text.length > HIGHLIGHT_LIMIT || !lowlight.registered(language)) return null;
  try {
    const tree = lowlight.highlight(language, text);
    return render(tree.children as HastNode[], 'h');
  } catch {
    return null;
  }
}

export function CodeEditor({
  value,
  onChange,
  fileName,
  label,
  readOnly = false,
  onSave,
  testId,
}: {
  value: string;
  onChange?(value: string): void;
  /** Decides the grammar and the direction. */
  fileName: string;
  /** The textarea's accessible name. */
  label: string;
  readOnly?: boolean;
  /** Ctrl/⌘+S. */
  onSave?(): void;
  testId?: string;
}) {
  const deferred = useDeferredValue(value);
  const coloured = useMemo(() => highlight(deferred, fileName), [deferred, fileName]);
  const dir = textDirectionOf(fileName);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave?.();
      return;
    }
    // Tab inserts two spaces rather than leaving the editor; Escape still does.
    if (event.key === 'Tab' && !event.shiftKey && !readOnly) {
      event.preventDefault();
      const target = event.currentTarget;
      const { selectionStart, selectionEnd } = target;
      const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
      onChange?.(next);
      requestAnimationFrame(() => {
        target.selectionStart = selectionStart + 2;
        target.selectionEnd = selectionStart + 2;
      });
    }
  };

  return (
    <div className="files-editor" dir={dir} data-testid={testId}>
      <pre className="files-editor-layer hljs" aria-hidden="true">
        <code>
          {coloured ?? deferred}
          {/* A trailing newline in a <pre> collapses; this keeps the last line's height. */}
          {'\n'}
        </code>
      </pre>
      <textarea
        className="files-editor-input"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={label}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        dir={dir}
        data-testid={testId ? `${testId}-input` : undefined}
      />
    </div>
  );
}
