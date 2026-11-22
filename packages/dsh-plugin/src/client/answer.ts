/**
 * A Markdown answer in the harness's own renderer (`MarkdownText`, the one its chat uses), with
 * every block taking its own direction: each paragraph, list, item, heading, quote and table cell
 * gets `dir="auto"`, so Arabic reads right to left and English left to right in one answer. The
 * renderer is the harness's; the plugin only adds the attribute after it renders.
 */
import { createElement as h, useEffect, useRef, type ReactNode } from 'react';
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import type { UiLanguage, UiTranslate } from '../ui-strings.js';

const BLOCKS = 'p, li, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, td, th, table';

/** Puts `dir="auto"` on every text block under `root` that has no direction yet. */
export function directBlocks(root: ParentNode): void {
  root.querySelectorAll(BLOCKS).forEach((el) => {
    if (!el.hasAttribute('dir')) el.setAttribute('dir', 'auto');
  });
}

const labelCache = new Map<UiLanguage, MarkdownLabels>();

/** Reference-stable labels per language (the renderer drops its cache on a new object). */
export function markdownLabels(language: UiLanguage, t: UiTranslate): MarkdownLabels {
  let labels = labelCache.get(language);
  if (!labels) {
    labels = {
      code: {
        copyLabel: t('md.copy'),
        copiedLabel: t('md.copied'),
        toolbarLabels: {
          codeLabel: t('md.code'),
          wrapLabel: t('md.wrap'),
          unwrapLabel: t('md.unwrap'),
        },
      },
      footnotes: t('md.footnotes'),
    };
    labelCache.set(language, labels);
  }
  return labels;
}

export function Answer(props: {
  text: string;
  labels: MarkdownLabels;
  variant?: 'body' | 'compact';
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    directBlocks(root);
    const observer = new MutationObserver(() => directBlocks(root));
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return h(
    'div',
    { ref },
    h(MarkdownText, { text: props.text, labels: props.labels, variant: props.variant ?? 'body' }),
  );
}
