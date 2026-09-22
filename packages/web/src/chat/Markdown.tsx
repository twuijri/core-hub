import { useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n/context.js';
import { usePane } from '../shell/pane.js';
import { IconCheck, IconCopy, IconPanel } from '../ui/icons.js';
import { Button, useToast } from '../ui/index.js';

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
  const toast = useToast();
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
      // The tick on the button is easy to miss when the pointer has already moved on.
      toast({ title: t('chat.copied'), tone: 'success', durationMs: 2000 });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: the code is still selectable.
    }
  };
  return (
    <div className="code-block" dir="ltr">
      <div className="code-tools">
        {language && <span className="code-lang">{language}</span>}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          tooltip={t('chat.copy_code')}
          aria-label={t('chat.copy_code')}
          icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          onClick={() => void copy()}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          tooltip={t('chat.open_in_pane')}
          aria-label={t('chat.open_in_pane')}
          icon={<IconPanel size={14} />}
          onClick={() =>
            pane.open({
              kind: 'code',
              title: language || t('pane.kind.code'),
              node: <pre className="prose-chat whitespace-pre-wrap text-sm">{code}</pre>,
            })
          }
        />
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
