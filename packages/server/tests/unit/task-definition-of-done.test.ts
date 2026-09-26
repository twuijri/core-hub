/**
 * A task's definition of done and its constraints (contract decision §104): written with the
 * task, sent to the agent in the run's prompt, ticked by the reviewer, and cleared when the
 * task runs again — across `tasks` and `sessions`, joined as production joins them.
 */
import { describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { taskRunsFor } from '../../src/modules/tasks/index.js';
import { taskPrompt } from '../../src/modules/tasks/runs.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
const AGENT = '01KAGENTXYZ000000000000000';

async function hub() {
  const runner = new FakeAgentRunner({
    script: [{ type: 'message_delta', text: 'تم.' }, { type: 'completed' }],
  });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  const modules = defaultModules.map((module) => (module.name === 'sessions' ? sessions : module));
  return { hub: await signedInHub({}, { modules }), runner };
}

const promptOf = (runner: FakeAgentRunner, index: number) =>
  (runner.started[index]?.prompt ?? [])
    .map((block) => ('text' in block ? block.text : ''))
    .join('');

describe('tasks: definition of done and constraints (§104)', () => {
  it('keeps both lists with the task, trimmed, unticked unless ticked', async () => {
    const { hub: h } = await hub();
    try {
      const created = await authed(h, h.token, {
        method: 'POST',
        url: '/api/v1/tasks',
        payload: {
          title: 'صفحة الإعدادات',
          definition_of_done: [
            { text: '  الاختبارات تمر  ' },
            { text: 'لقطة للصفحة', checked: true },
          ],
          constraints: [{ text: 'لا مكتبات جديدة' }],
        },
      });
      expect(created.statusCode).toBe(201);
      const task = created.json() as Json;
      expect(task.definition_of_done).toEqual([
        { text: 'الاختبارات تمر', checked: false },
        { text: 'لقطة للصفحة', checked: true },
      ]);
      expect(task.constraints).toEqual([{ text: 'لا مكتبات جديدة', checked: false }]);

      // A task written before these lists existed reads them as empty.
      const plain = (
        await authed(h, h.token, { method: 'POST', url: '/api/v1/tasks', payload: { title: 'x' } })
      ).json() as Json;
      expect(plain.definition_of_done).toEqual([]);
      expect(plain.constraints).toEqual([]);

      const edited = await authed(h, h.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${task.id as string}`,
        payload: { constraints: [] },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({
        constraints: [],
        definition_of_done: [{ text: 'الاختبارات تمر' }, { text: 'لقطة للصفحة' }],
      });

      // The contract bounds a line.
      const long = await authed(h, h.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${task.id as string}`,
        payload: { definition_of_done: [{ text: 'x'.repeat(501) }] },
      });
      expect(long.statusCode).toBe(400);
    } finally {
      await h.close();
    }
  });

  it('sends them to the agent, the reviewer ticks them, and the next run clears the ticks', async () => {
    const { hub: h, runner } = await hub();
    try {
      const task = (
        await authed(h, h.token, {
          method: 'POST',
          url: '/api/v1/tasks',
          payload: {
            title: 'صفحة الإعدادات',
            status: 'ready',
            definition_of_done: [{ text: 'الاختبارات تمر' }, { text: 'تعمل على الهاتف' }],
            constraints: [{ text: 'لا تلمس ملف الترجمة' }],
          },
        })
      ).json() as Json & { id: string };
      const start = () =>
        authed(h, h.token, {
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/assign`,
          payload: { agent_id: AGENT, start: true },
        });
      expect((await start()).statusCode).toBe(202);
      await taskRunsFor(h.app).settled();
      const prompt = promptOf(runner, 0);
      expect(prompt).toContain('## Definition of done');
      expect(prompt).toContain('- الاختبارات تمر');
      expect(prompt).toContain('- تعمل على الهاتف');
      expect(prompt).toContain('## Constraints');
      expect(prompt).toContain('- لا تلمس ملف الترجمة');

      const inReview = (
        await authed(h, h.token, { method: 'GET', url: `/api/v1/tasks/${task.id}` })
      ).json() as Json;
      expect(inReview.status).toBe('review');
      // The reviewer ticks what holds: the list as it is, with those lines checked.
      const ticked = await authed(h, h.token, {
        method: 'PATCH',
        url: `/api/v1/tasks/${task.id}`,
        payload: {
          definition_of_done: [
            { text: 'الاختبارات تمر', checked: true },
            { text: 'تعمل على الهاتف', checked: false },
          ],
          constraints: [{ text: 'لا تلمس ملف الترجمة', checked: true }],
        },
      });
      expect(ticked.json()).toMatchObject({
        definition_of_done: [{ checked: true }, { checked: false }],
        constraints: [{ checked: true }],
      });

      // Sent back for another attempt: the ticks were about the last one's work.
      expect((await start()).statusCode).toBe(202);
      await taskRunsFor(h.app).settled();
      const again = (
        await authed(h, h.token, { method: 'GET', url: `/api/v1/tasks/${task.id}` })
      ).json() as Json;
      expect(again.definition_of_done).toEqual([
        { text: 'الاختبارات تمر', checked: false },
        { text: 'تعمل على الهاتف', checked: false },
      ]);
      expect(again.constraints).toEqual([{ text: 'لا تلمس ملف الترجمة', checked: false }]);
      expect(promptOf(runner, 1)).toContain('- تعمل على الهاتف');
    } finally {
      await h.close();
    }
  });

  it('writes them in the language of the run, and leaves them out when there are none', () => {
    const base = { key: 'HUB', task: { number: 3, title: 'Page', description: null } };
    const english = taskPrompt({
      ...base,
      task: {
        ...base.task,
        definitionOfDone: [{ text: 'tests pass', checked: true }],
        constraints: [{ text: 'no new packages', checked: false }],
      },
      subtasks: [],
      instructions: null,
      language: 'en',
    });
    expect(english).toContain(
      '## Definition of done\nThe task is done only when every one of these holds:\n- tests pass',
    );
    expect(english).toContain('## Constraints\nKeep to these while you work:\n- no new packages');
    const bare = taskPrompt({ ...base, subtasks: [], instructions: null, language: 'en' });
    expect(bare).not.toContain('Definition of done');
    expect(bare).not.toContain('Constraints');
  });
});
