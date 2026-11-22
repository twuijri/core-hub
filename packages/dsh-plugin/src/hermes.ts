/**
 * Talking to the hub's agent from inside the harness (ADR 0033 §6): `/hermes <message>` and the
 * `corehub_ask_agent` tool both send to a hub conversation through the conversations API, in
 * the profile the person picked, and return the agent's final answer. One hub conversation
 * follows one harness session, so Hermes keeps the thread, its memory and its MCP.
 *
 * The answer is followed by polling the run (`sessions.getRun`) rather than streamed: a tool
 * returns one value, and a command one result. Sending (`start`) and following (`follow`) are
 * separate, so the tool can keep following a run the harness stopped waiting for (see
 * `ask-runs.ts`): Hermes often needs minutes, longer than a harness program's default timeout.
 */
import { HubApiError, type components } from '@corehub/contracts';
import { HARNESS_NAME } from './names.js';
import type { HubConnection } from './hub.js';
import type { PluginStore } from './store.js';

type Agent = components['schemas']['Agent'];
type Run = components['schemas']['Run'];
type Message = components['schemas']['Message'];

export interface AgentSettings {
  /** The hub profile the conversation lives in; null: the person's default. */
  profile: string | null;
  /** The agent's slug (`hermes` by default) or id. */
  agent: string;
}

/** A run on the hub: the conversation it belongs to, its id, and the profile it lives in. */
export interface RunTarget {
  session_id: string;
  run_id: string;
  profile: string;
}

export type AskResult =
  | { state: 'answered'; text: string; session_id: string; run_id: string }
  | { state: 'waiting'; session_id: string; run_id: string }
  | { state: 'failed'; message: string; session_id: string | null; run_id: string | null }
  | { state: 'timeout'; session_id: string; run_id: string };

export interface AgentBridgeOptions {
  connection(): HubConnection | null;
  store: PluginStore;
  settings(): AgentSettings;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * How a message the harness's own agent wrote starts in the hub conversation, so the person
 * reading it there can tell it from one they typed. The contract's `RunCreate` has no source or
 * metadata field (and `Message.author` is always the person for a user message), so the mark is
 * in the text. The harness's name is a product name, the same in every language.
 */
export const HARNESS_MARK = `↪ ${HARNESS_NAME}:`;

/** The text sent to the hub: marked when the harness's agent wrote it. */
export function hubText(text: string, fromHarnessAgent: boolean): string {
  return fromHarnessAgent ? `${HARNESS_MARK}\n\n${text}` : text;
}

export interface FollowOptions {
  signal?: AbortSignal;
  /** How long to follow before answering `timeout` (the run keeps going on the hub). */
  timeoutMs?: number;
  /** Return as soon as the run waits for an approval (the command), or keep following (the tool). */
  stopOnWaiting?: boolean;
  /** Each new status the run reports (`queued`, `running`, `waiting`, …). */
  onStatus?: (status: string) => void;
}

export type StartResult =
  { ok: true; target: RunTarget } | { ok: false; result: Extract<AskResult, { state: 'failed' }> };

/** Picks the agent: the configured slug or id, else Hermes, else the first enabled one. */
export function pickAgent(agents: readonly Agent[], wanted: string): Agent | null {
  const enabled = agents.filter((a) => a.enabled !== false);
  return (
    enabled.find((a) => a.slug === wanted || a.id === wanted) ??
    enabled.find((a) => a.kind === 'hermes') ??
    enabled[0] ??
    null
  );
}

/** The text of a message: its text blocks, in order. */
export function messageText(message: Pick<Message, 'content'> | null | undefined): string {
  const blocks = (message?.content ?? []) as Array<{ type?: string; text?: unknown }>;
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .join('\n')
    .trim();
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });

export class AgentBridge {
  constructor(private readonly options: AgentBridgeOptions) {}

  /** Sends one message and follows its run to the end (the `/hermes` command). */
  async ask(harnessSession: string, text: string, signal?: AbortSignal): Promise<AskResult> {
    const started = await this.start(harnessSession, text);
    if (!started.ok) return started.result;
    return this.follow(started.target, {
      ...(signal ? { signal } : {}),
      timeoutMs: this.options.timeoutMs ?? 10 * 60_000,
      stopOnWaiting: true,
    });
  }

  /**
   * Sends one message to the hub conversation that follows this harness session (starting one
   * the first time, or again when the hub deleted it) and returns its run, without waiting.
   * `fromHarnessAgent` marks the text as written by the harness's agent ({@link HARNESS_MARK}).
   */
  async start(
    harnessSession: string,
    text: string,
    options: { fromHarnessAgent?: boolean } = {},
  ): Promise<StartResult> {
    const failed = (message: string): StartResult => ({
      ok: false,
      result: { state: 'failed', message, session_id: null, run_id: null },
    });
    const connection = this.options.connection();
    if (!connection) return failed('not_linked');
    const settings = this.options.settings();
    const profile = settings.profile ?? connection.stored.default_profile;
    const body = hubText(text, options.fromHarnessAgent === true);

    let sessionId = this.conversationFor(harnessSession, profile);
    let created = false;
    if (!sessionId) {
      sessionId = await this.newConversation(connection, profile, settings.agent, text);
      if (!sessionId) return failed('no_agent');
      created = true;
    }

    let runId: string;
    try {
      runId = await this.send(connection, sessionId, profile, body);
    } catch (error) {
      // The conversation was deleted on the hub: start a new one, once.
      if (!created && error instanceof HubApiError && error.status === 404) {
        const fresh = await this.newConversation(connection, profile, settings.agent, text);
        if (!fresh) return failed('no_agent');
        sessionId = fresh;
        runId = await this.send(connection, sessionId, profile, body);
      } else throw error;
    }
    this.options.store.saveConversation(harnessSession, { session_id: sessionId, profile });
    return { ok: true, target: { session_id: sessionId, run_id: runId, profile } };
  }

  /**
   * Polls a run until it ends (or waits for an approval, when `stopOnWaiting`), then reads the
   * agent's answer. The interval grows from `pollMs` to five seconds: a run that takes minutes
   * costs tens of requests, not hundreds.
   */
  async follow(target: RunTarget, options: FollowOptions = {}): Promise<AskResult> {
    const { session_id: sessionId, run_id: runId, profile } = target;
    const connection = this.options.connection();
    if (!connection)
      return { state: 'failed', message: 'not_linked', session_id: sessionId, run_id: runId };
    const headers = { 'X-Hub-Profile': profile };
    const sleep = this.options.sleep ?? defaultSleep;
    const deadline = Date.now() + (options.timeoutMs ?? this.options.timeoutMs ?? 10 * 60_000);
    let interval = this.options.pollMs ?? 1500;
    let last: string | null = null;
    for (;;) {
      const { data } = await connection.client.raw('get', '/sessions/{session_id}/runs/{run_id}', {
        params: { session_id: sessionId, run_id: runId },
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const run = data as Run;
      if (run.status !== last) {
        last = run.status;
        options.onStatus?.(run.status);
      }
      if (run.status === 'waiting' && options.stopOnWaiting)
        return { state: 'waiting', session_id: sessionId, run_id: runId };
      if (TERMINAL.has(run.status)) {
        if (run.status !== 'succeeded')
          return {
            state: 'failed',
            message: (run.error as { message?: string } | null)?.message ?? run.status,
            session_id: sessionId,
            run_id: runId,
          };
        const answer = await this.output(
          connection,
          sessionId,
          profile,
          run.output_message_id ?? null,
        );
        return { state: 'answered', text: answer, session_id: sessionId, run_id: runId };
      }
      if (Date.now() > deadline) return { state: 'timeout', session_id: sessionId, run_id: runId };
      await sleep(interval, options.signal);
      interval = Math.min(5000, Math.round(interval * 1.5));
    }
  }

  private conversationFor(harnessSession: string, profile: string): string | null {
    const saved = this.options.store.conversation(harnessSession);
    return saved && saved.profile === profile ? saved.session_id : null;
  }

  private async newConversation(
    connection: HubConnection,
    profile: string,
    wanted: string,
    firstMessage: string,
  ): Promise<string | null> {
    const headers = { 'X-Hub-Profile': profile };
    const { data } = await connection.client.raw('get', '/agents', { headers });
    const agent = pickAgent(((data as { items?: Agent[] })?.items ?? []) as Agent[], wanted);
    if (!agent) return null;
    const title = `${HARNESS_NAME}: ${firstMessage.replace(/\s+/g, ' ').trim()}`.slice(0, 120);
    const { data: session } = await connection.client.raw('post', '/sessions', {
      body: { agent_id: agent.id, title },
      headers,
    });
    return (session as { id: string }).id;
  }

  private async send(
    connection: HubConnection,
    sessionId: string,
    profile: string,
    text: string,
  ): Promise<string> {
    const { data } = await connection.client.raw('post', '/sessions/{session_id}/runs', {
      params: { session_id: sessionId },
      body: { content: [{ type: 'text', text }], when: 'queue' },
      headers: { 'X-Hub-Profile': profile },
    });
    return (data as { run_id: string }).run_id;
  }

  private async output(
    connection: HubConnection,
    sessionId: string,
    profile: string,
    messageId: string | null,
  ): Promise<string> {
    const { data } = await connection.client.raw('get', '/sessions/{session_id}/messages', {
      params: { session_id: sessionId },
      query: { limit: 20 },
      headers: { 'X-Hub-Profile': profile },
    });
    const items = ((data as { items?: Message[] })?.items ?? []) as Message[];
    const message =
      (messageId ? items.find((m) => m.id === messageId) : undefined) ??
      [...items].reverse().find((m) => m.role === 'assistant');
    return messageText(message ?? null);
  }
}
