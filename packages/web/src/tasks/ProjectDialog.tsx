/**
 * A project's settings: the git repository its tasks work in, and the branch they start from.
 *
 * The repository is a folder inside the profile's own folder (the one its conversations work
 * in); the hub checks it is a git work tree before keeping it, and says why when it is not.
 * With a repository set, starting a task makes the task a worktree of it on a branch of its
 * own, and the agent works there. Left empty, a task works in its conversation's own folder.
 */
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { Button, Dialog, Field, Input, Notice, Select } from '../ui/index.js';
import { describeTaskError } from './errors.js';
import { useProjects, useUpdateProject } from './queries.js';

export function ProjectDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  /** The project to open on (the board's filter); the first one when there is none. */
  projectId: string | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  const projects = useProjects();
  const items = projects.data?.items ?? [];
  const update = useUpdateProject();
  const [chosen, setChosen] = useState<string>('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');

  const project = items.find((item) => item.id === chosen) ?? null;
  useEffect(() => {
    if (!open) return;
    setChosen(projectId ?? items[0]?.id ?? '');
    update.reset();
  }, [open, projectId, items.length]);
  useEffect(() => {
    setRepository(project?.working_dir ?? '');
    setBranch(project?.default_branch ?? '');
  }, [project?.id, project?.working_dir, project?.default_branch]);

  const patch: { working_dir?: string | null; default_branch?: string | null } = {};
  if (project) {
    if (repository.trim() !== (project.working_dir ?? '')) {
      patch.working_dir = repository.trim() === '' ? null : repository.trim();
    }
    if (branch.trim() !== (project.default_branch ?? '') && branch.trim() !== '') {
      patch.default_branch = branch.trim();
    }
  }
  const changed = Object.keys(patch).length > 0;

  const save = () => {
    if (!project || !changed) return;
    update.mutate({ id: project.id, ...patch }, { onSuccess: onClose });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t('tasks.project_settings.title')}
      description={t('tasks.project_settings.hint')}
      closeLabel={t('common.cancel')}
      testId="project-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!changed}
            loading={update.isPending}
            onClick={save}
            data-testid="project-dialog-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {items.length > 1 && (
          <Select
            value={chosen}
            onValueChange={(value) => setChosen(value ?? '')}
            options={items.map((item) => ({ value: item.id, label: item.name }))}
            label={t('tasks.project')}
            testId="project-dialog-project"
          />
        )}
        <Field label={t('tasks.project_settings.repository')} hint={t('tasks.repo.hint')}>
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={repository}
              placeholder={t('tasks.repo.placeholder')}
              onChange={(event) => setRepository(event.target.value)}
              data-testid="project-repository"
            />
          )}
        </Field>
        <Field
          label={t('tasks.project_settings.branch')}
          hint={t('tasks.project_settings.branch_hint')}
        >
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              data-testid="project-branch"
            />
          )}
        </Field>
        {update.isError && <Notice tone="danger">{describeTaskError(update.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
