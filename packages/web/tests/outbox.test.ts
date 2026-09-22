/**
 * The messages this tab holds back while a turn is alive, and how full the window is.
 * Both are rules, not drawings, so they are tested without a browser.
 */
import { describe, expect, it } from 'vitest';
import { contextUse, percentOf } from '../src/chat/ContextRing.js';
import { holdsBack, previewOfBlocks, queued } from '../src/chat/outbox.js';
import type { ContentBlock, Run } from '../src/types.js';

const text = (value: string): ContentBlock => ({ type: 'text', text: value }) as ContentBlock;

function run(id: string, input: number, output: number, started: string): Run {
  return {
    id,
    started_at: started,
    usage: { input_tokens: input, output_tokens: output, cost: null },
  } as unknown as Run;
}

describe('what "send" does while a run is alive', () => {
  it('holds a message back only in queue mode, and only while busy', () => {
    expect(holdsBack('queue', true)).toBe(true);
    expect(holdsBack(undefined, true)).toBe(true); // the contract's default
    expect(holdsBack('queue', false)).toBe(false);
    expect(holdsBack('next', true)).toBe(false);
    expect(holdsBack('interrupt', true)).toBe(false);
  });

  it('shows a few words of what was typed, and never the whole message', () => {
    expect(previewOfBlocks([text('  hello   there ')])).toBe('hello there');
    expect(previewOfBlocks([text('x'.repeat(200))])).toHaveLength(81);
    expect(previewOfBlocks([])).toBe('');
  });

  it('gives every waiting message a key of its own', () => {
    const a = queued([text('one')]);
    const b = queued([text('one')]);
    expect(a.key).not.toBe(b.key);
    expect(a.preview).toBe('one');
  });
});

describe('how full the window is', () => {
  it('says nothing at all when the model has no declared window', () => {
    expect(contextUse({ r1: run('r1', 10, 5, '2026-09-22T10:00:00Z') }, null)).toBeNull();
    expect(contextUse({ r1: run('r1', 10, 5, '2026-09-22T10:00:00Z') }, 0)).toBeNull();
  });

  it('says nothing until a turn has actually reported tokens', () => {
    expect(contextUse({}, 1000)).toBeNull();
    expect(contextUse({ r1: run('r1', 0, 0, '2026-09-22T10:00:00Z') }, 1000)).toBeNull();
  });

  it('reads the last turn that reported, not the sum of the conversation', () => {
    const use = contextUse(
      {
        r1: run('r1', 400, 100, '2026-09-22T10:00:00Z'),
        r2: run('r2', 200, 50, '2026-09-22T11:00:00Z'),
      },
      1000,
    );
    // A compacted conversation goes *down*: 250, not 750.
    expect(use).toEqual({ used: 250, window: 1000, ratio: 0.25 });
  });

  it('never claims a full window before it is full', () => {
    const use = contextUse({ r1: run('r1', 996, 0, '2026-09-22T10:00:00Z') }, 1000);
    expect(percentOf(use!)).toBe(99);
  });

  it('never goes past full when a provider counts more than the window', () => {
    const use = contextUse({ r1: run('r1', 5000, 0, '2026-09-22T10:00:00Z') }, 1000);
    expect(use?.ratio).toBe(1);
  });
});
