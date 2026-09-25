/**
 * The Workflows section of the Schedules page: every workflow of every profile the person
 * may enter (ADR 0016), each opened, run, copied or deleted in its own profile. A new one
 * is made in the profile of the top selector, and opens on the canvas.
 */
import { useState } from 'react';
import { useAuth } from '../../auth/context.js';
import { describeError } from '../../auth/client.js';
import { useI18n } from '../../i18n/context.js';
import { ProfileBadge } from '../../shell/ProfileBadge.js';
import { useManyProfiles, useProfileName } from '../../shell/profiles.js';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  Skeleton,
  SkeletonGroup,
  useConfirm,
  type BadgeTone,
} from '../../ui/index.js';
import { IconCopy, IconPlus, IconSchedules, IconTrash } from '../../ui/icons.js';
import { fromWorkflow } from './model.js';
import { useWorkflowWrites, useWorkflows, type WorkflowRow } from './queries.js';

const STATUS_TONE: Record<WorkflowRow['status'], BadgeTone> = {
  idle: 'neutral',
  running: 'info',
  waiting: 'warning',
  error: 'danger',
};

export function WorkflowsSection({
  onOpen,
  onNew,
  onShowRun,
}: {
  onOpen: (workflow: { id: string; profile: string }) => void;
  onNew: (profile: string) => void;
  onShowRun: (workflow: { id: string; profile: string }, runId: string) => void;
}) {
  const { t } = useI18n();
  const { homeProfile } = useAuth();
  const many = useManyProfiles();
  const profileName = useProfileName();
  const workflows = useWorkflows();
  const writes = useWorkflowWrites();
  const { ask, dialog } = useConfirm();
  const [notice, setNotice] = useState<string | null>(null);
  const error = writes.run.error ?? writes.create.error ?? writes.remove.error;

  return (
    <div className="flex flex-col gap-3" data-testid="workflows-section">
      <Card>
        <CardHeader
          title={t('workflows.new')}
          subtitle={t('workflows.new_hint', { name: profileName(homeProfile) })}
          actions={
            <Button
              variant="primary"
              icon={<IconPlus size={14} />}
              onClick={() => onNew(homeProfile)}
              data-testid="workflow-new"
            >
              {t('workflows.new')}
            </Button>
          }
        />
      </Card>
      {workflows.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          {[0, 1].map((i) => (
            <Skeleton key={i} height="4.5rem" radius="md" />
          ))}
        </SkeletonGroup>
      )}
      {workflows.isError && <Notice tone="danger">{describeError(workflows.error, t)}</Notice>}
      {error && <Notice tone="danger">{describeError(error, t)}</Notice>}
      {notice && !error && <Notice tone="success">{notice}</Notice>}
      {workflows.data && workflows.data.length === 0 && (
        <EmptyState
          icon={<IconSchedules size={20} />}
          title={t('workflows.empty')}
          body={t('workflows.empty_hint')}
        />
      )}
      <ul className="flex flex-col gap-3" data-testid="workflow-list">
        {(workflows.data ?? []).map((workflow) => (
          <li key={`${workflow.profile}:${workflow.id}`}>
            <Card testId="workflow-card" data-workflow-id={workflow.id}>
              <CardHeader
                title={<span dir="auto">{workflow.name}</span>}
                subtitle={`${t('workflows.steps_count', { count: workflow.nodes.length })} · ${t('workflows.runs_count', { count: workflow.run_count })}`}
                actions={
                  <span className="flex items-center gap-1">
                    {many && (
                      <ProfileBadge profile={workflow.profile} testId="workflow-card-profile" />
                    )}
                    <Badge tone={STATUS_TONE[workflow.status]}>
                      {t(`workflows.status.${workflow.status}`)}
                    </Badge>
                  </span>
                }
              />
              {workflow.description && (
                <p className="text-xs text-muted" dir="auto">
                  {workflow.description}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onOpen(workflow)}
                  data-testid="workflow-open"
                >
                  {t('workflows.open')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={workflow.nodes.length === 0}
                  loading={writes.run.isPending && writes.run.variables?.id === workflow.id}
                  onClick={() => {
                    setNotice(null);
                    writes.run.mutate(
                      { profile: workflow.profile, id: workflow.id, input: null },
                      {
                        onSuccess: (started) => {
                          setNotice(t('workflows.started', { name: workflow.name }));
                          onShowRun(workflow, started.workflow_run_id);
                        },
                      },
                    );
                  }}
                  data-testid="workflow-card-run"
                >
                  {t('workflows.run')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconCopy size={14} />}
                  loading={
                    writes.create.isPending &&
                    writes.create.variables?.draft.name ===
                      t('workflows.copy_name', { name: workflow.name })
                  }
                  onClick={() => {
                    setNotice(null);
                    const draft = fromWorkflow(workflow);
                    writes.create.mutate(
                      {
                        profile: workflow.profile,
                        draft: {
                          ...draft,
                          name: t('workflows.copy_name', { name: workflow.name }).slice(0, 120),
                        },
                      },
                      { onSuccess: (copy) => onOpen({ id: copy.id, profile: workflow.profile }) },
                    );
                  }}
                  data-testid="workflow-duplicate"
                >
                  {t('workflows.duplicate')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  className="ms-auto"
                  tooltip={t('common.delete')}
                  aria-label={t('common.delete')}
                  icon={<IconTrash size={14} />}
                  onClick={() => {
                    void ask({
                      title: t('workflows.confirm_delete', { name: workflow.name }),
                      confirmLabel: t('common.delete'),
                    }).then((sure) => {
                      if (sure)
                        writes.remove.mutate({ profile: workflow.profile, id: workflow.id });
                    });
                  }}
                  data-testid="workflow-delete"
                />
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {dialog}
    </div>
  );
}
