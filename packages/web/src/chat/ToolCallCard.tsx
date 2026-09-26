/**
 * The tools a turn used, beside the reply rather than inside it.
 *
 * Owner decision, 2026-09-23: tools are machinery, so they sit **outside** the agent's
 * bubble, and they take as little room as they can.
 *
 * - **While the run is alive**, the last four calls are shown as one-line rows, so what
 *   the agent is doing *now* is visible without the transcript turning into a log. A call
 *   still running and a call that failed stay in view whatever the window (owner,
 *   2026-09-26). The earlier ones are one click away, and the same click folds them back;
 *   a new step slides in and the oldest one in view fades.
 * - **When the run ends**, the whole group folds into one line — how many steps, how long,
 *   how many failed and the latest tools — and opens on a click. The rule itself is the pure
 *   `toolActivity` (toolActivity.ts), which the iOS and Android apps repeat with a window of 2.
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
import { IconCheck, IconChevron, IconFolder, IconPanel, IconTool } from '../ui/icons.js';
import { useOpenFile, useSessionFilesOptional } from '../files/context.js';
import { filesOfToolCall } from '../files/kinds.js';
import { pluralOf } from '../files/changes.js';
import { durationParts, toolActivity, WEB_LIVE_WINDOW } from './toolActivity.js';

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

/** How many calls a live run shows before "earlier" folds the rest away (toolActivity.ts). */
export const LIVE_WINDOW = WEB_LIVE_WINDOW;

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

/**
 * The files this call wrote or named, as links that open them beside the chat (decision
 * §48). Inside the row's `<summary>` a click must not also fold the row.
 */
function ToolFiles({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  const files = useSessionFilesOptional();
  const open = useOpenFile();
  if (!files || !open) return null;
  const linked = filesOfToolCall(files.files, call.id);
  if (linked.length === 0) return null;
  return (
    <>
      {linked.map((file) => (
        <button
          key={file.key}
          type="button"
          className="tool-file"
          aria-label={t('files.open', { name: file.name })}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            open(file.key);
          }}
          data-testid="tool-file-link"
        >
          <IconFolder size={12} />
          <span dir="auto">{file.name}</span>
        </button>
      ))}
    </>
  );
}

function ToolRow({ call }: { call: ToolCall }) {
  const { t } = useI18n();
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
      <ToolFiles call={call} />
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
      <ToolCallBody call={call} />
    </details>
  );
}

/**
 * What a call was given and what it returned — the inside of a tool row, and of a tool step
 * on the Trajectory tab. Renders nothing when the agent sent neither.
 */
export function ToolCallBody({ call }: { call: ToolCall }) {
  const { t } = useI18n();
  const pane = usePane();
  const output = call.output ?? '';
  const args = argumentsOf(call);
  if (!output && !args) return null;
  return (
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
  );
}

/**
 * The folded row's time, "42s" or "1m 05s", in the UI language. The group sits in the
 * message's fixed left-to-right frame, so every label in the UI language isolates itself
 * (`dir="auto"`): «6 خطوات» reads right to left, the tool names stay left to right.
 */
function SummaryTime({ ms }: { ms: number }) {
  const { t } = useI18n();
  const { minutes, seconds } = durationParts(ms);
  return (
    <span className="tool-time" dir="auto" data-testid="tool-group-time">
      {minutes > 0
        ? t('tool.activity.minutes', { minutes, seconds: String(seconds).padStart(2, '0') })
        : t('tool.activity.seconds', { seconds })}
    </span>
  );
}

export function ToolCalls({ calls, live }: { calls: readonly ToolCall[]; live: boolean }) {
  const { t, language } = useI18n();
  const [earlier, setEarlier] = useState(false);
  if (calls.length === 0) return null;

  const activity = toolActivity(calls, live);
  const { summary } = activity;
  if (!activity.folded) {
    const extra = activity.hidden;
    const shown = earlier ? calls : activity.visible;
    return (
      <section className="tool-group" data-testid="tool-group" data-live="true">
        {extra > 0 && (
          // One toggle in one place: it opens the earlier calls and folds them back,
          // as the finished group's line does (owner, 2026-09-23).
          <button
            type="button"
            className="tool-earlier"
            aria-expanded={earlier}
            onClick={() => setEarlier((open) => !open)}
            data-testid="tool-group-earlier"
          >
            <IconChevron size={12} className="tool-group-caret" />
            <span key={earlier ? 'open' : extra} className="tool-earlier-count" dir="auto">
              {earlier
                ? t('tool.activity.hide_earlier')
                : t(`tool.activity.earlier.${pluralOf(language, extra)}`, { count: extra })}
            </span>
          </button>
        )}
        <div className="tool-list">
          {shown.map((call, index) => (
            <div
              key={call.id}
              className="tool-step"
              // The oldest step still in view fades while the newer ones arrive under it.
              data-fading={!earlier && extra > 0 && index === 0 && call.status !== 'failed'}
            >
              <ToolRow call={call} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <details className="tool-group" data-testid="tool-group" data-live="false">
      <summary className="tool-group-summary" data-testid="tool-group-summary">
        <IconChevron size={12} className="tool-group-caret" />
        <IconTool size={14} />
        <span className="tool-group-count" dir="auto">
          {t(`tool.activity.steps.${pluralOf(language, summary.count)}`, {
            count: summary.count,
          })}
        </span>
        {summary.durationMs !== null && <SummaryTime ms={summary.durationMs} />}
        {summary.failed > 0 && (
          <Badge tone="danger">
            <span dir="auto" data-testid="tool-group-failed">
              {t(`tool.activity.failed.${pluralOf(language, summary.failed)}`, {
                count: summary.failed,
              })}
            </span>
          </Badge>
        )}
        <span className="tool-group-names" dir="ltr">
          {summary.names.map((name) => (
            <span key={name} className="tool-chip">
              {name}
            </span>
          ))}
        </span>
        {summary.failed === 0 && (
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
