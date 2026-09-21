/**
 * Process harness — ADR 0002 implementation 3, the last resort for CLIs that speak
 * neither ACP nor a gateway API.
 *
 * It is declared and **not selectable**. A real harness is a PTY, a transcript parser and
 * a command whitelist; each of those is a guess about one CLI's output, and a wrong guess
 * shows a person text an agent never wrote. So this file registers the adapter so the
 * registry and the clients can see that the kind exists and is marked `limited`, and
 * refuses every operation that would need the parser.
 *
 * What finishing it needs: a PTY dependency, a per-CLI transcript grammar, and the
 * command whitelist from `AgentCapabilities.commandWhitelist`. Until then nothing in the
 * hub can pick a harnessed agent, because `selectable` is false and the registry hides
 * such agents from pickers.
 */
import { notImplemented } from '../../../lib/errors.js';
import type { AgentCapability } from '../schema.js';
import type {
  AgentAdapter,
  AgentProbe,
  AgentSession,
  AgentTarget,
  DiscoveredAgent,
  SettingsSection,
} from './types.js';

export const PROCESS_ADAPTER_VERSION = '0.1.0-limited';

export function createProcessAdapter(): AgentAdapter {
  return {
    kind: 'harness',
    name: 'Process harness',
    version: PROCESS_ADAPTER_VERSION,
    selectable: false,

    capabilities(): AgentCapability[] {
      // Deliberately empty: the harness cannot honestly promise streaming, tools or
      // approvals until the transcript parser exists.
      return [];
    },

    async discover(): Promise<DiscoveredAgent[]> {
      // Detection would mean claiming any binary on PATH is drivable. It is not.
      return [];
    },

    async probe(_target: AgentTarget): Promise<AgentProbe> {
      return {
        installed: false,
        source: 'none',
        executablePath: null,
        version: null,
        runtime: { state: 'not_applicable', url: null, error: null },
        error: 'the process harness is declared but not implemented (ADR 0002)',
      };
    },

    settings(): SettingsSection[] {
      return [];
    },

    async start(_target: AgentTarget): Promise<AgentSession> {
      throw notImplemented({
        adapter: 'harness',
        reason: 'the process harness needs a PTY and a transcript parser; it is not selectable',
      });
    },
  };
}
