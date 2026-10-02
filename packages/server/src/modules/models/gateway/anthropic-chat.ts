/**
 * Anthropic Messages ↔ OpenAI Chat Completions, in the hub's gateway (DECISIONS §148).
 *
 * Why it exists: CLIProxyAPI 8.0.4's Anthropic route to Google Antigravity is refused by Google for
 * Claude Code's requests while the same account and model answer the Chat route (Hermes) and the
 * Gemini route (Gemini CLI), tools included (the owner's tests, 2026-10-01). So for a Google model
 * the gateway speaks Chat to CLIProxyAPI itself and answers Claude Code in Anthropic's own shape.
 * Claude models, and every other model, keep CLIProxyAPI's own Anthropic route, byte for byte.
 *
 * What is carried: the system prompt; text, images, tool calls (`tool_use`) and their results
 * (`tool_result`, as `tool` messages); tools and `tool_choice`; `max_tokens`, `temperature`,
 * `top_p`, `stop_sequences`; the thinking effort (as `reasoning_effort`); streaming, in both
 * directions, with the usage. Thinking the model streams back is shown as a thinking block.
 */

type Json = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The text of an Anthropic content (a string or blocks), its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = (block ?? {}) as Json;
      return b.type === 'text' ? str(b.text) : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** An Anthropic image block as a Chat image part, when it carries its bytes or an address. */
function imagePart(block: Json): Json | null {
  const source = (block.source ?? {}) as Json;
  if (source.type === 'base64' && typeof source.data === 'string') {
    return {
      type: 'image_url',
      image_url: { url: `data:${str(source.media_type) || 'image/png'};base64,${source.data}` },
    };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** A tool result's content as text (a string, or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return textOf(content);
}

/** Claude Code's effort, or a thinking budget, as Chat's `reasoning_effort`. */
function effortOf(body: Json): string | null {
  const output = (body.output_config ?? {}) as Json;
  if (typeof output.effort === 'string') {
    return output.effort === 'max' ? 'high' : output.effort;
  }
  const thinking = (body.thinking ?? {}) as Json;
  if (thinking.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
    return thinking.budget_tokens <= 2048
      ? 'low'
      : thinking.budget_tokens <= 8192
        ? 'medium'
        : 'high';
  }
  return null;
}

/** An Anthropic Messages request as an OpenAI Chat Completions one, for `model`. */
export function anthropicToChat(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of Array.isArray(body.messages) ? (body.messages as Json[]) : []) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.content;
    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }
    const blocks = Array.isArray(content) ? (content as Json[]) : [];
    if (role === 'assistant') {
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => str(block.text))
        .join('');
      const calls = blocks
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          id: str(block.id),
          type: 'function',
          function: { name: str(block.name), arguments: JSON.stringify(block.input ?? {}) },
        }));
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    // A user turn: tool results first (each a `tool` message), then what the person said.
    for (const block of blocks.filter((b) => b.type === 'tool_result')) {
      const text = resultText(block.content);
      messages.push({
        role: 'tool',
        tool_call_id: str(block.tool_use_id),
        content: block.is_error === true && text ? `Error: ${text}` : text,
      });
    }
    const parts: Json[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && str(block.text)) parts.push({ type: 'text', text: block.text });
      else if (block.type === 'image') {
        const part = imagePart(block);
        if (part) parts.push(part);
      }
    }
    if (parts.length === 0) continue;
    messages.push({
      role: 'user',
      content: parts.every((part) => part.type === 'text')
        ? parts.map((part) => str(part.text)).join('\n')
        : parts,
    });
  }
  const tools = Array.isArray(body.tools) ? (body.tools as Json[]) : [];
  const choice = (body.tool_choice ?? null) as Json | null;
  const effort = effortOf(body);
  const out: Json = {
    model,
    messages,
    ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body.stop_sequences) ? { stop: body.stop_sequences } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(body.stream === true ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  const callable = tools.filter((tool) => typeof tool.name === 'string' && tool.input_schema);
  if (callable.length > 0) {
    out.tools = callable.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: tool.input_schema,
      },
    }));
    if (choice?.type === 'any') out.tool_choice = 'required';
    else if (choice?.type === 'none') out.tool_choice = 'none';
    else if (choice?.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  return out;
}

const STOP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

/** A tool call's arguments as an object, whatever the model streamed. */
function parsedArguments(text: string): Json {
  try {
    const parsed = JSON.parse(text || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/** A whole Chat Completions answer as an Anthropic message. */
export function chatToAnthropic(answer: Json, model: string): Json {
  const choice = ((answer.choices as Json[] | undefined) ?? [])[0] ?? {};
  const message = (choice.message ?? {}) as Json;
  const content: Json[] = [];
  const reasoning = str(message.reasoning_content) || str(message.reasoning);
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  if (str(message.content)) content.push({ type: 'text', text: message.content });
  for (const call of (message.tool_calls as Json[] | undefined) ?? []) {
    const fn = (call.function ?? {}) as Json;
    content.push({
      type: 'tool_use',
      id: str(call.id) || `toolu_${Math.random().toString(36).slice(2, 14)}`,
      name: str(fn.name),
      input: parsedArguments(str(fn.arguments)),
    });
  }
  const usage = (answer.usage ?? {}) as Json;
  return {
    id: str(answer.id) || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason:
      content.some((block) => block.type === 'tool_use') && choice.finish_reason !== 'length'
        ? 'tool_use'
        : (STOP[str(choice.finish_reason)] ?? 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0) || 0,
      output_tokens: Number(usage.completion_tokens ?? 0) || 0,
    },
  };
}

/** A Chat error answer as Anthropic's envelope, the provider's words kept. */
export function chatErrorToAnthropic(status: number, text: string): string {
  let message = text;
  try {
    const parsed = JSON.parse(text) as Json;
    const error = parsed.error;
    if (error && typeof error === 'object' && typeof (error as Json).message === 'string') {
      message = (error as Json).message as string;
    } else if (typeof error === 'string') message = error;
  } catch {
    // Not JSON: as it came.
  }
  const type =
    status === 400
      ? 'invalid_request_error'
      : status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 404
            ? 'not_found_error'
            : status === 413
              ? 'request_too_large'
              : status === 429
                ? 'rate_limit_error'
                : status === 529 || status === 503
                  ? 'overloaded_error'
                  : 'api_error';
  return JSON.stringify({ type: 'error', error: { type, message } });
}

/**
 * A Chat Completions stream (SSE), turned into Anthropic's stream as it arrives: `message_start`,
 * a block per thinking, text or tool call (`content_block_start` / `_delta` / `_stop`), then
 * `message_delta` with the stop reason and the usage, and `message_stop`.
 */
export class ChatToAnthropicStream {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private started = false;
  private finished = false;
  private index = -1;
  private open: { kind: 'thinking' | 'text'; key: number } | null = null;
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private stop: string | null = null;
  private usage = { input_tokens: 0, output_tokens: 0 };

  constructor(
    private readonly model: string,
    private readonly id = `msg_${Date.now().toString(36)}`,
  ) {}

  /** The Anthropic events for one chunk of the Chat stream. */
  push(chunk: Buffer | string): string {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let out = '';
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      out += this.line(line);
      newline = this.buffer.indexOf('\n');
    }
    return out;
  }

  /** What is left when the Chat stream ends: the closing events, if the stream did not send them. */
  end(): string {
    let out = this.buffer ? this.line(this.buffer) : '';
    this.buffer = '';
    out += this.finish();
    return out;
  }

  private event(name: string, data: Json): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private begin(): string {
    if (this.started) return '';
    this.started = true;
    return this.event('message_start', {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private close(): string {
    if (!this.open) return '';
    const index = this.index;
    this.open = null;
    return this.event('content_block_stop', { type: 'content_block_stop', index });
  }

  private openBlock(kind: 'thinking' | 'text', key: number, block: Json): string {
    let out = this.close();
    this.index += 1;
    this.open = { kind, key };
    out += this.event('content_block_start', {
      type: 'content_block_start',
      index: this.index,
      content_block: block,
    });
    return out;
  }

  private line(line: string): string {
    if (!line.startsWith('data:')) return '';
    const data = line.slice(5).trim();
    if (!data) return '';
    if (data === '[DONE]') return this.finish();
    let chunk: Json;
    try {
      chunk = JSON.parse(data) as Json;
    } catch {
      return '';
    }
    let out = this.begin();
    const usage = chunk.usage as Json | undefined;
    if (usage && typeof usage === 'object') {
      this.usage = {
        input_tokens: Number(usage.prompt_tokens ?? this.usage.input_tokens) || 0,
        output_tokens: Number(usage.completion_tokens ?? this.usage.output_tokens) || 0,
      };
    }
    for (const choice of (chunk.choices as Json[] | undefined) ?? []) {
      const delta = (choice.delta ?? {}) as Json;
      const reasoning = str(delta.reasoning_content) || str(delta.reasoning);
      if (reasoning) {
        if (this.open?.kind !== 'thinking') {
          out += this.openBlock('thinking', 0, { type: 'thinking', thinking: '', signature: '' });
        }
        out += this.event('content_block_delta', {
          type: 'content_block_delta',
          index: this.index,
          delta: { type: 'thinking_delta', thinking: reasoning },
        });
      }
      const text = str(delta.content);
      if (text) {
        if (this.open?.kind !== 'text')
          out += this.openBlock('text', 0, { type: 'text', text: '' });
        out += this.event('content_block_delta', {
          type: 'content_block_delta',
          index: this.index,
          delta: { type: 'text_delta', text },
        });
      }
      // Tool calls are gathered whole (their arguments may come interleaved, a model calling
      // several at once) and sent as blocks of their own when the answer ends.
      for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
        const at = typeof call.index === 'number' ? call.index : this.calls.size;
        const fn = (call.function ?? {}) as Json;
        const held = this.calls.get(at) ?? { id: '', name: '', args: '' };
        if (str(call.id)) held.id = str(call.id);
        if (str(fn.name)) held.name = str(fn.name);
        held.args += str(fn.arguments);
        this.calls.set(at, held);
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        this.stop = STOP[choice.finish_reason] ?? 'end_turn';
      }
    }
    return out;
  }

  private finish(): string {
    if (this.finished) return '';
    this.finished = true;
    let out = this.begin();
    out += this.close();
    const ordered = [...this.calls.entries()].sort(([a], [b]) => a - b);
    for (const [at, call] of ordered) {
      this.index += 1;
      out += this.event('content_block_start', {
        type: 'content_block_start',
        index: this.index,
        content_block: {
          type: 'tool_use',
          id: call.id || `toolu_${this.id}_${at}`,
          name: call.name,
          input: {},
        },
      });
      out += this.event('content_block_delta', {
        type: 'content_block_delta',
        index: this.index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(parsedArguments(call.args)),
        },
      });
      out += this.event('content_block_stop', { type: 'content_block_stop', index: this.index });
    }
    const stop =
      ordered.length > 0 && this.stop !== 'max_tokens' ? 'tool_use' : (this.stop ?? 'end_turn');
    out += this.event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens },
    });
    out += this.event('message_stop', { type: 'message_stop' });
    return out;
  }
}
