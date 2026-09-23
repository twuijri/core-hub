/**
 * What an agent is told when a task starts, and what the card keeps of what it said.
 * The run itself is exercised end to end in `tests/unit/task-runs.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { SUMMARY_MAX, summaryOf, taskPrompt } from './runs.js';

describe('tasks: the prompt a task starts with', () => {
  it('carries the title, the brief, the checklist as it stands, and the instructions', () => {
    const prompt = taskPrompt({
      key: 'HUB',
      task: { number: 12, title: 'Settings page', description: 'Phone first.' },
      subtasks: [
        { title: 'Design', status: 'done' },
        { title: 'Tests', status: 'todo' },
      ],
      instructions: 'Start with the account tab.',
      language: 'en',
    });
    expect(prompt).toContain('# HUB-12: Settings page');
    expect(prompt).toContain('Phone first.');
    expect(prompt).toContain('- [x] Design\n- [ ] Tests');
    expect(prompt).toContain('## Instructions\nStart with the account tab.');
    expect(prompt).toMatch(/short summary/);
  });

  it('leaves out what the task does not have, and speaks the person’s language', () => {
    const prompt = taskPrompt({
      key: 'HUB',
      task: { number: 1, title: 'صفحة', description: null },
      subtasks: [],
      instructions: '  ',
      language: 'ar',
    });
    expect(prompt).not.toContain('##');
    expect(prompt).toContain('ملخص قصير');
  });
});

describe('tasks: the progress summary', () => {
  it('keeps a short reply whole, and nothing for an empty one', () => {
    expect(summaryOf('  Done: added the page.  ')).toBe('Done: added the page.');
    expect(summaryOf('   ')).toBeNull();
  });

  it('keeps the end of a long reply, where the summary was asked for', () => {
    const long = `${'word '.repeat(400)}Summary: all green.`;
    const summary = summaryOf(long)!;
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX + 1);
    expect(summary.startsWith('…')).toBe(true);
    expect(summary.endsWith('Summary: all green.')).toBe(true);
  });
});
