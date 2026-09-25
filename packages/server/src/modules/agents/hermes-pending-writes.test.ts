/**
 * The review list of memory and skill writes Hermes staged (contract decision §56): read from
 * Hermes's own `pending/<kind>/<id>.json`, rejected by removing the record, approved by Hermes's own
 * code — scripted here; the real Hermes applying one is `hermes-settings.real.test.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPROVE_PROGRAM,
  PendingWriteError,
  approvePendingWrite,
  listPendingWrites,
  rejectPendingWrite,
  type HermesPython,
} from './hermes-pending-writes.js';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-pending-'));
  homes.push(dir);
  return dir;
}

/** A record the way Hermes's `stage_write` writes it. */
function stage(dir: string, kind: 'memory' | 'skills', record: Record<string, unknown>): void {
  const folder = path.join(dir, 'pending', kind);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${String(record.id)}.json`), JSON.stringify(record));
}

describe('pending writes: the list', () => {
  it('lists memory and skill writes oldest first, with what each would change', () => {
    const dir = home();
    stage(dir, 'skills', {
      id: 'b2',
      subsystem: 'skills',
      action: 'patch',
      summary: "patch 'deploy' SKILL.md (+1/-1 lines)",
      origin: 'foreground',
      created_at: 1_790_000_200,
      payload: {
        action: 'patch',
        name: 'deploy',
        old_string: 'Fridays',
        new_string: 'Thursdays',
      },
    });
    stage(dir, 'memory', {
      id: 'a1',
      subsystem: 'memory',
      action: 'add',
      summary: 'Remember: the deploy runs on Fridays',
      origin: 'background_review',
      created_at: 1_790_000_100,
      payload: { action: 'add', target: 'user', content: 'Prefers Arabic.' },
    });
    stage(dir, 'memory', {
      id: 'c3',
      subsystem: 'memory',
      action: 'batch',
      summary: 'batch',
      origin: 'foreground',
      created_at: 1_790_000_300,
      payload: {
        action: 'batch',
        target: 'memory',
        operations: [
          { action: 'remove', old_text: 'old fact' },
          { action: 'add', content: 'new fact' },
        ],
      },
    });
    // Not Hermes's shape: left out rather than guessed at.
    writeFileSync(path.join(dir, 'pending', 'memory', 'broken.json'), '{not json');

    expect(listPendingWrites(dir)).toEqual([
      {
        id: 'a1',
        kind: 'memory',
        action: 'add',
        summary: 'Remember: the deploy runs on Fridays',
        origin: 'background_review',
        created_at: new Date(1_790_000_100_000).toISOString(),
        target: 'user',
        name: null,
        content: 'Prefers Arabic.',
        old_text: null,
      },
      {
        id: 'b2',
        kind: 'skills',
        action: 'patch',
        summary: "patch 'deploy' SKILL.md (+1/-1 lines)",
        origin: 'foreground',
        created_at: new Date(1_790_000_200_000).toISOString(),
        target: null,
        name: 'deploy',
        content: 'Thursdays',
        old_text: 'Fridays',
      },
      expect.objectContaining({ id: 'c3', content: '- old fact\n+ new fact' }),
    ]);
  });

  it('is empty where nothing waits', () => {
    expect(listPendingWrites(home())).toEqual([]);
  });
});

describe('pending writes: reject and approve', () => {
  it('rejects by removing the record, and a second reject is not found', () => {
    const dir = home();
    stage(dir, 'memory', { id: 'a1', payload: { action: 'add', content: 'x' } });
    rejectPendingWrite(dir, 'memory', 'a1');
    expect(existsSync(path.join(dir, 'pending', 'memory', 'a1.json'))).toBe(false);
    expect(() => rejectPendingWrite(dir, 'memory', 'a1')).toThrow(PendingWriteError);
    expect(() => rejectPendingWrite(dir, 'memory', '../config')).toThrow('pending_id_invalid');
  });

  it("approves through Hermes's own code, with the kind and id as arguments", async () => {
    const dir = home();
    stage(dir, 'skills', { id: 'b2', payload: { action: 'create', name: 'x', content: 'y' } });
    const calls: Array<{ home: string; argv: readonly string[] }> = [];
    const python: HermesPython = async (at, argv) => {
      calls.push({ home: at, argv });
      return { code: 0, stdout: '{"found": true, "applied": true, "error": ""}\n', stderr: '' };
    };
    await approvePendingWrite(python, dir, 'skills', 'b2');
    expect(calls).toEqual([{ home: dir, argv: [APPROVE_PROGRAM, 'skills', 'b2'] }]);
    expect(APPROVE_PROGRAM).toContain('apply_skill_pending');
    expect(APPROVE_PROGRAM).toContain('load_on_disk_store');
  });

  it("keeps the write waiting and says Hermes's words when Hermes cannot apply it", async () => {
    const dir = home();
    stage(dir, 'memory', { id: 'a1', payload: { action: 'add', content: 'x' } });
    const python: HermesPython = async () => ({
      code: 0,
      stdout: '{"found": true, "applied": false, "error": "Memory at 2190/2200 chars."}',
      stderr: '',
    });
    await expect(approvePendingWrite(python, dir, 'memory', 'a1')).rejects.toMatchObject({
      reason: 'pending_not_applied',
      hermesMessage: 'Memory at 2190/2200 chars.',
    });
    const crashed: HermesPython = async () => ({
      code: 1,
      stdout: '',
      stderr: 'Traceback …\nModuleNotFoundError: No module named tools',
    });
    await expect(approvePendingWrite(crashed, dir, 'memory', 'a1')).rejects.toMatchObject({
      reason: 'pending_not_applied',
      hermesMessage: 'ModuleNotFoundError: No module named tools',
    });
    await expect(approvePendingWrite(crashed, dir, 'memory', 'zz')).rejects.toMatchObject({
      reason: 'pending_not_found',
    });
  });
});
