/**
 * Hermes adapter — the first-class runtime the hub is built around (ADR 0006,
 * ADR 0002 implementation 2, ADR 0008 for how the hub reaches it).
 *
 * What this adapter does, and how it knows:
 * - **discover**: looks for the `hermes` executable on PATH and asks it for its version.
 * - **probe**: reports whether the CLI is installed and whether its API server answers
 *   `GET /health` (unauthenticated). A hub with Hermes installed but its gateway down is
 *   `stopped`, not "missing": ADR 0006 says a hub without Hermes is "not configured",
 *   never "empty".
 * - **settings**: the four sections the Hermes settings screen renders.
 * - **start**: a conversation over Hermes's **API server run surface**
 *   (`docs/inspirations/hermes-agent.md` §API server, read from Hermes's MIT sources):
 *
 *       POST /v1/runs                  { input, session_id, model?, model_options? } -> 202 { run_id }
 *       GET  /v1/runs/{id}/events      SSE, one JSON object per `data:` line:
 *                                      message.delta · message.interim · reasoning.available ·
 *                                      tool.started · tool.completed · approval.request ·
 *                                      approval.responded · subagent.start · subagent.complete ·
 *                                      run.completed | run.failed | run.cancelled | run.interrupted
 *       POST /v1/runs/{id}/approval    { choice: once | session | always | deny }
 *       POST /v1/runs/{id}/stop        {}
 *
 *   `session_id` is the hub's own stable id for the conversation; Hermes loads the
 *   transcript it stored under it, so the next turn continues where the last ended.
 *   Every request carries `Authorization: Bearer <API_SERVER_KEY>`; Hermes refuses to
 *   start its API server without a key, so there is no unauthenticated mode to support.
 *
 * The wire is behind `HermesTransport` so a unit test scripts a Hermes without a socket.
 * Nothing here knows about the database or the sessions module: `runner.ts` turns these
 * events into the contract's.
 */
import { HERMES_ENTRY } from '../catalog/index.js';
import type { AgentCapability } from '../schema.js';
import { HubError, notImplemented } from '../../../lib/errors.js';
import { EventQueue } from './event-queue.js';
import { parseVersion, probeHttp, runCommand, whichSync, type HostEnvironment } from './host.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentProbe,
  AgentSession,
  AgentTarget,
  DiscoveredAgent,
  PromptInput,
  SettingsSection,
} from './types.js';

export const HERMES_ADAPTER_VERSION = '1.1.0';

/** One frame of `GET /v1/runs/{id}/events`, as Hermes emits it. */
export interface HermesRunEvent {
  event: string;
  run_id?: string;
  timestamp?: number;
  [field: string]: unknown;
}

export interface HermesRunRequest {
  input: string;
  session_id: string;
  model?: string;
  model_options?: { reasoning_effort?: string };
}

/** The four calls a turn needs. The HTTP implementation is `httpHermesTransport`. */
export interface HermesTransport {
  createRun(body: HermesRunRequest, signal: AbortSignal): Promise<{ run_id: string }>;
  events(runId: string, signal: AbortSignal): AsyncIterable<HermesRunEvent>;
  approve(runId: string, choice: string): Promise<void>;
  stop(runId: string): Promise<void>;
}

export interface HermesHttpOptions {
  endpoint: string;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/** Hermes's `{ "error": { "message", "code" } }` envelope, or the raw text. */
async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string } };
    if (body.error?.message) {
      return body.error.code ? `${body.error.message} (${body.error.code})` : body.error.message;
    }
  } catch {
    // not JSON
  }
  return text || `HTTP ${response.status}`;
}

export function httpHermesTransport(options: HermesHttpOptions): HermesTransport {
  const base = options.endpoint.replace(/\/$/, '');
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json',
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
  });

  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const response = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const message = await readError(response);
      throw new HubError(response.status === 401 ? 'agent_unavailable' : 'agent_error', {
        message: `Hermes ${path}: ${message}`,
        details: { status: response.status, path },
      });
    }
    return response;
  };

  return {
    async createRun(body, signal) {
      const response = await post('/v1/runs', body, signal);
      const accepted = (await response.json()) as { run_id?: string };
      if (!accepted.run_id) {
        throw new HubError('agent_error', { message: 'Hermes /v1/runs answered without run_id' });
      }
      return { run_id: accepted.run_id };
    },

    async *events(runId, signal) {
      const response = await doFetch(`${base}/v1/runs/${encodeURIComponent(runId)}/events`, {
        method: 'GET',
        headers: { ...headers(), accept: 'text/event-stream' },
        signal,
      });
      if (!response.ok || !response.body) {
        throw new HubError('agent_error', {
          message: `Hermes /v1/runs/${runId}/events: ${await readError(response)}`,
          details: { status: response.status },
        });
      }
      yield* parseSse(response.body, signal);
    },

    async approve(runId, choice) {
      await post(`/v1/runs/${encodeURIComponent(runId)}/approval`, { choice });
    },

    async stop(runId) {
      await post(`/v1/runs/${encodeURIComponent(runId)}/stop`, {});
    },
  };
}

/**
 * Server-sent events, minimally: frames end with a blank line, `data:` lines carry the
 * JSON, `:` lines are keepalive comments. Hermes sends one JSON object per frame and no
 * `event:` line (the name is inside the object).
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<HermesRunEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frameToEvent(frame);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const last = frameToEvent(buffer);
    if (last) yield last;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function frameToEvent(frame: string): HermesRunEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as HermesRunEvent).event === 'string'
    ) {
      return parsed as HermesRunEvent;
    }
  } catch {
    // A frame that is not JSON is not an event; Hermes never sends one.
  }
  return null;
}

/** Hermes's approval choices, with the label a client shows. */
const HERMES_CHOICES: Record<string, string> = {
  once: 'Allow once',
  session: 'Allow for this session',
  always: 'Always allow',
  deny: 'Deny',
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * One conversation with Hermes. `send()` starts a run and follows its event stream until
 * the terminal frame; the events land on the session queue as adapter events.
 */
export class HermesSession implements AgentSession {
  private readonly queue = new EventQueue();
  private sessionId: string;
  private activeRunId: string | null = null;
  private activeAbort: AbortController | null = null;
  private counter = 0;
  private closed = false;

  constructor(
    private readonly transport: HermesTransport,
    options: { sessionRef: string; model?: string | null; reasoningEffort?: string | null },
  ) {
    this.sessionId = options.sessionRef;
    this.model = options.model ?? null;
    this.reasoningEffort = options.reasoningEffort ?? null;
  }

  private readonly model: string | null;
  private readonly reasoningEffort: string | null;

  get id(): string {
    return this.sessionId;
  }

  /** The Hermes run in flight, for tests and for the run record. */
  get runRef(): string | null {
    return this.activeRunId;
  }

  stream(): AsyncIterable<AgentEvent> {
    return this.queue.iterator();
  }

  async send(prompt: PromptInput): Promise<{ stopReason: string }> {
    if (this.closed) throw new HubError('state_invalid', { message: 'Hermes session is closed' });
    if (this.activeRunId) {
      throw new HubError('already_running', { details: { run_ref: this.activeRunId } });
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    const body: HermesRunRequest = { input: prompt.text, session_id: this.sessionId };
    if (this.model) body.model = this.model;
    if (this.reasoningEffort && this.reasoningEffort !== 'none') {
      body.model_options = { reasoning_effort: this.reasoningEffort };
    }
    let runId: string;
    try {
      runId = (await this.transport.createRun(body, abort.signal)).run_id;
    } catch (error) {
      this.activeAbort = null;
      throw error;
    }
    this.activeRunId = runId;

    const turn = new TurnState();
    let stopReason = 'failed';
    try {
      for await (const frame of this.transport.events(runId, abort.signal)) {
        const terminal = this.apply(frame, turn);
        if (terminal) {
          stopReason = terminal;
          break;
        }
      }
      if (stopReason === 'failed' && !turn.terminalSeen) {
        this.queue.push({ type: 'run.failed', error: 'Hermes closed the event stream early' });
      }
    } catch (error) {
      if (!turn.terminalSeen) {
        this.queue.push({
          type: 'run.failed',
          error: error instanceof Error ? error.message : 'Hermes event stream failed',
        });
      }
    } finally {
      this.activeRunId = null;
      this.activeAbort = null;
    }
    return { stopReason };
  }

  /** Folds one Hermes frame into adapter events; returns the stop reason on a terminal one. */
  private apply(frame: HermesRunEvent, turn: TurnState): string | null {
    switch (frame.event) {
      case 'message.delta': {
        const delta = str(frame.delta);
        if (delta) {
          turn.streamedText += delta;
          this.queue.push({ type: 'message.delta', text: delta });
        }
        return null;
      }
      case 'message.interim': {
        // Commentary beside tool calls; `already_streamed` means the deltas carried it.
        const text = str(frame.text);
        if (text && frame.already_streamed !== true) {
          const glue = turn.streamedText && !turn.streamedText.endsWith('\n') ? '\n\n' : '';
          turn.streamedText += glue + text;
          this.queue.push({ type: 'message.delta', text: glue + text });
        }
        return null;
      }
      case 'reasoning.available': {
        const text = str(frame.text);
        if (text) this.queue.push({ type: 'reasoning.delta', text });
        return null;
      }
      case 'tool.started': {
        const name = str(frame.tool) ?? 'tool';
        const id = `tool-${++this.counter}`;
        turn.openTools.push({ id, name });
        const preview = str(frame.preview);
        this.queue.push({
          type: 'tool.started',
          id,
          name,
          title: preview ?? name,
          kind: name,
          input: preview ? { preview } : {},
          raw: frame,
        });
        return null;
      }
      case 'tool.completed': {
        const name = str(frame.tool);
        const index = turn.findOpenTool(name);
        if (index < 0) return null;
        const [open] = turn.openTools.splice(index, 1);
        const failed = frame.error === true;
        this.queue.push({
          type: failed ? 'tool.failed' : 'tool.completed',
          id: open!.id,
          title: open!.name,
          output: str(frame.preview),
          raw: frame,
        });
        return null;
      }
      case 'subagent.start': {
        const delegation = str(frame.delegation_id) ?? `subagent-${++this.counter}`;
        const id = `subagent-${delegation}`;
        turn.openTools.push({ id, name: 'delegate_task' });
        this.queue.push({
          type: 'tool.started',
          id,
          name: 'delegate_task',
          title: str(frame.goal) ?? str(frame.preview) ?? 'delegate_task',
          kind: 'delegate_task',
          input: { goal: str(frame.goal) ?? '' },
          subagentId: delegation,
          raw: frame,
        });
        return null;
      }
      case 'subagent.complete': {
        const delegation = str(frame.delegation_id);
        const id = delegation ? `subagent-${delegation}` : null;
        const index = turn.openTools.findIndex((t) =>
          id ? t.id === id : t.name === 'delegate_task',
        );
        if (index < 0) return null;
        const [open] = turn.openTools.splice(index, 1);
        const status = str(frame.status) ?? 'completed';
        this.queue.push({
          type: status === 'completed' ? 'tool.completed' : 'tool.failed',
          id: open!.id,
          title: 'delegate_task',
          output: str(frame.summary) ?? str(frame.output_tail),
          raw: frame,
        });
        return null;
      }
      case 'approval.request': {
        const id = str(frame.request_id) ?? `approval-${++this.counter}`;
        const choices = Array.isArray(frame.choices)
          ? frame.choices.filter((c): c is string => typeof c === 'string')
          : ['once', 'deny'];
        const command = str(frame.command);
        const last = turn.openTools[turn.openTools.length - 1];
        this.queue.push({
          type: 'approval.requested',
          id,
          title: str(frame.description) ?? command ?? 'Hermes needs your approval',
          description: str(frame.description),
          command,
          toolId: last?.id ?? null,
          options: choices.map((choice) => ({
            id: choice,
            label: HERMES_CHOICES[choice] ?? choice,
            kind: choice,
          })),
        });
        return null;
      }
      case 'approval.responded':
      case 'run.started':
      case 'message.started':
      case 'run.stopping':
        return null;
      case 'run.completed':
      case 'run.cancelled':
      case 'run.failed':
      case 'run.interrupted': {
        turn.terminalSeen = true;
        const sessionId = str(frame.session_id);
        if (sessionId) this.sessionId = sessionId;
        const usage = frame.usage as Record<string, unknown> | undefined;
        const runtime = frame.runtime as Record<string, unknown> | undefined;
        if (usage && typeof usage === 'object') {
          this.queue.push({
            type: 'usage',
            modelLabel: str(runtime?.model) ?? this.model,
            providerId: str(runtime?.provider),
            ...(num(usage.input_tokens) !== undefined
              ? { inputTokens: num(usage.input_tokens)! }
              : {}),
            ...(num(usage.output_tokens) !== undefined
              ? { outputTokens: num(usage.output_tokens)! }
              : {}),
            ...(num(usage.cache_read_tokens) !== undefined
              ? { cacheReadTokens: num(usage.cache_read_tokens)! }
              : {}),
            ...(num(usage.cache_write_tokens) !== undefined
              ? { cacheWriteTokens: num(usage.cache_write_tokens)! }
              : {}),
          });
        }
        if (frame.event === 'run.completed') {
          // A run that never streamed (a provider without deltas) still has its answer here.
          const output = str(frame.output);
          if (output && !turn.streamedText)
            this.queue.push({ type: 'message.delta', text: output });
          this.queue.push({ type: 'run.completed', stopReason: 'completed' });
          return 'completed';
        }
        if (frame.event === 'run.cancelled') {
          this.queue.push({ type: 'run.completed', stopReason: 'cancelled', interrupted: true });
          return 'cancelled';
        }
        this.queue.push({
          type: 'run.failed',
          error:
            str(frame.error) ??
            (frame.event === 'run.interrupted'
              ? 'the Hermes gateway interrupted the run'
              : 'the Hermes run failed'),
        });
        return 'failed';
      }
      case 'error': {
        turn.terminalSeen = true;
        this.queue.push({ type: 'run.failed', error: str(frame.message) ?? 'Hermes error' });
        return 'failed';
      }
      default:
        // Frames the hub does not model (tool.progress, subagent.tool, …) are dropped, not
        // guessed at; the terminal frame still carries the outcome.
        return null;
    }
  }

  async respond(_approvalId: string, optionId: string): Promise<void> {
    if (!this.activeRunId) {
      throw new HubError('state_invalid', { details: { reason: 'no_run_in_flight' } });
    }
    await this.transport.approve(this.activeRunId, optionId);
  }

  async interrupt(): Promise<void> {
    if (!this.activeRunId) return;
    await this.transport.stop(this.activeRunId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.activeAbort?.abort();
    this.queue.end();
  }
}

class TurnState {
  streamedText = '';
  terminalSeen = false;
  openTools: { id: string; name: string }[] = [];

  /** Hermes names tools but does not number them: the newest open call of that name. */
  findOpenTool(name: string | null): number {
    if (name) {
      for (let i = this.openTools.length - 1; i >= 0; i -= 1) {
        if (this.openTools[i]!.name === name) return i;
      }
    }
    return this.openTools.length - 1;
  }
}

export interface HermesAdapterOptions {
  host: HostEnvironment;
  /** Overridden in tests; defaults to the gateway Hermes documents on 127.0.0.1:8642. */
  defaultEndpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** `API_SERVER_KEY` of the gateway, or how to read it; `null` means "not configured". */
  apiKey?: string | null | (() => string | null);
  /** Injected in tests: a scripted Hermes instead of HTTP. */
  transport?: (target: AgentTarget, endpoint: string) => HermesTransport;
}

export function createHermesAdapter(options: HermesAdapterOptions): AgentAdapter {
  const host = options.host;
  const defaultEndpoint = options.defaultEndpoint ?? HERMES_ENTRY.defaultEndpoint!;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const apiKey = (): string | null =>
    typeof options.apiKey === 'function' ? options.apiKey() : (options.apiKey ?? null);

  async function gatewayState(
    endpoint: string,
  ): Promise<{ state: 'running' | 'stopped' | 'error'; error: string | null }> {
    const health = await probeHttp(`${endpoint.replace(/\/$/, '')}/health`, {
      timeoutMs,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (health.ok) return { state: 'running', error: null };
    // A refused connection is "not started"; an answer that is not OK is a broken gateway.
    if (health.status === null) return { state: 'stopped', error: null };
    return { state: 'error', error: `gateway answered ${health.status}` };
  }

  return {
    kind: 'hermes',
    name: 'Hermes gateway',
    version: HERMES_ADAPTER_VERSION,
    selectable: true,

    capabilities(): AgentCapability[] {
      return [...HERMES_ENTRY.capabilities];
    },

    async discover(): Promise<DiscoveredAgent[]> {
      const executablePath = whichSync(HERMES_ENTRY.binary, host);
      if (!executablePath) return [];
      const result = await runCommand([executablePath, ...HERMES_ENTRY.versionArgs]);
      return [
        {
          slug: HERMES_ENTRY.id,
          name: HERMES_ENTRY.name,
          vendor: HERMES_ENTRY.vendor,
          command: [HERMES_ENTRY.binary],
          executablePath,
          version: parseVersion(`${result.stdout}${result.stderr}`),
          capabilities: [...HERMES_ENTRY.capabilities],
          sections: [...HERMES_ENTRY.sections],
        },
      ];
    },

    async probe(target: AgentTarget): Promise<AgentProbe> {
      const endpoint = target.endpoint ?? defaultEndpoint;
      const executablePath =
        whichSync(target.executablePath ?? target.command[0] ?? HERMES_ENTRY.binary, host) ?? null;
      const runtime = await gatewayState(endpoint);

      if (!executablePath) {
        // No CLI on the host. A reachable gateway still means a usable Hermes — it may be
        // another container — so that case is installed-elsewhere, not missing.
        if (runtime.state === 'running') {
          return {
            installed: true,
            source: 'none',
            executablePath: null,
            version: null,
            runtime: { state: 'running', url: endpoint, error: null },
            error: null,
          };
        }
        return {
          installed: false,
          source: 'none',
          executablePath: null,
          version: null,
          runtime: { state: runtime.state, url: null, error: runtime.error },
          error: null,
        };
      }

      const result = await runCommand([executablePath, ...HERMES_ENTRY.versionArgs]);
      return {
        installed: true,
        source: 'user_cli',
        executablePath,
        version: parseVersion(`${result.stdout}${result.stderr}`),
        runtime: {
          state: runtime.state,
          url: runtime.state === 'running' ? endpoint : null,
          error: runtime.error,
        },
        error: result.ok ? null : result.error,
      };
    },

    settings(_target, stored): SettingsSection[] {
      const value = (key: string, fallback: unknown): unknown => stored[key] ?? fallback;
      return [
        {
          key: 'agent',
          title: { ar: 'الوكيل', en: 'Agent' },
          restart_required: true,
          fields: [
            {
              key: 'max_turns',
              label: { ar: 'أقصى عدد للدورات', en: 'Max turns' },
              kind: 'integer',
              value: value('max_turns', 40),
              options: [],
              min: 1,
              max: 500,
              hint: null,
            },
          ],
        },
        {
          key: 'memory',
          title: { ar: 'الذاكرة', en: 'Memory' },
          restart_required: false,
          fields: [
            {
              key: 'write_approval',
              label: { ar: 'الموافقة على الكتابة', en: 'Approve memory writes' },
              kind: 'toggle',
              value: value('write_approval', true),
              options: [],
              min: null,
              max: null,
              hint: null,
            },
          ],
        },
        {
          key: 'session',
          title: { ar: 'الجلسة', en: 'Session' },
          restart_required: false,
          fields: [
            {
              key: 'approvals_mode',
              label: { ar: 'وضع الموافقات', en: 'Approvals mode' },
              kind: 'choice',
              value: value('approvals_mode', 'ask'),
              options: [
                { value: 'off', label: 'No approvals' },
                { value: 'ask', label: 'Ask' },
                { value: 'always', label: 'Always' },
              ],
              min: null,
              max: null,
              hint: null,
            },
          ],
        },
        {
          key: 'gateway',
          title: { ar: 'البوابة', en: 'Gateway' },
          restart_required: true,
          fields: [
            {
              key: 'endpoint',
              label: { ar: 'عنوان البوابة', en: 'Gateway URL' },
              kind: 'text',
              value: value('endpoint', defaultEndpoint),
              options: [],
              min: null,
              max: null,
              hint: 'Hermes API server, 8642 by default.',
            },
          ],
        },
      ];
    },

    async start(target: AgentTarget): Promise<AgentSession> {
      const endpoint = target.endpoint ?? defaultEndpoint;
      const sessionRef = target.sessionRef;
      if (!sessionRef) {
        // The runner mints the conversation id (ADR 0008 §Session continuity); an adapter
        // that invented one would give the hub a session it cannot find again.
        throw notImplemented({ adapter: 'hermes', reason: 'target.sessionRef is required' });
      }
      const transport = options.transport
        ? options.transport(target, endpoint)
        : httpHermesTransport({
            endpoint,
            apiKey: apiKey(),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          });
      if (!options.transport && !apiKey()) {
        throw new HubError('agent_unavailable', {
          details: { reason: 'hermes_api_key_missing', endpoint },
          message: 'no API_SERVER_KEY for the Hermes gateway (see docs/DEPLOY.md)',
        });
      }
      return new HermesSession(transport, {
        sessionRef,
        model: target.model ?? null,
        reasoningEffort: target.reasoningEffort ?? null,
      });
    },
  };
}
