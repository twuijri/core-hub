/**
 * Anthropic Messages ↔ OpenAI Chat, as the gateway speaks it for a Google model on Claude's wire
 * (DECISIONS §148): a conversation with tools, images and thinking carried across, and a Chat
 * stream answered as Anthropic's, cut anywhere.
 */
import { describe, expect, it } from 'vitest';
import {
  ChatToAnthropicStream,
  anthropicToChat,
  chatErrorToAnthropic,
  chatToAnthropic,
} from './anthropic-chat.js';

describe('Anthropic to Chat', () => {
  it('carries the system prompt, text, images, tool calls and their results, in order', () => {
    const chat = anthropicToChat(
      {
        model: 'ignored',
        system: [
          { type: 'text', text: 'You are Claude Code.' },
          { type: 'text', text: 'Be brief.' },
        ],
        max_tokens: 32000,
        temperature: 0.2,
        stop_sequences: ['END'],
        stream: true,
        output_config: { effort: 'high' },
        tool_choice: { type: 'tool', name: 'Read' },
        tools: [
          { name: 'Read', description: 'Read a file', input_schema: { type: 'object' } },
          { type: 'web_search_20250305', name: 'web_search' },
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'secret', signature: 'x' },
              { type: 'text', text: 'Reading.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.md' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'A', is_error: true },
              { type: 'text', text: 'and?' },
            ],
          },
        ],
      },
      'h01k/gemini-3-flash',
    );
    expect(chat).toEqual({
      model: 'h01k/gemini-3-flash',
      messages: [
        { role: 'system', content: 'You are Claude Code.\nBe brief.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
        {
          role: 'assistant',
          content: 'Reading.',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: { name: 'Read', arguments: '{"path":"a.md"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: 'Error: A' },
        { role: 'user', content: 'and?' },
      ],
      max_tokens: 32000,
      temperature: 0.2,
      stop: ['END'],
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
      // A server tool of Anthropic's (no schema) is not a function the model can call.
      tools: [
        {
          type: 'function',
          function: { name: 'Read', description: 'Read a file', parameters: { type: 'object' } },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'Read' } },
    });
  });
});

describe('Chat to Anthropic', () => {
  it('answers a whole Chat answer as an Anthropic message', () => {
    expect(
      chatToAnthropic(
        {
          id: 'c1',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'Hi',
                reasoning_content: 'think',
                tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: '{"p":1}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        },
        'gemini-3-flash',
      ),
    ).toEqual({
      id: 'c1',
      type: 'message',
      role: 'assistant',
      model: 'gemini-3-flash',
      content: [
        { type: 'thinking', thinking: 'think', signature: '' },
        { type: 'text', text: 'Hi' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { p: 1 } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 },
    });
    expect(JSON.parse(chatErrorToAnthropic(429, '{"error":{"message":"slow"}}'))).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow' },
    });
  });

  it('turns a Chat stream into Anthropic’s, cut at every byte, Arabic included', () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const sse =
      chunk({ role: 'assistant', content: '' }) +
      chunk({ content: 'هلا! ' }) +
      chunk({ content: 'كيف أقدر أساعد؟' }) +
      chunk({}, 'stop') +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n` +
      'data: [DONE]\n\n';
    const bytes = Buffer.from(sse, 'utf8');
    for (const cut of [1, 2, 3, 7, bytes.length]) {
      const stream = new ChatToAnthropicStream('gemini-3-flash', 'msg_1');
      let out = '';
      for (let at = 0; at < bytes.length; at += cut)
        out += stream.push(bytes.subarray(at, at + cut));
      out += stream.end();
      const events = out
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Anthropic SSE events, read by path in assertions
        .map((line) => JSON.parse(line.slice(6)) as Record<string, any>);
      expect(events.map((e) => e.type)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect(
        events
          .filter((e) => e.type === 'content_block_delta')
          .map((e) => e.delta.text)
          .join(''),
      ).toBe('هلا! كيف أقدر أساعد؟');
      expect(events.at(-2)).toMatchObject({
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 5, output_tokens: 4 },
      });
    }
  });

  it('ends a stream the provider cut off with the events Anthropic’s clients wait for', () => {
    const stream = new ChatToAnthropicStream('gemini-3-flash', 'msg_2');
    const out =
      stream.push(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi' } }] })}\n\n`,
      ) + stream.end();
    expect(out).toContain('"type":"content_block_stop"');
    expect(out).toContain('"type":"message_stop"');
  });
});
