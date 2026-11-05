/**
 * Tools in text: an agent's tool calls carried over Gemini Desktop, which has none (an experiment
 * on DECISIONS §155, the owner's request of 2026-11-05: «اهم شي عندي مع هرمز»).
 *
 * The native service takes text and answers text. So the tools an agent sends (OpenAI Chat
 * Completions `tools`) are written into the system message with one strict way to call them — a
 * `<tool_call>` block of JSON — and the answer is read back: each block that names a listed tool
 * with a JSON object of arguments becomes a real tool call for the agent; anything else is a
 * problem the model is told about once (`correction`). Tool results go back as `<tool_result>`
 * blocks in the next user message. What the agent sends back of an answer (its text and its
 * calls) is rendered the same way the answer was recorded (`renderAssistant`), so the hub keeps
 * one Gemini conversation per agent conversation (`threads.ts`) and sends only what is new.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ChatMessage } from '../adapters/types.js';

/** One tool as the agent declares it (Chat Completions `tools[].function`). */
export interface TextTool {
  name: string;
  description: string;
  parameters: Record<string, unknown> | null;
}

/** A call read from an answer: `arguments` is the JSON text the agent receives. */
export interface TextToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A Chat Completions request, as far as this file reads it. */
export interface ChatCompletionsBody {
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
}

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';
/** A tool's description is cut here: Hermes's longest run to a few thousand characters. */
const MAX_DESCRIPTION = 1_200;

/** The tools of a request; a request without any is a plain text turn. */
export function toolsOf(body: ChatCompletionsBody): TextTool[] {
  if (!Array.isArray(body.tools) || body.tool_choice === 'none') return [];
  const out: TextTool[] = [];
  for (const entry of body.tools as unknown[]) {
    const fn = (entry as { type?: unknown; function?: unknown })?.function as
      { name?: unknown; description?: unknown; parameters?: unknown } | undefined;
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description.trim() : '',
      parameters:
        fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
          ? (fn.parameters as Record<string, unknown>)
          : null,
    });
  }
  return out;
}

/** The instructions and the tool list, appended to the agent's own system message. */
export function toolProtocol(tools: readonly TextTool[]): string {
  const lines = [
    '# Tools',
    '',
    'You can use the tools listed below. To use one, write a block exactly like this:',
    '',
    OPEN,
    '{"name": "<tool name>", "arguments": {<the arguments, as JSON>}}',
    CLOSE,
    '',
    'Rules:',
    '- The block holds one JSON object: double quotes, no comments, no trailing commas, no code fence.',
    '- Use only the tool names listed here, with the arguments their schema asks for.',
    '- You may write several blocks to call several tools. Write nothing after the last block: stop there.',
    '- The results come back to you in <tool_result> blocks in the next message. Never write a <tool_result> yourself.',
    '- When you need no tool, answer normally, without any block.',
    '- Never describe a call in words instead of making it, and never say a tool ran before its result came back.',
    '',
    '## Available tools',
  ];
  for (const tool of tools) {
    lines.push('', `### ${tool.name}`);
    if (tool.description) {
      lines.push(
        tool.description.length > MAX_DESCRIPTION
          ? `${tool.description.slice(0, MAX_DESCRIPTION)}…`
          : tool.description,
      );
    }
    lines.push(`Arguments (JSON Schema): ${JSON.stringify(tool.parameters ?? { type: 'object' })}`);
  }
  return lines.join('\n');
}

/** How a call is written back into the conversation: the same text, whoever renders it. */
export function renderCall(name: string, args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args || '{}');
  } catch {
    parsed = args;
  }
  return `${OPEN}\n${JSON.stringify({ name, arguments: parsed })}\n${CLOSE}`;
}

/** An answer as recorded and as rendered again when the agent sends it back. */
export function renderAssistant(
  content: string,
  calls: readonly { name: string; arguments: string }[],
): string {
  return [content.trim(), ...calls.map((call) => renderCall(call.name, call.arguments))]
    .filter((part) => part !== '')
    .join('\n\n');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const piece = part as { type?: unknown; text?: unknown };
      return typeof piece?.text === 'string' ? piece.text : '';
    })
    .join('');
}

/** Whether a message carries an image, which Gemini Desktop is not sent (§155). */
function hasImage(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => {
      const type = (part as { type?: unknown })?.type;
      return type === 'image_url' || type === 'input_image' || type === 'image';
    })
  );
}

function resultBlock(name: string, id: string, content: string): string {
  return `<tool_result name="${name}" id="${id}">\n${content}\n</tool_result>`;
}

/**
 * The agent's messages as Gemini Desktop's text turns: the tools in the system message, each
 * answer with its calls rendered, and each run of tool results as one user message. `images`
 * says the request carried one (the turn is then refused, as for the direct agent).
 */
export function threadOf(
  body: ChatCompletionsBody,
  tools: readonly TextTool[],
): { messages: ChatMessage[]; images: boolean } {
  const raw = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const out: ChatMessage[] = [];
  const names = new Map<string, string>();
  let images = false;
  let system = '';
  let results: string[] = [];
  const flush = () => {
    if (results.length === 0) return;
    out.push({ role: 'user', text: results.join('\n\n') });
    results = [];
  };
  for (const entry of raw) {
    const message = entry as {
      role?: unknown;
      content?: unknown;
      tool_calls?: unknown;
      tool_call_id?: unknown;
      name?: unknown;
    };
    if (hasImage(message.content)) images = true;
    const text = textOf(message.content);
    switch (message.role) {
      case 'system':
      case 'developer':
        system = system ? `${system}\n\n${text}` : text;
        break;
      case 'tool': {
        const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
        const name = names.get(id) ?? (typeof message.name === 'string' ? message.name : 'tool');
        results.push(resultBlock(name, id, text));
        break;
      }
      case 'assistant': {
        flush();
        const calls: { name: string; arguments: string }[] = [];
        if (Array.isArray(message.tool_calls)) {
          for (const call of message.tool_calls as unknown[]) {
            const c = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
            const name = typeof c.function?.name === 'string' ? c.function.name : '';
            if (!name) continue;
            if (typeof c.id === 'string') names.set(c.id, name);
            calls.push({
              name,
              arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : '{}',
            });
          }
        }
        out.push({ role: 'assistant', text: renderAssistant(text, calls) });
        break;
      }
      default:
        flush();
        out.push({ role: 'user', text });
    }
  }
  flush();
  const instructions = tools.length > 0 ? toolProtocol(tools) : '';
  const whole = [system.trim(), instructions].filter((part) => part !== '').join('\n\n');
  if (whole) out.unshift({ role: 'system', text: whole });
  return { messages: out, images };
}

/**
 * The key of the Gemini conversation an agent's conversation lives in. The agent names none
 * (Hermes calls with its profile's token alone), so it is the conversation's start: its system
 * message and first user message. Two conversations that start alike share the key and branch
 * from one another, which `threads.ts` already does for an edited history.
 */
export function conversationKey(messages: readonly ChatMessage[]): string | null {
  const first = messages.find((message) => message.role === 'user');
  if (!first) return null;
  const system = messages.find((message) => message.role === 'system')?.text ?? '';
  const hash = createHash('sha256').update(system).update('\u0000').update(first.text);
  return `tools-${hash.digest('hex').slice(0, 32)}`;
}

/** Undo what the Gemini app may do to markup it writes: entities, and a fence around JSON. */
function unwrap(text: string): string {
  let out = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
  const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(out);
  if (fenced) out = fenced[1]!.trim();
  return out;
}

/** What one answer holds: its text, the calls it made, and what was wrong with the others. */
export interface ReadAnswer {
  content: string;
  calls: TextToolCall[];
  problems: string[];
}

function checkArguments(tool: TextTool, args: Record<string, unknown>): string | null {
  const schema = tool.parameters;
  if (!schema) return null;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const missing = required.filter((name) => typeof name === 'string' && !(name in args));
  if (missing.length > 0) {
    return `${tool.name} needs ${missing.map((name) => `"${String(name)}"`).join(', ')}`;
  }
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, { type?: unknown }>)
      : {};
  for (const [name, value] of Object.entries(args)) {
    const type = properties[name]?.type;
    if (typeof type !== 'string' || value === null) continue;
    const ok =
      type === 'string'
        ? typeof value === 'string'
        : type === 'integer'
          ? Number.isInteger(value)
          : type === 'number'
            ? typeof value === 'number'
            : type === 'boolean'
              ? typeof value === 'boolean'
              : type === 'array'
                ? Array.isArray(value)
                : type === 'object'
                  ? typeof value === 'object' && !Array.isArray(value)
                  : true;
    if (!ok) return `${tool.name}'s "${name}" must be ${type === 'integer' ? 'an' : 'a'} ${type}`;
  }
  return null;
}

/** Where the first block of an answer starts, written plainly or as the app escapes it; -1: none. */
export function blockStart(text: string): number {
  const starts = [text.indexOf(OPEN), text.indexOf('&lt;tool_call&gt;')].filter((at) => at >= 0);
  return starts.length > 0 ? Math.min(...starts) : -1;
}

/** Reads the calls out of an answer. Text after the first block is dropped (the rules say stop). */
export function readAnswer(text: string, tools: readonly TextTool[]): ReadAnswer {
  const shown = blockStart(text);
  if (shown < 0) return { content: text, calls: [], problems: [] };
  // Exactly what was shown while it streamed (`shownSoFar`), so the agent sends back what the
  // conversation recorded.
  const content = text.slice(0, shown);
  const source = text.replace(/&lt;tool_call&gt;/g, OPEN).replace(/&lt;\/tool_call&gt;/g, CLOSE);
  const first = source.indexOf(OPEN);
  const calls: TextToolCall[] = [];
  const problems: string[] = [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let at = first;
  while (at >= 0) {
    const start = at + OPEN.length;
    const end = source.indexOf(CLOSE, start);
    const next = source.indexOf(OPEN, start);
    // A block left open runs to the next one, or to the end of the answer.
    let stop = source.length;
    if (end >= 0 && (next < 0 || end < next)) {
      stop = end;
      at = source.indexOf(OPEN, end + CLOSE.length);
    } else if (next >= 0) {
      stop = next;
      at = next;
    } else {
      at = -1;
    }
    const body = unwrap(source.slice(start, stop));
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      problems.push(`a ${OPEN} block is not valid JSON: ${body.slice(0, 200)}`);
      continue;
    }
    const call = parsed as { name?: unknown; arguments?: unknown; parameters?: unknown };
    const name = typeof call?.name === 'string' ? call.name : '';
    const tool = byName.get(name);
    if (!tool) {
      problems.push(name ? `there is no tool "${name}"` : `a ${OPEN} block names no tool`);
      continue;
    }
    let args = call.arguments ?? call.parameters ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        problems.push(`${name}'s arguments are not a JSON object`);
        continue;
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      problems.push(`${name}'s arguments are not a JSON object`);
      continue;
    }
    const wrong = checkArguments(tool, args as Record<string, unknown>);
    if (wrong) {
      problems.push(wrong);
      continue;
    }
    calls.push({
      id: `call_${randomBytes(12).toString('hex')}`,
      name,
      arguments: JSON.stringify(args),
    });
  }
  return { content, calls, problems };
}

/** The one message that tells the model what was wrong with its calls. */
export function correction(problems: readonly string[]): string {
  return [
    'Your tool call could not be used:',
    ...problems.map((problem) => `- ${problem}`),
    '',
    `Write the corrected ${OPEN} block(s) now, following the rules and the schemas in the system message, and nothing else.`,
  ].join('\n');
}

/**
 * How much of a growing answer can be shown already: everything before a block starts, minus a
 * tail that could still become `<tool_call>`.
 */
export function shownSoFar(text: string): number {
  const block = blockStart(text);
  if (block >= 0) return block;
  for (let keep = Math.min(OPEN.length - 1, text.length); keep > 0; keep--) {
    const tail = text.slice(text.length - keep);
    if (OPEN.startsWith(tail) || '&lt;tool_call&gt;'.startsWith(tail)) {
      return text.length - keep;
    }
  }
  return text.length;
}
