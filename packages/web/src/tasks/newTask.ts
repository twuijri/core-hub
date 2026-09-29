/**
 * The New task dialog's rules, apart from the view so they are tested on their own: what the
 * form holds, what it refuses, and the `TaskCreate` it sends.
 *
 * The phones' twin is `TaskRules.create` (iOS `Screens/Tasks/TaskRules.swift`, Android
 * `TaskDetail.kt`): a task given to an agent and set to "Start now" is created, then started
 * with `tasks.assignTask(start: true)` — the web's "Assign and start" — because `TaskCreate`
 * has no model; the start is where the run's model is chosen (`TaskAssign.model`).
 */
import { cleanLines } from './CheckList.js';
import type { CheckItem, NewTaskBody } from './queries.js';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Where a new task waits (contract `TaskCreate.status`). */
export const NEW_STATUSES = ['triage', 'todo', 'ready'] as const;
export type NewStatus = (typeof NEW_STATUSES)[number];

/**
 * When it starts: not yet (someone starts it by hand), now (created, then started with the
 * chosen model), or on its own once it is Ready and everything it depends on is done
 * (`auto_start`).
 */
export type StartWhen = 'later' | 'now' | 'auto';

/** The contract's limit on a title (`TaskCreate.title.maxLength`). */
export const TITLE_MAX = 300;

export interface NewTaskForm {
  title: string;
  description: string;
  /** `null`: nobody for now. */
  agentId: string | null;
  /** The agent is Hermes: the card goes on Hermes's own kanban, which runs it (§103, §104). */
  hermes: boolean;
  /** `<provider>/<model>`, the catalogue's `key`; `null`: the agent's own default. */
  model: string | null;
  priority: Priority;
  /** The `datetime-local` field's value (`YYYY-MM-DDTHH:mm`, local time), or `''`. */
  due: string;
  /** As typed: separated by commas (Latin or Arabic). */
  tags: string;
  /** `''`: the profile's own list. */
  projectId: string;
  subtasks: CheckItem[];
  definitionOfDone: CheckItem[];
  constraints: CheckItem[];
  status: NewStatus;
  when: StartWhen;
}

export function emptyForm(title = ''): NewTaskForm {
  return {
    title,
    description: '',
    agentId: null,
    hermes: false,
    model: null,
    priority: 'normal',
    due: '',
    tags: '',
    projectId: '',
    subtasks: [],
    definitionOfDone: [],
    constraints: [],
    status: 'triage',
    // As on the phones ("Start now" on by default): it counts only once an agent is chosen.
    when: 'now',
  };
}

/**
 * What "when" means for this form. "Now" needs an agent to run it; Hermes's card is run by
 * Hermes's own dispatcher from its board, so the hub neither starts it nor auto-starts it.
 */
export function effectiveWhen(form: Pick<NewTaskForm, 'when' | 'agentId' | 'hermes'>): StartWhen {
  if (form.hermes) return 'later';
  if (form.when === 'now' && form.agentId === null) return 'later';
  return form.when;
}

/** Tags as the hub keeps them: trimmed, no empties, each once. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[,،]/)) {
    const tag = part.trim();
    if (tag !== '') seen.add(tag);
  }
  return [...seen];
}

/** The due field's local moment as an instant, or `null` when empty or not a date. */
export function dueInstant(due: string): Date | null {
  if (due.trim() === '') return null;
  const when = new Date(due);
  return Number.isNaN(when.getTime()) ? null : when;
}

export interface FormProblems {
  title?: 'required';
  due?: 'invalid' | 'past';
}

export function problemsOf(form: NewTaskForm, now: Date = new Date()): FormProblems {
  const problems: FormProblems = {};
  if (form.title.trim() === '') problems.title = 'required';
  if (form.due.trim() !== '') {
    const when = dueInstant(form.due);
    if (!when) problems.due = 'invalid';
    else if (when.getTime() < now.getTime()) problems.due = 'past';
  }
  return problems;
}

export function hasProblems(problems: FormProblems): boolean {
  return Object.keys(problems).length > 0;
}

/**
 * The `TaskCreate` for this form. Only what was filled is sent; lists a Hermes card cannot
 * take (§104: Hermes briefs its own worker from the card) are left out, never sent to be
 * refused.
 */
export function createBody(form: NewTaskForm): NewTaskBody {
  const when = effectiveWhen(form);
  const body: NewTaskBody = {
    title: form.title.trim(),
    status: form.status,
    priority: form.priority,
    auto_start: when === 'auto',
  };
  const description = form.description.trim();
  if (description !== '') body.description = form.description;
  if (form.agentId) body.assignee_agent_id = form.agentId;
  if (form.projectId) body.project_id = form.projectId;
  const tags = parseTags(form.tags);
  if (tags.length > 0) body.tags = tags;
  const due = dueInstant(form.due);
  if (due) body.due_at = due.toISOString();
  const subtasks = cleanLines(form.subtasks).map((item) => ({ title: item.text }));
  if (subtasks.length > 0) body.subtasks = subtasks;
  if (!form.hermes) {
    const done = cleanLines(form.definitionOfDone).map((item) => ({
      text: item.text,
      checked: false,
    }));
    const keep = cleanLines(form.constraints).map((item) => ({ text: item.text, checked: false }));
    if (done.length > 0) body.definition_of_done = done;
    if (keep.length > 0) body.constraints = keep;
  }
  return body;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (contract `Ulid`) for the `Idempotency-Key` header: 48 bits of time, 80 of chance. */
export function newUlid(now: number = Date.now()): string {
  let time = '';
  let rest = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[rest % 32]! + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = '';
  for (let i = 0; i < 16; i += 1) random += CROCKFORD[bytes[i]! % 32];
  return time + random;
}
