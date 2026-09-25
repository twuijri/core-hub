/**
 * Skill use is recorded from the agent's own tool calls (contract decision §47): Hermes loads a
 * skill with `skill_view(name, file_path?)`. A scripted run proves what counts — a completed
 * load, once per run and skill — and what does not: a failed load, a linked file of a skill
 * already loaded, an edit through `skill_manage`, any other tool.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { requireSqlite } from '../../lib/db.js';
import { modules as defaultModules } from '../index.js';
import { testHub } from '../../../tests/unit/helpers.js';
import { UsageAnalytics } from '../audit/index.js';
import { createSessionsModule } from './index.js';
import { skillUseOf } from './skill-use.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

describe('which tool call is a skill use', () => {
  const call = (name: string, input: Record<string, unknown>, status = 'succeeded') =>
    skillUseOf({ name, input, status: status as 'succeeded' });

  it('is a completed skill_view, named by its `name` argument', () => {
    expect(call('skill_view', { name: 'arxiv' })).toBe('arxiv');
    expect(call('skill_view', { name: ' superpowers:writing-plans ' })).toBe(
      'superpowers:writing-plans',
    );
    // A linked file of the skill is the same skill.
    expect(call('skill_view', { name: 'arxiv', file_path: 'references/api.md' })).toBe('arxiv');
  });

  it('is nothing else', () => {
    expect(call('skill_view', { name: 'arxiv' }, 'failed')).toBeNull();
    expect(call('skill_view', { name: 'arxiv' }, 'running')).toBeNull();
    expect(call('skill_view', {})).toBeNull();
    expect(call('skill_view', { name: '   ' })).toBeNull();
    expect(call('skill_manage', { name: 'arxiv', action: 'patch' })).toBeNull();
    expect(call('skills_list', {})).toBeNull();
    expect(call('read_file', { path: 'SKILL.md' })).toBeNull();
  });
});

describe('a run records the skills it loaded', () => {
  it('writes one use per run and skill, and the Skills usage report reads them', async () => {
    const sessions = createSessionsModule({
      agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
      runner: new FakeAgentRunner({
        script: [
          // What Hermes's TUI gateway sends, as the adapter turns it into events.
          { type: 'tool_started', ref: 't1', name: 'skill_view', input: { name: 'arxiv' } },
          { type: 'tool_completed', ref: 't1', output: '{"success": true, "name": "arxiv"}' },
          {
            type: 'tool_started',
            ref: 't2',
            name: 'skill_view',
            input: { name: 'arxiv', file_path: 'references/api.md' },
          },
          { type: 'tool_completed', ref: 't2', output: '{"success": true}' },
          { type: 'tool_started', ref: 't3', name: 'skill_view', input: { name: 'nope' } },
          { type: 'tool_failed', ref: 't3', output: '{"success": false}' },
          {
            type: 'tool_started',
            ref: 't4',
            name: 'skill_manage',
            input: { name: 'arxiv', action: 'patch' },
          },
          { type: 'tool_completed', ref: 't4', output: 'patched' },
          {
            type: 'tool_started',
            ref: 't5',
            name: 'skill_view',
            input: { name: 'github-pr-workflow' },
          },
          { type: 'tool_completed', ref: 't5', output: '{"success": true}' },
          { type: 'message_delta', text: 'تم.' },
          { type: 'completed' },
        ],
      }),
    });
    const h = await testHub(
      {},
      { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
    );
    try {
      const headers = { 'x-hub-profile': 'default' };
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers,
        payload: { agent_id: AGENT_ID },
      });
      const id = (created.json() as { id: string }).id;
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${id}/runs`,
        headers,
        payload: { content: [{ type: 'text', text: 'ابحث في arxiv' }] },
      });
      let live = true;
      for (let attempt = 0; attempt < 50 && live; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const trajectory = await h.app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${id}/trajectory`,
          headers,
        });
        live = (trajectory.json() as { live: boolean }).live;
      }
      expect(live).toBe(false);

      const db = requireSqlite(h.app.hub.database);
      // `skill_uses` is `audit`'s table; read it the way any caller outside `audit` could.
      const rows = db.all<{
        skill: string;
        sessionId: string;
        agentId: string;
        runId: string;
        workspace: string;
      }>(
        sql`SELECT skill, session_id AS sessionId, agent_id AS agentId, run_id AS runId, workspace FROM skill_uses`,
      );
      expect(rows.map((row) => row.skill).sort()).toEqual(['arxiv', 'github-pr-workflow']);
      expect(rows.every((row) => row.sessionId === id && row.agentId === AGENT_ID)).toBe(true);
      expect(new Set(rows.map((row) => row.runId)).size).toBe(1);

      expect(rows[0]!.workspace).toBe(rows[1]!.workspace);
      const report = new UsageAnalytics(db).skills({
        profiles: [{ id: rows[0]!.workspace, slug: 'default', isDefault: true }],
        days: 7,
      });
      expect(report.totals).toMatchObject({ uses: 2, distinct_skills: 2 });
      expect(typeof report.counting_since).toBe('string');
    } finally {
      await h.close();
    }
  });
});
