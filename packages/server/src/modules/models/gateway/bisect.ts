/**
 * A one-off diagnosis for Claude Code on a Google model (DECISIONS §148, preview.45): Google
 * refuses Claude Code's request on CLIProxyAPI's Chat route while the same model answers a plain
 * request there, and other agents' large requests with tools. The gateway then asks the model a
 * few variants of the refused request, once per session, each with one thing taken out, and logs
 * which ones Google answers. Only a variant that changes nothing the model needs is kept for the
 * session (`keep`); the others are said in the log and nothing more.
 *
 * Every variant is of the Chat request the gateway built from Claude Code's (`anthropicToChat`).
 * A Claude model never reaches here.
 */

type Json = Record<string, unknown>;

export interface BisectStep {
  /** Its number in the log ("bisect step 3"). */
  n: number;
  name: string;
  /** Safe to keep as the session's way of asking when it is the first that answers. */
  keep: boolean;
  /** Sent without the agent's own request headers (`user-agent`, `anthropic-beta`, …). */
  bareHeaders?: boolean;
  apply(body: Json): Json;
}

/** Claude Code's billing line, the first system text it sends. */
const BILLING_LINE = /^x-anthropic-billing-header:[^\n]*(?:\n|$)/gm;
/** Claude Code's sentence saying who it is ("You are Claude Code, Anthropic's official CLI…"). */
const IDENTITY = /You are (?:Claude Code\b|a Claude agent\b)[^.\n]*\./;
const NEUTRAL_IDENTITY = 'You are a coding agent that helps people with software tasks.';

function mapSystem(body: Json, edit: (text: string) => string): Json {
  if (!Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map((message) => {
      const m = (message ?? {}) as Json;
      if (m.role !== 'system' || typeof m.content !== 'string') return message;
      return { ...m, content: edit(m.content) };
    }),
  };
}

/** JSON-schema keywords Google's function declarations do not take. */
const UNSUPPORTED = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  '$comment',
  'definitions',
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'patternProperties',
  'dependentRequired',
  'dependentSchemas',
  'format',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'const',
  'examples',
]);

/** A tool's parameters with only what Gemini's schema subset takes; `allOf` merged in. */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema as Json)) {
    if (UNSUPPORTED.has(key) || key === 'allOf') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      // Property names are the tool's own words, not keywords: each value is a schema.
      out[key] = Object.fromEntries(
        Object.entries(value as Json).map(([name, sub]) => [name, geminiSchema(sub)]),
      );
      continue;
    }
    out[key] = geminiSchema(value);
  }
  const all = (schema as Json).allOf;
  if (Array.isArray(all)) {
    for (const part of all) {
      const clean = geminiSchema(part);
      if (!clean || typeof clean !== 'object') continue;
      for (const [key, value] of Object.entries(clean as Json)) {
        if (key === 'properties' && out.properties && typeof out.properties === 'object') {
          out.properties = { ...(value as Json), ...(out.properties as Json) };
        } else if (key === 'required' && Array.isArray(out.required) && Array.isArray(value)) {
          out.required = [...new Set([...(out.required as unknown[]), ...value])];
        } else if (!(key in out)) out[key] = value;
      }
    }
  }
  return out;
}

function withCleanSchemas(body: Json): Json {
  if (!Array.isArray(body.tools)) return body;
  return {
    ...body,
    tools: body.tools.map((tool) => {
      const t = (tool ?? {}) as Json;
      const fn = (t.function ?? null) as Json | null;
      if (!fn || fn.parameters === undefined) return tool;
      return { ...t, function: { ...fn, parameters: geminiSchema(fn.parameters) } };
    }),
  };
}

export const BISECT: readonly BisectStep[] = [
  {
    n: 1,
    name: 'billing line left out',
    keep: true,
    apply: (body) => mapSystem(body, (text) => text.replace(BILLING_LINE, '')),
  },
  {
    n: 2,
    name: 'identity sentence made neutral',
    keep: false,
    apply: (body) => mapSystem(body, (text) => text.replace(IDENTITY, NEUTRAL_IDENTITY)),
  },
  {
    n: 3,
    name: 'no tools',
    keep: false,
    apply: (body) => {
      const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, ...rest } = body;
      return rest;
    },
  },
  {
    n: 4,
    name: 'tool schemas cleaned for Gemini',
    keep: true,
    apply: withCleanSchemas,
  },
  {
    n: 5,
    name: 'system prompt alone',
    keep: false,
    apply: (body) => {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = messages.filter((m) => ((m ?? {}) as Json).role === 'system');
      const {
        tools: _tools,
        tool_choice: _choice,
        parallel_tool_calls: _parallel,
        messages: _messages,
        ...rest
      } = body;
      return { ...rest, messages: [...system, { role: 'user', content: 'ok' }] };
    },
  },
  {
    n: 6,
    name: "the agent's own headers left out",
    keep: true,
    bareHeaders: true,
    apply: (body) => body,
  },
];

/** The kept step's change, applied to every later request of the session. */
export function bisectStep(n: number | undefined): BisectStep | null {
  return BISECT.find((step) => step.n === n) ?? null;
}
