import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../adapters/types.js';
import { agentTurn, type AgentTurnEvent, type AgentTurnReport } from './agent-turn.js';
import type { GeminiDesktop, GeminiDesktopTurn } from './index.js';
import { historyHash } from './threads.js';
import {
  conversationKey,
  readAnswer,
  renderAssistant,
  shownSoFar,
  threadOf,
  toolsOf,
  type ChatCompletionsBody,
} from './tools-in-text.js';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'terminal',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, timeout: { type: 'integer' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } },
  },
];

const body = (messages: unknown[], extra: Record<string, unknown> = {}): ChatCompletionsBody => ({
  messages,
  tools: TOOLS,
  ...extra,
});

describe('tools in text', () => {
  it('writes the tools into the system message and keeps the agent’s own', () => {
    const { messages } = threadOf(
      body([
        { role: 'system', content: 'You are Hermes.' },
        { role: 'user', content: 'hi' },
      ]),
      toolsOf(body([])),
    );
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.text.startsWith('You are Hermes.\n\n# Tools')).toBe(true);
    expect(messages[0]!.text).toContain('### terminal');
    expect(messages[0]!.text).toContain('"required":["command"]');
    expect(messages[1]).toEqual({ role: 'user', text: 'hi' });
  });

  it('sends no tool words when the agent sends no tools, or says none', () => {
    expect(toolsOf({ messages: [] })).toEqual([]);
    expect(toolsOf(body([], { tool_choice: 'none' }))).toEqual([]);
    const { messages } = threadOf({ messages: [{ role: 'user', content: 'hi' }] }, []);
    expect(messages).toEqual([{ role: 'user', text: 'hi' }]);
  });

  it('reads a call, its arguments and the words before it', () => {
    const read = readAnswer(
      'Let me look.\n<tool_call>\n{"name": "terminal", "arguments": {"command": "ls"}}\n</tool_call>',
      toolsOf(body([])),
    );
    expect(read.content).toBe('Let me look.\n');
    expect(read.problems).toEqual([]);
    expect(read.calls).toHaveLength(1);
    expect(read.calls[0]!.name).toBe('terminal');
    expect(JSON.parse(read.calls[0]!.arguments)).toEqual({ command: 'ls' });
    expect(read.calls[0]!.id).toMatch(/^call_[0-9a-f]{24}$/);
  });

  it('reads several calls, a fenced one, an escaped one and one left open', () => {
    const tools = toolsOf(body([]));
    const read = readAnswer(
      [
        '<tool_call>```json\n{"name":"terminal","arguments":{"command":"pwd"}}\n```</tool_call>',
        '&lt;tool_call&gt;{"name":"read_file","arguments":{"path":"a"}}&lt;/tool_call&gt;',
        '<tool_call>{"name":"terminal","arguments":"{\\"command\\":\\"id\\"}"}',
      ].join('\n'),
      tools,
    );
    expect(read.problems).toEqual([]);
    expect(read.calls.map((call) => JSON.parse(call.arguments))).toEqual([
      { command: 'pwd' },
      { path: 'a' },
      { command: 'id' },
    ]);
  });

  it('names what is wrong: bad JSON, an unknown tool, a missing or mistyped argument', () => {
    const tools = toolsOf(body([]));
    expect(readAnswer('<tool_call>{name: terminal}</tool_call>', tools).problems[0]).toMatch(
      /not valid JSON/,
    );
    expect(readAnswer('<tool_call>{"name":"browse"}</tool_call>', tools).problems).toEqual([
      'there is no tool "browse"',
    ]);
    expect(
      readAnswer('<tool_call>{"name":"terminal","arguments":{}}</tool_call>', tools).problems,
    ).toEqual(['terminal needs "command"']);
    expect(
      readAnswer(
        '<tool_call>{"name":"terminal","arguments":{"command":"ls","timeout":"5"}}</tool_call>',
        tools,
      ).problems,
    ).toEqual([`terminal's "timeout" must be an integer`]);
  });

  it('renders an answer the agent sends back exactly as it was recorded', () => {
    const tools = toolsOf(body([]));
    const said =
      'Sure.\n<tool_call>\n{"name":"terminal","arguments":{"command":"ls"}}\n</tool_call>';
    const read = readAnswer(said, tools);
    const recorded = renderAssistant(read.content, read.calls);
    const back = threadOf(
      body([
        { role: 'user', content: 'list' },
        {
          role: 'assistant',
          content: read.content,
          tool_calls: read.calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        },
        { role: 'tool', tool_call_id: read.calls[0]!.id, content: 'a.txt' },
      ]),
      tools,
    ).messages;
    expect(back[2]).toEqual({ role: 'assistant', text: recorded });
    expect(back[3]!.role).toBe('user');
    expect(back[3]!.text).toBe(
      `<tool_result name="terminal" id="${read.calls[0]!.id}">\na.txt\n</tool_result>`,
    );
  });

  it('holds back only what could still become a block', () => {
    expect(shownSoFar('Hello')).toBe(5);
    expect(shownSoFar('Hello <tool')).toBe(6);
    expect(shownSoFar('Hello <tool_call>{')).toBe(6);
    expect(shownSoFar('a < b')).toBe(5);
  });

  it('keys a conversation by its start, whatever came after', () => {
    const start = [
      { role: 'system' as const, text: 's' },
      { role: 'user' as const, text: 'first' },
    ];
    const key = conversationKey(start);
    expect(key).toMatch(/^tools-[0-9a-f]{32}$/);
    expect(conversationKey([...start, { role: 'assistant', text: 'x' }])).toBe(key);
    expect(conversationKey([{ role: 'user', text: 'other' }])).not.toBe(key);
  });
});

/** A Gemini Desktop that answers each turn with the next scripted text, and records the turns. */
function scripted(answers: string[]): { desktop: GeminiDesktop; turns: GeminiDesktopTurn[] } {
  const turns: GeminiDesktopTurn[] = [];
  const desktop = {
    async *chat(_row: unknown, turn: GeminiDesktopTurn): AsyncIterable<ChatEvent> {
      turns.push(turn);
      turn.onPlan?.(turns.length === 1 ? 'new' : 'continue');
      const text = answers.shift() ?? '';
      // In two pieces, the cut inside the block's opening tag.
      const cut = Math.max(1, text.indexOf('<tool') + 3);
      yield { type: 'delta', text: text.slice(0, cut) };
      yield { type: 'delta', text: text.slice(cut) };
      yield { type: 'completed' };
    },
  } as unknown as GeminiDesktop;
  return { desktop, turns };
}

async function run(
  desktop: GeminiDesktop,
  request: ChatCompletionsBody,
): Promise<{ events: AgentTurnEvent[]; report: AgentTurnReport }> {
  const events: AgentTurnEvent[] = [];
  let report: AgentTurnReport | null = null;
  for await (const event of agentTurn({
    desktop,
    row: { id: 'row', workspace: 'w', ownerId: null },
    model: 'gemini-desktop-auto',
    body: request,
    report: (r) => (report = r),
  })) {
    events.push(event);
  }
  return { events, report: report! };
}

describe('an agent call on Gemini Desktop', () => {
  it('streams the words, then hands over the calls', async () => {
    const { desktop, turns } = scripted([
      'Checking.\n<tool_call>{"name":"terminal","arguments":{"command":"ls"}}</tool_call>',
    ]);
    const { events, report } = await run(desktop, body([{ role: 'user', content: 'list' }]));
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('Checking.\n');
    const calls = events.find((e) => e.type === 'calls');
    expect(calls && calls.type === 'calls' && calls.calls[0]!.name).toBe('terminal');
    expect(events.at(-1)).toEqual({ type: 'done', finish: 'tool_calls' });
    expect(report).toMatchObject({ tools: 2, plan: 'new', calls: 1, outcome: 'called' });
    expect(turns[0]!.conversation).toMatch(/^tools-/);
    // What the conversation keeps is what the agent will send back.
    const answer =
      'Checking.\n<tool_call>{"name":"terminal","arguments":{"command":"ls"}}</tool_call>';
    expect(turns[0]!.recordAs?.(answer)).toBe(
      'Checking.\n\n<tool_call>\n{"name":"terminal","arguments":{"command":"ls"}}\n</tool_call>',
    );
  });

  it('tells the model once what was wrong, and uses its corrected call', async () => {
    const { desktop, turns } = scripted([
      '<tool_call>{"name":"terminal","arguments":{}}</tool_call>',
      '<tool_call>{"name":"terminal","arguments":{"command":"ls"}}</tool_call>',
    ]);
    const { events, report } = await run(desktop, body([{ role: 'user', content: 'list' }]));
    expect(turns).toHaveLength(2);
    expect(turns[1]!.messages.at(-1)!.text).toContain('terminal needs "command"');
    expect(events.filter((e) => e.type === 'delta')).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'done', finish: 'tool_calls' });
    expect(report).toMatchObject({ corrected: true, outcome: 'called', calls: 1 });
  });

  it('gives up after one correction and says why', async () => {
    const { desktop } = scripted([
      '<tool_call>{"name":"nope"}</tool_call>',
      '<tool_call>{"name":"nope"}</tool_call>',
    ]);
    const { events, report } = await run(desktop, body([{ role: 'user', content: 'list' }]));
    expect(report.outcome).toBe('unusable');
    const said = events.find((e) => e.type === 'delta');
    expect(said && said.type === 'delta' && said.text).toMatch(/no tool "nope"/);
    expect(events.at(-1)).toEqual({ type: 'done', finish: 'stop' });
  });

  it('answers in words when no tool is needed', async () => {
    const { desktop } = scripted(['All done, a < b.']);
    const { events, report } = await run(desktop, body([{ role: 'user', content: 'hi' }]));
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('All done, a < b.');
    expect(report.outcome).toBe('answered');
  });

  it('continues the same Gemini conversation after a tool result', async () => {
    const { desktop, turns } = scripted([
      '<tool_call>{"name":"terminal","arguments":{"command":"ls"}}</tool_call>',
      'There is a.txt.',
    ]);
    const first = await run(desktop, body([{ role: 'user', content: 'list' }]));
    const calls = first.events.find((e) => e.type === 'calls');
    if (!calls || calls.type !== 'calls') throw new Error('no calls');
    const call = calls.calls[0]!;
    await run(
      desktop,
      body([
        { role: 'user', content: 'list' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        },
        { role: 'tool', tool_call_id: call.id, content: 'a.txt' },
      ]),
    );
    expect(turns[1]!.conversation).toBe(turns[0]!.conversation);
    // The history before the new message hashes to what the first turn recorded.
    const recorded = [
      ...turns[0]!.messages,
      {
        role: 'assistant' as const,
        text: turns[0]!.recordAs!(
          '<tool_call>{"name":"terminal","arguments":{"command":"ls"}}</tool_call>',
        ),
      },
    ];
    expect(historyHash(turns[1]!.messages.slice(0, -1))).toBe(historyHash(recorded));
  });

  it('refuses an image, as for the direct agent', async () => {
    const { desktop, turns } = scripted(['x']);
    const { events } = await run(
      desktop,
      body([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'data:' } },
          ],
        },
      ]),
    );
    expect(turns).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: 'failed', status: 400 });
  });
});
