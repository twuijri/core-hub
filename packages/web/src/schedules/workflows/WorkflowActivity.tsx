/**
 * A workflow card while its run goes (owner, 2026-09-29): the card's edge turns green and a
 * brighter sweep goes round it — the task board's running card (`.task-card[data-frame]`),
 * the same tokens and the same turn — and the badge says "Running · <step>" or "Waiting for
 * approval". With reduced motion the edge stays green and still. The dot on the sidebar's
 * Workflows entry says the same for the whole profile.
 */
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/context.js';
import { Badge, type BadgeTone } from '../../ui/index.js';
import { useAnyWorkflowRunning, useCardActivity, type CardActivity } from './activity.js';
import type { WorkflowRow } from './queries.js';

const TONE: Record<CardActivity['state'], BadgeTone> = {
  idle: 'neutral',
  running: 'success',
  waiting: 'warning',
  error: 'danger',
};

/** Hands the card its state; the card lays itself out. */
export function WorkflowActivity({
  workflow,
  children,
}: {
  workflow: WorkflowRow;
  children(activity: CardActivity): ReactNode;
}) {
  return <>{children(useCardActivity(workflow))}</>;
}

/** The card's `data-frame`: the edge the stylesheet draws for a run going or waiting. */
export function frameOf(activity: CardActivity): 'running' | 'waiting' | undefined {
  return activity.state === 'running' || activity.state === 'waiting' ? activity.state : undefined;
}

export function WorkflowActivityBadge({ activity }: { activity: CardActivity }) {
  const { t } = useI18n();
  const label =
    activity.state === 'running'
      ? activity.step
        ? t('workflows.activity.running_step', { step: activity.step })
        : t('workflows.status.running')
      : activity.state === 'waiting'
        ? activity.step
          ? t('workflows.activity.waiting_step', { step: activity.step })
          : t('workflows.activity.waiting')
        : t(`workflows.status.${activity.state}`);
  return (
    <span data-testid="workflow-card-status" data-state={activity.state}>
      <Badge tone={TONE[activity.state]} className="workflow-status">
        {activity.state === 'running' && <span className="workflow-card-live" aria-hidden="true" />}
        {label}
      </Badge>
    </span>
  );
}

/**
 * The sidebar's Workflows entry: a small green dot that breathes while one of them runs. It is
 * the eye's cue only (`aria-hidden`): inside the link it would change the link's name while a
 * run goes; the page itself says which workflow runs and where it is.
 */
export function WorkflowsRunningDot({ profile }: { profile: string }) {
  if (!useAnyWorkflowRunning(profile)) return null;
  return (
    <span
      className="workflows-running-dot"
      aria-hidden="true"
      data-testid="sidebar-workflows-running"
    />
  );
}
