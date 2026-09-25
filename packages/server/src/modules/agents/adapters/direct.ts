/**
 * The `builtin` adapter — the **direct** agent (ADOPTION-BACKLOG §2.15, owner's decision
 * of 2026-09-22).
 *
 * Every other adapter drives something: a child process speaking ACP, a gateway holding
 * the conversation. This one drives nothing. A turn is the hub writing one request to the
 * model provider and reading the answer back, which is why it is fast — one hop instead
 * of three — and why almost all of this file is about the two things that hop does not
 * get for free: the conversation, and the files.
 *
 * - **The conversation** lives here, in the session object, for exactly as long as the
 *   hub session's `AgentSession` does. Hermes keeps its transcript in its own home and
 *   an ACP child keeps its in memory; this keeps its in memory too, and says so. A
 *   restart starts a fresh context — the stored transcript in `sessions` is intact, but
 *   the model has not read it. Closing that gap is a transcript port from `sessions`,
 *   which is a change to `sessions/ports.ts` and belongs to its own branch.
 * - **The files** are read off disk and put in the request. There is no file tool to
 *   point at a path with, so a text-like attachment is inlined up to a stated size and
 *   an image is sent inline to a model that declares `vision`. Anything else is refused
 *   by name, with the reason — never dropped, never silently truncated.
 *
 * **No tools.** Skills and MCP over the direct path are backlog §2.16, and this adapter
 * claims neither `tools` nor `approvals` nor `mcp` in its capabilities, so nothing in the
 * hub offers them here.
 *
 * Credentials: none of them are in this file. The provider row, the key and the HTTP
 * client all stay in `models` (ADR 0010); what crosses the boundary is
 * `AgentModelsPort.directChat`, which takes a provider row id and gives back events.
 */
import { readFile as readFileFromDisk } from 'node:fs/promises';
import { notImplemented } from '../../../lib/errors.js';
import type { AgentCapability } from '../schema.js';
import type {
  DirectChatEvent,
  DirectChatImage,
  DirectChatMessage,
  DirectModelFacts,
} from '../ports.js';
import { EventQueue } from './event-queue.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentProbe,
  AgentSession,
  AgentTarget,
  DiscoveredAgent,
  PromptBlock,
  PromptInput,
  SettingsSection,
} from './types.js';

export const DIRECT_ADAPTER_VERSION = '1.0.0';

// --------------------------------------------------------------- attachment limits
//
// Stated here, in `docs/domain/models.md` §الاتصال المباشر and in the change record,
// because they are a product promise: over the limit the turn is refused with the number,
// never quietly cut down to size.

/** One text-like attachment, inlined into the prompt. */
export const MAX_TEXT_BYTES = 64 * 1024;
/** Every text-like attachment of one turn, together. */
export const MAX_TEXT_TOTAL_BYTES = 256 * 1024;
/** One image, before base64 (which adds a third). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Every image of one turn, together. */
export const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

/** Extensions that are text even when the browser guessed `application/octet-stream`. */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'log',
  'json',
  'yml',
  'yaml',
  'xml',
  'html',
  'css',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'sh',
  'bash',
  'sql',
  'toml',
  'ini',
  'env',
  'conf',
  'diff',
  'patch',
]);

function isTextLike(mime: string | undefined, name: string): boolean {
  const type = (mime ?? '').toLowerCase();
  if (type.startsWith('text/')) return true;
  if (/^application\/(json|xml|x-yaml|yaml|javascript|sql|toml)$/.test(type)) return true;
  if (/^application\/[\w.-]+\+(json|xml|yaml)$/.test(type)) return true;
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return TEXT_EXTENSIONS.has(extension);
}

function isImage(mime: string | undefined): boolean {
  return IMAGE_MIMES.has((mime ?? '').toLowerCase());
}

/** A refusal carrying the contract error code the run should end with. */
export class AttachmentRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentRefused';
  }
}

export interface BuiltPrompt {
  text: string;
  images: DirectChatImage[];
}

export interface PromptBuildOptions {
  /** Whether the model this turn will run on declares `vision`. */
  vision: boolean;
  /** For the refusal sentence, so it names the model the person actually chose. */
  modelLabel: string;
  readFile: (path: string) => Promise<Uint8Array>;
}

/**
 * The turn's blocks as one text prompt plus the images to send beside it.
 *
 * Throws `AttachmentRefused` rather than returning a partial prompt: a turn that quietly
 * ignored the file the question was about is worse than a turn that did not happen.
 */
export async function buildPrompt(
  blocks: readonly PromptBlock[],
  options: PromptBuildOptions,
): Promise<BuiltPrompt> {
  const parts: string[] = [];
  const images: DirectChatImage[] = [];
  let textBudget = MAX_TEXT_TOTAL_BYTES;
  let imageBudget = MAX_IMAGE_TOTAL_BYTES;

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) parts.push(block.text);
      continue;
    }
    if (block.type === 'location') {
      parts.push(`[location ${block.latitude},${block.longitude}]`);
      continue;
    }
    const name = block.name ?? block.attachmentId;
    if (!block.path) {
      throw new AttachmentRefused(
        'agent_error',
        `"${name}" could not be written to disk for this turn, so it cannot be sent`,
      );
    }
    if (isImage(block.mime)) {
      if (!options.vision) {
        throw new AttachmentRefused(
          'unsupported_media_type',
          `"${name}" is an image and ${options.modelLabel} does not accept images; ` +
            'choose a model that does, or send the file as text',
        );
      }
      const bytes = await options.readFile(block.path);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new AttachmentRefused(
          'payload_too_large',
          `"${name}" is ${bytes.byteLength} bytes; the direct agent sends images up to ` +
            `${MAX_IMAGE_BYTES} bytes`,
        );
      }
      imageBudget -= bytes.byteLength;
      if (imageBudget < 0) {
        throw new AttachmentRefused(
          'payload_too_large',
          `this turn's images add up to more than ${MAX_IMAGE_TOTAL_BYTES} bytes`,
        );
      }
      images.push({
        mime: (block.mime ?? 'image/png').toLowerCase(),
        dataBase64: Buffer.from(bytes).toString('base64'),
        name,
      });
      continue;
    }
    if (isTextLike(block.mime, name)) {
      const bytes = await options.readFile(block.path);
      if (bytes.byteLength > MAX_TEXT_BYTES) {
        throw new AttachmentRefused(
          'payload_too_large',
          `"${name}" is ${bytes.byteLength} bytes; the direct agent inlines text files up ` +
            `to ${MAX_TEXT_BYTES} bytes`,
        );
      }
      textBudget -= bytes.byteLength;
      if (textBudget < 0) {
        throw new AttachmentRefused(
          'payload_too_large',
          `this turn's text attachments add up to more than ${MAX_TEXT_TOTAL_BYTES} bytes`,
        );
      }
      parts.push(`--- ${name} ---\n${Buffer.from(bytes).toString('utf8')}\n--- end of ${name} ---`);
      continue;
    }
    throw new AttachmentRefused(
      'unsupported_media_type',
      `"${name}" is ${block.mime ?? 'of an unknown type'} and the direct agent can send only ` +
        'text-like files and images; there is no agent runtime here to open it with',
    );
  }
  return { text: parts.join('\n\n'), images };
}

// --------------------------------------------------------------------- the session

/** The slice of `AgentModelsPort` this adapter uses. Nothing here reads a key. */
export interface DirectModelsPort {
  modelFacts(workspace: string, providerId: string, model: string): DirectModelFacts | null;
  directChat(
    workspace: string,
    request: {
      providerId: string;
      model: string;
      messages: DirectChatMessage[];
      reasoningEffort?: string | null;
      signal?: AbortSignal;
      fallbacks?: readonly { providerId: string; model: string }[];
    },
  ): AsyncIterable<DirectChatEvent>;
}

export interface DirectAdapterOptions {
  /**
   * The `models` port, looked up per call: it is registered after `agents` mounts, and a
   * hub whose `models` module never registered one refuses turns instead of inventing an
   * endpoint.
   */
  models: () => DirectModelsPort | null;
  /** Test seam: how attachment bytes are read. */
  readFile?: (path: string) => Promise<Uint8Array>;
}

export class DirectSession implements AgentSession {
  readonly id: string;
  private readonly queue = new EventQueue();
  /** The conversation so far, in provider vocabulary. Process memory; see the header. */
  private readonly history: DirectChatMessage[] = [];
  private turn: AbortController | null = null;
  private interrupted = false;
  private closed = false;

  constructor(
    private readonly target: AgentTarget,
    private readonly options: Required<Pick<DirectAdapterOptions, 'models' | 'readFile'>>,
  ) {
    this.id = target.sessionRef ?? `direct-${target.slug}`;
    const system = systemPromptOf(target);
    if (system) this.history.push({ role: 'system', text: system });
  }

  stream(): AsyncIterable<AgentEvent> {
    return this.queue.iterator();
  }

  respond(): Promise<void> {
    // Nothing on this path asks for permission: there are no tools (backlog §2.16).
    return Promise.reject(
      notImplemented({
        adapter: 'builtin',
        reason: 'the direct agent runs no tools, so it never asks for an approval',
      }),
    );
  }

  interrupt(): Promise<void> {
    this.interrupted = true;
    this.turn?.abort();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.turn?.abort();
    this.queue.end();
    return Promise.resolve();
  }

  async send(prompt: PromptInput): Promise<{ stopReason: string }> {
    if (this.closed) return { stopReason: 'closed' };
    this.interrupted = false;
    const port = this.options.models();
    const workspace = this.target.workspace;
    const providerId = prompt.modelProviderId ?? this.target.modelProviderId ?? null;
    const model = prompt.model ?? this.target.model ?? null;

    // Three ways to have nothing to run, each named. "No model chosen" is the common one
    // on a fresh hub and must not read as a broken agent.
    if (!port || !workspace) {
      return this.fail('provider_not_configured', 'this hub has no provider store wired');
    }
    if (!model || !providerId) {
      return this.fail(
        'provider_not_configured',
        'no model is chosen for this profile; pick one in Models and try again',
      );
    }
    const facts = port.modelFacts(workspace, providerId, model);

    let built: BuiltPrompt;
    try {
      built = await buildPrompt(prompt.blocks ?? [{ type: 'text', text: prompt.text }], {
        vision: facts?.vision ?? false,
        modelLabel: facts?.modelLabel ?? model,
        readFile: this.options.readFile,
      });
    } catch (error) {
      if (error instanceof AttachmentRefused) return this.fail(error.code, error.message);
      throw error;
    }

    const message: DirectChatMessage = {
      role: 'user',
      text: built.text,
      ...(built.images.length > 0 ? { images: built.images } : {}),
    };
    this.history.push(message);

    const controller = new AbortController();
    this.turn = controller;
    let answer = '';
    try {
      for await (const event of port.directChat(workspace, {
        providerId,
        model,
        messages: [...this.history],
        ...(prompt.reasoningEffort !== undefined
          ? { reasoningEffort: prompt.reasoningEffort }
          : {}),
        signal: controller.signal,
        // The profile's chain (contract decision §49). The models module walks it: it knows
        // which provider errors another model could get past, and this file sees no provider.
        ...(prompt.fallbacks && prompt.fallbacks.length > 0
          ? {
              fallbacks: prompt.fallbacks.map((member) => ({
                providerId: member.providerId,
                model: member.model,
              })),
            }
          : {}),
      })) {
        switch (event.type) {
          case 'fallback':
            this.queue.push({
              type: 'model.fallback',
              failed: event.failed.map((attempt) => ({ ...attempt })),
              answered: { ...event.answered },
            });
            break;
          case 'delta':
            answer += event.text;
            this.queue.push({ type: 'message.delta', text: event.text });
            break;
          case 'reasoning':
            this.queue.push({ type: 'reasoning.delta', text: event.text });
            break;
          case 'usage':
            this.queue.push({
              type: 'usage',
              modelLabel: event.modelLabel,
              providerId: event.providerId,
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
              ...(event.cacheReadTokens !== undefined
                ? { cacheReadTokens: event.cacheReadTokens }
                : {}),
              ...(event.cacheWriteTokens !== undefined
                ? { cacheWriteTokens: event.cacheWriteTokens }
                : {}),
              ...(event.reasoningTokens !== undefined
                ? { reasoningTokens: event.reasoningTokens }
                : {}),
              ...(event.costMicroUsd !== undefined ? { costMicroUsd: event.costMicroUsd } : {}),
              ...(event.costSource !== undefined ? { costSource: event.costSource } : {}),
            });
            break;
          case 'completed':
            if (answer) this.history.push({ role: 'assistant', text: answer });
            this.queue.push({ type: 'run.completed', stopReason: 'end_turn' });
            return { stopReason: 'end_turn' };
          case 'failed': {
            // An abort the hub asked for is not a failure: it is a turn that stopped
            // when it was told to, and the run state machine has a state for that.
            if (event.code === 'cancelled' || this.interrupted) {
              if (answer) this.history.push({ role: 'assistant', text: answer });
              this.queue.push({
                type: 'run.completed',
                stopReason: 'cancelled',
                interrupted: true,
              });
              return { stopReason: 'cancelled' };
            }
            // A turn nobody will answer must not stay in the history; the next turn
            // would then send a question the model never saw an answer to.
            this.history.pop();
            return this.fail(event.code, event.message);
          }
        }
      }
      // The port's stream ended without saying how. Treat what arrived as the answer.
      if (answer) this.history.push({ role: 'assistant', text: answer });
      this.queue.push({ type: 'run.completed', stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    } catch (error) {
      this.history.pop();
      return this.fail(
        'agent_error',
        error instanceof Error ? error.message : 'the provider stream failed',
      );
    } finally {
      this.turn = null;
    }
  }

  /**
   * One failure shape: the contract's own code, and the provider's own sentence. The
   * runner passes both through untouched — nothing here is re-worded on the way out.
   */
  private fail(code: string, message: string): { stopReason: string } {
    this.queue.push({ type: 'run.failed', error: message, code });
    return { stopReason: 'error' };
  }
}

function systemPromptOf(target: AgentTarget): string | null {
  const value = target.settings?.system_prompt;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createDirectAdapter(options: DirectAdapterOptions): AgentAdapter {
  const readFile =
    options.readFile ?? (async (path: string) => new Uint8Array(await readFileFromDisk(path)));
  return {
    kind: 'builtin',
    name: 'Direct model',
    version: DIRECT_ADAPTER_VERSION,
    selectable: true,

    capabilities(): AgentCapability[] {
      // `vision` is the floor the adapter can carry; whether a given *model* accepts an
      // image is the model row's own `vision` capability, checked per turn. No `tools`,
      // no `approvals`, no `mcp`, no `skills` — backlog §2.16, not half-built here.
      return ['streaming', 'vision', 'resume'];
    },

    discover(): Promise<DiscoveredAgent[]> {
      // Nothing to find: this agent is the hub. It is seeded from the catalog and is
      // never a binary somebody installed.
      return Promise.resolve([]);
    },

    probe(_target: AgentTarget): Promise<AgentProbe> {
      return Promise.resolve({
        // Always installed: it ships as part of the hub and there is nothing to install
        // or remove (ADR 0006's `bundled`). Whether a *provider* is configured is a
        // different question, answered out loud when a turn runs.
        installed: true,
        source: 'builtin',
        executablePath: null,
        version: DIRECT_ADAPTER_VERSION,
        runtime: { state: 'not_applicable', url: null, error: null },
        capabilities: ['streaming', 'vision', 'resume'],
        // A bundled agent has no install to go wrong, so it has no install error to
        // report (owner, 2026-09-22: «برق ما يكون له خطأ... لانه هو شي مضمن»). Whether a
        // provider is configured is a different question, and a turn answers it out loud
        // at the moment it matters — a probe that ran before the models module mounted
        // must not leave a red line on the card for ever.
        error: null,
      });
    },

    settings(_target: AgentTarget, stored: Record<string, unknown>): SettingsSection[] {
      return [
        {
          key: 'direct',
          title: { ar: 'الاتصال المباشر', en: 'Direct connection' },
          restart_required: false,
          fields: [
            {
              key: 'system_prompt',
              label: { ar: 'التوجيه الأول', en: 'System prompt' },
              kind: 'text',
              value: stored.system_prompt ?? null,
              options: [],
              min: null,
              max: null,
              hint: 'Sent ahead of every turn in this profile. Empty means none.',
            },
          ],
        },
      ];
    },

    start(target: AgentTarget): Promise<AgentSession> {
      return Promise.resolve(new DirectSession(target, { models: options.models, readFile }));
    },
  };
}
