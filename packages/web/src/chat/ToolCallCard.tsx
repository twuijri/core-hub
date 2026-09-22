/**
 * One tool event, folded into the agent's turn.
 *
 * It sits on the raised surface rather than the agent's own, so machinery does not read as
 * something the agent said, and it opens by itself only when it failed — a card that opens
 * on every call turns a transcript into a log.
 */
import { useI18n } from '../i18n/context.js';
import { usePane } from '../shell/pane.js';
import type { ToolCall } from '../types.js';
import { Badge, type BadgeTone } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { IconPanel, IconTool } from '../ui/icons.js';

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const STATUS_TONE: Record<ToolCall['status'], BadgeTone> = {
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  interrupted: 'warning',
  awaiting_approval: 'warning',
};

export function ToolCallCard({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  const pane = usePane();
  const output = call.output ?? '';
  return (
    <details className="tool-card" data-testid="tool-call" open={call.status === 'failed'}>
      <summary className="tool-head">
        <IconTool size={14} />
        <span className="tool-name">{call.name}</span>
        {call.preview && (
          <span className="tool-preview" dir="auto">
            {call.preview}
          </span>
        )}
        <Badge tone={STATUS_TONE[call.status] ?? 'neutral'} dot={call.status === 'running'}>
          {t(`tool.status.${call.status}`)}
        </Badge>
        {call.duration_ms !== null && (
          <span className="tool-time">{formatDuration(call.duration_ms)}</span>
        )}
      </summary>
      <div className="tool-body">
        {output ? (
          <pre className="tool-output" dir="ltr">
            {output}
            {call.output_truncated && <span className="text-faint"> …{t('tool.truncated')}</span>}
          </pre>
        ) : (
          <p className="text-xs text-faint">{t('tool.no_output')}</p>
        )}
        {output && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            icon={<IconPanel size={14} />}
            onClick={() =>
              pane.open({
                kind: 'tool',
                title: `${call.name}${call.preview ? ` · ${call.preview}` : ''}`,
                node: (
                  <pre className="tool-output" dir="ltr">
                    {output}
                  </pre>
                ),
              })
            }
          >
            {t('chat.open_in_pane')}
          </Button>
        )}
      </div>
    </details>
  );
}
