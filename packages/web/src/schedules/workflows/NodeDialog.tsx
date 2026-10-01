/**
 * A step, a connection or a trigger opened from the canvas, each in its own dialog (owner,
 * 2026-09-29: "like n8n"): the step's form with room to breathe, and beside it what the step
 * reads and what it said the last time the workflow ran. The canvas stays a drawing.
 *
 * The forms are the ones the side panel had (`StepPanel.tsx`), unchanged: every field, the
 * "Test this step", "Run from this step" and "Delete step". Closing (✕, Escape, "Back to
 * canvas") keeps every change in the drawing; nothing is saved until Save.
 */
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/context.js';
import { Badge, Button, Dialog, type BadgeTone } from '../../ui/index.js';
import { StepPanel, readableOutput } from './StepPanel.js';
import {
  latestSteps,
  nodeStates,
  upstreamOf,
  type Action,
  type Draft,
  type NodeRunState,
  type WfEdge,
  type WfNode,
  type WorkflowIssue,
} from './model.js';
import type { WorkflowRunRow } from './queries.js';
import type { Agent, Model } from '../../types.js';

const STATE_TONE: Record<NodeRunState, BadgeTone> = {
  idle: 'neutral',
  waiting: 'warning',
  running: 'info',
  done: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

export function NodeDialog({
  draft,
  node,
  edge,
  onClose,
  dispatch,
  agents,
  models,
  issues,
  problems,
  onRunFrom,
  runFromBusy,
  profile,
  workflowId,
  lastRun,
  runInput,
}: {
  draft: Draft;
  node: WfNode | null;
  edge: WfEdge | null;
  onClose: () => void;
  dispatch: (action: Action) => void;
  agents: readonly Agent[];
  models: readonly Model[];
  issues: readonly WorkflowIssue[];
  problems: readonly WorkflowIssue[];
  onRunFrom: (nodeId: string) => void;
  runFromBusy: boolean;
  profile: string;
  workflowId: string | null;
  /** The workflow's newest run: what each step said, shown beside the form. */
  lastRun: WorkflowRunRow | null;
  /** What "Run" sends as `{{input}}`. */
  runInput: string;
}) {
  const { t } = useI18n();
  const open = node !== null || edge !== null;
  const title = node
    ? `${node.send ? t('workflows.send.title') : t(`workflows.kinds.${node.kind}`)} · ${node.title || node.id}`
    : t('workflows.editor.edge_title');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={<span dir="auto">{title}</span>}
      size={node ? 'xl' : 'md'}
      closeLabel={t('ui.close')}
      testId={node ? 'workflow-node-dialog' : 'workflow-edge-dialog'}
      footer={
        <Button variant="secondary" onClick={onClose} data-testid="workflow-dialog-done">
          {t('workflows.nodes.back_to_canvas')}
        </Button>
      }
    >
      {open && (
        <div
          className={
            node ? 'grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]' : 'flex flex-col gap-3'
          }
        >
          <div className="min-w-0">
            <StepPanel
              draft={draft}
              node={node}
              edge={edge}
              dispatch={dispatch}
              agents={agents}
              models={models}
              issues={issues}
              problems={problems}
              onRunFrom={onRunFrom}
              runFromBusy={runFromBusy}
              profile={profile}
              workflowId={workflowId}
              lastRunId={lastRun?.id ?? null}
            />
          </div>
          {node && <StepPreview draft={draft} node={node} lastRun={lastRun} runInput={runInput} />}
        </div>
      )}
    </Dialog>
  );
}

/** What the step reads (the input, the steps before it) and what it said last time. */
function StepPreview({
  draft,
  node,
  lastRun,
  runInput,
}: {
  draft: Draft;
  node: WfNode;
  lastRun: WorkflowRunRow | null;
  runInput: string;
}) {
  const { t } = useI18n();
  const steps = lastRun ? latestSteps(lastRun) : new Map();
  const state = lastRun ? (nodeStates(draft, lastRun).get(node.id) ?? null) : null;
  const before = upstreamOf(draft, node.id);
  const own = steps.get(node.id);
  return (
    <aside
      className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-2 p-3"
      aria-label={t('workflows.nodes.preview')}
      data-testid="workflow-node-preview"
    >
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
          {t('workflows.nodes.input')}
        </h3>
        <Variable path="{{input}}" value={runInput.trim() || null} />
        <Variable path="{{trigger}}" value={null} note={t('workflows.nodes.trigger_value')} />
        {before.map((step) => (
          <Variable
            key={step.id}
            path={`{{steps.${step.id}.output}}`}
            label={step.title || step.id}
            value={(steps.get(step.id)?.output as string | null | undefined) ?? null}
          />
        ))}
      </section>
      <section className="flex flex-col gap-1.5" data-testid="workflow-node-last-output">
        <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
          {t('workflows.nodes.output')}
          {state && (
            <Badge tone={STATE_TONE[state]} dot>
              {t(`workflows.states.${state}`)}
            </Badge>
          )}
        </h3>
        {own?.error ? (
          <p className="text-xs text-danger-soft-text" dir="auto">
            {own.error}
          </p>
        ) : own?.output ? (
          <Output text={own.output} />
        ) : (
          <p className="text-xs text-muted">
            {lastRun ? t('workflows.nodes.no_output') : t('workflows.nodes.no_run')}
          </p>
        )}
      </section>
    </aside>
  );
}

function Variable({
  path,
  label,
  value,
  note,
}: {
  path: string;
  label?: string;
  value: string | null;
  note?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-raised px-2 py-1.5">
      {/* A long step id or title wraps to its own line and truncates there, inside the card
          (owner, 2026-10-01: the label ran out of the box). */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
        <code dir="ltr" className="min-w-0 max-w-full truncate">
          {path}
        </code>
        {label && (
          <span className="min-w-0 max-w-full truncate text-muted" dir="auto">
            {label}
          </span>
        )}
      </span>
      <span className="line-clamp-3 text-xs text-muted [overflow-wrap:anywhere]" dir="auto">
        {value ?? note ?? t('workflows.nodes.no_value')}
      </span>
    </div>
  );
}

function Output({ text }: { text: string }) {
  const shown = readableOutput(text);
  return (
    <div
      className={`max-h-72 min-w-0 overflow-auto whitespace-pre-wrap rounded-md bg-raised p-2 text-xs [overflow-wrap:anywhere]${shown.json ? ' font-mono' : ''}`}
      dir={shown.json ? 'ltr' : 'auto'}
    >
      {shown.text}
    </div>
  );
}
