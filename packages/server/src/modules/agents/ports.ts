/**
 * What `agents` offers the `sessions` module.
 *
 * `sessions` declares two ports it needs (`modules/sessions/ports.ts`): `AgentDirectory`
 * ("does this agent exist here and can it take a turn?") and `AgentRunner` (the four
 * verbs of a turn). Both are the registry's business, so both are implemented here and
 * wiring them is one line in `src/modules/index.ts`:
 *
 *     createSessionsModule({ agents: agentDirectory(app), runner: agentRunner(app) })
 *
 * The interfaces are restated here rather than imported because a module never imports
 * another module's internals (ARCHITECTURE §Modules); `sessions` owns the shape, this
 * file owns an implementation that satisfies it structurally.
 */

/** A registry entry, reduced to what starting a turn needs. */
export interface AgentInfo {
  id: string;
  name: string;
  /** `acp` | `hermes` | `harness` (ADR 0002). Stored on the run for the UI. */
  adapterKind: string;
  defaultModel: string | null;
  defaultProvider: string | null;
  /** False when the agent is known but not installed / not running on this host. */
  available: boolean;
  /** Machine-readable reason for `available: false` (`not_installed`, `stopped`, …). */
  unavailableReason?: string;
}

export interface AgentDirectoryPort {
  /** `null` when the workspace has no such agent — the caller answers 404. */
  find(workspace: string, agentId: string): Promise<AgentInfo | null>;
}
