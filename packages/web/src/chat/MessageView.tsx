import { useI18n } from '../i18n/context.js';
import type { Message } from '../types.js';
import { Markdown } from './Markdown.js';
import { ToolCallCard } from './ToolCallCard.js';
import { textOf } from './transcript.js';

function ReasoningFold({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useI18n();
  return (
    <details
      className="my-2 rounded-md border border-line px-3 py-1 text-sm text-muted"
      data-testid="reasoning"
    >
      <summary className="cursor-pointer">
        {streaming ? t('chat.thinking') : t('chat.reasoning')}
      </summary>
      <p className="mt-2 whitespace-pre-wrap" dir="auto">
        {text}
      </p>
    </details>
  );
}

function Attachments({ message }: { message: Message }) {
  const { t } = useI18n();
  const blocks = message.content.filter((b) => b.type !== 'text');
  if (blocks.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {blocks.map((block, i) => (
        <li key={i} className="chip">
          {block.type === 'location'
            ? `${t('chat.location')} ${block.latitude.toFixed(4)}, ${block.longitude.toFixed(4)}`
            : (block.name ?? block.type)}
        </li>
      ))}
    </ul>
  );
}

export function MessageView({
  message,
  showReasoning,
}: {
  message: Message;
  showReasoning: boolean;
}) {
  const { t } = useI18n();
  const text = textOf(message);
  if (message.role === 'user' || message.role === 'command') {
    return (
      <article
        className="my-3 flex justify-end"
        data-testid="message-user"
        data-role={message.role}
      >
        <div
          className={`max-w-[85%] rounded-xl bg-bubble px-4 py-2 text-bubble-text ${message.role === 'command' ? 'font-mono text-sm' : ''}`}
        >
          <p className="whitespace-pre-wrap" dir="auto">
            {text}
          </p>
          <Attachments message={message} />
        </div>
      </article>
    );
  }
  if (message.role === 'system') {
    return (
      <article className="my-2 text-center text-xs text-muted" data-testid="message-system">
        <span dir="auto">{text}</span>
      </article>
    );
  }
  const streaming = message.status === 'streaming';
  return (
    <article className="my-4" data-testid="message-assistant" data-status={message.status}>
      <header className="mb-1 flex items-center gap-2 text-xs text-muted">
        <span className="font-medium text-ink" dir="auto">
          {message.author.name || t('chat.assistant')}
        </span>
        {streaming && <span className="chip">{t('chat.streaming')}</span>}
        {message.status === 'failed' && (
          <span className="chip bg-danger-soft text-danger-soft-text">{t('chat.failed')}</span>
        )}
        {message.status === 'interrupted' && (
          <span className="chip bg-warning-soft text-warning-soft-text">
            {t('chat.interrupted')}
          </span>
        )}
      </header>
      {showReasoning && message.reasoning?.text && (
        <ReasoningFold text={message.reasoning.text} streaming={streaming && !text} />
      )}
      {message.tool_calls.map((call) => (
        <ToolCallCard key={call.id} call={call} />
      ))}
      {text ? <Markdown text={text} /> : streaming ? <span className="text-faint">…</span> : null}
      {message.usage && (
        <p className="mt-1 text-xs text-faint">
          {t('chat.usage', {
            input: message.usage.input_tokens,
            output: message.usage.output_tokens,
          })}
          {message.usage.cost
            ? ` · ${message.usage.cost.amount} ${message.usage.cost.currency}`
            : ''}
        </p>
      )}
    </article>
  );
}
