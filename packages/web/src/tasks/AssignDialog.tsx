/**
 * Give a task to an agent — and, by default, have it start now.
 *
 * "Assign and start" is the first button because it is what a person giving work to an
 * agent means: the hub opens the task's conversation and the agent begins (contract
 * `TaskAssign.start`). "Assign only" is there for a task that should wait its turn.
 *
 * Only agents that can take a turn on this hub are offered — the same rule as the chips
 * above the composer — so the dialog never offers an agent the hub would refuse.
 */
import { useEffect, useMemo, useState } from 'react';
import { describeError } from '../auth/client.js';
import { installedAgents } from '../chat/AgentChips.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { Button, Dialog, Field, Notice, Select, Textarea, useToast } from '../ui/index.js';
import { listOf } from './board.js';
import { useAssignTask, type Task } from './queries.js';

export function AssignDialog({ task, onClose }: { task: Task | null; onClose(): void }) {
  const { t, language } = useI18n();
  const waitingOn = task?.waiting_on ?? [];
  const toast = useToast();
  const agents = useAgents();
  const assign = useAssignTask();
  const choices = useMemo(() => installedAgents(agents.data ?? []), [agents.data]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');

  // A new task opens the dialog fresh: its current agent chosen, nothing typed yet.
  useEffect(() => {
    if (!task) return;
    const current = task.assignee?.kind === 'agent' ? task.assignee.id : null;
    setAgentId(
      current && choices.some((a) => a.id === current) ? current : (choices[0]?.id ?? null),
    );
    setInstructions('');
    assign.reset();
    // Keyed on the task alone: `choices` arriving later must not wipe what the person
    // already picked (the effect below fills an empty choice instead).
  }, [task?.id]);
  useEffect(() => {
    if (task && agentId === null && choices[0]) setAgentId(choices[0].id);
  }, [task, agentId, choices]);

  const submit = (start: boolean) => {
    if (!task || !agentId) return;
    assign.mutate(
      {
        id: task.id,
        // The card's own profile: the board holds every profile, and a task is assigned
        // where it lives (ADR 0016). The dialog's agents are that profile's too (the board
        // opens it inside the card's `ProfileScope`).
        workspace: task.profile,
        agent_id: agentId,
        start,
        instructions: instructions.trim() || null,
      },
      {
        onSuccess: (result) => {
          onClose();
          // Asked to start and no run came back: the agent keeps its own board (Hermes),
          // the task went there, and the person should know who starts it.
          if (start && result.run_id === null) {
            toast({ title: t('tasks.assign.not_started'), tone: 'info' });
          }
        },
      },
    );
  };

  return (
    <Dialog
      open={task !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('tasks.assign.title')}
      description={task ? <span dir="auto">{task.title}</span> : undefined}
      closeLabel={t('common.cancel')}
      testId="task-assign-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            disabled={!agentId || assign.isPending}
            onClick={() => submit(false)}
            data-testid="task-assign-only"
          >
            {t('tasks.assign.only')}
          </Button>
          <Button
            variant="primary"
            disabled={!agentId}
            loading={assign.isPending}
            onClick={() => submit(true)}
            data-testid="task-assign-start"
          >
            {t('tasks.assign.start')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {choices.length === 0 && !agents.isPending ? (
          <Notice tone="warning">{t('tasks.assign.no_agents')}</Notice>
        ) : (
          <Select
            value={agentId}
            onValueChange={setAgentId}
            options={choices.map((agent) => ({ value: agent.id, label: agent.name }))}
            label={t('tasks.assign.agent')}
            testId="task-assign-agent"
          />
        )}
        <Field label={t('tasks.assign.instructions')} hint={t('tasks.assign.instructions_hint')}>
          {(props) => (
            <Textarea
              {...props}
              dir="auto"
              rows={3}
              maxLength={8000}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              data-testid="task-assign-instructions"
            />
          )}
        </Field>
        {/* Starting by hand is not held back by what the task depends on — the person is
            told first, in the words of what is not done (DECISIONS §93). */}
        {waitingOn.length > 0 && (
          <Notice tone="warning" testId="task-assign-waiting">
            {t('tasks.assign.waiting', {
              titles: listOf(
                waitingOn.map((one) => one.title),
                language,
              ),
            })}
          </Notice>
        )}
        {assign.isError && <Notice tone="danger">{describeError(assign.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
