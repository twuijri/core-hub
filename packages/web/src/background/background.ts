/**
 * The Background panel (contract decision §47), the pure half: where each item lives in the
 * client, and how many things are running. No React.
 */
import { PROFILE_PARAM, chatHref } from '../chat/anchor.js';
import { agentRoute, routeOf } from '../navigation/manifest.js';
import type { BackgroundItem, BackgroundList } from '../types.js';

/** Pages a job opens, by its kind: where that work is started and followed. */
const JOB_PAGES: Record<string, string> = {
  export: 'workspaces',
  import: 'workspaces',
  install: 'agent_manager',
  update: 'agent_manager',
  uninstall: 'agent_manager',
  restart: 'agent_manager',
  check_update: 'agent_manager',
  discover: 'agent_manager',
  refresh_catalogue: 'models',
  worktree: 'tasks',
  webhook_test: 'webhooks',
  device_request: 'device_connections',
  schedule_run: 'schedules',
  workflow_run: 'schedules',
};

/**
 * Where an item lives: its conversation (a chat or schedule run, a subagent), the task board
 * (a task run), the Schedules page opened at the run (a workflow run), or the page its job is
 * about. `inLink` is the profile a link carries once the person has more than one.
 */
export function backgroundHref(
  item: BackgroundItem,
  inLink: (profile: string) => string | null,
): string | null {
  const profile = inLink(item.profile);
  if (item.kind === 'task_run') return routeOf('tasks');
  if (item.kind === 'workflow_run' && item.resource) {
    const params = new URLSearchParams({ workflow_run: item.resource.id });
    params.set(PROFILE_PARAM, item.profile);
    return `${routeOf('schedules')}?${params.toString()}`;
  }
  // A run or a subagent opens its conversation; the Subagents panel is there.
  if (item.session_id) return chatHref(item.session_id, null, undefined, profile);
  if (item.kind === 'job') {
    const kind = item.job_kind ?? '';
    if (item.resource?.kind === 'agent') {
      if (kind === 'plugin_install') return agentRoute('agent_plugins', item.resource.id);
      if (kind === 'channel_login') return agentRoute('agent_channels', item.resource.id);
    }
    const page = JOB_PAGES[kind];
    return page ? routeOf(page) : null;
  }
  return null;
}

/** How many things are working now: what the top-bar button counts. */
export function runningCount(list: BackgroundList | undefined): number {
  return list?.running?.length ?? 0;
}
