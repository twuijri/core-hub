// Which of an agent's pages exist for it (NAVIGATION §4). One answer, used by the card's chips
// and by the agent's side list, so the two can never offer different pages.
import { agentMenu, type Destination } from '../navigation/manifest.js';
import type { Agent } from '../types.js';

/**
 * An agent that is actually here can be configured: the card offers its Settings button and
 * the side list its Settings row. Its settings come from the adapter's descriptor (ADR 0002),
 * which every adapter has, so `settings` is not a capability an agent has to declare.
 */
export function configurable(agent: Pick<Agent, 'status' | 'install'>): boolean {
  return agent.status !== 'not_installed' && agent.install.source !== 'none';
}

/**
 * The agent's pages in manifest order (`agentLevel`): every page whose capability the adapter
 * declares, and Settings last for an agent that can be configured. Claude Code, which declares
 * `skills` and `mcp`, gets Skills · MCP · Settings and nothing else.
 */
export function agentSections(
  agent: Pick<Agent, 'capabilities' | 'status' | 'install'>,
  role: string,
): Destination[] {
  const declared = configurable(agent) ? [...agent.capabilities, 'settings'] : agent.capabilities;
  return agentMenu(declared, role);
}
