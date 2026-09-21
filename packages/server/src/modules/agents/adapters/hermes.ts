/**
 * Hermes adapter — the first-class runtime the hub is built around (ADR 0006,
 * ADR 0002 implementation 2).
 *
 * What this slice does, and how it knows:
 * - **discover**: looks for the `hermes` executable on PATH and asks it for its version.
 * - **probe**: reports whether the CLI is installed and whether its gateway answers.
 *   Hermes exposes an HTTP API server on 8642 with `GET /health` and
 *   `GET /v1/capabilities` (docs/inspirations/hermes-agent.md §1, from Hermes's public
 *   MIT docs). A hub with Hermes installed but its gateway down is `stopped`, not
 *   "missing": ADR 0006 says a hub without Hermes is "not configured", never "empty".
 * - **settings**: the four sections the Hermes settings screen renders.
 *
 * What it does **not** do yet, and why it is not faked: `start()` throws
 * `not_implemented`. Driving a turn means the TUI gateway JSON-RPC surface
 * (`prompt.submit`, `session.*`, server→client approval requests), which belongs with the
 * `sessions` module in the second half of Phase 0. Reporting a session the hub cannot
 * actually stream would be a false success, which TEAM-RULES §4 forbids.
 */
import { HERMES_ENTRY } from '../catalog/index.js';
import type { AgentCapability } from '../schema.js';
import { notImplemented } from '../../../lib/errors.js';
import { parseVersion, probeHttp, runCommand, whichSync, type HostEnvironment } from './host.js';
import type {
  AgentAdapter,
  AgentProbe,
  AgentSession,
  AgentTarget,
  DiscoveredAgent,
  SettingsSection,
} from './types.js';

export const HERMES_ADAPTER_VERSION = '1.0.0';

export interface HermesAdapterOptions {
  host: HostEnvironment;
  /** Overridden in tests; defaults to the gateway Hermes documents on 127.0.0.1:8642. */
  defaultEndpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createHermesAdapter(options: HermesAdapterOptions): AgentAdapter {
  const host = options.host;
  const defaultEndpoint = options.defaultEndpoint ?? HERMES_ENTRY.defaultEndpoint!;
  const timeoutMs = options.timeoutMs ?? 2_000;

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

    async start(_target: AgentTarget): Promise<AgentSession> {
      throw notImplemented({
        adapter: 'hermes',
        reason:
          'driving a Hermes turn needs the TUI gateway JSON-RPC surface, which arrives with the sessions module',
      });
    },
  };
}
