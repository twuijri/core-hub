import { describe, expect, it, vi } from 'vitest';
import { ConsentGate } from '../src/consent.js';
import {
  ProgramHost,
  ProgramRefusal,
  cleanProgramProfiles,
  programsOf,
  type HarnessMcp,
} from '../src/programs.js';

const mcp = (call: HarnessMcp['call']): HarnessMcp => ({
  servers: () => [
    { name: 'GitHub', state: 'connected' },
    { name: 'github', state: 'connected' },
    { name: 'resolve', state: 'connected' },
  ],
  tools: (server) =>
    server === 'resolve'
      ? [{ name: 'render', description: 'Render', input_schema: { type: 'object' } }]
      : [],
  call,
});

const host = (
  call: HarnessMcp['call'],
  answer: 'once' | 'session' | 'deny' = 'session',
  softDeadlineMs = 50,
) => {
  const record = vi.fn();
  return {
    record,
    host: new ProgramHost({
      mcp: mcp(call),
      profiles: () => ({ resolve: ['work'] }),
      consent: new ConsentGate(async () => answer),
      question: (p) => ({
        key: p.id,
        title: 't',
        message: 'm',
        labels: { once: 'o', session: 's', deny: 'd' },
      }),
      record,
      softDeadlineMs,
    }),
  };
};

describe('programs', () => {
  it('gives every server a unique id', () => {
    expect(
      programsOf([
        { name: 'GitHub', state: 'x' },
        { name: 'github', state: 'x' },
      ]).map((p) => p.id),
    ).toEqual(['github', 'github-2']);
  });

  it('keeps only valid profile choices', () => {
    expect(
      cleanProgramProfiles({ resolve: ['work', 'Bad Slug', 'work'], x: [], 'bad name!': ['a'] }),
    ).toEqual({
      resolve: ['work'],
    });
  });

  it('reports only switched-on programs, with their tools', () => {
    const { host: h } = host(async () => ({ content: [], isError: false }));
    expect(h.report()).toEqual([
      {
        id: 'resolve',
        name: 'resolve',
        profiles: ['work'],
        tools: [expect.objectContaining({ name: 'render' })],
      },
    ]);
  });

  it('refuses a program not shared with the profile, and a missing tool', async () => {
    const { host: h } = host(async () => ({ content: [], isError: false }));
    await expect(
      h.call({ programId: 'resolve', tool: 'render', args: {}, profile: 'default' }),
    ).rejects.toBeInstanceOf(ProgramRefusal);
    await expect(
      h.call({ programId: 'github', tool: 'x', args: {}, profile: 'work' }),
    ).rejects.toThrow(/not shared/);
    await expect(
      h.call({ programId: 'resolve', tool: 'nope', args: {}, profile: 'work' }),
    ).rejects.toThrow(/no tool/);
  });

  it('refuses when the person declines', async () => {
    const call = vi.fn();
    const { host: h, record } = host(call, 'deny');
    await expect(
      h.call({ programId: 'resolve', tool: 'render', args: {}, profile: 'work' }),
    ).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(call).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, detail: 'declined on this computer' }),
    );
  });

  it('answers done, or running and then done for a long call', async () => {
    const { host: quick } = host(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }));
    expect(
      await quick.call({ programId: 'resolve', tool: 'render', args: {}, profile: 'work' }),
    ).toEqual({
      state: 'done',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    let finish: (v: { content: Array<Record<string, unknown>>; isError: boolean }) => void = () =>
      undefined;
    const { host: slow } = host(() => new Promise((resolve) => (finish = resolve)), 'session', 10);
    const first = await slow.call({
      programId: 'resolve',
      tool: 'render',
      args: {},
      profile: 'work',
    });
    expect(first.state).toBe('running');
    const callId = first.state === 'running' ? first.callId : '';
    expect(slow.status(callId).state).toBe('running');
    finish({ content: [{ type: 'text', text: 'rendered' }], isError: false });
    await new Promise((r) => setTimeout(r, 5));
    expect(slow.status(callId)).toEqual({
      state: 'done',
      content: [{ type: 'text', text: 'rendered' }],
      isError: false,
    });
    expect(() => slow.status('nope')).toThrow(ProgramRefusal);
  });
});
