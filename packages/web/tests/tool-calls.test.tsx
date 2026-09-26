/**
 * The tools of a turn, and the "thinking" that was only the reply again.
 *
 * Owner decisions, 2026-09-23: tools sit **outside** the agent's bubble; a live run shows
 * the last four calls with the earlier ones a click away; a finished run folds them into
 * one line. And a reasoning block that merely repeats the reply is not shown — Hermes's
 * run stream sent the reply's opening as `reasoning.available`, and old sessions keep it.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { PaneProvider } from '../src/shell/pane.js';
import { MessageView } from '../src/chat/MessageView.js';
import { ToolCalls, LIVE_WINDOW } from '../src/chat/ToolCallCard.js';
import {
  durationParts,
  summarizeTools,
  toolActivity,
  WEB_LIVE_WINDOW,
} from '../src/chat/toolActivity.js';
import { AnsweredQuestions, answeredQuestions } from '../src/chat/AnsweredQuestions.js';
import { reasoningWorthShowing } from '../src/chat/turns.js';
import type { Message, ToolCall } from '../src/types.js';

const call = (id: string, name: string, extra: Partial<ToolCall> = {}): ToolCall =>
  ({
    id,
    name,
    status: 'succeeded',
    preview: null,
    arguments: null,
    output: null,
    output_truncated: false,
    duration_ms: 120,
    subagent_id: null,
    started_at: null,
    finished_at: null,
    ...extra,
  }) as ToolCall;

function mount(node: React.ReactNode) {
  return render(
    <I18nProvider language="en">
      <PaneProvider>{node}</PaneProvider>
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe('the tool activity rule (toolActivity)', () => {
  const six = (status: (i: number) => ToolCall['status'] = () => 'succeeded') =>
    ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => call(id, `tool_${id}`, { status: status(i) }));

  it('shows the last four while live and counts the rest as earlier', () => {
    const activity = toolActivity(six(), true);
    expect(WEB_LIVE_WINDOW).toBe(4);
    expect(activity.folded).toBe(false);
    expect(activity.visible.map((c) => c.id)).toEqual(['c', 'd', 'e', 'f']);
    expect(activity.hidden).toBe(2);
  });

  it('takes the window it is given (two on a phone)', () => {
    const activity = toolActivity(six(), true, 2);
    expect(activity.visible.map((c) => c.id)).toEqual(['e', 'f']);
    expect(activity.hidden).toBe(4);
  });

  it('keeps a failed or still-running call in view until the turn ends', () => {
    const calls = six((i) => (i === 0 ? 'failed' : i === 1 ? 'running' : 'succeeded'));
    const activity = toolActivity(calls, true, 2);
    expect(activity.visible.map((c) => c.id)).toEqual(['a', 'b', 'e', 'f']);
    expect(activity.hidden).toBe(2);
  });

  it('stays live while a call still runs or waits, even after the message ended', () => {
    const waiting = toolActivity([call('a', 'x', { status: 'awaiting_approval' })], false);
    expect(waiting.folded).toBe(false);
  });

  it('folds a finished turn into one summary', () => {
    const calls = [
      call('1', 'skill_view', {
        started_at: '2026-09-26T10:00:00.000Z',
        finished_at: '2026-09-26T10:00:05.000Z',
      }),
      call('2', 'vision_analyze', {
        status: 'failed',
        started_at: '2026-09-26T10:00:05.000Z',
        finished_at: '2026-09-26T10:00:40.000Z',
      }),
      call('3', 'terminal', {
        started_at: '2026-09-26T10:00:40.000Z',
        finished_at: '2026-09-26T10:01:00.000Z',
      }),
      call('4', 'vision_analyze', {
        started_at: '2026-09-26T10:01:00.000Z',
        finished_at: '2026-09-26T10:01:05.000Z',
      }),
    ];
    const activity = toolActivity(calls, false);
    expect(activity.folded).toBe(true);
    expect(activity.visible).toEqual([]);
    expect(activity.hidden).toBe(4);
    expect(activity.summary).toEqual({
      count: 4,
      failed: 1,
      durationMs: 65_000,
      names: ['vision_analyze', 'terminal', 'skill_view'],
    });
    expect(durationParts(65_000)).toEqual({ minutes: 1, seconds: 5 });
  });

  it('sums the durations when the calls carry no times, and says nothing when neither', () => {
    expect(summarizeTools([call('1', 'a'), call('2', 'b')]).durationMs).toBe(240);
    expect(summarizeTools([call('1', 'a', { duration_ms: null })]).durationMs).toBeNull();
    expect(durationParts(240)).toEqual({ minutes: 0, seconds: 1 });
  });
});

describe('a live run', () => {
  it(`shows the last ${LIVE_WINDOW} calls, the earlier ones on a click, and folds them back`, () => {
    const calls = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) =>
      call(id, `tool_${id}`, { status: i === 5 ? 'running' : 'succeeded' }),
    );
    mount(<ToolCalls calls={calls} live />);
    expect(screen.getAllByTestId('tool-call')).toHaveLength(LIVE_WINDOW);
    expect(screen.queryByText('tool_a')).toBeNull();
    const toggle = screen.getByTestId('tool-group-earlier');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('+2 earlier steps');
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('tool-call')).toHaveLength(6);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Hide the earlier steps');
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('tool-call')).toHaveLength(LIVE_WINDOW);
    expect(toggle).toHaveTextContent('+2 earlier steps');
  });

  it('keeps an early failure in view', () => {
    const calls = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) =>
      call(id, `tool_${id}`, { status: i === 0 ? 'failed' : 'succeeded' }),
    );
    mount(<ToolCalls calls={calls} live />);
    expect(screen.getAllByTestId('tool-call')).toHaveLength(LIVE_WINDOW + 1);
    expect(screen.getByText('tool_a')).toBeTruthy();
    expect(screen.getByTestId('tool-group-earlier')).toHaveTextContent('+1 earlier step');
  });
});

describe('a finished run', () => {
  it('folds into one line: how many steps, how long, how many failed, the latest tools', () => {
    const calls = [
      call('1', 'terminal', { duration_ms: 30_000 }),
      call('2', 'terminal', { duration_ms: 30_000 }),
      call('3', 'vision_analyze', { status: 'failed', duration_ms: 5_000 }),
    ];
    mount(<ToolCalls calls={calls} live={false} />);
    const summary = screen.getByTestId('tool-group-summary');
    expect(summary).toHaveTextContent('3 steps');
    expect(screen.getByTestId('tool-group-time')).toHaveTextContent('1m 05s');
    expect(screen.getByTestId('tool-group-failed')).toHaveTextContent('1 failed');
    expect(summary).toHaveTextContent('vision_analyze');
    expect(summary).toHaveTextContent('terminal');
    expect(screen.getByTestId('tool-group')).not.toHaveAttribute('open');
  });

  it('counts in Arabic with the right plural', () => {
    render(
      <I18nProvider language="ar">
        <PaneProvider>
          <ToolCalls calls={[call('1', 'a'), call('2', 'b')]} live={false} />
        </PaneProvider>
      </I18nProvider>,
    );
    expect(screen.getByTestId('tool-group-summary')).toHaveTextContent('خطوتان');
  });

  it('opens a call only when there is something inside it', () => {
    mount(
      <ToolCalls
        calls={[
          call('1', 'terminal', { preview: 'ps aux' }),
          call('2', 'read_file', { output: 'hello', arguments: { path: 'a.md' } }),
        ]}
        live={false}
      />,
    );
    const [bare, full] = screen.getAllByTestId('tool-call');
    expect(bare!.tagName).toBe('DIV');
    expect(full!.tagName).toBe('DETAILS');
    expect(within(full!).getByText('hello')).toBeTruthy();
    expect(screen.queryByText('No output.')).toBeNull();
  });
});

describe('where the tools sit', () => {
  it('outside the agent bubble', () => {
    const message = {
      id: 'm1',
      profile: 'default',
      owner_id: 'u',
      created_at: 't',
      updated_at: 't',
      session_id: 's',
      room_id: null,
      seq: 1,
      role: 'assistant',
      author: { kind: 'agent', id: null, name: 'Hermes', avatar: null },
      content: [{ type: 'text', text: 'Done.' }],
      reasoning: null,
      tool_calls: [call('1', 'terminal')],
      run_id: null,
      status: 'complete',
      mentions: [],
      handoff: null,
      usage: null,
      reply_to_message_id: null,
    } as unknown as Message;
    const { container } = mount(<MessageView message={message} showReasoning />);
    const bubble = container.querySelector('.msg-agent-body')!;
    expect(within(bubble as HTMLElement).queryByTestId('tool-group')).toBeNull();
    expect(screen.getByTestId('tool-group')).toBeTruthy();
  });
});

describe('reasoning that is only the reply', () => {
  const msg = (reasoning: string, reply: string) =>
    ({
      reasoning: { text: reasoning, duration_ms: null },
      content: [{ type: 'text', text: reply }],
    }) as unknown as Pick<Message, 'reasoning' | 'content'>;

  it('is hidden when the reply starts with it', () => {
    expect(
      reasoningWorthShowing(msg('أهلاً بك! كيف يمكنني', 'أهلاً بك!  كيف يمكنني مساعدتك؟')),
    ).toBe(false);
  });

  it('is shown when it says something else', () => {
    expect(reasoningWorthShowing(msg('The user greets me.', 'أهلاً بك!'))).toBe(true);
  });
});

describe('a question the agent asked', () => {
  it('stays in the reply with what was answered, skipped, or left to time out', () => {
    const calls = [
      call('1', 'clarify', {
        arguments: { question: 'Which device?' },
        output: JSON.stringify({
          question: 'Which device?',
          choices_offered: ['Mac', 'Windows'],
          user_response: 'Windows',
        }),
      }),
      call('2', 'clarify', {
        output: JSON.stringify({ question: 'Which branch?', user_response: '' }),
      }),
      call('3', 'clarify', {
        output: JSON.stringify({
          responses: [{ question: 'Name?', user_response: '' }],
          timed_out: true,
        }),
      }),
      call('4', 'clarify', { output: 'not json' }),
      call('5', 'terminal', { output: JSON.stringify({ question: 'x', user_response: 'y' }) }),
    ];
    expect(answeredQuestions(calls)).toEqual([
      { id: '1', question: 'Which device?', answer: 'Windows', timedOut: false },
      { id: '2', question: 'Which branch?', answer: '', timedOut: false },
      { id: '3:0', question: 'Name?', answer: '', timedOut: true },
    ]);
    mount(<AnsweredQuestions calls={calls} />);
    const rows = screen.getAllByTestId('answered-question');
    expect(rows[0]).toHaveTextContent('You answered: Windows');
    expect(rows[1]).toHaveTextContent('Question skipped');
    expect(rows[2]).toHaveTextContent('Time ran out without an answer');
  });
});
