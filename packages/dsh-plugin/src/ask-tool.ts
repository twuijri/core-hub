/**
 * The model-facing side of talking to the hub's agent (ADR 0033 §6): `corehub_ask_agent` sends
 * a question, `corehub_agent_result` collects an answer that came after the call returned. The
 * state behind them (one question at a time per harness session, answers kept until they reach
 * the agent, the harness job that delivers a slow answer) is in `ask-runs.ts`.
 *
 * The texts here are read by the harness's model, not by the person, so they are English only,
 * like every tool description of the harness.
 */
import type { AskReply, AskRuns } from './ask-runs.js';
import { NO_SESSION } from './ask-runs.js';
import type { ToolRegistry } from './host.js';
import { AGENT_RESULT_TOOL, ASK_AGENT_TOOL, COMMAND_NAME, PRODUCT_NAME } from './names.js';

/** How long the ask waits in the call when a harness job will deliver a slower answer. */
export const ASK_WAIT_WITH_JOB_MS = 45_000;
/** How long it waits without a job: under a `run_code` program's default two minutes. */
export const ASK_WAIT_MS = 90_000;
/** `corehub_agent_result`'s default wait, and its cap (under `run_code`'s 600,000 ms cap). */
export const RESULT_WAIT_MS = 60_000;
export const RESULT_WAIT_MAX_MS = 540_000;

export const ASK_DESCRIPTION = `Ask the ${PRODUCT_NAME} agent (Hermes, on the person’s hub server, with its own memory, skills and MCP tools) and get its answer. One hub conversation follows this harness session, so it keeps the thread. Use it for questions that need the hub’s memory, the person’s server-side tools, or another agent’s view.

Hermes often needs several minutes. The call returns the answer when it comes within about ${ASK_WAIT_WITH_JOB_MS / 1000} seconds; otherwise it returns at once with state "running" and:
- a job_id: the answer arrives by itself as that background job's completion notice; keep working meanwhile, or read it with job_output({ job_id, wait: true }) when you are blocked on it;
- or, when background jobs are unavailable here (the call then waits up to ${ASK_WAIT_MS / 1000} seconds first), a run_id: collect the answer with ${AGENT_RESULT_TOOL}({ run_id }).
Never ask a question again because it is slow: only one question per session runs at a time, and a call made while one runs sends nothing new — it returns the running one (or its answer). Set force_new: true only for a clearly different question that must be sent now. Inside run_code, a call that waits for the answer needs run_code's timeoutMs above that wait (up to 600000).`;

export const RESULT_DESCRIPTION = `Collect the answer of a ${PRODUCT_NAME} agent question that ${ASK_AGENT_TOOL} returned as "running", by the run_id (or job_id) it gave. Waits up to wait_seconds (default ${RESULT_WAIT_MS / 1000}, at most ${RESULT_WAIT_MAX_MS / 1000}) unless wait is false; still "running" means call it again later — never ask the question again. Inside run_code, set run_code's timeoutMs above the wait (up to 600000).`;

export interface ToolAnswer {
  ok: boolean;
  state: 'answered' | 'running' | 'failed';
  answer: string;
  run_id?: string;
  job_id?: string;
}

const quote = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return `“${flat.length > 160 ? `${flat.slice(0, 157)}…` : flat}”`;
};

function failure(message: string): string {
  switch (message) {
    case 'not_linked':
      return `This harness is not linked to a hub. The person must run /${COMMAND_NAME} link first.`;
    case 'no_agent':
      return 'The hub has no agent in this profile to talk to.';
    default:
      return `The hub’s agent could not answer: ${message}`;
  }
}

/** What the model reads for a reply of the tracker. */
export function toolAnswer(reply: AskReply, tool: 'ask' | 'result'): ToolAnswer {
  const { entry } = reply;
  const ids = {
    ...(entry.target ? { run_id: entry.target.run_id } : {}),
    ...(entry.jobId ? { job_id: entry.jobId } : {}),
  };
  const earlier =
    reply.earlier && tool === 'ask'
      ? `This is your earlier question ${quote(entry.question)}; no new message was sent to the hub. `
      : '';
  const different =
    reply.earlier && tool === 'ask'
      ? ' If your new question is a different one, ask it with force_new: true.'
      : '';

  if (reply.state === 'running') {
    const waiting =
      entry.phase === 'waiting'
        ? ` It is waiting for an approval in ${PRODUCT_NAME}; the person must answer it there.`
        : '';
    const how = entry.jobId
      ? `Its answer will arrive by itself as the completion notice of background job ${entry.jobId}; keep working meanwhile, or read it with job_output({ job_id: "${entry.jobId}", wait: true }) when you are blocked on it.`
      : entry.target
        ? `Collect its answer with ${AGENT_RESULT_TOOL}({ run_id: "${entry.target.run_id}" }).`
        : `Collect its answer with ${AGENT_RESULT_TOOL} once it has a run id, or ask again in a moment (nothing new will be sent).`;
    return {
      ok: true,
      state: 'running',
      answer: `${earlier}The hub’s agent is still working (Hermes often needs several minutes).${waiting} ${how} Do not ask again.${different}`,
      ...ids,
    };
  }

  const result = entry.result;
  if (result?.state === 'answered') {
    const text = result.text || '(The agent answered without text.)';
    return {
      ok: true,
      state: 'answered',
      answer: earlier
        ? `${earlier}Its answer:\n\n${text}${different ? `\n\n${different.trim()}` : ''}`
        : text,
      ...ids,
    };
  }
  const why =
    result?.state === 'timeout'
      ? `The hub’s agent is still working after the plugin stopped following it; its answer will be in the ${PRODUCT_NAME} conversation.`
      : result?.state === 'waiting'
        ? `The hub’s agent is waiting for an approval in ${PRODUCT_NAME}.`
        : failure(result?.state === 'failed' ? result.message : 'unknown');
  return { ok: false, state: 'failed', answer: `${earlier}${why}${different}`, ...ids };
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    state: { type: 'string', enum: ['answered', 'running', 'failed'] },
    answer: { type: 'string' },
    run_id: { type: 'string' },
    job_id: { type: 'string' },
  },
  required: ['ok', 'state', 'answer'],
};

const render = (_args: unknown, value: unknown) => {
  const v = value as Partial<ToolAnswer>;
  const mark = v.state === 'running' ? '[running] ' : v.ok ? '' : '[not answered] ';
  return [{ type: 'text', text: `${mark}${v.answer ?? ''}` }];
};

const clampSeconds = (value: unknown, fallbackMs: number) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value * 1000 : fallbackMs;
  return Math.min(RESULT_WAIT_MAX_MS, Math.max(0, Math.round(n)));
};

/** Registers both tools; the registry withdraws them when the injecting context unloads. */
export function registerAskTools(tools: ToolRegistry, asks: AskRuns): void {
  tools.register({
    name: ASK_AGENT_TOOL,
    description: ASK_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send to the hub’s agent.' },
        force_new: {
          type: 'boolean',
          description:
            'Send this as a new question even while an earlier one of this session is still running. Only for a clearly different question.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      const a = (args ?? {}) as { message?: unknown; force_new?: unknown };
      const message = String(a.message ?? '').trim();
      if (!message) return { ok: false, state: 'failed', answer: 'message is empty' };
      const reply = await asks.ask(exec.agent?.id ?? NO_SESSION, message, {
        forceNew: a.force_new === true,
        waitMs: ASK_WAIT_MS,
        jobWaitMs: ASK_WAIT_WITH_JOB_MS,
        signal: exec.signal,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId },
      });
      return toolAnswer(reply, 'ask');
    },
  });

  tools.register({
    name: AGENT_RESULT_TOOL,
    description: RESULT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: `The run_id (or job_id) ${ASK_AGENT_TOOL} returned.`,
        },
        wait: {
          type: 'boolean',
          description: 'Wait for the answer (default true); false returns the current state.',
        },
        wait_seconds: {
          type: 'number',
          description: `How long to wait (default ${RESULT_WAIT_MS / 1000}, at most ${RESULT_WAIT_MAX_MS / 1000}).`,
        },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      const a = (args ?? {}) as { run_id?: unknown; wait?: unknown; wait_seconds?: unknown };
      const id = String(a.run_id ?? '').trim();
      const waitMs = a.wait === false ? 0 : clampSeconds(a.wait_seconds, RESULT_WAIT_MS);
      const reply = id ? await asks.result(id, waitMs, exec.signal) : null;
      if (!reply)
        return {
          ok: false,
          state: 'failed',
          answer: `No question with the id “${id}” is known in this harness process (it may have restarted). The answer, if any, is in the ${PRODUCT_NAME} conversation.`,
        };
      return toolAnswer(reply, 'result');
    },
  });
}
