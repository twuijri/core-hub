/**
 * The Background panel's list (contract decision §47): how jobs read in it, and how the items
 * of every source are put in one order.
 */
import { describe, expect, it } from 'vitest';
import { jobItem, mergeBackground, type BackgroundItem } from './background.js';
import type { JobRow } from './service.js';

const job = (over: Partial<JobRow>): JobRow =>
  ({
    id: '01J8QK3ZR2W7M5N4P6T8V9X0JB',
    workspace: '01J8QK3ZR2W7M5N4P6T8V9X0WS',
    ownerId: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    kind: 'auth.export',
    status: 'running',
    progress: -1,
    progressMessage: 'يصدّر البروفايل',
    entityKind: 'profile',
    entityId: '01J8QK3ZR2W7M5N4P6T8V9X0PF',
    startedAt: new Date('2026-09-25T10:00:00Z'),
    finishedAt: null,
    ...over,
  }) as JobRow;

const item = (over: Partial<BackgroundItem>): BackgroundItem => ({
  id: 'run:1',
  kind: 'chat_run',
  job_kind: null,
  title: 't',
  profile: 'default',
  status: 'running',
  started_at: null,
  finished_at: null,
  stoppable: true,
  session_id: null,
  resource: null,
  ...over,
});

describe('Background items from jobs', () => {
  it('reads a job as its verb, its progress line and its subject; stoppable only where it stops', () => {
    expect(jobItem(job({}), 'work')).toEqual({
      id: 'job:01J8QK3ZR2W7M5N4P6T8V9X0JB',
      kind: 'job',
      job_kind: 'export',
      title: 'يصدّر البروفايل',
      profile: 'work',
      status: 'running',
      started_at: '2026-09-25T10:00:00.000Z',
      finished_at: null,
      stoppable: true,
      session_id: null,
      resource: { kind: 'profile', id: '01J8QK3ZR2W7M5N4P6T8V9X0PF' },
    });
    expect(jobItem(job({ kind: 'agents.plugin_install' }), 'w')!.stoppable).toBe(false);
    expect(jobItem(job({ status: 'cancelling' }), 'w')).toMatchObject({
      status: 'running',
      stoppable: false,
    });
    expect(jobItem(job({ status: 'succeeded', progressMessage: null }), 'w')).toMatchObject({
      title: 'export',
      stoppable: false,
    });
  });

  it('leaves out the jobs a run stands for', () => {
    expect(jobItem(job({ kind: 'sessions.run' }), 'w')).toBeNull();
    expect(jobItem(job({ kind: 'tasks.run' }), 'w')).toBeNull();
  });
});

describe('one list from every source', () => {
  it('puts running first, oldest first and queued last, then the finished, newest first', () => {
    const merged = mergeBackground([
      item({ id: 'run:new', started_at: '2026-09-25T10:05:00Z' }),
      item({ id: 'run:queued', status: 'queued' }),
      item({ id: 'run:old', started_at: '2026-09-25T10:01:00Z' }),
      item({ id: 'job:a', status: 'succeeded', finished_at: '2026-09-25T09:00:00Z' }),
      item({ id: 'job:b', status: 'failed', finished_at: '2026-09-25T09:30:00Z' }),
      item({ id: 'run:old', started_at: '2026-09-25T10:01:00Z' }),
    ]);
    expect(merged.running.map((i) => i.id)).toEqual(['run:old', 'run:new', 'run:queued']);
    expect(merged.finished.map((i) => i.id)).toEqual(['job:b', 'job:a']);
  });

  it('shows at most fifty finished', () => {
    const many = Array.from({ length: 60 }, (_, n) =>
      item({
        id: `job:${n}`,
        status: 'succeeded',
        finished_at: `2026-09-25T09:${String(n).padStart(2, '0')}:00Z`,
      }),
    );
    expect(mergeBackground(many).finished).toHaveLength(50);
  });
});
