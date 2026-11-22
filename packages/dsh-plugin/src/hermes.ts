/**
 * Talking to the hub's agent from inside the harness (ADR 0033 §6): `/hermes <message>` and the
 * `corehub_ask_agent` tool both send to a hub conversation through the conversations API, in
 * the profile the person picked, and return the agent's final answer. One hub conversation
 * follows one harness session, so Hermes keeps the thread, its memory and its MCP.
 *
 * The answer is followed by polling the run (`sessions.getRun`) rather than streamed: a tool
 * returns one value, and a command one result.
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

  async ask(harnessSession: string, text: string, signal?: AbortSignal): Promise<AskResult> {
    const connection = this.options.connection();
    if (!connection)
      return { state: 'failed', message: 'not_linked', session_id: null, run_id: null };
    const settings = this.options.settings();
    const profile = settings.profile ?? connection.stored.default_profile;
    const headers = { 'X-Hub-Profile': profile };

    let sessionId = this.conversationFor(harnessSession, profile);
    let created = false;
    if (!sessionId) {
      sessionId = await this.newConversation(connection, profile, settings.agent, text);
      if (!sessionId)
        return { state: 'failed', message: 'no_agent', session_id: null, run_id: null };
      created = true;
    }

    let runId: string;
    try {
      runId = await this.send(connection, sessionId, profile, text);
    } catch (error) {
      // The conversation was deleted on the hub: start a new one, once.
      if (!created && error instanceof HubApiError && error.status === 404) {
        const fresh = await this.newConversation(connection, profile, settings.agent, text);
        if (!fresh) return { state: 'failed', message: 'no_agent', session_id: null, run_id: null };
        sessionId = fresh;
        runId = await this.send(connection, sessionId, profile, text);
      } else throw error;
    }
    this.options.store.saveConversation(harnessSession, { session_id: sessionId, profile });

    const sleep = this.options.sleep ?? defaultSleep;
    const deadline = Date.now() + (this.options.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const { data } = await connection.client.raw('get', '/sessions/{session_id}/runs/{run_id}', {
        params: { session_id: sessionId, run_id: runId },
        headers,
        ...(signal ? { signal } : {}),
      });
      const run = data as Run;
      if (run.status === 'waiting')
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
      await sleep(this.options.pollMs ?? 1500, signal);
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
