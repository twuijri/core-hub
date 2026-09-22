import { useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n/context.js';
import { usePane } from '../shell/pane.js';
import { IconCheck, IconCopy, IconPanel } from '../ui/icons.js';
import { Tooltip } from '../ui/Tooltip.js';

function textOfChildren(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOfChildren).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOfChildren((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function CodeBlock(props: ComponentProps<'pre'>) {
  const { t } = useI18n();
  const pane = usePane();
  const [copied, setCopied] = useState(false);
  const code = textOfChildren(props.children);
  const child = Array.isArray(props.children) ? props.children[0] : props.children;
  const className =
    (child as { props?: { className?: string } } | undefined)?.props?.className ?? '';
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: the code is still selectable.
    }
  };
  return (
    <div className="group relative" dir="ltr">
      <div className="absolute end-1 top-1 flex gap-1 opacity-0 transition-ui focus-within:opacity-100 group-hover:opacity-100">
        {language && <span className="chip">{language}</span>}
        <Tooltip label={t('chat.copy_code')}>
          <button
            type="button"
            className="btn btn-ghost px-1"
            onClick={() => void copy()}
            aria-label={t('chat.copy_code')}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
        </Tooltip>
        <Tooltip label={t('chat.open_in_pane')}>
          <button
            type="button"
            className="btn btn-ghost px-1"
            onClick={() =>
              pane.open({
                kind: 'code',
                title: language || t('pane.kind.code'),
                node: <pre className="prose-chat whitespace-pre-wrap text-sm">{code}</pre>,
              })
            }
            aria-label={t('chat.open_in_pane')}
          >
            <IconPanel size={14} />
          </button>
        </Tooltip>
      </div>
      <pre {...props} />
    </div>
  );
}

/** Streamed markdown: GFM tables/lists, highlighted fenced code, links in a new tab. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat" dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
