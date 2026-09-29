/**
 * Workflows: every workflow of every profile the person may enter, each drawn and run on its
 * canvas (`schedules/workflows/`, DECISIONS §52).
 *
 * Its own page since 2026-09-28 (owner, DECISIONS §126) — until then it was a tab of Schedules.
 * The address keeps what the tab carried, without the tab: `/workflows?workflow=<id|new>&
 * profile=<slug>[&run=<id|latest>]` opens one on the canvas, and `?workflow_run=<id>&profile=`
 * opens one run. The old `/schedules?section=workflows…` address still lands here
 * (`SchedulesScreen`), with the rest of it kept.
 */
import { Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { WorkflowRunDialog } from '../schedules/ScheduleRuns.js';
import { useScheduleEvents } from '../schedules/events.js';
import { WorkflowsSection } from '../schedules/workflows/WorkflowsSection.js';
import { PanelBoundary } from '../schedules/workflows/PanelBoundary.js';
import { AppShell } from '../shell/AppShell.js';
import { Skeleton } from '../ui/index.js';

// The canvas is loaded only when a workflow is opened.
const WorkflowEditor = lazy(() => import('../schedules/workflows/WorkflowEditor.js'));

/** The query of an old `/schedules?section=workflows…` address, as this page reads it. */
export function workflowsQueryFromSchedules(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('section');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

export function WorkflowsScreen() {
  const { t } = useI18n();
  const title = t(termKey('workflows'));
  // Live: a run started anywhere — a trigger, a schedule, another tab — shows on its card.
  useScheduleEvents();
  const { homeProfile } = useAuth();
  const [params, setParams] = useSearchParams();
  const editing = params.get('workflow');
  const editingProfile = params.get('profile') ?? homeProfile;
  const openRun = params.get('workflow_run');
  const openRunProfile = params.get('profile') ?? homeProfile;
  const showWorkflow = (
    workflow: { id: string; profile: string } | null,
    run: string | null = null,
  ) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (workflow) {
        next.set('workflow', workflow.id);
        next.set('profile', workflow.profile);
      } else {
        next.delete('workflow');
        next.delete('profile');
      }
      if (run) next.set('run', run);
      else next.delete('run');
      return next;
    });
  const closeRun = () =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('workflow_run');
      // The editor keeps its workflow's profile in the same place.
      if (!next.get('workflow')) next.delete('profile');
      return next;
    });

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>
      {editing ? (
        <PanelBoundary resetKey={editing} testId="workflow-editor-failed">
          <Suspense fallback={<Skeleton height="30rem" radius="md" />}>
            <WorkflowEditor
              workflowId={editing === 'new' ? null : editing}
              profile={editingProfile}
              runId={params.get('run')}
              onBack={() => showWorkflow(null)}
              onSaved={(id) => showWorkflow({ id, profile: editingProfile })}
              onShowRun={(run, id) =>
                showWorkflow({ id: id ?? editing, profile: editingProfile }, run)
              }
            />
          </Suspense>
        </PanelBoundary>
      ) : (
        <WorkflowsSection
          onOpen={(workflow) => showWorkflow(workflow)}
          onNew={(profile) => showWorkflow({ id: 'new', profile })}
          onShowRun={(workflow, run) => showWorkflow(workflow, run)}
        />
      )}
      {openRun && <WorkflowRunDialog runId={openRun} profile={openRunProfile} onClose={closeRun} />}
    </AppShell>
  );
}
