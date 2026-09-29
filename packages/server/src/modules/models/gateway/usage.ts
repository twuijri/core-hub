/**
 * What one model call through the gateway used, read from the answer as it streams past
 * (ADR 0029 §Usage). The gateway never changes a byte of the answer; it only looks.
 *
 * Each wire says it in its own place:
 *
 * - Anthropic Messages: `message_start.message.usage` (input and cache) and the last
 *   `message_delta.usage` (output, and the final input count some servers send there);
 * - OpenAI Responses: `response.completed.response.usage`;
 * - OpenAI Chat Completions: the chunk that carries `usage` (the translator asks for it with
 *   `stream_options.include_usage`);
 * - a whole JSON answer (no stream): its top-level `usage`, in the same three shapes.
 */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export const NO_USAGE: CallUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** A `usage` object of any of the three wires, as far as it says anything. */
export function readUsage(usage: unknown): Partial<CallUsage> | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const out: Partial<CallUsage> = {};
  const set = (key: keyof CallUsage, value: unknown) => {
    const n = num(value);
    if (n !== undefined) out[key] = n;
  };
  // Anthropic (and OpenAI Responses, which uses the same two names).
  set('inputTokens', u.input_tokens);
  set('outputTokens', u.output_tokens);
  set('cacheReadTokens', u.cache_read_input_tokens);
  set('cacheWriteTokens', u.cache_creation_input_tokens);
  // OpenAI Chat.
  set('inputTokens', u.prompt_tokens);
  set('outputTokens', u.completion_tokens);
  const promptDetails = (u.prompt_tokens_details ?? u.input_tokens_details) as
    Record<string, unknown> | undefined;
  if (promptDetails) set('cacheReadTokens', promptDetails.cached_tokens);
  const outputDetails = (u.completion_tokens_details ?? u.output_tokens_details) as
    Record<string, unknown> | undefined;
  if (outputDetails) set('reasoningTokens', outputDetails.reasoning_tokens);
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Reads usage out of an answer fed to it chunk by chunk (`push`), SSE or JSON. `result()` after
 * the last chunk; `null` when the answer said nothing about usage.
 */
export class UsageTap {
  private buffer = '';
  private json = '';
  private sse: boolean | null = null;
  private found: Partial<CallUsage> | null = null;
  /** Bounds what is kept of a non-streamed answer (a large body is not parsed). */
  private static readonly MAX_JSON = 4 * 1024 * 1024;

  constructor(contentType: string | undefined) {
    if (contentType) this.sse = contentType.includes('text/event-stream');
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.sse === false) {
      if (this.json.length < UsageTap.MAX_JSON) this.json += text;
      return;
    }
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private line(line: string): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    this.event(event);
  }

  private event(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === 'message_start') {
      this.merge(readUsage((event.message as Record<string, unknown> | undefined)?.usage));
      return;
    }
    if (type === 'message_delta') {
      this.merge(readUsage(event.usage));
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      this.merge(readUsage((event.response as Record<string, unknown> | undefined)?.usage), true);
      return;
    }
    if (event.usage) this.merge(readUsage(event.usage), true);
  }

  /** Later numbers win: a stream's last word on a count is its final one. */
  private merge(usage: Partial<CallUsage> | null, replace = false): void {
    if (!usage) return;
    this.found = replace ? { ...usage } : { ...(this.found ?? {}), ...usage };
  }

  result(): CallUsage | null {
    if (this.sse !== true && this.json) {
      try {
        const body = JSON.parse(this.json) as Record<string, unknown>;
        this.merge(readUsage(body.usage), true);
      } catch {
        // Not JSON after all: nothing to read.
      }
    } else if (this.buffer) {
      this.line(this.buffer);
      this.buffer = '';
    }
    return this.found ? { ...NO_USAGE, ...this.found } : null;
  }
}

/** Two calls' usage, added. */
export function addUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}
