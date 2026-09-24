/**
 * Hand a card on Hermes's board to another workspace — which is another Hermes profile
 * (ADR 0014). Hermes does the handing over; the card then shows in the workspace it went to.
 *
 * A card that is running is asked about first: Hermes stops its run before it moves the
 * card, and that is the person's call, not the board's.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAgents, useProfiles } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { Button, Dialog, Notice, Select, useConfirm } from '../ui/index.js';
import { describeTaskError } from './errors.js';
import { useAssignTask, type Task } from './queries.js';

export function HandOverDialog({ task, onClose }: { task: Task | null; onClose(): void }) {
  const { t } = useI18n();
  const workspaces = useProfiles().data ?? [];
  const agents = useAgents();
  const assign = useAssignTask();
  const { ask, dialog } = useConfirm();
  // Every workspace but the one the card is in: handing it to itself says nothing.
  const choices = useMemo(
    () => workspaces.filter((workspace) => workspace.slug !== task?.profile),
    [workspaces, task?.profile],
  );
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!task) return;
    setTarget(null);
    assign.reset();
  }, [task?.id]);
  useEffect(() => {
    if (task && target === null && choices[0]) setTarget(choices[0].slug);
  }, [task, target, choices]);

  // The Hermes agent: the card's own assignee, or the registry's Hermes.
  const hermesId =
    (task?.assignee?.kind === 'agent' ? task.assignee.id : null) ??
    agents.data?.find((agent) => agent.slug === 'hermes')?.id ??
    null;

  const submit = async () => {
    if (!task || !target || !hermesId) return;
    if (task.status === 'running') {
      const sure = await ask({
        title: t('tasks.handover.confirm_running', { title: task.title }),
        body: t('tasks.handover.confirm_running_body'),
        confirmLabel: t('tasks.handover.submit'),
      });
      if (!sure) return;
    }
    assign.mutate(
      {
        id: task.id,
        workspace: task.profile,
        handTo: target,
        agent_id: hermesId,
        start: false,
        instructions: null,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <>
      <Dialog
        open={task !== null}
        onOpenChange={(open) => !open && onClose()}
        title={t('tasks.handover.title')}
        description={task ? <span dir="auto">{task.title}</span> : undefined}
        closeLabel={t('common.cancel')}
        testId="task-handover-dialog"
        footer={
          <Button
            variant="primary"
            disabled={!target || !hermesId}
            loading={assign.isPending}
            onClick={() => void submit()}
            data-testid="task-handover-submit"
          >
            {t('tasks.handover.submit')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {choices.length === 0 ? (
            <Notice tone="info">{t('tasks.handover.no_workspaces')}</Notice>
          ) : (
            <Select
              value={target}
              onValueChange={setTarget}
              options={choices.map((workspace) => ({
                value: workspace.slug,
                label: workspace.name,
              }))}
              label={t('tasks.handover.workspace')}
              testId="task-handover-workspace"
            />
          )}
          <p className="text-xs text-muted">{t('tasks.handover.hint')}</p>
          {assign.isError && <Notice tone="danger">{describeTaskError(assign.error, t)}</Notice>}
        </div>
      </Dialog>
      {dialog}
    </>
  );
}
