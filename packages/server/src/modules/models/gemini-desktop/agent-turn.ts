/**
 * One call of an agent (Hermes, Chat Completions) answered by Gemini Desktop with its tools in
 * text (`tools-in-text.ts`; an experiment on DECISIONS §155, `COREHUB_GEMINI_DESKTOP_TOOLS`).
 *
 * The answer's text streams as it comes until a `<tool_call>` block starts; the blocks are read
 * at the end. When an answer's blocks are all unusable, the model is told what was wrong once
 * and its corrected calls are used. Every call is logged with what the experiment measures: how
 * many calls, how many were unusable, whether the correction saved the turn, and whether the
 * Gemini conversation was continued or started again with the history folded in.
 */
import type { ChatMessage } from '../adapters/types.js';
import type { AccountScope } from './accounts.js';
import type { GeminiDesktop } from './index.js';
import {
  conversationKey,
  correction,
  readAnswer,
  renderAssistant,
  shownSoFar,
  threadOf,
  toolsOf,
  type ChatCompletionsBody,
  type TextToolCall,
} from './tools-in-text.js';

export type AgentTurnEvent =
  | { type: 'delta'; text: string }
  | { type: 'calls'; calls: TextToolCall[] }
  | { type: 'done'; finish: 'stop' | 'tool_calls' }
  | { type: 'failed'; status: number; message: string };

/** What one call did, for the experiment's measure. */
export interface AgentTurnReport {
  tools: number;
  plan: 'continue' | 'branch' | 'new' | null;
  calls: number;
  problems: string[];
  corrected: boolean;
  outcome: 'answered' | 'called' | 'unusable' | 'failed';
  ms: number;
}

const STATUS: Record<string, number> = {
  no_key: 401,
  unauthorized: 401,
  rate_limited: 429,
  unreachable: 502,
  model_not_found: 404,
  unsupported: 400,
  cancelled: 499,
};

export async function* agentTurn(options: {
  desktop: GeminiDesktop;
  row: AccountScope;
  model: string;
  body: ChatCompletionsBody;
  signal?: AbortSignal;
  report?: (report: AgentTurnReport) => void;
  now?: () => number;
}): AsyncIterable<AgentTurnEvent> {
  const now = options.now ?? Date.now;
  const started = now();
  const tools = toolsOf(options.body);
  const { messages, images } = threadOf(options.body, tools);
  const report: AgentTurnReport = {
    tools: tools.length,
    plan: null,
    calls: 0,
    problems: [],
    corrected: false,
    outcome: 'failed',
    ms: 0,
  };
  const finish = () => {
    report.ms = now() - started;
    options.report?.(report);
  };
  if (images) {
    finish();
    yield {
      type: 'failed',
      status: 400,
      message: 'Gemini Desktop takes text only in Core Hub; send the message without the image',
    };
    return;
  }
  const key = conversationKey(messages);
  // What the conversation keeps of an answer: its text and its calls as the agent will send them
  // back; an answer with nothing usable is kept as said, so its correction continues from it.
  const recordAs = (answer: string): string => {
    const read = readAnswer(answer, tools);
    if (read.calls.length === 0 && read.problems.length > 0) return answer;
    return renderAssistant(read.content, read.calls);
  };

  let history: ChatMessage[] = messages;
  let shown = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = '';
    for await (const event of options.desktop.chat(options.row, {
      model: options.model,
      messages: history,
      conversation: key,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(tools.length > 0 ? { recordAs } : {}),
      onPlan: (kind) => {
        if (attempt === 0) report.plan = kind;
      },
    })) {
      if (event.type === 'delta') {
        raw += event.text;
        // The correction's own words are never shown: the agent gets its calls only.
        if (attempt > 0) continue;
        const upTo = tools.length > 0 ? shownSoFar(raw) : raw.length;
        if (upTo > shown) {
          yield { type: 'delta', text: raw.slice(shown, upTo) };
          shown = upTo;
        }
      } else if (event.type === 'failed') {
        const message = event.detail ?? `Gemini Desktop failed (${event.reason})`;
        report.outcome = 'failed';
        report.problems.push(message);
        finish();
        yield { type: 'failed', status: event.status ?? STATUS[event.reason] ?? 502, message };
        return;
      }
    }
    if (tools.length === 0) {
      report.outcome = 'answered';
      finish();
      yield { type: 'done', finish: 'stop' };
      return;
    }
    const read = readAnswer(raw, tools);
    if (attempt === 0 && read.content.length > shown) {
      // The tail held back in case it began a block, and it did not.
      yield { type: 'delta', text: read.content.slice(shown) };
      shown = read.content.length;
    }
    report.problems.push(...read.problems);
    if (read.calls.length > 0) {
      report.calls = read.calls.length;
      report.corrected = attempt > 0;
      report.outcome = 'called';
      finish();
      yield { type: 'calls', calls: read.calls };
      yield { type: 'done', finish: 'tool_calls' };
      return;
    }
    if (read.problems.length === 0 || attempt > 0) {
      report.outcome = read.problems.length === 0 ? 'answered' : 'unusable';
      finish();
      if (read.problems.length > 0 && shown === 0) {
        yield {
          type: 'delta',
          text: `Gemini Desktop asked for a tool in a way Core Hub could not read: ${read.problems.join('; ')}`,
        };
      }
      yield { type: 'done', finish: 'stop' };
      return;
    }
    history = [
      ...history,
      { role: 'assistant', text: raw },
      { role: 'user', text: correction(read.problems) },
    ];
  }
}
