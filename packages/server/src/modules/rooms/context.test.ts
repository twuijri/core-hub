import { describe, expect, it } from 'vitest';
import {
  judgeHandoff,
  mentionedSeats,
  seatPrompt,
  trimmed,
  unseenFor,
  type ContextMessage,
} from './context.js';

const seats = [
  { id: 'A', name: 'Code' },
  { id: 'B', name: 'Code Reviewer' },
  { id: 'C', name: 'المخطِّط' },
];

const message = (
  seq: number,
  content: string,
  extra: Partial<ContextMessage> = {},
): ContextMessage => ({
  seq,
  authorKind: 'user',
  authorName: 'Tariq',
  seatId: null,
  content,
  status: 'complete',
  ...extra,
});

describe('room context', () => {
  it('reads whole seat names out of an agent reply, first mentioned first, never itself or code', () => {
    expect(
      mentionedSeats('Over to @Code Reviewer, then @Code.', seats, 'X').map((s) => s.id),
    ).toEqual(['B', 'A']);
    expect(mentionedSeats('@المخطِّط راجع', seats, 'X').map((s) => s.id)).toEqual(['C']);
    expect(mentionedSeats('I am @Code and done', seats, 'A')).toEqual([]);
    expect(mentionedSeats('run `@Code` or\n```\n@Code Reviewer\n```', seats, 'X')).toEqual([]);
    expect(mentionedSeats('@Coder is nobody; mail a@Code', seats, 'X')).toEqual([]);
  });

  it('keeps the newest messages that fit and says how many were left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => message(i + 1, `m${i + 1}`));
    const cut = trimmed(many);
    expect(cut.kept).toHaveLength(30);
    expect(cut.kept[0]!.seq).toBe(11);
    expect(cut.dropped).toBe(10);
    const long = trimmed([message(1, 'x'.repeat(100)), message(2, 'y'.repeat(100))], 30, 150);
    expect(long.kept.map((m) => m.seq)).toEqual([2]);
    const huge = trimmed([message(1, 'z'.repeat(500))], 30, 100);
    expect(huge.kept[0]!.content).toHaveLength(101);
  });

  it('shows a seat what others said, finished, and not its own words', () => {
    const unseen = unseenFor('A', [
      message(1, 'hello'),
      message(2, 'mine', { authorKind: 'seat', seatId: 'A', authorName: 'Code' }),
      message(3, '', { authorKind: 'seat', seatId: 'B', status: 'streaming' }),
      message(4, 'theirs', { authorKind: 'seat', seatId: 'B', authorName: 'Code Reviewer' }),
    ]);
    expect(unseen.map((m) => m.seq)).toEqual([1, 4]);
  });

  it('writes the turn: who, where, the others, how to pass, the summary and the new messages', () => {
    const prompt = seatPrompt({
      roomName: 'Launch',
      seat: { id: 'A', name: 'Code', description: 'writes the code', instructions: 'Tests first.' },
      others: [{ id: 'B', name: 'Code Reviewer', description: 'reviews', instructions: null }],
      people: ['Tariq'],
      summary: 'We ship in October.',
      handoffEnabled: true,
      unseen: [
        message(1, '@Code start'),
        message(2, 'ok', { authorKind: 'seat', seatId: 'B', authorName: 'Code Reviewer' }),
      ],
    });
    expect(prompt.split('\n')[0]).toBe(
      'You are @Code, one of the agents in the room "Launch" — a group conversation of people and AI agents.',
    );
    expect(prompt).toContain('Your role in this room: writes the code');
    expect(prompt).toContain('Your instructions for this room:\nTests first.');
    expect(prompt).toContain('Other agents here: @Code Reviewer (reviews).');
    expect(prompt).toContain('mention it as @Name');
    expect(prompt).toContain('Summary of the room so far:\nWe ship in October.');
    expect(prompt).toContain('[Tariq] @Code start\n[@Code Reviewer] ok');
  });

  it('the handoff guard: a repeated pass is a loop, too many is too deep, once goes through', () => {
    expect(
      judgeHandoff({ from: 'A', to: 'B', depth: 1, visited: ['A>B'], maxDepth: null }),
    ).toEqual({
      go: false,
      reason: 'loop_detected',
      depth: 2,
    });
    expect(judgeHandoff({ from: 'B', to: 'A', depth: 1, visited: ['A>B'], maxDepth: 3 })).toEqual({
      go: true,
      depth: 2,
      visited: ['A>B', 'B>A'],
    });
    expect(judgeHandoff({ from: 'B', to: 'C', depth: 3, visited: [], maxDepth: 3 })).toMatchObject({
      go: false,
      reason: 'max_depth',
    });
    expect(
      judgeHandoff({ from: 'A', to: 'B', depth: 3, visited: ['A>B'], maxDepth: 3, once: true }),
    ).toMatchObject({ go: true, depth: 4 });
  });
});
