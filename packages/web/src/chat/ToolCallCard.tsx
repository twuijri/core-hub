import { useI18n } from '../i18n/context.js';
import { usePane } from '../shell/pane.js';
import type { ToolCall } from '../types.js';
import { IconPanel, IconTool } from '../ui/icons.js';

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const STATUS_TONE: Record<ToolCall['status'], string> = {
  running: 'bg-info-soft text-info-soft-text',
  succeeded: 'bg-success-soft text-success-soft-text',
  failed: 'bg-danger-soft text-danger-soft-text',
  interrupted: 'bg-warning-soft text-warning-soft-text',
  awaiting_approval: 'bg-warning-soft text-warning-soft-text',
};

/** One tool event, folded into the assistant message; output opens inline or in the pane. */
export function ToolCallCard({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  const pane = usePane();
  const output = call.output ?? '';
  return (
    <details
      className="card my-2 p-0 text-sm"
      data-testid="tool-call"
      open={call.status === 'failed'}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <IconTool size={16} />
        <span className="font-mono text-xs">{call.name}</span>
        {call.preview && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" dir="auto">
            {call.preview}
          </span>
        )}
        <span className={`chip ${STATUS_TONE[call.status]}`}>
          {t(`tool.status.${call.status}`)}
        </span>
        {call.duration_ms !== null && (
          <span className="text-xs text-faint">{formatDuration(call.duration_ms)}</span>
        )}
      </summary>
      <div className="border-t border-line px-3 py-2">
        {output ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs" dir="ltr">
            {output}
            {call.output_truncated && <span className="text-faint"> …{t('tool.truncated')}</span>}
          </pre>
        ) : (
          <p className="text-xs text-faint">{t('tool.no_output')}</p>
        )}
        {output && (
          <button
            type="button"
            className="btn btn-ghost mt-2 text-xs"
            onClick={() =>
              pane.open({
                kind: 'tool',
                title: `${call.name}${call.preview ? ` · ${call.preview}` : ''}`,
                node: (
                  <pre className="whitespace-pre-wrap font-mono text-xs" dir="ltr">
                    {output}
                  </pre>
                ),
              })
            }
          >
            <IconPanel size={14} /> {t('chat.open_in_pane')}
          </button>
        )}
      </div>
    </details>
  );
}
