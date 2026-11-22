/**
 * Every name the plugin uses that another side has to agree on: the product's own (from
 * `@corehub/contracts`, never a typed literal), the harness rows it touches, and the hub paths
 * the hub side of ADR 0033 adds. One file, so a rename or a moved path is one edit.
 */
import { PRODUCT, derived } from '@corehub/contracts';

/** The plugin's Cordis name and the id of its row in `cordis.patch.yml`. */
export const PLUGIN_NAME = PRODUCT.id;

/** What the person reads: "Core Hub". */
export const PRODUCT_NAME = PRODUCT.name;
export const PRODUCT_NAME_AR = PRODUCT.nameAr;

/** The slash command: `/corehub link …`, `/corehub status`, `/corehub unlink`. */
export const COMMAND_NAME = PRODUCT.id;

/** The command that hands a message to the hub's agent. */
export const AGENT_COMMAND_NAME = 'hermes';

/** The model-facing tool that does the same for the harness's own agent. */
export const ASK_AGENT_TOOL = `${PRODUCT.id}_ask_agent`;

/** The tool that collects the answer of a question the ask tool left running. */
export const AGENT_RESULT_TOOL = `${PRODUCT.id}_agent_result`;

/** The kind of the harness background job that carries a slow answer (`corehub-…` ids). */
export const ASK_JOB_KIND = PRODUCT.id;

/**
 * The provider row the plugin writes under `llm-pi-ai.providers` (the harness's model list).
 * Its `Authorization` header in the patch is a placeholder: the real bearer is put on each
 * request from memory (see `provider.ts`), so the token is never in the harness's config
 * patch or its credential store (ADR 0033 §2).
 */
export const PROVIDER_ID = PRODUCT.id;
export const TOKEN_PLACEHOLDER = `Bearer ${PRODUCT.id}-dsh-plugin`;

/**
 * The variable a screen task's own harness process reads its key from (`apiKeyEnv` of its
 * profile): set only in that child's environment, never in this process's.
 */
export const TOKEN_ENV = `${derived.envPrefix}DSH_TOKEN`;

/** The harness rows the plugin reads or edits (dsh-base, 0.2.2-rc.5). */
export const HARNESS_ROWS = {
  llm: 'llm-pi-ai',
  defaultModel: 'agent-default-model',
} as const;

/** The hub's REST prefix (the contract's `servers[0].url`), for the addresses the harness calls. */
export const API_BASE = '/api/v1';

/**
 * The model gateway's external entrance (ADR 0033 §3), as the hub side declares it in the
 * contract. Relative to {@link API_BASE}. OpenAI Chat Completions first; Anthropic Messages is
 * offered beside it.
 */
export const GATEWAY = {
  openai: '/gateway/openai/v1',
  anthropic: '/gateway/anthropic/v1',
} as const;

/** The device capability for screen tasks (ADR 0033 §5); only advertised on macOS. */
export const SCREEN_CAPABILITY = 'screen_task';

/**
 * How an MCP server of the harness is described in the device's report (`DeviceProgram.source`).
 * A hub whose contract does not know it yet refuses the report; the link then reports the
 * folders without the programs (see `device-link.ts`).
 */
export const PROGRAM_SOURCE = 'dsh';

/**
 * The device platform of a computer linked through this plugin (`DevicePlatform`, DECISIONS
 * §157). A hub older than it refuses the value; the claim then says the OS instead.
 */
export const DEVICE_PLATFORM = 'dsh';

/** How this computer presents itself when it pairs (`DeviceRegistration.model`). */
export const HARNESS_NAME = 'DeepSeek Harness';

/** The harness profile the plugin composes for screen tasks (headless + Computer Use). */
export const SCREEN_PROFILE = `${PRODUCT.id}-screen`;
