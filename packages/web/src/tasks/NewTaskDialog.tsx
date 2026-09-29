/**
 * A new task, written whole (owner, 2026-09-29: a task with only a name is useless).
 *
 * Everything `TaskCreate` takes, in the order a person thinks of it: what to do (the title and
 * the details the agent works from), who does it (the agent, and the model its run uses), the
 * details (priority, due, tags, project), the steps (subtasks, and what done means), and when it
 * starts. It is made in the profile the person is in (ADR 0016), with one `Idempotency-Key`
 * per dialog as the phones send it.
 *
 * Two rules come from the hub, not from taste:
 *
 * - **A Hermes card is Hermes's.** Given to Hermes, the card goes on Hermes's own kanban and
 *   Hermes's dispatcher runs it with its own model; Hermes briefs its worker from the card, so
 *   it takes no definition of done or constraints (§103, §104). The dialog says so rather than
 *   offering fields the hub would refuse.
 * - **The model belongs to the start.** `TaskCreate` has no model; `tasks.assignTask(start:
 *   true)` has (`TaskAssign.model`). So "Start now" creates the task, then starts it with the
 *   chosen model — the phones' `TaskRules.create` and the web's "Assign and start". A start
 *   that fails leaves the task made: Save then only tries the start again.
 *
 * The phones' twins: iOS `Screens/Tasks/NewTaskSheet.swift`, Android `NewTaskSheet` in
 * `TaskDetail.kt` — the same words where they have them.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/context.js';
import { installedAgents } from '../chat/AgentChips.js';
import { useComposerModels } from '../chat/useComposerControls.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { useManyProfiles, useProfileName } from '../shell/profiles.js';
import { Combobox } from '../ui/Combobox.js';
import {
  Button,
  Dialog,
  Field,
  Input,
  Label,
  Notice,
  Radio,
  Select,
  Textarea,
} from '../ui/index.js';
import { CheckListEditor } from './CheckList.js';
import { describeTaskError } from './errors.js';
import {
  NEW_STATUSES,
  PRIORITIES,
  TITLE_MAX,
  createBody,
  effectiveWhen,
  emptyForm,
  hasProblems,
  newUlid,
  problemsOf,
  type NewTaskForm,
  type StartWhen,
} from './newTask.js';
import { useAssignTask, useCreateTask, useProjects, type Task } from './queries.js';

export function NewTaskDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  /** The task as the hub made it — and started it, when asked. */
  onCreated(task: Task, started: boolean): void;
}) {
  const { t } = useI18n();
  const { homeProfile } = useAuth();
  const many = useManyProfiles();
  const profileName = useProfileName();
  const agents = useAgents();
  const projects = useProjects();
  const models = useComposerModels();
  const create = useCreateTask();
  const assign = useAssignTask();
  const choices = useMemo(() => installedAgents(agents.data ?? []), [agents.data]);
  const projectItems = projects.data?.items ?? [];

  const [form, setForm] = useState<NewTaskForm>(() => emptyForm());
  /** Save was pressed: the problems are shown from then on, as the person fixes them. */
  const [tried, setTried] = useState(false);
  /** Made already, and its start failed: Save only tries the start again. */
  const [made, setMade] = useState<Task | null>(null);
  const key = useRef(newUlid());
  const titleRef = useRef<HTMLInputElement>(null);

  // Every opening is a fresh task: its own key, nothing typed, nothing refused.
  useEffect(() => {
    if (!open) return;
    setForm(emptyForm());
    setTried(false);
    setMade(null);
    key.current = newUlid();
    create.reset();
    assign.reset();
  }, [open]);

  const set = <K extends keyof NewTaskForm>(field: K, value: NewTaskForm[K]) =>
    setForm((current) => ({ ...current, [field]: value }));

  const chosen = choices.find((agent) => agent.id === form.agentId) ?? null;
  const when = effectiveWhen(form);
  const problems = problemsOf(form);
  const busy = create.isPending || assign.isPending;

  const pickAgent = (id: string | null) =>
    setForm((current) => {
      const agent = choices.find((one) => one.id === id) ?? null;
      return { ...current, agentId: agent?.id ?? null, hermes: agent?.slug === 'hermes' };
    });
  const pickWhen = (next: string) =>
    setForm((current) => ({
      ...current,
      when: next as StartWhen,
      // Starting on its own happens in Ready: chosen from intake, it goes to Ready with it.
      status: next === 'auto' && current.status === 'triage' ? 'ready' : current.status,
    }));

  const save = async () => {
    setTried(true);
    if (hasProblems(problems)) {
      if (problems.title) titleRef.current?.focus();
      return;
    }
    try {
      const task = made ?? (await create.mutateAsync({ ...createBody(form), key: key.current }));
      const start = when === 'now' && form.agentId !== null;
      if (start) {
        setMade(task);
        await assign.mutateAsync({
          id: task.id,
          workspace: homeProfile,
          agent_id: form.agentId!,
          start: true,
          instructions: null,
          model: form.model,
        });
      }
      onCreated(task, start);
      onClose();
    } catch {
      // Shown below, from the mutation that failed.
    }
  };

  // Closing after a start that failed keeps the task: the board still shows where it went.
  const close = () => {
    if (made) onCreated(made, false);
    onClose();
  };

  const title = many
    ? t('tasks.new_task_in', { name: profileName(homeProfile) })
    : t('tasks.new_task');
  const error = assign.error ?? create.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title={title}
      closeLabel={t('common.cancel')}
      size="lg"
      testId="new-task-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={close} data-testid="new-task-cancel">
            {t(made ? 'tasks.new.close' : 'common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void save()}
            data-testid="new-task-save"
          >
            {t(made ? 'tasks.new.start_again' : 'tasks.new.create')}
          </Button>
        </>
      }
    >
      <div
        className="new-task-form flex flex-col gap-4"
        data-profile={homeProfile}
        data-testid="new-task-form"
      >
        <div className="flex flex-col gap-3">
          <Field
            label={t('tasks.new.name')}
            error={tried && problems.title ? t('tasks.new.name_required') : undefined}
          >
            {(props) => (
              <Input
                {...props}
                ref={titleRef}
                dir="auto"
                required
                autoFocus
                maxLength={TITLE_MAX}
                value={form.title}
                invalid={tried && !!problems.title}
                disabled={made !== null}
                onChange={(event) => set('title', event.target.value)}
                // Enter in the title saves, as the old quick field made the task.
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void save();
                  }
                }}
                data-testid="new-task-title"
              />
            )}
          </Field>
          <Field label={t('tasks.new.description')} hint={t('tasks.new.description_hint')}>
            {(props) => (
              <Textarea
                {...props}
                dir="auto"
                rows={5}
                value={form.description}
                disabled={made !== null}
                onChange={(event) => set('description', event.target.value)}
                data-testid="new-task-description"
              />
            )}
          </Field>
        </div>

        <Section title={t('tasks.new.who')} testId="new-task-who">
          {choices.length === 0 && !agents.isPending ? (
            <Notice tone="warning">{t('tasks.assign.no_agents')}</Notice>
          ) : (
            <div className="new-task-grid">
              <div className="ch-field-row">
                <Label>{t('tasks.new.agent')}</Label>
                <Select
                  value={form.agentId}
                  onValueChange={pickAgent}
                  placeholder={t('tasks.new.agent_none')}
                  options={choices.map((agent) => ({ value: agent.id, label: agent.name }))}
                  label={t('tasks.new.agent')}
                  title={null}
                  disabled={made !== null}
                  testId="new-task-agent"
                />
              </div>
              {chosen && !form.hermes && (
                <Field label={t('tasks.new.model')} hint={t('tasks.new.model_hint')}>
                  {() => (
                    <Combobox
                      value={form.model}
                      onChange={(value) => set('model', value)}
                      options={models}
                      label={t('tasks.new.model')}
                      placeholder={t('tasks.new.model_default')}
                      disabled={made !== null}
                      testId="new-task-model"
                    />
                  )}
                </Field>
              )}
            </div>
          )}
          {form.hermes && (
            <Notice tone="info" testId="new-task-hermes">
              {t('tasks.new.hermes_note')}
            </Notice>
          )}
        </Section>

        <Section title={t('tasks.new.details')} testId="new-task-details">
          <div className="new-task-grid">
            <div className="ch-field-row">
              <Label>{t('tasks.details.priority')}</Label>
              <Select
                value={form.priority}
                onValueChange={(value) =>
                  set('priority', PRIORITIES.find((one) => one === value) ?? 'normal')
                }
                options={PRIORITIES.map((value) => ({
                  value,
                  label: t(`tasks.priority.${value}`),
                }))}
                label={t('tasks.details.priority')}
                title={null}
                disabled={made !== null}
                testId="new-task-priority"
              />
            </div>
            <Field
              label={t('tasks.new.due')}
              error={
                tried && problems.due
                  ? t(problems.due === 'past' ? 'tasks.new.due_past' : 'tasks.new.due_invalid')
                  : undefined
              }
            >
              {(props) => (
                <Input
                  {...props}
                  type="datetime-local"
                  dir="ltr"
                  value={form.due}
                  invalid={tried && !!problems.due}
                  disabled={made !== null}
                  onChange={(event) => set('due', event.target.value)}
                  data-testid="new-task-due"
                />
              )}
            </Field>
            <Field label={t('tasks.new.tags')} hint={t('tasks.new.tags_hint')}>
              {(props) => (
                <Input
                  {...props}
                  dir="auto"
                  value={form.tags}
                  disabled={made !== null}
                  onChange={(event) => set('tags', event.target.value)}
                  data-testid="new-task-tags"
                />
              )}
            </Field>
            {/* A picker with one option answers nothing: the profile's own list is the default. */}
            {projectItems.length > 1 && (
              <div className="ch-field-row">
                <Label>{t('tasks.new.project')}</Label>
                <Select
                  value={form.projectId || null}
                  onValueChange={(value) => set('projectId', value ?? '')}
                  placeholder={t('tasks.new.project_own')}
                  options={projectItems.map((project) => ({
                    value: project.id,
                    label: project.name,
                  }))}
                  label={t('tasks.new.project')}
                  title={null}
                  disabled={made !== null}
                  testId="new-task-project"
                />
              </div>
            )}
          </div>
        </Section>

        <CheckListEditor
          kind="subtasks"
          items={form.subtasks}
          onChange={(next) => set('subtasks', next)}
          reviewing={false}
          ticks={false}
        />
        {form.hermes ? (
          <p className="text-xs text-muted" data-testid="new-task-no-dod">
            {t('tasks.dod.hermes_card')}
          </p>
        ) : (
          <>
            <CheckListEditor
              kind="dod"
              items={form.definitionOfDone}
              onChange={(next) => set('definitionOfDone', next)}
              reviewing={false}
              ticks={false}
            />
            <CheckListEditor
              kind="constraints"
              items={form.constraints}
              onChange={(next) => set('constraints', next)}
              reviewing={false}
              ticks={false}
            />
          </>
        )}

        <Section title={t('tasks.new.when')} testId="new-task-when">
          {!form.hermes && (
            <Radio
              label={t('tasks.new.when')}
              value={when}
              onChange={pickWhen}
              disabled={made !== null}
              options={[
                {
                  value: 'now',
                  label: t('tasks.new.start_now'),
                  hint: t(chosen ? 'tasks.new.start_now_hint' : 'tasks.new.start_needs_agent'),
                  disabled: !chosen,
                },
                {
                  value: 'auto',
                  label: t('tasks.auto_start.label'),
                  hint: t('tasks.auto_start.hint'),
                },
                {
                  value: 'later',
                  label: t('tasks.new.start_later'),
                  hint: t('tasks.new.start_later_hint'),
                },
              ]}
              testId="new-task-when-choice"
            />
          )}
          {/* A task started now goes to Running; otherwise it waits where the person puts it. */}
          {when !== 'now' && (
            <div className="ch-field-row">
              <Label>{t('tasks.new.status')}</Label>
              <Select
                value={form.status}
                onValueChange={(value) =>
                  set('status', NEW_STATUSES.find((one) => one === value) ?? 'triage')
                }
                options={NEW_STATUSES.map((value) => ({
                  value,
                  label: t(`tasks.status.${value}`),
                }))}
                label={t('tasks.new.status')}
                title={null}
                disabled={made !== null}
                testId="new-task-status"
              />
              <p className="ch-field-hint">{t('tasks.new.status_hint')}</p>
            </div>
          )}
        </Section>

        {made && (
          <Notice tone="warning" testId="new-task-not-started">
            {t('tasks.new.not_started')}
          </Notice>
        )}
        {error && (
          <Notice tone="danger" testId="new-task-error">
            {describeTaskError(error, t)}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}
