/**
 * The default ports: there is no agent registry and no adapter yet.
 *
 * They answer honestly rather than pretending — an unknown agent id is a 404
 * (invariant 2) and any attempt to run is `422 agent_unavailable`. Replacing
 * them with the `agents` module's registry and adapter is one line in
 * `src/modules/index.ts`; nothing else in this module changes.
 */
import { HubError } from '../../lib/errors.js';
import type {
  AgentDirectory,
  AgentEvent,
  AgentInfo,
  AgentRunner,
  AttachmentsPort,
  SessionsNotifier,
} from './ports.js';

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
  /**
   * Naming a session is the one thing here that does *not* throw: it is optional work
   * on behalf of a person who asked for nothing, and the caller already has a fallback
   * (`titles.ts`). An error would only be logged and thrown away.
   */
  async ask() {
    return null;
  },
};

/**
 * No file registry wired: ids resolve to nothing and no bytes are ever written.
 *
 * This is the honest default rather than an in-memory store, for the same reason the
 * runner above throws: a hub whose `knowledge` module is not composed has nowhere to
 * put a file, and pretending otherwise would lose it. With the real port in place
 * (`src/modules/index.ts`) every path below is the `knowledge` service's.
 */
export const noAttachments: AttachmentsPort = {
  resolve() {
    return new Map();
  },
  materialise() {
    return [];
  },
  async capture() {
    throw new HubError('service_unavailable', {
      details: { reason: 'attachments_not_wired' },
    });
  },
};

/**
 * No notifier wired: nothing is told to anybody.
 *
 * Unlike the runner above this does not throw, because the absence of a notice is not a
 * failure of the run. A hub composed without `notify` streams exactly as it did before.
 */
export const noNotifier: SessionsNotifier = {
  runFinished() {},
  approvalRequested() {},
};
