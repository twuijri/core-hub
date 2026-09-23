/**
 * The shape of the board and the meaning of a drop. These are the rules the screen obeys,
 * so they are tested without one.
 */
import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  columnOf,
  dropOptions,
  isDropTarget,
  quickActionFor,
  quickActionTarget,
  transitionFor,
  type ColumnDef,
} from '../src/tasks/board.js';

const column = (id: string): ColumnDef => COLUMNS.find((c) => c.id === id)!;

describe('the shape of the board', () => {
  it('is an intake strip and four columns, not nine', () => {
    expect(COLUMNS.map((c) => c.id)).toEqual(['queue', 'waiting', 'review', 'done']);
  });

  it('puts the three stages of doing the work in one column', () => {
    expect(column('queue').statuses).toEqual(['todo', 'ready', 'running']);
  });

  it('puts both kinds of waiting — on a time and on a person — in one column', () => {
    expect(column('waiting').statuses).toEqual(['scheduled', 'blocked']);
  });

  it('shows the archive behind done rather than as a column of its own', () => {
    expect(columnOf('archived')).toBe('done');
  });

  it('gives the intake strip no column, because it is not one', () => {
    expect(columnOf('triage')).toBeNull();
  });

  it('shrinks the columns that are usually empty, and not the ones that are not', () => {
    expect(column('waiting').collapsible).toBe(true);
    // Review stays a full column even when empty (owner decision, 2026-09-23).
    expect(column('review').collapsible).toBe(false);
    expect(column('queue').collapsible).toBe(false);
    expect(column('done').collapsible).toBe(false);
  });
});

describe('what a drop means', () => {
  it('means nothing inside the same column: that is a reorder', () => {
    expect(dropOptions('todo', column('queue'))).toEqual([]);
    expect(transitionFor('ready', 'ready')).toBeNull();
  });

  it('asks which kind of waiting, because the drop could mean either', () => {
    const options = dropOptions('ready', column('waiting'));
    expect(options.map((option) => option.transition.action)).toEqual(['schedule', 'block']);
  });

  it('knows that blocking needs a reason and archiving needs a confirmation', () => {
    expect(transitionFor('ready', 'blocked')).toMatchObject({ requiresReason: true });
    expect(transitionFor('done', 'archived')).toMatchObject({ confirm: true });
  });

  it('never lets a person drop into the worker’s column', () => {
    // `running` is the worker's: a person promotes to `ready` and the hub takes it.
    expect(transitionFor('todo', 'running')).toBeNull();
    expect(transitionFor('ready', 'running')).toBeNull();
  });

  it('never lets a person drop into intake, but lets intake join the queue', () => {
    expect(transitionFor('todo', 'triage')).toBeNull();
    expect(transitionFor('done', 'triage')).toBeNull();
    expect(transitionFor('triage', 'todo')).toMatchObject({ action: 'queue' });
  });

  it('lets a blocked task come back to the queue, and a reviewed one be reopened', () => {
    expect(transitionFor('blocked', 'todo')).toMatchObject({ action: 'unblock' });
    expect(transitionFor('review', 'ready')).toMatchObject({ action: 'reopenReview' });
  });

  it('refuses a drop it has no meaning for, instead of moving the card anyway', () => {
    expect(isDropTarget('triage', column('done'))).toBe(false);
    expect(isDropTarget('triage', column('queue'))).toBe(true);
    expect(isDropTarget('done', column('queue'))).toBe(false);
  });

  it('accepts the drops it does have a meaning for', () => {
    expect(isDropTarget('todo', column('waiting'))).toBe(true);
    expect(isDropTarget('running', column('review'))).toBe(true);
    expect(isDropTarget('review', column('done'))).toBe(true);
  });
});

describe('the one thing a card offers without opening', () => {
  it('queues an intake task, promotes a todo, archives a done one', () => {
    expect(quickActionFor('triage')).toBe('queue');
    expect(quickActionFor('todo')).toBe('promote');
    expect(quickActionFor('done')).toBe('archive');
  });

  it('offers nothing while the work is in flight', () => {
    for (const status of ['ready', 'running', 'blocked', 'scheduled', 'review'] as const) {
      expect(quickActionFor(status), status).toBeNull();
    }
  });

  it('knows where each quick action moves the task', () => {
    expect(quickActionTarget('queue')).toBe('todo');
    expect(quickActionTarget('promote')).toBe('ready');
    expect(quickActionTarget('archive')).toBe('archived');
  });
});
