/**
 * The rules of the MCP tool picker (DECISIONS §134, `src/agents/mcpToolFilter.ts`): Hermes's
 * matching, and the filter a choice of boxes is saved as.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedBy,
  filterToSave,
  globMatch,
  initialAllowed,
  lockedBy,
  preset,
  withLocks,
} from '../src/agents/mcpToolFilter.js';

const tools = ['get_issue', 'list_repos', 'create_issue', 'delete_repo'].map((name) => ({
  name,
  access: (name.startsWith('get') || name.startsWith('list') ? 'read' : 'write') as
    'read' | 'write',
}));
const all = new Set(tools.map((tool) => tool.name));

describe('matching as Hermes does', () => {
  it('matches exact names and fnmatch globs, case-sensitively', () => {
    expect(globMatch('get_issue', 'get_*')).toBe(true);
    expect(globMatch('Get_issue', 'get_*')).toBe(false);
    expect(globMatch('ab', 'a?')).toBe(true);
    expect(globMatch('a.b', 'a?b')).toBe(true);
    expect(globMatch('axb', 'a.b')).toBe(false);
    expect(globMatch('rb', '[rt]b')).toBe(true);
    expect(globMatch('xb', '[!rt]b')).toBe(true);
    expect(globMatch('rb', '[!rt]b')).toBe(false);
  });

  it('lets include win, then exclude, else everything', () => {
    expect(allowedBy({ include: ['get_*'], exclude: ['get_issue'] }, 'get_issue')).toBe(true);
    expect(allowedBy({ include: [], exclude: null }, 'get_issue')).toBe(false);
    expect(allowedBy({ include: null, exclude: ['delete_*'] }, 'delete_repo')).toBe(false);
    expect(allowedBy({ include: null, exclude: null }, 'anything')).toBe(true);
    expect(allowedBy(undefined, 'anything')).toBe(true);
  });
});

describe('saving a choice', () => {
  it('saves every box ticked as no filter, and a subset as an allow-list', () => {
    expect(filterToSave(undefined, tools, all)).toEqual({ include: null, exclude: null });
    expect(filterToSave(undefined, tools, preset('read', tools))).toEqual({
      include: ['get_issue', 'list_repos'],
      exclude: null,
    });
    expect(filterToSave(undefined, tools, preset('none', tools))).toEqual({
      include: [],
      exclude: null,
    });
  });

  it('keeps a block-list a block-list, and an entry for a tool the server no longer has', () => {
    const current = { include: null, exclude: ['delete_repo', 'old_tool'] };
    const allowed = initialAllowed(current, tools);
    expect([...allowed]).toEqual(['get_issue', 'list_repos', 'create_issue']);
    allowed.delete('create_issue');
    expect(filterToSave(current, tools, allowed)).toEqual({
      include: null,
      exclude: ['old_tool', 'create_issue', 'delete_repo'],
    });
    expect(
      filterToSave(
        { include: ['get_issue', 'gone'], exclude: null },
        tools,
        new Set(['list_repos']),
      ),
    ).toEqual({
      include: ['gone', 'list_repos'],
      exclude: null,
    });
  });

  it('keeps a hand-written pattern, and the tools it decides cannot be changed by a box', () => {
    const current = { include: ['get_*'], exclude: null };
    expect(lockedBy(current, 'get_issue')).toBe('get_*');
    expect(lockedBy(current, 'list_repos')).toBeNull();
    const none = withLocks(current, tools, preset('none', tools));
    expect([...none]).toEqual(['get_issue']);
    expect(filterToSave(current, tools, new Set(['get_issue', 'list_repos']))).toEqual({
      include: ['get_*', 'list_repos'],
      exclude: null,
    });
  });
});
