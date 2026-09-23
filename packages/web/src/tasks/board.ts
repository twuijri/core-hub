/**
 * The shape of the board: which statuses share a column, and which drops mean what.
 *
 * The hub keeps nine task statuses. Showing nine columns was a mistake — it is the shape
 * the *data* has, not the shape the *work* has (owner, 2026-09-22: the board must look
 * like the one we built for Hermes). So the board is an **intake strip plus four
 * columns**, and the card says which stage inside the column it is in:
 *
 * - **queue** — `todo` → `ready` → `running`, the three stages of "this is being done";
 * - **waiting** — `scheduled` (waiting on a time) and `blocked` (waiting on a person);
 * - **review** — done by the agent, not yet accepted;
 * - **done** — accepted, with the archive folded in behind it.
 *
 * `triage` is the intake strip: a task arrives there and is *specified* before it joins
 * the queue, so nothing is ever dropped into it. `running` is the worker's, so nothing is
 * dropped there either.
 *
 * A drop into a column can mean more than one thing — dropping into **waiting** is either
 * "schedule it" or "it is blocked" — and when it does, the person is asked which rather
 * than being given whichever the code happened to try first.
 */
export const TASK_STATUSES = [
  'triage',
  'todo',
  'ready',
  'scheduled',
  'running',
  'blocked',
  'review',
  'done',
  'archived',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type ColumnId = 'queue' | 'waiting' | 'review' | 'done';

export interface ColumnDef {
  id: ColumnId;
  statuses: readonly TaskStatus[];
  /** A column that shrinks to a strip while it is empty. */
  collapsible: boolean;
}

export const INTAKE_STATUS: TaskStatus = 'triage';
export const ARCHIVED_STATUS: TaskStatus = 'archived';

export const COLUMNS: readonly ColumnDef[] = [
  { id: 'queue', statuses: ['todo', 'ready', 'running'], collapsible: false },
  // Waiting is usually empty, and an empty column that takes a full slot is a column
  // that pushes the work off the screen.
  { id: 'waiting', statuses: ['scheduled', 'blocked'], collapsible: true },
  // Review stays a full column even when empty (owner decision, 2026-09-23): only intake
  // and Waiting fold to strips.
  { id: 'review', statuses: ['review'], collapsible: false },
  { id: 'done', statuses: ['done'], collapsible: false },
];

export type TransitionAction =
  | 'queue'
  | 'promote'
  | 'schedule'
  | 'block'
  | 'unblock'
  | 'requestReview'
  | 'reopenReview'
  | 'complete'
  | 'archive';

export interface Transition {
  action: TransitionAction;
  /** The hub refuses this move without a reason, so the board asks for one first. */
  requiresReason: boolean;
  /** Terminal: confirm before doing it. */
  confirm: boolean;
}

function transition(action: TransitionAction, over: Partial<Transition> = {}): Transition {
  return { action, requiresReason: false, confirm: false, ...over };
}

/**
 * What a move from one status to another means, or `null` when it is not a move a person
 * may make. Keyed by destination, because that is the question a drop asks.
 */
const RULES: Partial<Record<TaskStatus, Partial<Record<TaskStatus, Transition>>>> = {
  todo: {
    // Intake joins the queue: the one move out of the strip, and the only one.
    triage: transition('queue'),
    blocked: transition('unblock'),
    scheduled: transition('unblock'),
    review: transition('reopenReview'),
  },
  ready: {
    todo: transition('promote'),
    blocked: transition('unblock'),
    scheduled: transition('unblock'),
    review: transition('reopenReview'),
  },
  scheduled: {
    todo: transition('schedule'),
    ready: transition('schedule'),
    running: transition('schedule'),
    blocked: transition('schedule'),
  },
  blocked: {
    todo: transition('block', { requiresReason: true }),
    ready: transition('block', { requiresReason: true }),
    running: transition('block', { requiresReason: true }),
  },
  review: {
    ready: transition('requestReview'),
    running: transition('requestReview'),
  },
  done: {
    ready: transition('complete'),
    running: transition('complete'),
    review: transition('complete'),
    blocked: transition('complete'),
  },
  archived: {
    done: transition('archive', { confirm: true }),
  },
};

export function transitionFor(from: TaskStatus, to: TaskStatus): Transition | null {
  if (from === to) return null;
  return RULES[to]?.[from] ?? null;
}

export interface ColumnDrop {
  to: TaskStatus;
  transition: Transition;
}

/**
 * Everything a drop into `column` could mean for a card coming from `from`. A move inside
 * the same column is a reorder and means nothing; one option runs straight away; several
 * are put to the person.
 */
export function dropOptions(from: TaskStatus, column: ColumnDef): ColumnDrop[] {
  if (column.statuses.includes(from)) return [];
  const seen = new Set<TransitionAction>();
  const options: ColumnDrop[] = [];
  for (const to of column.statuses) {
    const found = transitionFor(from, to);
    if (!found || seen.has(found.action)) continue;
    seen.add(found.action);
    options.push({ to, transition: found });
  }
  return options;
}

export function isDropTarget(from: TaskStatus, column: ColumnDef): boolean {
  return column.statuses.includes(from) || dropOptions(from, column).length > 0;
}

/** The column a status is shown in; `null` for the intake strip. */
export function columnOf(status: TaskStatus): ColumnId | null {
  if (status === ARCHIVED_STATUS) return 'done';
  return COLUMNS.find((column) => column.statuses.includes(status))?.id ?? null;
}

/**
 * The one thing a card offers without opening anything: the move a person almost always
 * wants next from that stage. Everything else is in the menu.
 */
export type QuickAction = 'queue' | 'promote' | 'archive';

export function quickActionFor(status: TaskStatus): QuickAction | null {
  if (status === 'triage') return 'queue';
  if (status === 'todo') return 'promote';
  if (status === 'done') return 'archive';
  return null;
}

/** Where that quick action moves the task. */
export function quickActionTarget(action: QuickAction): TaskStatus {
  if (action === 'queue') return 'todo';
  if (action === 'promote') return 'ready';
  return 'archived';
}
