import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n/context.js';
import { usePane } from '../shell/pane.js';
import { IconCheck, IconCopy, IconPanel } from '../ui/icons.js';
import { Button, useToast } from '../ui/index.js';
import { rehypeMarkQuery } from './anchor.js';
import { useOpenFile, useSessionFilesOptional } from '../files/context.js';
import { fileForMention } from '../files/kinds.js';
import { rehypeFileMentions, type Mention } from '../files/mentions.js';
import type { SessionFile } from '../types.js';

type Plugins = NonNullable<Options['rehypePlugins']>;
const HIGHLIGHT: Plugins[number] = [rehypeHighlight, { detect: false, ignoreMissing: true }];

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

/**
 * The words a reply may use for the conversation's files: each file's path, and its bare
 * name when no other file has it.
 */
export function mentionsOf(files: readonly SessionFile[]): Mention[] {
  const names = new Map<string, number>();
  for (const file of files) names.set(file.name, (names.get(file.name) ?? 0) + 1);
  const out: Mention[] = [];
  for (const file of files) {
    if (file.path) out.push({ word: file.path, key: file.key });
    if (names.get(file.name) === 1 && file.name !== file.path)
      out.push({ word: file.name, key: file.key });
  }
  return out;
}

function safeDecode(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** A name that opens the file beside the chat. */
function FileLink({
  fileKey,
  children,
  code,
}: {
  fileKey: string;
  children: ReactNode;
  code?: boolean;
}) {
  const open = useOpenFile();
  return (
    <button
      type="button"
      className={code ? 'file-link file-link-code' : 'file-link'}
      data-testid="file-mention"
      onClick={() => open?.(fileKey)}
    >
      {code ? <code>{children}</code> : children}
    </button>
  );
}

/**
 * Streamed markdown: GFM tables/lists, highlighted fenced code, links in a new tab.
 * `mark` wraps each occurrence of a searched word in `<mark>` (anchor.ts), after the
 * code has been highlighted, so neither changes the other. Inside a conversation, a word
 * or an inline code span that names one of its files opens that file (decision §48).
 */
export function Markdown({ text, mark }: { text: string; mark?: string | null | undefined }) {
  const files = useSessionFilesOptional();
  const list = files?.files;
  const mentions = useMemo(() => (list ? mentionsOf(list) : []), [list]);
  const rehypePlugins = useMemo<Plugins>(() => {
    const plugins: Plugins = [];
    if (mentions.length > 0)
      plugins.push([rehypeFileMentions, { mentions }] as unknown as Plugins[number]);
    plugins.push(HIGHLIGHT);
    if (mark) plugins.push([rehypeMarkQuery, { query: mark }] as unknown as Plugins[number]);
    return plugins;
  }, [mark, mentions]);
  return (
    <div className="prose-chat" dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{
          pre: CodeBlock,
          a: ({ href, children, ...rest }) => {
            const key = (rest as Record<string, unknown>)['data-file-key'];
            if (typeof key === 'string') return <FileLink fileKey={key}>{children}</FileLink>;
            // A link to a file of the conversation (`[the report](report.html)`) opens it.
            const linked =
              list && href && !/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(href)
                ? fileForMention(list, safeDecode(href))
                : null;
            if (linked) return <FileLink fileKey={linked.key}>{children}</FileLink>;
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          code: ({ className, children, node: _node, ...rest }) => {
            const inline = !className && !textOfChildren(children).includes('\n');
            const linked = inline && list ? fileForMention(list, textOfChildren(children)) : null;
            if (linked)
              return (
                <FileLink fileKey={linked.key} code>
                  {children}
                </FileLink>
              );
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
