/**
 * One workflow, drawn: the canvas, the palette, the selected step's form, the hub's live
 * check, Save and Run — and its runs, shown on the same canvas.
 *
 * Opened from the Workflows section of the Schedules page (`?section=workflows&workflow=<id
 * or new>&profile=<slug>`, and `&run=<id>` for a run), so it is part of the Schedules
 * destination and adds no page to the navigation map. The screen's code is loaded only when
 * a workflow is opened (`SchedulesScreen.tsx`, `lazy`).
 *
 * The drawing is checked by the hub as it changes (`schedules.validateWorkflow`, the same
 * rule saving applies); its findings are marked on the steps and connections they name. A
 * run shows each step's state, what it produced, the connections it went along, and the two
 * answers on a step that waits for a person — the same `respondApproval` as everywhere.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/context.js';
import { describeError } from '../../auth/client.js';
import { useI18n } from '../../i18n/context.js';
import { ProfileBadge } from '../../shell/ProfileBadge.js';
import { useManyProfiles } from '../../shell/profiles.js';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Notice,
  Select,
  Skeleton,
  TabPanel,
  Tabs,
  type BadgeTone,
} from '../../ui/index.js';
import { IconArrowStart, IconGauge, IconPlus } from '../../ui/icons.js';
import { RunLimitsDialog, WorkflowLimitsForm, type Limits } from '../WorkflowLimits.js';
import { ApprovalGate } from '../ScheduleRuns.js';
import { WorkflowCanvas, type CanvasIssues } from './WorkflowCanvas.js';
import { IssueList, StepPanel, StepRunPanel } from './StepPanel.js';
import {
  NODE_KINDS,
  emptyDraft,
  fromWorkflow,
  initialState,
  issuesByTarget,
  latestSteps,
  nodeStates,
  reducer,
  takenEdges,
  type Selection,
  type Validation,
  type WorkflowIssue,
} from './model.js';
import {
  useProfileAgents,
  useProfileModels,
  useWorkflow,
  useWorkflowRun,
  useWorkflowRuns,
  useWorkflowWrites,
  validateDraft,
  type WorkflowRunRow,
} from './queries.js';

const CHECK_DELAY_MS = 350;

const RUN_TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  waiting: 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export default function WorkflowEditor({
  workflowId,
  profile,
  runId,
  onBack,
  onSaved,
  onShowRun,
}: {
  /** `null` for a workflow that is not saved yet. */
  workflowId: string | null;
  profile: string;
  /** The run shown, or `null` for the drawing itself. */
  runId: string | null;
  onBack: () => void;
  /** A new workflow was saved: its address changes to its id. */
  onSaved: (id: string) => void;
  /**
   * Show a run (`'latest'` for the newest), or the drawing (`null`). `workflowId` is the
   * workflow's id when it was saved just now, so its address changes in the same step.
   */
  onShowRun: (runId: string | 'latest' | null, workflowId?: string) => void;
}) {
  const { t, language } = useI18n();
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const many = useManyProfiles();
  const workflow = useWorkflow(profile, workflowId);
  const runs = useWorkflowRuns(profile, workflowId);
  const agents = useProfileAgents(profile);
  const models = useProfileModels(profile);
  const writes = useWorkflowWrites();
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(emptyDraft()));
  const [validation, setValidation] = useState<Validation | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [runLimitsOpen, setRunLimitsOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);

  // The saved drawing, once, when it arrives — never over what someone is drawing.
  useEffect(() => {
    if (!workflowId || !workflow.data || loadedFor.current === workflowId) return;
    loadedFor.current = workflowId;
    dispatch({ type: 'load', draft: fromWorkflow(workflow.data) });
  }, [workflowId, workflow.data]);

  // The hub's check, a moment after each change.
  const { draft } = state;
  useEffect(() => {
    let live = true;
    setChecking(true);
    const timer = setTimeout(() => {
      validateDraft(client, profile, draft)
        .then((result) => {
          if (!live) return;
          setValidation(result);
          setCheckError(null);
        })
        .catch((error: unknown) => {
          if (live) setCheckError(describeError(error, t));
        })
        .finally(() => {
          if (live) setChecking(false);
        });
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `t` and `client` do not change what is checked.
  }, [draft, profile]);

  const found = useMemo(() => issuesByTarget(validation), [validation]);
  const problems = validation?.problems ?? [];
  const canvasIssues: CanvasIssues = useMemo(
    () => ({
      nodes: found.nodes,
      edges: found.edges,
      problems: new Set(
        problems.flatMap((p) => [p.node_id, p.edge_id]).filter((id): id is string => !!id),
      ),
    }),
    [found, problems],
  );

  const saving = writes.create.isPending || writes.update.isPending;
  const nameMissing = draft.name.trim() === '';
  const blocked = problems.length > 0;

  /** Save what is drawn; the id it is saved under. */
  const save = async (): Promise<string | null> => {
    setMessage(null);
    if (nameMissing || blocked) return null;
    if (workflowId) {
      await writes.update.mutateAsync({ profile, id: workflowId, draft });
      dispatch({ type: 'saved' });
      return workflowId;
    }
    const created = await writes.create.mutateAsync({ profile, draft });
    loadedFor.current = created.id;
    dispatch({ type: 'saved' });
    onSaved(created.id);
    return created.id;
  };

  const runFrom = async (startNodeIds: string[] | null, limits?: Limits) => {
    setMessage(null);
    const id = workflowId && !state.dirty ? workflowId : await save().catch(() => null);
    if (!id) return;
    const started = await writes.run.mutateAsync({
      profile,
      id,
      input: input.trim() || null,
      startNodeIds,
      ...(limits ? { limits } : {}),
    });
    setRunLimitsOpen(false);
    setMessage(t('workflows.started', { name: draft.name }));
    onShowRun(started.workflow_run_id, id);
  };

  const runError = writes.run.error ?? writes.create.error ?? writes.update.error;
  const selectedNode =
    state.selected?.type === 'node'
      ? (draft.nodes.find((node) => node.id === state.selected!.id) ?? null)
      : null;
  const selectedEdge =
    state.selected?.type === 'edge'
      ? (draft.edges.find((edge) => edge.id === state.selected!.id) ?? null)
      : null;
  const selectedIssues: WorkflowIssue[] = selectedNode
    ? (found.nodes.get(selectedNode.id) ?? [])
    : selectedEdge
      ? (found.edges.get(selectedEdge.id) ?? [])
      : [];
  const pick = (issue: WorkflowIssue) =>
    dispatch({
      type: 'select',
      selection: issue.node_id
        ? { type: 'node', id: issue.node_id }
        : issue.edge_id
          ? { type: 'edge', id: issue.edge_id }
          : null,
    });

  if (workflowId && workflow.isPending) return <Skeleton height="30rem" radius="md" />;
  if (workflowId && workflow.isError) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} />
        <Notice tone="danger">{describeError(workflow.error, t)}</Notice>
      </div>
    );
  }

  const mode = runId ? 'runs' : 'edit';
  const when = (at: string | null) =>
    at
      ? new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(Date.parse(at))
      : '';

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="workflow-editor"
      data-workflow-id={workflowId ?? 'new'}
    >
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <BackButton onBack={onBack} />
            {many && <ProfileBadge profile={profile} testId="workflow-profile" />}
            <span className="ms-auto flex items-center gap-2 text-xs" aria-live="polite">
              {state.dirty && <Badge tone="warning">{t('workflows.editor.unsaved')}</Badge>}
              <CheckStatus checking={checking} validation={validation} error={checkError} />
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('workflows.editor.name')} className="min-w-60 flex-1">
              {(props) => (
                <Input
                  {...props}
                  value={draft.name}
                  onChange={(event) => dispatch({ type: 'rename', name: event.target.value })}
                  placeholder={t('workflows.untitled')}
                  dir="auto"
                  data-testid="workflow-name"
                />
              )}
            </Field>
            <Button
              variant="primary"
              loading={saving}
              disabled={nameMissing || blocked || (!state.dirty && !!workflowId)}
              tooltip={
                nameMissing
                  ? t('workflows.editor.name_required')
                  : blocked
                    ? t('workflows.editor.save_blocked')
                    : undefined
              }
              onClick={() => void save().catch(() => undefined)}
              data-testid="workflow-save"
            >
              {t('common.save')}
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field
              label={t('workflows.editor.run_input')}
              hint={t('workflows.editor.run_input_hint', { input: '{{input}}' })}
              className="min-w-60 flex-1"
            >
              {(props) => (
                <Input
                  {...props}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  dir="auto"
                  data-testid="workflow-run-input"
                />
              )}
            </Field>
            <Button
              variant="secondary"
              loading={writes.run.isPending}
              disabled={nameMissing || blocked || draft.nodes.length === 0}
              tooltip={state.dirty || !workflowId ? t('workflows.editor.save_first') : undefined}
              onClick={() => void runFrom(null).catch(() => undefined)}
              data-testid="workflow-run"
            >
              {t('workflows.run')}
            </Button>
            <Button
              variant="secondary"
              iconOnly
              icon={<IconGauge size={16} />}
              aria-label={t('schedules.limits.run_with')}
              tooltip={t('schedules.limits.run_with')}
              disabled={nameMissing || blocked || draft.nodes.length === 0}
              onClick={() => setRunLimitsOpen(true)}
              data-testid="workflow-run-with-limits"
            />
          </div>
          {runLimitsOpen && (
            <RunLimitsDialog
              open
              limits={(workflow.data as { limits?: Limits } | undefined)?.limits}
              busy={writes.run.isPending}
              onClose={() => setRunLimitsOpen(false)}
              onRun={(limits) => void runFrom(null, limits).catch(() => undefined)}
            />
          )}
          {nameMissing && state.dirty && (
            <p className="text-xs text-muted">{t('workflows.editor.name_required')}</p>
          )}
          {runError && <Notice tone="danger">{describeError(runError, t)}</Notice>}
          {message && !runError && <Notice tone="success">{message}</Notice>}
        </div>
      </Card>

      <Tabs
        value={mode}
        onValueChange={(next) => onShowRun(next === 'runs' ? 'latest' : null)}
        items={[
          { value: 'edit', label: t('workflows.editor.mode_edit') },
          { value: 'runs', label: t('workflows.editor.mode_runs'), disabled: !workflowId },
        ]}
        label={t('workflows.section')}
        testId="workflow-modes"
      >
        <TabPanel value="edit">
          {mode === 'edit' && (
            <div className="flex flex-col gap-3">
              <div
                className="flex flex-wrap items-center gap-2"
                role="toolbar"
                aria-label={t('workflows.editor.palette')}
                data-testid="workflow-palette"
              >
                <span className="text-xs font-medium text-muted">
                  {t('workflows.editor.palette')}
                </span>
                {NODE_KINDS.map((kind) => (
                  <Button
                    key={kind}
                    size="sm"
                    variant="secondary"
                    icon={<IconPlus size={14} />}
                    tooltip={t(`workflows.kind_hints.${kind}`)}
                    onClick={() =>
                      dispatch({
                        type: 'add',
                        kind,
                        title: t(`workflows.kinds.${kind}`),
                        agentId: agents.data?.[0]?.id ?? null,
                      })
                    }
                    data-testid={`workflow-add-${kind}`}
                  >
                    {t(`workflows.kinds.${kind}`)}
                  </Button>
                ))}
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <WorkflowCanvas
                  draft={draft}
                  selected={state.selected}
                  dispatch={dispatch}
                  readOnly={false}
                  issues={canvasIssues}
                  run={null}
                />
                <Card testId="workflow-side">
                  <StepPanel
                    draft={draft}
                    node={selectedNode}
                    edge={selectedEdge}
                    dispatch={dispatch}
                    agents={agents.data ?? []}
                    models={models.data ?? []}
                    issues={selectedIssues}
                    problems={problems}
                    onRunFrom={(id) => void runFrom([id]).catch(() => undefined)}
                    runFromBusy={writes.run.isPending}
                    settings={
                      <section
                        className="flex flex-col gap-2 border-t border-line pt-3"
                        data-testid="workflow-settings"
                      >
                        <h3 className="text-sm font-medium">{t('schedules.limits.title')}</h3>
                        {workflowId ? (
                          <WorkflowLimitsForm workflowId={workflowId} profile={profile} />
                        ) : (
                          <p className="text-xs text-muted">{t('schedules.limits.save_first')}</p>
                        )}
                      </section>
                    }
                  />
                </Card>
              </div>
              <IssueList
                issues={[...(validation?.problems ?? []), ...(validation?.warnings ?? [])]}
                problems={problems}
                t={t}
                onPick={pick}
              />
            </div>
          )}
        </TabPanel>
        <TabPanel value="runs">
          {mode === 'runs' && workflowId && (
            <RunView
              profile={profile}
              runId={runId}
              runs={runs.data ?? null}
              runsError={runs.error}
              saved={workflow.data ? fromWorkflow(workflow.data) : draft}
              onShowRun={onShowRun}
              when={when}
              onAnswered={() => void queryClient.invalidateQueries({ queryKey: ['schedules'] })}
            />
          )}
        </TabPanel>
      </Tabs>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<IconArrowStart size={14} />}
      onClick={onBack}
      data-testid="workflow-back"
    >
      {t('workflows.editor.back')}
    </Button>
  );
}

function CheckStatus({
  checking,
  validation,
  error,
}: {
  checking: boolean;
  validation: Validation | null;
  error: string | null;
}) {
  const { t } = useI18n();
  if (error)
    return <Badge tone="danger">{t('workflows.editor.check_failed', { message: error })}</Badge>;
  if (!validation) return checking ? <Badge>{t('workflows.editor.checking')}</Badge> : null;
  const problems = validation.problems.length;
  const warnings = validation.warnings.length;
  return (
    <span
      className="flex items-center gap-1"
      data-testid="workflow-check"
      data-valid={String(validation.valid)}
    >
      {problems > 0 && (
        <Badge tone="danger">{t('workflows.editor.problems', { count: problems })}</Badge>
      )}
      {warnings > 0 && (
        <Badge tone="warning">{t('workflows.editor.warnings', { count: warnings })}</Badge>
      )}
      {problems === 0 && <Badge tone="success">{t('workflows.editor.valid')}</Badge>}
    </span>
  );
}

/** A run on the canvas: each step's state, the connections taken, and a step's details. */
function RunView({
  profile,
  runId,
  runs,
  runsError,
  saved,
  onShowRun,
  when,
  onAnswered,
}: {
  profile: string;
  runId: string | null;
  runs: WorkflowRunRow[] | null;
  runsError: unknown;
  saved: ReturnType<typeof fromWorkflow>;
  onShowRun: (runId: string | 'latest' | null) => void;
  when: (at: string | null) => string;
  onAnswered: () => void;
}) {
  const { t } = useI18n();
  const writes = useWorkflowWrites();
  const wanted = runId === 'latest' ? (runs?.[0]?.id ?? null) : runId;
  const run = useWorkflowRun(profile, wanted);
  const [selected, setSelected] = useState<Selection>(null);
  const shown = run.data ?? null;
  const states = useMemo(() => (shown ? nodeStates(saved, shown) : new Map()), [saved, shown]);
  const taken = useMemo(
    () => (shown ? takenEdges(saved, shown) : new Set<string>()),
    [saved, shown],
  );
  const steps = useMemo(() => (shown ? latestSteps(shown) : new Map()), [shown]);
  const waitingStep = shown?.steps.find(
    (step) => step.status === 'waiting_approval' && step.approval_id,
  );

  // Open on the step that waits for a person, if there is one.
  useEffect(() => {
    if (waitingStep && selected === null) setSelected({ type: 'node', id: waitingStep.node_id });
  }, [waitingStep?.node_id]);

  if (runsError) return <Notice tone="danger">{String(runsError)}</Notice>;
  if (runs === null) return <Skeleton height="20rem" radius="md" />;
  if (runs.length === 0 && !wanted) {
    return (
      <p className="text-sm text-muted" data-testid="workflow-runs-empty">
        {t('workflows.editor.runs_empty')}
      </p>
    );
  }
  const node =
    selected?.type === 'node'
      ? (saved.nodes.find((each) => each.id === selected.id) ?? null)
      : null;
  const step = node ? (steps.get(node.id) ?? null) : null;
  const going = shown && ['queued', 'running', 'waiting'].includes(shown.status);
  const gateFor = (nodeId: string, compact: boolean) => {
    const waiting = steps.get(nodeId);
    if (!waiting || waiting.status !== 'waiting_approval' || !waiting.approval_id) return null;
    return (
      <ApprovalGate
        key={`${waiting.approval_id}-${compact}`}
        approvalId={waiting.approval_id}
        profile={profile}
        onAnswered={onAnswered}
        compact={compact}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="workflow-run-view" data-run-id={wanted ?? ''}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-60">
          <Field label={t('workflows.editor.run_pick')}>
            {() => (
              <Select
                value={wanted}
                onValueChange={(value) => onShowRun(value ?? 'latest')}
                options={runs.map((each) => ({
                  value: each.id,
                  label: t('workflows.editor.run_of', {
                    status: t(`schedules.run.status.${each.status}`),
                    at: when(each.started_at ?? each.finished_at),
                  }),
                }))}
                label={t('workflows.editor.run_pick')}
                testId="workflow-run-pick"
              />
            )}
          </Field>
        </div>
        {shown && (
          <Badge tone={RUN_TONE[shown.status] ?? 'neutral'} dot testId="workflow-run-state">
            {t(`schedules.run.status.${shown.status}`)}
          </Badge>
        )}
        {going && (
          <Button
            size="sm"
            variant="ghost"
            loading={writes.cancel.isPending}
            onClick={() => wanted && writes.cancel.mutate({ profile, runId: wanted })}
            data-testid="workflow-run-cancel"
          >
            {t('workflows.editor.cancel_run')}
          </Button>
        )}
      </div>
      {shown?.error && (
        <Notice tone="danger">
          <span dir="auto">{shown.error}</span>
        </Notice>
      )}
      {(writes.rerun.error ?? writes.cancel.error) && (
        <Notice tone="danger">{describeError(writes.rerun.error ?? writes.cancel.error, t)}</Notice>
      )}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <WorkflowCanvas
          draft={saved}
          selected={selected}
          dispatch={(action) => {
            if (action.type === 'select') setSelected(action.selection);
          }}
          readOnly
          issues={{ nodes: new Map(), edges: new Map(), problems: new Set() }}
          run={shown ? { states, taken } : null}
          nodeExtra={(each) => gateFor(each.id, true)}
        />
        <Card testId="workflow-side">
          <StepRunPanel
            node={node}
            step={step}
            state={node ? (states.get(node.id) ?? null) : null}
            gate={node ? gateFor(node.id, false) : null}
            onRerunFrom={
              wanted
                ? (nodeId) =>
                    writes.rerun.mutate(
                      { profile, runId: wanted, nodeId },
                      { onSuccess: (started) => onShowRun(started.workflow_run_id) },
                    )
                : null
            }
            rerunBusy={writes.rerun.isPending}
          />
        </Card>
      </div>
    </div>
  );
}
