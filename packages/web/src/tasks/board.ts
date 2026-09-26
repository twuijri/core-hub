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

/**
 * How a card says its stage without a column of its own (owner's board decision,
 * 2026-09-17, rebuilt here): a frame around the whole card, each drawn differently so the
 * stage is not told by colour alone — and the status word stays on the card beside it.
 *
 * - **running** — a green frame that turns (still under reduced motion, but still green);
 * - **blocked** — a solid red frame;
 * - **scheduled** — an amber dashed frame, with a clock beside the word;
 * - **review** — a purple frame;
 * - **ready** — a quiet edge and a "ready" badge: ready is `todo` with a yes, not an alarm.
 *
 * `null` is a plain card: intake, `todo`, `done` and the archive.
 */
export type CardFrame = 'running' | 'blocked' | 'scheduled' | 'review' | 'ready';

export function cardFrame(status: TaskStatus): CardFrame | null {
  switch (status) {
    case 'running':
    case 'blocked':
    case 'scheduled':
    case 'review':
    case 'ready':
      return status;
    default:
      return null;
  }
}

/** Whether a card prints its stage as a word: every stage its column does not already say. */
export function showsStatusWord(status: TaskStatus): boolean {
  return status !== 'todo' && status !== 'triage';
}

export interface CollapseState {
  /** Cards in the column right now. */
  count: number;
  /** The person opened the strip by hand. */
  openedByHand: boolean;
  /** The status of the card being dragged, or `null` when nothing is. */
  dragging: TaskStatus | null;
}

/**
 * Whether a column is folded to a strip. Only a collapsible column folds, and only while it
 * is empty, nobody opened it, and the card being dragged (if any) could not be dropped
 * there — a strip that stays shut while a card is heading for it is a target nobody can
 * hit, and one that opens for a card it would refuse is a promise it cannot keep.
 */
export function isColumnCollapsed(column: ColumnDef, state: CollapseState): boolean {
  if (!column.collapsible) return false;
  if (state.count > 0 || state.openedByHand) return false;
  if (state.dragging !== null && isDropTarget(state.dragging, column)) return false;
  return true;
}

/** Titles as a sentence lists them, in the UI's language («أ، ب» / "A, B"). */
export function listOf(items: readonly string[], language: string): string {
  return items.join(language === 'ar' ? '، ' : ', ');
}
