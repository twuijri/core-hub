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
 *
 * Laid out like n8n (owner, 2026-09-29, after testers got lost): the canvas takes the page,
 * the workflow's triggers are nodes at its start, a "+" adds the next step from a searchable
 * list, and a step, a connection or a trigger opens in its own dialog. Save sits by the name
 * with an "unsaved" mark, Ctrl/Cmd+S saves, and leaving with unsaved work asks first
 * (`LeaveGuard.tsx`).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/context.js';
import { describeError, fieldErrorsOf } from '../../auth/client.js';
import { useI18n } from '../../i18n/context.js';
import { ProfileBadge } from '../../shell/ProfileBadge.js';
import { useManyProfiles } from '../../shell/profiles.js';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Notice,
  Select,
  Skeleton,
  TabPanel,
  Tabs,
  type BadgeTone,
} from '../../ui/index.js';
import {
  IconArrowStart,
  IconGauge,
  IconPlay,
  IconPlus,
  IconSave,
  IconSettings,
  IconTrigger,
} from '../../ui/icons.js';
import { RunLimitsDialog, WorkflowLimitsForm, type Limits } from '../WorkflowLimits.js';
import { ApprovalGate } from '../ScheduleRuns.js';
import { WorkflowCanvas, type AddFrom, type CanvasIssues } from './WorkflowCanvas.js';
import { IssueList, StepRunPanel } from './StepPanel.js';
import { newTriggerBody } from './WorkflowTriggers.js';
import { FailureAlertForm } from './SendForm.js';
import { PanelBoundary } from './PanelBoundary.js';
import { NodeDialog } from './NodeDialog.js';
import { NodePicker, type Picked } from './NodePicker.js';
import { DEFAULT_SCHEDULE, TriggerDialog, scheduleWhen } from './TriggerDialog.js';
import { useLeaveGuard } from './LeaveGuard.js';
import {
  MANUAL_TRIGGER_ID,
  firstStepPlace,
  triggerPlaces,
  type CanvasTrigger,
} from './trigger-nodes.js';
import {
  emptyDraft,
  fromWorkflow,
  hasUnsaved,
  initialState,
  issuesByTarget,
  latestSteps,
  nextNodeId,
  nextPendingId,
  nodeStates,
  placeRefusedFields,
  reducer,
  takenEdges,
  type Draft,
  type PendingTrigger,
  type Position,
  type Selection,
  type Validation,
  type WorkflowIssue,
} from './model.js';
import {
  createTrigger,
  createWorkflowSchedule,
  useProfileAgents,
  useProfileModels,
  useTriggerWrites,
  useWorkflow,
  useWorkflowRun,
  useWorkflowRuns,
  useWorkflowScheduleWrites,
  useWorkflowSchedules,
  useWorkflowTriggers,
  useWorkflowWrites,
  validateDraft,
  workflowScheduleBody,
  type TriggerPreset,
  type WorkflowRunRow,
} from './queries.js';
import { intlLocale } from '../../i18n/index.js';

const CHECK_DELAY_MS = 350;

/**
 * Work left without saving — by the browser's Back button, which cannot be held — kept for
 * this tab's life and offered back when the same workflow is opened again.
 */
const leftBehind = new Map<string, { draft: Draft; pending: PendingTrigger[] }>();

/** Why a check or a save was refused: the general sentence, and each field put in its place. */
interface Refusal {
  message: string;
  placed: ReturnType<typeof placeRefusedFields>;
}

function refusalOf(error: unknown, draft: Draft, t: Parameters<typeof describeError>[1]): Refusal {
  return {
    message: describeError(error, t),
    placed: placeRefusedFields(fieldErrorsOf(error), draft),
  };
}

/** The general sentence, with the fields no form shows named after it. */
function generalMessage(refusal: Refusal): string {
  const rest = refusal.placed.general.map((field) => `${field.path || '/'}: ${field.message}`);
  return rest.length > 0 ? `${refusal.message} (${rest.join('; ')})` : refusal.message;
}

/** Whether every field the refusal names is shown next to its field, so no banner is needed. */
function allPlaced(refusal: Refusal): boolean {
  const { name, issues, general } = refusal.placed;
  return general.length === 0 && (name !== null || issues.length > 0);
}

const RUN_TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  running: 'info',
  waiting: 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/** What is open over the canvas: a step, a connection or a trigger. */
type Opened = { type: 'node' | 'edge' | 'trigger'; id: string } | null;

/** The list a step or a trigger is added from, and where the new one goes. */
type Picking = { mode: 'step' | 'trigger'; from: AddFrom | null; at?: Position } | null;

const WEBHOOK_PRESETS = new Set<string>(['clickup', 'github', 'generic_hmac', 'token']);

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
  const location = useLocation();
  const queryClient = useQueryClient();
  const many = useManyProfiles();
  const workflow = useWorkflow(profile, workflowId);
  const runs = useWorkflowRuns(profile, workflowId);
  const agents = useProfileAgents(profile);
  const models = useProfileModels(profile);
  const writes = useWorkflowWrites();
  const webhooks = useWorkflowTriggers(profile, workflowId);
  const schedules = useWorkflowSchedules(profile, workflowId);
  const triggerWrites = useTriggerWrites(profile, workflowId ?? '');
  const scheduleWrites = useWorkflowScheduleWrites(profile);
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(emptyDraft()));
  const [validation, setValidation] = useState<Validation | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<Refusal | null>(null);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [runLimitsOpen, setRunLimitsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [opened, setOpened] = useState<Opened>(null);
  const [picking, setPicking] = useState<Picking>(null);
  const [manualShown, setManualShown] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const stashKey = `${profile}:${workflowId ?? 'new'}`;
  const [restorable, setRestorable] = useState(() => leftBehind.get(stashKey) ?? null);

  // The saved drawing, once, when it arrives — never over what someone is drawing.
  useEffect(() => {
    if (!workflowId || !workflow.data || loadedFor.current === workflowId) return;
    loadedFor.current = workflowId;
    dispatch({ type: 'load', draft: fromWorkflow(workflow.data) });
  }, [workflowId, workflow.data]);

  // The hub's check, a moment after each change — for a saved workflow only once it has
  // loaded, so the empty drawing the editor starts from is never checked in its place.
  const { draft } = state;
  useEffect(() => {
    if (workflowId && loadedFor.current !== workflowId) return;
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
          if (live) setCheckError(refusalOf(error, draft, t));
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
  }, [draft, profile, workflowId]);

  // A refused save is about the drawing as it was; a change makes it stale.
  const { create, update } = writes;
  useEffect(() => {
    if (create.error) create.reset();
    if (update.error) update.reset();
    // Only a change of the drawing clears it.
  }, [draft]);

  const saveError = writes.create.error ?? writes.update.error;
  const saveRefusal = useMemo(
    () => (saveError ? refusalOf(saveError, draft, t) : null),
    // The drawing the save sent is the one on screen: any change clears the error.
    [saveError],
  );
  // What the check or a save refused, field by field, is marked like the check's findings.
  const refused = useMemo(
    () => [...(checkError?.placed.issues ?? []), ...(saveRefusal?.placed.issues ?? [])],
    [checkError, saveRefusal],
  );
  const shown: Validation | null = useMemo(
    () =>
      refused.length > 0
        ? {
            valid: false,
            problems: [...(validation?.problems ?? []), ...refused],
            warnings: validation?.warnings ?? [],
          }
        : validation,
    [validation, refused],
  );
  const nameRefused = checkError?.placed.name ?? saveRefusal?.placed.name ?? null;

  const found = useMemo(() => issuesByTarget(shown), [shown]);
  const problems = shown?.problems ?? [];
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
  const unsaved = hasUnsaved(state);
  const saveBlocked = nameMissing
    ? t('workflows.editor.name_required')
    : blocked
      ? t('workflows.editor.save_blocked')
      : null;

  // Keep what is left behind when the editor goes away with unsaved work (the browser's Back).
  const latest = useRef({ state, leaving: false });
  latest.current.state = state;
  useEffect(() => {
    const key = stashKey;
    return () => {
      const { state: last, leaving } = latest.current;
      if (!leaving && hasUnsaved(last)) {
        leftBehind.set(key, { draft: last.draft, pending: last.pending });
      }
    };
  }, [stashKey]);

  /** Save what is drawn, then the triggers that waited for it; the id it is saved under. */
  const save = async (): Promise<string | null> => {
    setMessage(null);
    setTriggerError(null);
    if (nameMissing || blocked) return null;
    let id = workflowId;
    if (workflowId) {
      if (state.dirty) await writes.update.mutateAsync({ profile, id: workflowId, draft });
      dispatch({ type: 'saved' });
    } else {
      const created = await writes.create.mutateAsync({ profile, draft });
      loadedFor.current = created.id;
      dispatch({ type: 'saved' });
      id = created.id;
    }
    if (id && state.pending.length > 0) {
      const made: string[] = [];
      for (const each of state.pending) {
        try {
          if (each.kind === 'webhook') {
            const preset = each.preset as TriggerPreset;
            await createTrigger(
              client,
              profile,
              id,
              newTriggerBody(preset, t(`workflows.triggers.presets.${preset}`)),
            );
          } else {
            await createWorkflowSchedule(
              client,
              profile,
              workflowScheduleBody(draft.name, id, each.schedule),
            );
          }
          made.push(each.id);
        } catch (error) {
          setTriggerError(describeError(error, t));
        }
      }
      dispatch({ type: 'pending_remove', ids: made });
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    }
    leftBehind.delete(stashKey);
    setRestorable(null);
    if (!workflowId && id) onSaved(id);
    return id;
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Ctrl+S / Cmd+S saves, wherever the focus is in the editor (and never the browser's page).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's')
        return;
      event.preventDefault();
      if (latest.current.state.draft.name.trim() === '') {
        nameField.current?.focus();
        return;
      }
      void saveRef.current().catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const leaveGuard = useLeaveGuard({
    unsaved,
    here: `${location.pathname}${location.search}`,
    onSave: async () => (await save().catch(() => null)) !== null,
    saveBlocked,
    onLeave: () => {
      latest.current.leaving = true;
      leftBehind.delete(stashKey);
    },
  });

  const runFrom = async (startNodeIds: string[] | null, limits?: Limits) => {
    setMessage(null);
    const id = workflowId && !unsaved ? workflowId : await save().catch(() => null);
    if (!id) return;
    const started = await writes.run.mutateAsync({
      profile,
      id,
      input: input.trim() || null,
      startNodeIds,
      ...(limits ? { limits } : {}),
    });
    setRunLimitsOpen(false);
    setOpened(null);
    setMessage(t('workflows.started', { name: draft.name }));
    onShowRun(started.workflow_run_id, id);
  };

  // ------------------------------------------------------------ triggers on the canvas

  const when = (at: string | null) =>
    at
      ? new Intl.DateTimeFormat(intlLocale(language), {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(Date.parse(at))
      : '';

  const webhookRows = webhooks.data ?? [];
  const scheduleRows = schedules.data ?? [];
  const showManual = draft.nodes.length > 0 || manualShown;
  const triggers: CanvasTrigger[] = useMemo(() => {
    const list: CanvasTrigger[] = [];
    if (showManual) {
      list.push({
        id: MANUAL_TRIGGER_ID,
        kind: 'manual',
        title: t('workflows.nodes.trigger_kinds.manual'),
        detail: input.trim() ? `{{input}} = ${input.trim()}` : t('workflows.nodes.manual_detail'),
        pending: false,
        enabled: true,
      });
    }
    for (const row of webhookRows) {
      list.push({
        id: row.id,
        kind: 'webhook',
        title: row.name,
        detail: row.events.length
          ? `${t(`workflows.triggers.presets.${row.preset}`)} · ${row.events.join(', ')}`
          : t(`workflows.triggers.presets.${row.preset}`),
        pending: false,
        enabled: row.enabled,
      });
    }
    for (const row of scheduleRows) {
      list.push({
        id: `schedule:${row.id}`,
        kind: 'schedule',
        title: row.name,
        detail: scheduleWhen(row.trigger, t, (at) => when(at)),
        detailLtr: row.trigger.kind === 'cron',
        pending: false,
        enabled: row.enabled,
      });
    }
    for (const each of state.pending) {
      list.push({
        id: each.id,
        kind: each.kind,
        title:
          each.kind === 'webhook'
            ? t(`workflows.triggers.presets.${each.preset}`)
            : t('workflows.nodes.trigger_kinds.schedule'),
        detail: each.kind === 'schedule' ? each.schedule.value : '',
        detailLtr: each.kind === 'schedule' && each.schedule.mode === 'cron',
        pending: true,
        enabled: true,
      });
    }
    return list;
    // `when` and `t` follow the language, which re-renders anyway.
  }, [showManual, input, webhookRows, scheduleRows, state.pending, language]);

  const openStep = (id: string) => {
    dispatch({ type: 'select', selection: { type: 'node', id } });
    setOpened({ type: 'node', id });
  };

  /** Add what was picked: a step where it was asked for, or a trigger. */
  const onPick = (picked: Picked) => {
    const from = picking?.from ?? null;
    const at = picking?.at;
    setPicking(null);
    if (picked.group === 'step') {
      const kind = picked.kind === 'send' ? 'notify' : picked.kind;
      const id = nextNodeId(kind, draft.nodes);
      const triggerIndex =
        from?.type === 'trigger' ? triggers.findIndex((each) => each.id === from.id) : -1;
      const position =
        at ??
        (from?.type === 'trigger'
          ? firstStepPlace(draft, triggerPlaces(draft, triggers.length)[triggerIndex] ?? null)
          : undefined);
      dispatch({
        type: 'add',
        kind,
        title: picked.kind === 'send' ? t('workflows.send.title') : t(`workflows.kinds.${kind}`),
        agentId: agents.data?.[0]?.id ?? null,
        ...(position ? { position } : {}),
        ...(from?.type === 'node' ? { after: { from: from.id, route: from.route } } : {}),
        // A notice that sends (§124): kept as a `notify` node, so older apps load it.
        ...(picked.kind === 'send' ? { patch: { send: { targets: [] } } } : {}),
      });
      setOpened({ type: 'node', id });
      return;
    }
    setTriggerError(null);
    if (picked.kind === 'manual') {
      setManualShown(true);
      setOpened({ type: 'trigger', id: MANUAL_TRIGGER_ID });
      return;
    }
    if (!workflowId) {
      // Not saved yet: the trigger is made right after the first save.
      const id = nextPendingId(state.pending);
      const trigger: PendingTrigger =
        picked.kind === 'schedule'
          ? { id, kind: 'schedule', schedule: DEFAULT_SCHEDULE }
          : { id, kind: 'webhook', preset: picked.kind };
      dispatch({ type: 'pending_add', trigger });
      setOpened({ type: 'trigger', id });
      return;
    }
    if (WEBHOOK_PRESETS.has(picked.kind)) {
      const preset = picked.kind as TriggerPreset;
      triggerWrites.create.mutate(
        newTriggerBody(preset, t(`workflows.triggers.presets.${preset}`)),
        {
          onSuccess: (made) => setOpened({ type: 'trigger', id: made.id }),
          onError: (error) => setTriggerError(describeError(error, t)),
        },
      );
      return;
    }
    scheduleWrites.create.mutate(
      workflowScheduleBody(draft.name || t('workflows.untitled'), workflowId, DEFAULT_SCHEDULE),
      {
        onSuccess: (made) => setOpened({ type: 'trigger', id: `schedule:${made.id}` }),
        onError: (error) => setTriggerError(describeError(error, t)),
      },
    );
  };

  const runError = writes.run.error ?? saveError;
  const openedNode =
    opened?.type === 'node' ? (draft.nodes.find((node) => node.id === opened.id) ?? null) : null;
  const openedEdge =
    opened?.type === 'edge' ? (draft.edges.find((edge) => edge.id === opened.id) ?? null) : null;
  const openedTrigger =
    opened?.type === 'trigger' ? (triggers.find((each) => each.id === opened.id) ?? null) : null;
  const openedIssues: WorkflowIssue[] = openedNode
    ? (found.nodes.get(openedNode.id) ?? [])
    : openedEdge
      ? (found.edges.get(openedEdge.id) ?? [])
      : [];
  const lastRunId = runs.data?.[0]?.id ?? null;
  const lastRun = useWorkflowRun(profile, openedNode ? lastRunId : null);
  const pick = (issue: WorkflowIssue) => {
    const selection: Selection = issue.node_id
      ? { type: 'node', id: issue.node_id }
      : issue.edge_id
        ? { type: 'edge', id: issue.edge_id }
        : null;
    dispatch({ type: 'select', selection });
    if (selection) setOpened(selection);
  };
  const runDisabledReason =
    saveBlocked ?? (draft.nodes.length === 0 ? t('workflows.nodes.no_steps') : null);

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

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="workflow-editor"
      data-workflow-id={workflowId ?? 'new'}
      data-unsaved={unsaved ? 'true' : 'false'}
    >
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <BackButton onBack={() => leaveGuard.guard(onBack)} />
            {many && <ProfileBadge profile={profile} testId="workflow-profile" />}
            <span className="ms-auto flex items-center gap-2 text-xs" aria-live="polite">
              <CheckStatus checking={checking} validation={validation} error={checkError} />
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field
              label={t('workflows.editor.name')}
              hint={nameMissing ? t('workflows.editor.name_required') : undefined}
              error={
                nameRefused !== null
                  ? t('workflows.editor.name_refused', { message: nameRefused })
                  : undefined
              }
              className="min-w-60 flex-1"
            >
              {(props) => (
                <Input
                  {...props}
                  ref={nameField}
                  value={draft.name}
                  onChange={(event) => dispatch({ type: 'rename', name: event.target.value })}
                  placeholder={t('workflows.untitled')}
                  dir="auto"
                  data-testid="workflow-name"
                />
              )}
            </Field>
            <span className="flex flex-wrap items-center gap-2">
              {unsaved ? (
                <Badge tone="warning" dot testId="workflow-unsaved">
                  {t('workflows.editor.unsaved')}
                </Badge>
              ) : workflowId ? (
                <Badge tone="success" testId="workflow-all-saved">
                  {t('workflows.nodes.all_saved')}
                </Badge>
              ) : null}
              <Button
                variant="primary"
                icon={<IconSave size={16} />}
                loading={saving}
                disabled={saveBlocked !== null || (!unsaved && !!workflowId)}
                tooltip={saveBlocked ?? t('workflows.nodes.save_shortcut')}
                onClick={() => void save().catch(() => undefined)}
                data-testid="workflow-save"
              >
                {t('common.save')}
              </Button>
              <Button
                variant="secondary"
                icon={<IconPlay size={16} />}
                loading={writes.run.isPending}
                disabled={runDisabledReason !== null}
                tooltip={
                  runDisabledReason ??
                  (unsaved || !workflowId ? t('workflows.editor.save_first') : undefined)
                }
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
                disabled={runDisabledReason !== null}
                onClick={() => setRunLimitsOpen(true)}
                data-testid="workflow-run-with-limits"
              />
              <Button
                variant="ghost"
                iconOnly
                icon={<IconSettings size={16} />}
                aria-label={t('workflows.nodes.settings')}
                tooltip={t('workflows.nodes.settings')}
                onClick={() => setSettingsOpen(true)}
                data-testid="workflow-settings-open"
              />
            </span>
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
          {restorable && (
            <Notice tone="warning" testId="workflow-restore">
              <span className="flex flex-wrap items-center gap-2">
                {t('workflows.leave.left_behind')}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    dispatch({
                      type: 'restore',
                      draft: restorable.draft,
                      pending: restorable.pending,
                    });
                    leftBehind.delete(stashKey);
                    setRestorable(null);
                  }}
                  data-testid="workflow-restore-yes"
                >
                  {t('workflows.leave.restore')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    leftBehind.delete(stashKey);
                    setRestorable(null);
                  }}
                  data-testid="workflow-restore-no"
                >
                  {t('workflows.leave.discard')}
                </Button>
              </span>
            </Notice>
          )}
          {writes.run.error ? (
            <Notice tone="danger">{describeError(writes.run.error, t)}</Notice>
          ) : saveRefusal ? (
            <Notice tone="danger" testId="workflow-save-error">
              {allPlaced(saveRefusal)
                ? t('workflows.editor.fields_refused')
                : generalMessage(saveRefusal)}
            </Notice>
          ) : null}
          {triggerError && (
            <Notice tone="danger" testId="workflow-trigger-error">
              {triggerError}
            </Notice>
          )}
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
              <PanelBoundary testId="workflow-canvas-failed">
                <WorkflowCanvas
                  draft={draft}
                  selected={state.selected}
                  dispatch={dispatch}
                  readOnly={false}
                  issues={canvasIssues}
                  run={null}
                  height="calc(100dvh - 20rem)"
                  triggers={triggers}
                  onOpenNode={openStep}
                  onOpenEdge={(id) => setOpened({ type: 'edge', id })}
                  onOpenTrigger={(id) => setOpened({ type: 'trigger', id })}
                  onAddStep={(from, at) =>
                    setPicking({ mode: 'step', from, ...(at ? { at } : {}) })
                  }
                  onAddTrigger={() => setPicking({ mode: 'trigger', from: null })}
                  toolbar={
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconTrigger size={14} />}
                        loading={triggerWrites.create.isPending || scheduleWrites.create.isPending}
                        onClick={() => setPicking({ mode: 'trigger', from: null })}
                        data-testid="workflow-add-trigger"
                      >
                        {t('workflows.nodes.add_trigger')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<IconPlus size={14} />}
                        onClick={() => setPicking({ mode: 'step', from: null })}
                        data-testid="workflow-add-step"
                      >
                        {t('workflows.nodes.add_step')}
                      </Button>
                    </>
                  }
                />
              </PanelBoundary>
              <IssueList
                issues={[...problems, ...(shown?.warnings ?? [])]}
                problems={problems}
                t={t}
                onPick={pick}
              />
              <NodePicker
                open={picking !== null}
                mode={picking?.mode ?? 'step'}
                manualShown={showManual}
                onClose={() => setPicking(null)}
                onPick={onPick}
              />
              {/* An error in a step's form closes that form only; another step opens it again. */}
              <PanelBoundary resetKey={opened?.id ?? null}>
                <NodeDialog
                  draft={draft}
                  node={openedNode}
                  edge={openedEdge}
                  onClose={() => setOpened(null)}
                  dispatch={dispatch}
                  agents={agents.data ?? []}
                  models={models.data ?? []}
                  issues={openedIssues}
                  problems={problems}
                  onRunFrom={(id) => void runFrom([id]).catch(() => undefined)}
                  runFromBusy={writes.run.isPending}
                  profile={profile}
                  workflowId={workflowId}
                  lastRun={lastRun.data ?? null}
                  runInput={input}
                />
              </PanelBoundary>
              <TriggerDialog
                trigger={openedTrigger}
                onClose={() => setOpened(null)}
                profile={profile}
                workflowId={workflowId}
                workflowName={draft.name}
                webhook={webhookRows.find((row) => row.id === openedTrigger?.id) ?? null}
                schedule={
                  scheduleRows.find((row) => `schedule:${row.id}` === openedTrigger?.id) ?? null
                }
                pending={state.pending.find((each) => each.id === openedTrigger?.id) ?? null}
                onPendingChange={(trigger) => dispatch({ type: 'pending_update', trigger })}
                onPendingRemove={(id) => {
                  dispatch({ type: 'pending_remove', ids: [id] });
                  setOpened(null);
                }}
                runInput={input}
                onRunInput={setInput}
                onRun={() => void runFrom(null).catch(() => undefined)}
                runBusy={writes.run.isPending}
                runDisabledReason={runDisabledReason}
                onHideManual={
                  draft.nodes.length === 0
                    ? () => {
                        setManualShown(false);
                        setOpened(null);
                      }
                    : null
                }
                onShowRun={(id) => onShowRun(id)}
              />
              <Dialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                title={t('workflows.nodes.settings')}
                size="md"
                closeLabel={t('ui.close')}
                testId="workflow-settings-dialog"
              >
                <section className="flex flex-col gap-3" data-testid="workflow-settings">
                  <h3 className="text-sm font-medium">{t('schedules.limits.title')}</h3>
                  {workflowId ? (
                    <WorkflowLimitsForm workflowId={workflowId} profile={profile} />
                  ) : (
                    <p className="text-xs text-muted">{t('schedules.limits.save_first')}</p>
                  )}
                  <FailureAlertForm
                    alert={draft.on_failure ?? null}
                    profile={profile}
                    onChange={(alert) => dispatch({ type: 'alert', alert })}
                  />
                </section>
              </Dialog>
            </div>
          )}
        </TabPanel>
        <TabPanel value="runs">
          {mode === 'runs' && workflowId && (
            <PanelBoundary resetKey={runId} testId="workflow-run-failed">
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
            </PanelBoundary>
          )}
        </TabPanel>
      </Tabs>
      {leaveGuard.dialog}
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
  error: Refusal | null;
}) {
  const { t } = useI18n();
  if (error)
    return (
      <span data-testid="workflow-check-error">
        <Badge tone="danger">
          {allPlaced(error)
            ? t('workflows.editor.check_fields')
            : t('workflows.editor.check_failed', { message: generalMessage(error) })}
        </Badge>
      </span>
    );
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
  const [find, setFind] = useState('');
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
  // The runs about one task or one event (§123): matched on the ids a trigger gave them.
  const needle = find.trim().toLowerCase();
  const listed = needle
    ? runs.filter((each) =>
        [each.task_id, each.event_id].some((id) => id?.toLowerCase().includes(needle)),
      )
    : runs;
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
        {/* A fixed width, so a long run label ends in "…" instead of running over the search. */}
        <div className="w-72 min-w-0 max-w-full">
          <Field label={t('workflows.editor.run_pick')}>
            {() => (
              <Select
                value={wanted}
                onValueChange={(value) => onShowRun(value ?? 'latest')}
                options={listed.map((each) => ({
                  value: each.id,
                  label:
                    t('workflows.editor.run_of', {
                      status: t(`schedules.run.status.${each.status}`),
                      at: when(each.started_at ?? each.finished_at),
                    }) + (each.task_id ? ` · ${each.task_id}` : ''),
                }))}
                label={t('workflows.editor.run_pick')}
                testId="workflow-run-pick"
              />
            )}
          </Field>
        </div>
        <div className="min-w-48">
          <Field label={t('workflows.editor.run_find')}>
            {(props) => (
              <Input
                {...props}
                value={find}
                onChange={(event) => setFind(event.target.value)}
                placeholder={t('workflows.editor.run_find_hint')}
                dir="ltr"
                data-testid="workflow-runs-find"
              />
            )}
          </Field>
        </div>
        {shown && (
          <Badge tone={RUN_TONE[shown.status] ?? 'neutral'} dot testId="workflow-run-state">
            {t(`schedules.run.status.${shown.status}`)}
          </Badge>
        )}
        {shown?.phase && (
          <Badge testId="workflow-run-phase">
            {t(`workflows.phase.${shown.phase}`) === `workflows.phase.${shown.phase}`
              ? shown.phase
              : t(`workflows.phase.${shown.phase}`)}
          </Badge>
        )}
        {shown?.filtered && (
          <Badge testId="workflow-run-filtered">{t('workflows.editor.run_filtered')}</Badge>
        )}
        {shown?.task_id && (
          <Badge tone="info" testId="workflow-run-task">
            <span dir="ltr">{t('workflows.editor.run_task', { id: shown.task_id })}</span>
          </Badge>
        )}
        {shown?.event_id && (
          <Badge testId="workflow-run-event">
            <span dir="ltr">{t('workflows.editor.run_event', { id: shown.event_id })}</span>
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
            profile={profile}
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
