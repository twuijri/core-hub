/**
 * The bridge's own logic, with a scripted runner — the argv it builds, how it reads
 * Hermes's answers, and how it relays a refusal. Runs everywhere.
 */
import { describe, expect, it } from 'vitest';
import {
  HermesRefusal,
  createHermesKanban,
  refusalOf,
  verbFor,
  type KanbanResult,
} from './hermes-kanban.js';

const ok = (stdout: unknown): KanbanResult => ({
  code: 0,
  stdout: JSON.stringify(stdout),
  stderr: '',
});

describe('the verb for a move', () => {
  it('asks for the verbs the real Hermes accepted', () => {
    expect(verbFor('todo', 'ready', 't_1')).toEqual(['promote', 't_1']);
    expect(verbFor('blocked', 'ready', 't_1')).toEqual(['unblock', 't_1']);
    expect(verbFor('review', 'ready', 't_1')).toEqual(['reopen-review', 't_1']);
    expect(verbFor('ready', 'review', 't_1')).toEqual(['request-review', 't_1']);
    expect(verbFor('ready', 'done', 't_1')).toEqual(['complete', 't_1']);
    expect(verbFor('done', 'archived', 't_1')).toEqual(['archive', 't_1']);
  });

  it('carries the reason for blocking and scheduling', () => {
    expect(verbFor('ready', 'blocked', 't_1', 'ننتظر المفتاح')).toEqual([
      'block',
      't_1',
      'ننتظر المفتاح',
    ]);
    expect(verbFor('ready', 'scheduled', 't_1', '  ')).toEqual(['schedule', 't_1', '—']);
  });

  it('leaves the triage exit to Hermes’s specifier', () => {
    // In Hermes a card leaves triage when a model has written its spec, not by a flag.
    expect(verbFor('triage', 'todo', 't_1')).toEqual(['specify', 't_1']);
  });

  it('never asks Hermes to set running, which is its worker’s to do', () => {
    expect(verbFor('ready', 'running', 't_1')).toBeNull();
  });
});

describe('reading Hermes’s answers', () => {
  it('reads the card from stdout and ignores the warnings on stderr', async () => {
    const kanban = createHermesKanban(async () => ({
      ...ok({ id: 't_8e06409d', title: 'جرّب', status: 'ready' }),
      stderr: 'kanban.db: linked SQLite 3.46.1 is vulnerable to the WAL-reset corruption bug',
    }));
    const card = await kanban.create({
      title: 'جرّب',
      idempotencyKey: '01J8QK3ZR2W7M5N4P6T8V9X0AB',
    });
    expect(card.id).toBe('t_8e06409d');
  });

  it('sends our id as the idempotency key, so a retried create finds its card', async () => {
    let seen: readonly string[] = [];
    const kanban = createHermesKanban(async (argv) => {
      seen = argv;
      return ok({ id: 't_1', title: 'x', status: 'ready' });
    });
    await kanban.create({ title: 'x', body: 'y', idempotencyKey: '01J8QK3ZR2W7M5N4P6T8V9X0AB' });
    expect(seen).toEqual([
      'create',
      'x',
      '--body',
      'y',
      '--idempotency-key',
      '01J8QK3ZR2W7M5N4P6T8V9X0AB',
      '--json',
    ]);
  });
});

describe('a refusal', () => {
  it('is Hermes’s own sentence, not the database warning above it', () => {
    const message = refusalOf({
      code: 1,
      stdout: '',
      stderr:
        'kanban.db: SQLite is vulnerable to the WAL-reset corruption bug — see `hermes doctor`.\n' +
        "cannot promote t_1: task t_1 is 'scheduled'; promote only applies to 'todo' or 'blocked'\n",
    });
    expect(message).toBe(
      "cannot promote t_1: task t_1 is 'scheduled'; promote only applies to 'todo' or 'blocked'",
    );
  });

  it('comes back as HermesRefusal, so the hub can answer 409 in Hermes’s words', async () => {
    const kanban = createHermesKanban(async () => ({
      code: 1,
      stdout: '',
      stderr: 'cannot block t_1\n',
    }));
    await expect(kanban.move('t_1', 'todo', 'blocked', 'x')).rejects.toBeInstanceOf(HermesRefusal);
    await expect(kanban.move('t_1', 'todo', 'blocked', 'x')).rejects.toThrow('cannot block t_1');
  });

  it('says so, rather than calling Hermes, when no verb exists for the move', async () => {
    let called = false;
    const kanban = createHermesKanban(async () => {
      called = true;
      return ok({});
    });
    await expect(kanban.move('t_1', 'ready', 'running')).rejects.toBeInstanceOf(HermesRefusal);
    expect(called).toBe(false);
  });
});
