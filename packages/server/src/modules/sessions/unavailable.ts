/**
 * The default ports: there is no agent registry and no adapter yet.
 *
 * They answer honestly rather than pretending — an unknown agent id is a 404
 * (invariant 2) and any attempt to run is `422 agent_unavailable`. Replacing
 * them with the `agents` module's registry and adapter is one line in
 * `src/modules/index.ts`; nothing else in this module changes.
 */
import { HubError } from '../../lib/errors.js';
import type { AgentDirectory, AgentEvent, AgentInfo, AgentRunner } from './ports.js';

export const unavailableAgents: AgentDirectory = {
  async find(_workspace: string, _agentId: string): Promise<AgentInfo | null> {
    return null;
  },
};

function unavailable(): HubError {
  return new HubError('agent_unavailable', {
    details: { reason: 'adapter_not_wired' },
  });
}

export const unavailableRunner: AgentRunner = {
  async start() {
    throw unavailable();
  },
  // eslint-disable-next-line require-yield -- never reached: start() throws first.
  async *stream(): AsyncIterable<AgentEvent> {
    throw unavailable();
  },
  async send() {
    throw unavailable();
  },
  async interrupt() {
    throw unavailable();
  },
};
