/**
 * The Hermes helper's session (ADR 0031, owner's decision of 2026-10-28).
 *
 * A small agent of the hub's own that looks into Hermes when it is in trouble. The owner's
 * case: a friend whose Hermes broke and who could not fix it alone. So it never runs through
 * Hermes — it talks to the hub's model gateway (ADR 0029) in OpenAI Chat Completions with
 * tools, and the tools are the hub's own code, run by the hub's process on the hub's machine.
 *
 * **Three levels**, asked at the start of every conversation as a question with three
 * choices, green to red (the owner: «بالوان اخضر واخر شي احمر»):
 * - 🟢 `check` — reads and checks, and tells the person how to fix it. Changes nothing.
 * - 🟡 `fix` — also Hermes's own repairs: `hermes doctor --fix`, a restart, any `hermes …`
 *   command, an update of a personal install. Each one waits for the person's approval.
 * - 🔴 `full` — also any program on this machine and writing any file. Each one waits for
 *   the person's approval, and shows exactly what will run. The owner only — the same line
 *   as the web terminal (DECISIONS §70).
 * A skipped or unanswered question is green. The level is this conversation's alone, and the
 * helper can ask to raise it (`request_more_access`) — the same question again.
 *
 * Admins and the owner only: a member is refused before anything runs.
 *
 * **No gateway** (a hub without CLIProxyAPI, or one whose gateway would not start): the
 * helper still answers, without tools, from a snapshot of Hermes the hub takes itself —
 * status, `hermes doctor`, the end of the error log — sent with the person's question
 * through the providers' own path (`directChat`, as the `direct` agent).
 *
 * Every tool output is redacted before the model reads it (`redactSecrets`): keys, tokens
 * and passwords never leave the machine because a log or a config file carried them.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirectChatMessage } from '../ports.js';
import type { DirectModelsPort } from './direct.js';
import { EventQueue } from './event-queue.js';
import { runCommand, type CommandResult } from './host.js';
import type { AgentEvent, AgentSession, AgentTarget, PromptInput } from './types.js';

export type HelperLevel = 'check' | 'fix' | 'full';
const LEVELS: readonly HelperLevel[] = ['check', 'fix', 'full'];

export interface HelperUser {
  role: 'owner' | 'admin' | 'member';
  locale: 'ar' | 'en';
}

/** What the helper may ask of the hub about Hermes. Bound to the runtime in `../index.ts`. */
export interface HermesHelperHost {
  /** The person starting the conversation, or null when the hub cannot tell. */
  user(userId: string | null): HelperUser | null;
  /** The runtime's status, its gateways and processes, as plain data. */
  status(): Record<string, unknown>;
  /** Hermes's home: where its config, `.env`, logs and profiles are. */
  home(): string | null;
  /** The `hermes` program the hub runs, or null when there is none. */
  executable(): string | null;
  /** The environment a `hermes …` command gets: the hub's own (`HermesRuntime.cliEnv`). */
  cliEnv(): NodeJS.ProcessEnv;
  /** Whether this hub supervises Hermes and can restart it. */
  canRestart(): boolean;
  restart(): Promise<void>;
  /** Whether the Hermes here is the person's own install, which `hermes update` may update. */
  canUpdate(): boolean;
  update(onLine: (line: string) => void): Promise<void>;
  /** The hub: its version, the platform, how it runs. */
  hubFacts(): Record<string, unknown>;
}

export interface HermesHelperOptions {
  host: () => HermesHelperHost | null;
  /** The providers' own path, for a hub without a gateway (no tools then). */
  models: () => DirectModelsPort | null;
  /** Test seams. */
  fetch?: typeof fetch;
  run?: typeof runCommand;
  /** How long the level question waits before the conversation goes on green. */
  questionWaitMs?: number;
}

/** Tool calls one turn may make before the helper stops and says so. */
const MAX_TOOL_ROUNDS = 24;
/** What a tool hands back to the model, at most (characters). */
const MAX_TOOL_OUTPUT = 24_000;
/** What a tool shows in the chat, at most. */
const MAX_SHOWN_OUTPUT = 8_000;
/** A file read whole, at most; past it only its end is read. */
const MAX_FILE_BYTES = 256 * 1024;
const DOCTOR_TIMEOUT_MS = 3 * 60_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const QUESTION_WAIT_MS = 5 * 60_000 + 5_000;

// ---------------------------------------------------------------------- redaction

const SECRET_NAME = /(key|token|secret|password|passwd|pwd|auth|credential|cookie|session)/i;

/**
 * Keys, tokens and passwords out of text the model will read: a `NAME=value` or `name: value`
 * whose name says it is a secret, an `Authorization`/`Bearer` value, and anything that looks
 * like a provider key. What stays is the shape — the name and `[hidden]` — so the model can
 * still tell a key is set.
 */
export function redactSecrets(text: string): string {
  return (
    text
      // NAME=value and name: value, the name saying secret (dotenv, YAML, logs).
      .replace(
        /^(\s*(?:export\s+)?["']?)([A-Za-z0-9_.-]*?)(["']?\s*[=:]\s*)(["']?)([^\s"'#][^\n"']*)(["']?)/gm,
        (whole, lead: string, name: string, sep: string, q1: string, value: string, q2: string) =>
          SECRET_NAME.test(name) && value.trim() && !/^\[(hidden|set|empty)\]$/.test(value.trim())
            ? `${lead}${name}${sep}${q1}[hidden]${q2}`
            : whole,
      )
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [hidden]')
      // Well-known key shapes, wherever they are.
      .replace(
        /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|\d{8,10}:[A-Za-z0-9_-]{30,})\b/g,
        '[hidden]',
      )
      // Long opaque strings in a JSON value whose key says secret.
      .replace(
        /("[A-Za-z0-9_.-]*(?:key|token|secret|password|auth)[A-Za-z0-9_.-]*"\s*:\s*")([^"]{6,})(")/gi,
        '$1[hidden]$3',
      )
  );
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  return `${text.slice(0, head)}\n… [${text.length - max} characters left out] …\n${text.slice(text.length - (max - head))}`;
}

// --------------------------------------------------------------------- the wording

interface Wording {
  question: string;
  raise: string;
  check: string;
  fix: string;
  full: string;
  members: string;
  run: string;
  deny: string;
}

const WORDING: Record<HelperUser['locale'], Wording> = {
  ar: {
    question: 'قبل ما أبدأ: وش الصلاحية اللي تعطيني في هذي المحادثة؟',
    raise: 'أحتاج صلاحية أعلى عشان أكمل. تعطيني؟',
    check: '🟢 فحص بس — أفحص وأقول لك الحل، وما أغيّر شي (Recommended)',
    fix: '🟡 يصلّح — أشغّل أدوات إصلاح Hermes، وكل خطوة بموافقتك',
    full: '🔴 صلاحية كاملة — أي أمر وأي ملف على الجهاز، وكل أمر بموافقتك. خطير: ممكن يمسح أو يخرّب شي',
    members: 'مساعد Hermes للمشرفين بس. اطلب من مشرف الهب يفتحه.',
    run: 'نفّذ',
    deny: 'لا',
  },
  en: {
    question: 'Before I start: what may I do in this conversation?',
    raise: 'I need more access to go on. Will you give it?',
    check: '🟢 Check only — I look and tell you the fix; I change nothing (Recommended)',
    fix: '🟡 Fix — I run Hermes’s repair tools, each step with your approval',
    full: '🔴 Full access — any command and any file on this machine, each with your approval. Dangerous: it could delete or break something',
    members: 'The Hermes helper is for admins only. Ask an admin of this hub to open it.',
    run: 'Run',
    deny: 'No',
  },
};

/** The level a person's answer names; null = none (skipped, or words that name none). */
export function levelOfAnswer(answer: string | null, wording: Wording): HelperLevel | null {
  if (!answer) return null;
  const text = answer.trim();
  if (text === wording.full || text.startsWith('🔴')) return 'full';
  if (text === wording.fix || text.startsWith('🟡')) return 'fix';
  if (text === wording.check || text.startsWith('🟢')) return 'check';
  const lower = text.toLowerCase();
  if (/(full|كامل|احمر|أحمر|red)/.test(lower)) return 'full';
  if (/(fix|صلّح|صلح|اصلاح|إصلاح|اصفر|أصفر|yellow)/.test(lower)) return 'fix';
  if (/(check|فحص|اخضر|أخضر|green)/.test(lower)) return 'check';
  return null;
}

// -------------------------------------------------------------------------- tools

interface ToolSpec {
  name: string;
  level: HelperLevel;
  /** Changes something: waits for the person's approval. */
  gated: boolean;
  kind: 'read' | 'execute' | 'edit' | 'other';
  description: string;
  parameters: Record<string, unknown>;
}

const WHY = {
  type: 'string',
  description: 'One short sentence, in the person’s language, saying why this step is needed.',
};

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'hermes_status',
    level: 'check',
    gated: false,
    kind: 'read',
    description:
      'How Hermes runs right now as the hub sees it: whether the hub supervises it, its state, endpoint, process id, restarts, last error, its messaging gateways, and the hub’s own version and platform.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'hermes_doctor',
    level: 'check',
    gated: false,
    kind: 'execute',
    description:
      'Runs `hermes doctor` (checks only, changes nothing) and returns its report. The best first step for almost any problem.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_hermes_files',
    level: 'check',
    gated: false,
    kind: 'read',
    description:
      'Lists a folder inside Hermes’s home (config.yaml, .env, logs/, profiles/<name>/ …), with sizes and modification times. `path` is relative to the home; empty = the home itself.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_hermes_file',
    level: 'check',
    gated: false,
    kind: 'read',
    description:
      'Reads a text file inside Hermes’s home, secrets hidden. For a log, `tail_lines` reads only its end (default 200, at most 2000). A `.env` file shows its variable names only. `path` is relative to the home, e.g. `logs/errors.log`, `config.yaml`, `profiles/work/config.yaml`.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, tail_lines: { type: 'integer' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_more_access',
    level: 'check',
    gated: false,
    kind: 'other',
    description:
      'Asks the person for a higher level than this conversation has, when a fix needs it. The person chooses; the answer comes back. Explain first, in your reply, what you want to do and why.',
    parameters: { type: 'object', properties: { why: WHY }, additionalProperties: false },
  },
  {
    name: 'hermes_doctor_fix',
    level: 'fix',
    gated: true,
    kind: 'execute',
    description: 'Runs `hermes doctor --fix`: Hermes repairs what its own checks found.',
    parameters: {
      type: 'object',
      properties: { why: WHY },
      required: ['why'],
      additionalProperties: false,
    },
  },
  {
    name: 'restart_hermes',
    level: 'fix',
    gated: true,
    kind: 'execute',
    description:
      'Restarts Hermes and its messaging gateways, when this hub supervises it (see hermes_status `mode: managed`).',
    parameters: {
      type: 'object',
      properties: { why: WHY },
      required: ['why'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_hermes',
    level: 'fix',
    gated: true,
    kind: 'execute',
    description:
      'Runs one `hermes` command with these arguments (no shell), e.g. ["config", "set", "model.default", "…"], ["gateway", "status"], ["profile", "list"]. Returns its output and exit code.',
    parameters: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' } }, why: WHY },
      required: ['args', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_hermes',
    level: 'fix',
    gated: true,
    kind: 'execute',
    description:
      'Updates the person’s own Hermes install with `hermes update --yes`. Only where hermes_status says `can_update: true`; in a server image Hermes is updated by updating the image.',
    parameters: {
      type: 'object',
      properties: { why: WHY },
      required: ['why'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    level: 'full',
    gated: true,
    kind: 'execute',
    description:
      'Runs any program on this machine as the hub’s user, with these arguments (no shell unless you name one). `cwd` defaults to Hermes’s home. Returns output and exit code.',
    parameters: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        why: WHY,
      },
      required: ['argv', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    level: 'full',
    gated: true,
    kind: 'edit',
    description:
      'Writes a text file (absolute path, or relative to Hermes’s home). An existing file is copied first to `<name>.corehub-backup-<time>` next to it.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, why: WHY },
      required: ['path', 'content', 'why'],
      additionalProperties: false,
    },
  },
];

function toolsFor(level: HelperLevel, ceiling: HelperLevel, host: HermesHelperHost): ToolSpec[] {
  const rank = LEVELS.indexOf(level);
  return TOOLS.filter((tool) => {
    if (LEVELS.indexOf(tool.level) > rank) return false;
    if (tool.name === 'request_more_access') return rank < LEVELS.indexOf(ceiling);
    if (tool.name === 'restart_hermes') return host.canRestart();
    if (tool.name === 'update_hermes') return host.canUpdate();
    return true;
  });
}

function systemPrompt(level: HelperLevel, ceiling: HelperLevel, user: HelperUser, tools: boolean) {
  const language = user.locale === 'ar' ? 'Arabic (Saudi, plain everyday words)' : 'English';
  const levels: Record<HelperLevel, string> = {
    check:
      'CHECK ONLY (green): you may look but change nothing. Give the person exact, numbered steps to fix it themselves.',
    fix: 'FIX (yellow): you may also run Hermes’s own repairs; every one waits for the person’s approval.',
    full: 'FULL ACCESS (red): you may also run any program and write any file; every one waits for the person’s approval. Be careful: back up before changing, never delete what you cannot restore, and prefer the smallest change.',
  };
  return [
    'You are the Hermes helper inside Core Hub. Hermes Agent is the AI agent runtime the hub runs; you help when it misbehaves — it does not start, does not answer, a channel (Telegram, WhatsApp …) is silent, a model or key fails, an update broke something.',
    `Always answer in ${language}, short and friendly, for someone who is not technical. Name the cause in one sentence, then what to do.`,
    tools
      ? `This conversation’s level: ${levels[level]}`
      : 'Your tools are not available right now (the hub’s model gateway is not running). A snapshot of Hermes taken by the hub is in the person’s message; work from it and give manual steps.',
    tools
      ? 'Start by looking (hermes_status, hermes_doctor, the logs in logs/) before you conclude. Read what the tools return; do not guess.'
      : '',
    tools && LEVELS.indexOf(level) < LEVELS.indexOf(ceiling)
      ? 'If the fix needs a level this conversation does not have, explain it and call request_more_access.'
      : '',
    'Secrets in files and logs are shown as [hidden]; never ask the person to paste a key or password into this chat.',
    'Hermes facts: its home holds config.yaml, .env (keys), logs/ (agent.log, errors.log, gateway.log), profiles/<name>/ (each with its own config.yaml and .env), and sessions. In Core Hub’s server image Hermes itself is read-only and is updated by updating the image; on a computer it may be the person’s own install.',
    'If the problem is outside Hermes (the hub itself, the network, the provider’s account), say so plainly.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------- OpenAI chat wire

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface StreamResult {
  text: string;
  calls: ChatToolCall[];
}

/** Reads an OpenAI Chat Completions stream: text and reasoning as they come, tool calls whole. */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  on: { text(delta: string): void; reasoning(delta: string): void },
): Promise<StreamResult> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let text = '';
  const calls: { id: string; name: string; arguments: string }[] = [];
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: {
      choices?: {
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
      error?: { message?: string };
    };
    try {
      chunk = JSON.parse(data) as typeof chunk;
    } catch {
      return;
    }
    if (chunk.error) throw new Error(chunk.error.message ?? 'the model stream failed');
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      text += delta.content;
      on.text(delta.content);
    }
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (thought) on.reasoning(thought);
    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? calls.length;
      const call = (calls[index] ??= { id: '', name: '', arguments: '' });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer.trim()) handle(buffer.trim());
  return {
    text,
    calls: calls
      .filter((call) => call && call.name)
      .map((call) => ({
        id: call.id || `call_${randomUUID()}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments || '{}' },
      })),
  };
}

// ------------------------------------------------------------------- the session

interface Pending<T> {
  resolve(value: T): void;
}

export class HermesHelperSession implements AgentSession {
  readonly id: string;
  private readonly queue = new EventQueue();
  private readonly history: ChatMessage[] = [];
  /** The no-gateway path's history, in the providers' vocabulary. */
  private readonly plain: DirectChatMessage[] = [];
  private level: HelperLevel | null = null;
  private turn: AbortController | null = null;
  private interrupted = false;
  private closed = false;
  private readonly approvals = new Map<string, Pending<string | null>>();
  private readonly questions = new Map<string, Pending<string | null>>();
  private readonly fetchImpl: typeof fetch;
  private readonly run: typeof runCommand;

  constructor(
    private readonly target: AgentTarget,
    private readonly options: HermesHelperOptions,
  ) {
    this.id = target.sessionRef ?? `hermes-helper-${randomUUID()}`;
    this.fetchImpl = options.fetch ?? fetch;
    this.run = options.run ?? runCommand;
  }

  stream(): AsyncIterable<AgentEvent> {
    return this.queue.iterator();
  }

  respond(approvalId: string, optionId: string): Promise<void> {
    const pending = this.approvals.get(approvalId);
    if (!pending) return Promise.resolve();
    this.approvals.delete(approvalId);
    pending.resolve(optionId);
    return Promise.resolve();
  }

  answer(questionId: string, text: string | null): Promise<void> {
    const pending = this.questions.get(questionId);
    if (!pending) return Promise.resolve();
    this.questions.delete(questionId);
    pending.resolve(text);
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    this.interrupted = true;
    this.turn?.abort();
    this.settleWaits();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.turn?.abort();
    this.settleWaits();
    this.queue.end();
    return Promise.resolve();
  }

  private settleWaits(): void {
    for (const pending of this.approvals.values()) pending.resolve(null);
    for (const pending of this.questions.values()) pending.resolve(null);
    this.approvals.clear();
    this.questions.clear();
  }

  private get gateway(): { url: string; token: string; model: string } | null {
    const env = this.target.env ?? {};
    const url = env.COREHUB_GATEWAY_URL;
    const token = env.COREHUB_GATEWAY_TOKEN;
    if (!url || !token) return null;
    return {
      url: url.replace(/\/+$/, ''),
      token,
      model: env.COREHUB_GATEWAY_MODEL ?? 'corehub-main',
    };
  }

  async send(prompt: PromptInput): Promise<{ stopReason: string }> {
    if (this.closed) return { stopReason: 'closed' };
    this.interrupted = false;
    const host = this.options.host();
    if (!host) return this.fail('agent_unavailable', 'this hub has no Hermes runtime to look at');
    const user = host.user(this.target.userId ?? null);
    if (!user || user.role === 'member') {
      return this.fail('forbidden', WORDING[user?.locale ?? 'en'].members);
    }
    const ceiling: HelperLevel = user.role === 'owner' ? 'full' : 'fix';
    const gateway = this.gateway;
    if (!gateway) return this.sendPlain(prompt, host, user);

    if (!this.level) {
      this.level = (await this.askLevel(user, ceiling, 'check')) ?? 'check';
      if (this.interrupted || this.closed) return this.stopped();
    }

    const text = prompt.text;
    this.history.push({ role: 'user', content: text });
    const controller = new AbortController();
    this.turn = controller;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const specs = toolsFor(this.level, ceiling, host);
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt(this.level, ceiling, user, true) },
          ...this.history,
        ];
        const response = await this.fetchImpl(`${gateway.url}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${gateway.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: gateway.model,
            stream: true,
            messages,
            tools: specs.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const said = await response.text().catch(() => '');
          this.history.pop();
          return this.fail(
            'agent_error',
            `the model gateway answered ${response.status}: ${clip(said.trim(), 600)}`,
          );
        }
        const result = await readChatStream(response.body, {
          text: (delta) => this.queue.push({ type: 'message.delta', text: delta }),
          reasoning: (delta) => this.queue.push({ type: 'reasoning.delta', text: delta }),
        });
        if (result.calls.length === 0) {
          this.history.push({ role: 'assistant', content: result.text });
          this.queue.push({ type: 'run.completed', stopReason: 'end_turn' });
          return { stopReason: 'end_turn' };
        }
        this.history.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: result.calls,
        });
        if (result.text) this.queue.push({ type: 'message.delta', text: '\n\n' });
        for (const call of result.calls) {
          const output = await this.callTool(call, host, user, ceiling);
          this.history.push({ role: 'tool', tool_call_id: call.id, content: output });
          if (this.interrupted || this.closed) return this.stopped();
        }
      }
      const tired =
        user.locale === 'ar'
          ? 'وقفت هنا لأني سويت خطوات كثيرة في هالدور. اكتب «كمل» وأكمل من حيث وقفت.'
          : 'I stopped here after many steps in one go. Say “continue” and I will pick up where I left off.';
      this.queue.push({ type: 'message.delta', text: tired });
      this.history.push({ role: 'assistant', content: tired });
      this.queue.push({ type: 'run.completed', stopReason: 'max_turn_requests' });
      return { stopReason: 'max_turn_requests' };
    } catch (error) {
      if (this.interrupted || controller.signal.aborted) return this.stopped();
      return this.fail(
        'agent_error',
        error instanceof Error ? error.message : 'the model gateway stream failed',
      );
    } finally {
      this.turn = null;
    }
  }

  private stopped(): { stopReason: string } {
    this.queue.push({ type: 'run.completed', stopReason: 'cancelled', interrupted: true });
    return { stopReason: 'cancelled' };
  }

  private fail(code: string, message: string): { stopReason: string } {
    this.queue.push({ type: 'run.failed', error: message, code });
    return { stopReason: 'error' };
  }

  /** The level question, from `floor` up to what this person may give. */
  private async askLevel(
    user: HelperUser,
    ceiling: HelperLevel,
    floor: HelperLevel,
    raising = false,
  ): Promise<HelperLevel | null> {
    const wording = WORDING[user.locale];
    const offered = LEVELS.filter(
      (level) =>
        LEVELS.indexOf(level) >= LEVELS.indexOf(floor) &&
        LEVELS.indexOf(level) <= LEVELS.indexOf(ceiling),
    );
    const id = `level-${randomUUID()}`;
    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.questions.delete(id);
        resolve(null);
      }, this.options.questionWaitMs ?? QUESTION_WAIT_MS);
      timer.unref?.();
      this.questions.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      this.queue.push({
        type: 'question.asked',
        id,
        question: raising ? wording.raise : wording.question,
        choices: offered.map((level) =>
          raising ? wording[level].replace(/ \(Recommended\)$/, '') : wording[level],
        ),
      });
    });
    const chosen = levelOfAnswer(answer, wording);
    if (!chosen) return null;
    // Never above what this person may give, whatever they typed.
    return LEVELS.indexOf(chosen) > LEVELS.indexOf(ceiling) ? ceiling : chosen;
  }

  private async approve(
    call: ChatToolCall,
    command: string,
    why: string | null,
    user: HelperUser,
  ): Promise<boolean> {
    const wording = WORDING[user.locale];
    const id = `approval-${call.id}`;
    const option = await new Promise<string | null>((resolve) => {
      this.approvals.set(id, { resolve });
      this.queue.push({
        type: 'approval.requested',
        id,
        title: command,
        description: why,
        command,
        toolId: call.id,
        options: [
          { id: 'once', label: wording.run, kind: 'allow_once' },
          { id: 'deny', label: wording.deny, kind: 'reject_once' },
        ],
      });
    });
    return option === 'once';
  }

  private async callTool(
    call: ChatToolCall,
    host: HermesHelperHost,
    user: HelperUser,
    ceiling: HelperLevel,
  ): Promise<string> {
    const level = this.level ?? 'check';
    const spec = toolsFor(level, ceiling, host).find((tool) => tool.name === call.function.name);
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      return `Error: the arguments were not valid JSON: ${clip(call.function.arguments, 300)}`;
    }
    const title = describeCall(call.function.name, input, host);
    this.queue.push({
      type: 'tool.started',
      id: call.id,
      title,
      kind: spec?.kind ?? 'other',
      name: call.function.name,
      input,
    });
    if (!spec) {
      const said = `Not available at this conversation’s level (${level}). Call request_more_access first, or give the person manual steps.`;
      this.queue.push({ type: 'tool.failed', id: call.id, title, output: said });
      return said;
    }
    if (spec.gated) {
      const why = typeof input.why === 'string' ? input.why : null;
      const yes = await this.approve(call, title, why, user);
      if (!yes) {
        const said =
          'DECLINED: the person did not approve this step. Do not try it again; explain what they can do instead.';
        this.queue.push({ type: 'tool.failed', id: call.id, title, output: said });
        return said;
      }
    }
    try {
      const { output, ok, exitCode } = await this.execute(spec.name, input, host, user, ceiling);
      const clean = redactSecrets(output);
      this.queue.push({
        type: ok ? 'tool.completed' : 'tool.failed',
        id: call.id,
        title,
        output: clip(clean, MAX_SHOWN_OUTPUT),
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
      return clip(clean, MAX_TOOL_OUTPUT);
    } catch (error) {
      const said = `Error: ${error instanceof Error ? error.message : String(error)}`;
      this.queue.push({ type: 'tool.failed', id: call.id, title, output: said });
      return said;
    }
  }

  private async execute(
    name: string,
    input: Record<string, unknown>,
    host: HermesHelperHost,
    user: HelperUser,
    ceiling: HelperLevel,
  ): Promise<{ output: string; ok: boolean; exitCode?: number | null }> {
    switch (name) {
      case 'hermes_status':
        return { ok: true, output: JSON.stringify(statusOf(host), null, 2) };
      case 'hermes_doctor':
        return this.hermes(host, ['doctor'], DOCTOR_TIMEOUT_MS);
      case 'hermes_doctor_fix':
        return this.hermes(host, ['doctor', '--fix'], DOCTOR_TIMEOUT_MS);
      case 'run_hermes': {
        const args = stringArray(input.args);
        if (!args) return { ok: false, output: 'Error: `args` must be a list of strings.' };
        return this.hermes(host, args, COMMAND_TIMEOUT_MS);
      }
      case 'list_hermes_files':
        return listInHome(host, typeof input.path === 'string' ? input.path : '');
      case 'read_hermes_file':
        return readInHome(
          host,
          typeof input.path === 'string' ? input.path : '',
          typeof input.tail_lines === 'number' ? input.tail_lines : null,
        );
      case 'request_more_access': {
        const current = this.level ?? 'check';
        const next = LEVELS[LEVELS.indexOf(current) + 1] ?? current;
        const chosen = await this.askLevel(user, ceiling, next, true);
        if (chosen && LEVELS.indexOf(chosen) > LEVELS.indexOf(current)) this.level = chosen;
        return {
          ok: true,
          output: `The conversation’s level is now ${this.level}${chosen ? '' : ' (the person did not raise it)'}.`,
        };
      }
      case 'restart_hermes':
        await host.restart();
        return {
          ok: true,
          output: 'Hermes was asked to restart. Check hermes_status in a few seconds.',
        };
      case 'update_hermes': {
        const lines: string[] = [];
        try {
          await host.update((line) => lines.push(line));
          return { ok: true, output: lines.join('\n') || 'Updated.' };
        } catch (error) {
          lines.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
          return { ok: false, output: lines.join('\n') };
        }
      }
      case 'run_command': {
        const argv = stringArray(input.argv);
        if (!argv || argv.length === 0) {
          return { ok: false, output: 'Error: `argv` must be a non-empty list of strings.' };
        }
        const cwd =
          typeof input.cwd === 'string' && input.cwd
            ? path.resolve(host.home() ?? os.homedir(), input.cwd)
            : (host.home() ?? os.homedir());
        return commandOutcome(
          await this.run(argv, { cwd, env: host.cliEnv(), timeoutMs: COMMAND_TIMEOUT_MS }),
        );
      }
      case 'write_file': {
        if (typeof input.path !== 'string' || typeof input.content !== 'string') {
          return { ok: false, output: 'Error: `path` and `content` are required.' };
        }
        const file = path.resolve(host.home() ?? os.homedir(), input.path);
        let backup: string | null = null;
        if (existsSync(file)) {
          backup = `${file}.corehub-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          copyFileSync(file, backup);
        } else {
          mkdirSync(path.dirname(file), { recursive: true });
        }
        writeFileSync(file, input.content);
        return {
          ok: true,
          output: `Wrote ${file} (${Buffer.byteLength(input.content)} bytes).${backup ? ` The old file is at ${backup}.` : ''}`,
        };
      }
      default:
        return { ok: false, output: `Error: no tool named ${name}.` };
    }
  }

  private async hermes(
    host: HermesHelperHost,
    args: string[],
    timeoutMs: number,
  ): Promise<{ output: string; ok: boolean; exitCode?: number | null }> {
    const exe = host.executable();
    if (!exe) return { ok: false, output: 'Error: the hub found no `hermes` program to run.' };
    return commandOutcome(
      await this.run([exe, ...args], {
        env: host.cliEnv(),
        timeoutMs,
        ...(host.home() ? { cwd: host.home()! } : {}),
      }),
    );
  }

  /**
   * No gateway: one answer from the providers' own path, without tools, from a snapshot the
   * hub takes before the first turn (status, `hermes doctor`, the end of the error log).
   */
  private async sendPlain(
    prompt: PromptInput,
    host: HermesHelperHost,
    user: HelperUser,
  ): Promise<{ stopReason: string }> {
    const port = this.options.models();
    const workspace = this.target.workspace;
    const providerId = prompt.modelProviderId ?? this.target.modelProviderId ?? null;
    const model = prompt.model ?? this.target.model ?? null;
    if (!port || !workspace || !providerId || !model) {
      return this.fail(
        'provider_not_configured',
        'no model is chosen for this profile; pick one in Models and try again',
      );
    }
    let text = prompt.text;
    if (this.plain.length === 0) {
      this.plain.push({ role: 'system', text: systemPrompt('check', 'check', user, false) });
      text = `${await this.snapshot(host)}\n\n---\n\n${prompt.text}`;
    }
    this.plain.push({ role: 'user', text });
    const controller = new AbortController();
    this.turn = controller;
    let answer = '';
    try {
      for await (const event of port.directChat(workspace, {
        providerId,
        model,
        messages: [...this.plain],
        signal: controller.signal,
        conversation: this.id,
      })) {
        if (event.type === 'delta') {
          answer += event.text;
          this.queue.push({ type: 'message.delta', text: event.text });
        } else if (event.type === 'reasoning') {
          this.queue.push({ type: 'reasoning.delta', text: event.text });
        } else if (event.type === 'failed') {
          if (event.code === 'cancelled' || this.interrupted) return this.stopped();
          this.plain.pop();
          return this.fail(event.code, event.message);
        } else if (event.type === 'completed') {
          break;
        }
      }
      if (answer) this.plain.push({ role: 'assistant', text: answer });
      this.queue.push({ type: 'run.completed', stopReason: 'end_turn' });
      return { stopReason: 'end_turn' };
    } catch (error) {
      this.plain.pop();
      return this.fail(
        'agent_error',
        error instanceof Error ? error.message : 'the provider failed',
      );
    } finally {
      this.turn = null;
    }
  }

  private async snapshot(host: HermesHelperHost): Promise<string> {
    const doctor = await this.hermes(host, ['doctor'], 90_000).catch((error: unknown) => ({
      ok: false,
      output: String(error),
    }));
    const errors = readInHome(host, 'logs/errors.log', 80);
    const parts = [
      'Snapshot of Hermes taken by the hub just now (tools are not available):',
      `## Status\n${JSON.stringify(statusOf(host), null, 2)}`,
      `## hermes doctor\n${doctor.output}`,
      `## logs/errors.log (end)\n${errors.output}`,
    ];
    return clip(redactSecrets(parts.join('\n\n')), MAX_TOOL_OUTPUT);
  }
}

// ------------------------------------------------------------------- the helpers

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : null;
}

function commandOutcome(result: CommandResult): {
  output: string;
  ok: boolean;
  exitCode?: number | null;
} {
  const text = [result.stdout.trim(), result.stderr.trim(), result.error ?? '']
    .filter(Boolean)
    .join('\n');
  const exit = /exit code (\d+)/.exec(result.error ?? '');
  return {
    ok: result.ok,
    output: text || (result.ok ? '(no output)' : 'Error: the command failed with no output'),
    exitCode: result.ok ? 0 : exit ? Number(exit[1]) : null,
  };
}

function statusOf(host: HermesHelperHost): Record<string, unknown> {
  return {
    hermes: host.status(),
    executable: host.executable(),
    home: host.home(),
    can_restart: host.canRestart(),
    can_update: host.canUpdate(),
    hub: host.hubFacts(),
  };
}

/** What the chat shows for a call: the command as it will run, or the tool and its path. */
function describeCall(
  name: string,
  input: Record<string, unknown>,
  host: HermesHelperHost,
): string {
  const exe = 'hermes';
  switch (name) {
    case 'hermes_doctor':
      return `${exe} doctor`;
    case 'hermes_doctor_fix':
      return `${exe} doctor --fix`;
    case 'run_hermes':
      return [exe, ...(stringArray(input.args) ?? [])].map(quoteArg).join(' ');
    case 'run_command':
      return (stringArray(input.argv) ?? []).map(quoteArg).join(' ');
    case 'restart_hermes':
      return 'restart Hermes';
    case 'update_hermes':
      return `${exe} update --yes`;
    case 'write_file':
      return `write ${typeof input.path === 'string' ? path.resolve(host.home() ?? os.homedir(), input.path) : '?'}`;
    case 'read_hermes_file':
      return `read ${typeof input.path === 'string' ? input.path : '?'}`;
    case 'list_hermes_files':
      return `list ${typeof input.path === 'string' && input.path ? input.path : '.'}`;
    default:
      return name;
  }
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A path inside Hermes's home, every link resolved; null when it leaves the home. */
function insideHome(host: HermesHelperHost, relative: string): string | null {
  const home = host.home();
  if (!home) return null;
  let root: string;
  try {
    root = realpathSync(home);
  } catch {
    return null;
  }
  const wanted = path.resolve(root, relative || '.');
  let real: string;
  try {
    real = realpathSync(wanted);
  } catch {
    real = wanted;
  }
  return real === root || real.startsWith(root + path.sep) ? real : null;
}

function listInHome(host: HermesHelperHost, relative: string): { output: string; ok: boolean } {
  const dir = insideHome(host, relative);
  if (!dir) return { ok: false, output: 'Error: that path is not inside Hermes’s home.' };
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .slice(0, 300)
      .map((entry) => {
        try {
          const info = statSync(path.join(dir, entry.name));
          return `${entry.isDirectory() ? 'dir ' : 'file'}  ${String(info.size).padStart(10)}  ${info.mtime.toISOString()}  ${entry.name}`;
        } catch {
          return `?     ${entry.name}`;
        }
      });
    return { ok: true, output: entries.join('\n') || '(empty)' };
  } catch (error) {
    return { ok: false, output: `Error: ${(error as Error).message}` };
  }
}

function readInHome(
  host: HermesHelperHost,
  relative: string,
  tailLines: number | null,
): { output: string; ok: boolean } {
  const file = insideHome(host, relative);
  if (!file) return { ok: false, output: 'Error: that path is not inside Hermes’s home.' };
  try {
    const info = statSync(file);
    if (info.isDirectory()) return listInHome(host, relative);
    const buffer = readFileSync(file);
    if (buffer.subarray(0, 8000).includes(0)) {
      return { ok: false, output: 'Error: that is not a text file.' };
    }
    let text = buffer.toString('utf8');
    // A `.env` shows names only: which keys are set is the useful part.
    if (path.basename(file) === '.env' || file.endsWith('.env')) {
      text = text
        .split('\n')
        .map((line) => {
          const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
          if (!match) return line.trim().startsWith('#') ? line : '';
          return `${match[1]}=${match[2]!.trim() ? '[set]' : '[empty]'}`;
        })
        .filter(Boolean)
        .join('\n');
    }
    const lines = Math.min(Math.max(Math.floor(tailLines ?? 0), 0), 2000);
    if (lines > 0 || buffer.byteLength > MAX_FILE_BYTES) {
      const all = text.split('\n');
      const keep = lines > 0 ? lines : 400;
      text = `[last ${Math.min(keep, all.length)} of ${all.length} lines]\n${all.slice(-keep).join('\n')}`;
    }
    return { ok: true, output: text };
  } catch (error) {
    return { ok: false, output: `Error: ${(error as Error).message}` };
  }
}
