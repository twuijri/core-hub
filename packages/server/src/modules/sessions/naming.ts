/**
 * "Sessions name themselves" (contract decision §26), wired up.
 *
 * `titles.ts` holds the pure parts — the prompt, the cleanup, the fallback. This holds the
 * three rules that need the store, the port and the socket:
 *
 * 1. **It runs after the run, never inside it.** `SessionNamer.schedule()` returns
 *    immediately; the work is a tracked promise the engine's `settledAll()` waits on, so a
 *    test is deterministic and a shutdown does not cut a title in half. A failure is
 *    logged and nothing else: a session that could not be named keeps reading "New chat",
 *    which is the state it was already in.
 * 2. **Once per session.** Only a session whose title is still `null`, and only one
 *    attempt at a time (`inFlight`), so a burst of replies is one question, not five.
 * 3. **Never over a person.** `title_set_by_user` is checked here as well as at the point
 *    the patch is written — the row is the authority, not the caller.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { EngineScope } from './engine.js';
import type { SessionsPorts } from './ports.js';
import type { SessionsRealtime } from './realtime.js';
import type { SessionRow } from './mappers.js';
import type { SessionsStore } from './store.js';
import { cleanTitle, fallbackTitle, titlePrompt, TITLE_MAX } from './titles.js';

/** A title is a handful of words; an agent that needs longer than this is not worth waiting for. */
export const TITLE_TIMEOUT_MS = 20_000;

export interface SessionNamerDeps {
  store: SessionsStore;
  realtime: SessionsRealtime;
  ports: SessionsPorts;
  log: FastifyBaseLogger;
  /** Re-renders the row for `session.updated`; the engine already owns that mapping. */
  render(scope: EngineScope, session: SessionRow): Record<string, unknown>;
}

export class SessionNamer {
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: SessionNamerDeps) {}

  /**
   * Name this session if it still needs a name. Returns at once; the work is tracked.
   * `force` is the "Retitle" gesture: the person cleared the title, so the hub tries
   * again even though it already named this session once.
   */
  schedule(scope: EngineScope, sessionId: string): void {
    if (this.inFlight.has(sessionId)) return;
    this.inFlight.add(sessionId);
    const task = this.name(scope, sessionId)
      .catch((error: unknown) => {
        // Never fatal: a nameless session is the state we started from.
        this.deps.log.warn({ err: error, sessionId }, 'sessions: naming the session failed');
      })
      .finally(() => {
        this.inFlight.delete(sessionId);
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  /** Shutdown and test hook: every naming attempt has finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async name(scope: EngineScope, sessionId: string): Promise<void> {
    const { store, ports } = this.deps;
    const row = store.getSession(scope.workspace, sessionId);
    // Re-read, do not trust the caller: between the reply finishing and this running, the
    // person may have named it, or deleted it.
    if (!row || row.titleSetByUser || row.title !== null) return;

    const exchange = firstExchange(store, scope.workspace, sessionId);
    if (!exchange) return;

    let suggested: string | null = null;
    if (ports.runner.ask) {
      try {
        suggested = cleanTitle(
          await ports.runner.ask({
            workspace: scope.workspace,
            agentId: row.agentId,
            sessionId: row.id,
            prompt: titlePrompt(exchange),
            model: row.modelLabel,
            provider: row.provider,
            timeoutMs: TITLE_TIMEOUT_MS,
          }),
          TITLE_MAX,
        );
      } catch (error) {
        // The agent refused, timed out, or is gone. The fallback below still names it.
        this.deps.log.info({ err: error, sessionId }, 'sessions: the agent named no session');
      }
    }
    const title = suggested ?? fallbackTitle(exchange.user);
    if (!title) return;

    // Last check before the write: the two awaits above are two chances for a person to
    // have typed a title of their own, and theirs wins.
    const current = store.getSession(scope.workspace, sessionId);
    if (!current || current.titleSetByUser || current.title !== null) return;

    const updated = store.updateSession(scope.workspace, sessionId, { title });
    if (!updated) return;
    this.deps.realtime.emitToProfile(scope.profile, 'session.updated', {
      session: this.deps.render(scope, updated),
    });
  }
}

/**
 * The first user message and the first assistant reply — the whole of what naming a
 * conversation needs, and no more of the transcript than that.
 */
export function firstExchange(
  store: SessionsStore,
  workspace: string,
  sessionId: string,
): { user: string; assistant: string } | null {
  const messages = store.allMessages(workspace, sessionId);
  const user = messages.find((m) => m.role === 'user' || m.role === 'command');
  if (!user || user.content.trim() === '') return null;
  const assistant = messages.find((m) => m.role === 'assistant' && m.seq > user.seq);
  return { user: user.content, assistant: assistant?.content ?? '' };
}
