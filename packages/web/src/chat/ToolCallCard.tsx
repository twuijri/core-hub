/**
 * The tools a turn used, beside the reply rather than inside it.
 *
 * Owner decision, 2026-09-23: tools are machinery, so they sit **outside** the agent's
 * bubble, and they take as little room as they can.
 *
 * - **While the run is alive**, the last four calls are shown as one-line rows, so what
 *   the agent is doing *now* is visible without the transcript turning into a log. The
 *   earlier ones are one click away.
 * - **When the run ends**, the whole group folds into one line — how many, which tools,
 *   and whether any failed — and opens on a click.
 *
 * Each call opens to what it was given and what it returned, when the agent sent either.
 * Hermes's run stream carries neither a result nor its arguments beyond a one-line preview
 * (`tool.completed` is a name, a duration and an error flag), so for Hermes a row is just
 * the row: an empty "No output" box under every call said nothing and took the space.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { usePane } from '../shell/pane.js';
import type { ToolCall } from '../types.js';
import { Badge, type BadgeTone } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { IconCheck, IconChevron, IconPanel, IconTool } from '../ui/icons.js';

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

/** How many calls a live run shows before "earlier" folds the rest away. */
export const LIVE_WINDOW = 4;

/** The arguments worth showing: not the ones that only repeat the preview line. */
function argumentsOf(call: ToolCall): string | null {
  const args = call.arguments;
  if (!args) return null;
  const keys = Object.keys(args);
  if (keys.length === 0) return null;
  if (keys.length === 1 && keys[0] === 'preview' && args.preview === call.preview) return null;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return null;
  }
}

function ToolRow({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  const pane = usePane();
  const output = call.output ?? '';
  const args = argumentsOf(call);
  const head = (
    <>
      <IconTool size={12} />
      <span className="tool-name">{call.name}</span>
      {call.preview && (
        <span className="tool-preview" dir="auto">
          {call.preview}
        </span>
      )}
      {call.status === 'succeeded' ? (
        <span className="tool-ok" aria-label={t('tool.status.succeeded')}>
          <IconCheck size={12} />
        </span>
      ) : (
        <Badge tone={STATUS_TONE[call.status] ?? 'neutral'} dot={call.status === 'running'}>
          {t(`tool.status.${call.status}`)}
        </Badge>
      )}
      {call.duration_ms !== null && (
        <span className="tool-time">{formatDuration(call.duration_ms)}</span>
      )}
    </>
  );

  // Nothing to open: a row, not a disclosure with an empty inside.
  if (!output && !args) {
    return (
      <div className="tool-row" data-testid="tool-call" data-status={call.status}>
        <div className="tool-head">{head}</div>
      </div>
    );
  }
  return (
    <details className="tool-row" data-testid="tool-call" data-status={call.status}>
      <summary className="tool-head">{head}</summary>
      <div className="tool-body">
        {args && (
          <>
            <p className="tool-label">{t('tool.arguments')}</p>
            <pre className="tool-output" dir="ltr">
              {args}
            </pre>
          </>
        )}
        {output && (
          <>
            <p className="tool-label">{t('tool.result')}</p>
            <pre className="tool-output" dir="ltr">
              {output}
              {call.output_truncated && <span className="text-faint"> …{t('tool.truncated')}</span>}
            </pre>
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
          </>
        )}
      </div>
    </details>
  );
}

export function ToolCalls({ calls, live }: { calls: readonly ToolCall[]; live: boolean }) {
  const { t } = useI18n();
  const [earlier, setEarlier] = useState(false);
  if (calls.length === 0) return null;

  const busy = calls.some(
    (call) => call.status === 'running' || call.status === 'awaiting_approval',
  );
  if (live || busy) {
    const hidden = earlier ? 0 : Math.max(0, calls.length - LIVE_WINDOW);
    return (
      <section className="tool-group" data-testid="tool-group" data-live="true">
        {hidden > 0 && (
          <button
            type="button"
            className="tool-earlier"
            onClick={() => setEarlier(true)}
            data-testid="tool-group-earlier"
          >
            {t('tool.earlier', { count: hidden })}
          </button>
        )}
        <div className="tool-list">
          {calls.slice(hidden).map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </div>
      </section>
    );
  }

  const names = [...new Set(calls.map((call) => call.name))];
  const failed = calls.filter((call) => call.status === 'failed').length;
  return (
    <details className="tool-group" data-testid="tool-group" data-live="false">
      <summary className="tool-group-summary" data-testid="tool-group-summary">
        <IconChevron size={12} className="tool-group-caret" />
        <IconTool size={14} />
        <span className="tool-group-count">{t('tool.count', { count: calls.length })}</span>
        <span className="tool-group-names" dir="ltr">
          {names.join(' · ')}
        </span>
        {failed > 0 ? (
          <Badge tone="danger">{t('tool.failed_count', { count: failed })}</Badge>
        ) : (
          <span className="tool-ok" aria-label={t('tool.status.succeeded')}>
            <IconCheck size={12} />
          </span>
        )}
      </summary>
      <div className="tool-list">
        {calls.map((call) => (
          <ToolRow key={call.id} call={call} />
        ))}
      </div>
    </details>
  );
}
