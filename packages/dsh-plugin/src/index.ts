/**
 * Core Hub for DeepSeek Harness (ADR 0033): a Cordis plugin that links the harness on the
 * person's computer to their Core Hub server.
 *
 * - `/corehub link | status | models | unlink` — the pairing claim, the link's state, the hub's
 *   models as a provider of the harness, and unlinking (§2, §3).
 * - The device link: the hub's agents reach this computer's shared folders, the harness's MCP
 *   servers and (on macOS) screen tasks, each as the person allowed (§4, §5).
 * - `/hermes <message>` and the `corehub_ask_agent` tool: the hub's agent from inside the
 *   harness (§6).
 *
 * The settings below are the row's config: the harness's Plugins page shows them as this
 * plugin's settings, and changes apply without a restart. The link itself (hub, token) is never
 * part of them.
 */
import Schema from '@deepseek-ai/schemastery';
import { CoreHub, dataDirOf, type Settings } from './core.js';
import type { CommandRuntime, ConfigEditor, HostContext, ToolRegistry } from './host.js';
import { translator, pickLanguage } from './i18n.js';
import { AGENT_COMMAND_NAME, ASK_AGENT_TOOL, COMMAND_NAME, PLUGIN_NAME } from './names.js';

export const name = PLUGIN_NAME;

/** The configuration editor is in every dsh-base profile; the data folder sits beside its patch. */
export const inject = ['configEditor'];

interface Volatile<T> {
  get(): T;
}

export interface Config {
  folders: Volatile<Array<{ path: string; write: boolean }>>;
  allowOpen: Volatile<boolean>;
  programs: Volatile<Record<string, string[]>>;
  agentProfile: Volatile<string>;
  agent: Volatile<string>;
  screenTasks: Volatile<boolean>;
  screenModel: Volatile<string>;
  dshCommand: Volatile<string[]>;
  language: Volatile<'auto' | 'en' | 'ar'>;
  dataDir: string;
}

export const Config = Schema.object({
  folders: Schema.array(
    Schema.object({
      path: Schema.string().required().description('Absolute path of a folder on this computer.'),
      write: Schema.boolean().default(false).description('Writable (read-only when off).'),
    }),
  )
    .default([])
    .description('Folders the hub’s agents may use on this computer.')
    .volatile(),
  allowOpen: Schema.boolean()
    .default(false)
    .description(
      'Let the hub’s agents open files in the shared folders and web links on this computer.',
    )
    .volatile(),
  programs: Schema.dict(Schema.array(Schema.string()))
    .default({})
    .description(
      'MCP servers of this harness profile offered to the hub: server name → hub profiles it serves. A server not listed is off.',
    )
    .volatile(),
  agentProfile: Schema.string()
    .default('')
    .description('The hub profile /hermes talks in (empty: your default profile).')
    .volatile(),
  agent: Schema.string()
    .default('hermes')
    .description('The hub agent /hermes talks to (its slug).')
    .volatile(),
  screenTasks: Schema.boolean()
    .default(true)
    .description('Offer screen tasks to the hub (macOS with Computer Use only; asks every time).')
    .volatile(),
  screenModel: Schema.string()
    .default('')
    .description(
      'The hub model screen tasks use when the hub names none (empty: the first the hub offers).',
    )
    .volatile(),
  dshCommand: Schema.array(Schema.string())
    .default([])
    .description('How to start this harness’s CLI for screen tasks (empty: found automatically).')
    .volatile(),
  language: Schema.union(['auto', 'en', 'ar'] as const)
    .default('auto')
    .description('The plugin’s language.')
    .volatile(),
  dataDir: Schema.string()
    .default('')
    .description('Where the plugin keeps its link (empty: beside this profile’s patch).'),
}).i18n({
  ar: {
    folders: 'المجلدات اللي تقدر وكلاء الهب يستخدمونها في هذا الجهاز.',
    allowOpen: 'اسمح لوكلاء الهب يفتحون ملفات المجلدات المشاركة وروابط الويب في هذا الجهاز.',
    programs:
      'خوادم MCP في بروفايل الهارنس المعروضة للهب: اسم الخادم ← بروفايلات الهب. الخادم غير المذكور مطفي.',
    agentProfile: 'بروفايل الهب اللي يتكلم فيه /hermes (فاضي: بروفايلك الافتراضي).',
    agent: 'وكيل الهب اللي يكلمه /hermes (اسمه المختصر).',
    screenTasks: 'اعرض مهام الشاشة على الهب (للماك مع Computer Use فقط، ويسأل كل مرة).',
    screenModel: 'موديل الهب لمهام الشاشة إذا ما حدد الهب موديل (فاضي: أول موديل يعرضه الهب).',
    dshCommand: 'أمر تشغيل الهارنس لمهام الشاشة (فاضي: يُكتشف تلقائياً).',
    language: 'لغة الإضافة.',
    dataDir: 'مكان حفظ الربط (فاضي: جنب ملف البروفايل).',
  },
});

const read = <T>(value: Volatile<T> | T | undefined, fallback: T): T => {
  if (value && typeof value === 'object' && typeof (value as Volatile<T>).get === 'function') {
    const v = (value as Volatile<T>).get();
    return v === undefined || v === null ? fallback : v;
  }
  return value === undefined || value === null ? fallback : (value as T);
};

export function settingsOf(config: Partial<Config>): Settings {
  return {
    folders: read(config.folders, []),
    allowOpen: read(config.allowOpen, false),
    programs: read(config.programs, {}),
    agentProfile: read(config.agentProfile, ''),
    agent: read(config.agent, 'hermes'),
    screenTasks: read(config.screenTasks, true),
    screenModel: read(config.screenModel, ''),
    dshCommand: read(config.dshCommand, []),
    language: read(config.language, 'auto'),
  };
}

export function apply(ctx: HostContext & { configEditor: ConfigEditor }, config: Config): void {
  const log = ctx.logger(PLUGIN_NAME);
  const settings = () => settingsOf(config);
  const core = new CoreHub({
    dataDir: dataDirOf(config.dataDir ?? '', ctx.configEditor?.documentPath ?? null),
    settings,
    log,
    hostHasComputerUse: () => !!ctx.get?.('computerUse'),
  });
  core.configEditor = ctx.configEditor;

  ctx.effect(() => {
    core.start();
    return () => core.stop();
  });

  // The Core Hub provider's bearer, from memory, on each of its requests (see provider.ts).
  ctx.on('llm-pi-ai/request-headers', ((
    request: { provider?: string },
    headers: Headers,
    next: () => Headers,
  ) => {
    core.authorize(request?.provider, headers);
    return next();
  }) as never);

  // Live settings changed (the Plugins page): the hub hears the new folders and programs.
  ctx.on('loader/volatile-update', () => core.settingsChanged());

  ctx.inject(['commands'], (c) => registerCommands(c.commands as CommandRuntime, core));
  ctx.inject(['tools'], (c) => {
    core.tools = c.tools as ToolRegistry;
    c.effect(() => () => {
      core.tools = null;
    });
    registerAskTool(c.tools as ToolRegistry, core);
  });
  ctx.inject(['mcpManager'], (c) => {
    core.mcpManager = c.mcpManager ?? null;
    c.on('mcp-manager/status', () => core.settingsChanged());
    c.effect(() => () => {
      core.mcpManager = null;
    });
  });
  ctx.inject(['userQuestions'], (c) => {
    core.userQuestions = c.userQuestions ?? null;
    c.effect(() => () => {
      core.userQuestions = null;
    });
  });
}

function registerCommands(commands: CommandRuntime, core: CoreHub): void {
  const t = () => translator(pickLanguage(core.settings().language));
  commands.register({
    name: COMMAND_NAME,
    description: t()('command.corehub'),
    input: { hint: t()('command.corehub.hint') },
    // A pairing code is short-lived, but it is still a secret for its minutes: not logged.
    recordInput: false,
    handler: async ({ rawInput }) => {
      const text = rawInput.trim();
      const sub = text.split(/\s+/)[0] ?? '';
      const arg = text.slice(sub.length).trim();
      try {
        switch (sub.toLowerCase()) {
          case 'link':
            return { kind: 'success', text: await core.linkWith(arg) };
          case 'status':
          case '':
            return { kind: 'success', text: core.statusText() };
          case 'models':
            return { kind: 'success', text: await core.refreshModels() };
          case 'unlink':
            return { kind: 'success', text: await core.unlink() };
          case 'help':
            return { kind: 'success', text: core.help() };
          default:
            // `/corehub {"type":"corehub.pairing",…}` links too.
            if (text.startsWith('{') || /:\/\//.test(text))
              return { kind: 'success', text: await core.linkWith(text) };
            return { kind: 'error', text: core.help() };
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  commands.register({
    name: AGENT_COMMAND_NAME,
    description: t()('command.agent'),
    input: { hint: t()('command.agent.hint') },
    handler: async ({ agent, rawInput, signal }) => {
      const message = rawInput.trim();
      if (!message)
        return { kind: 'error', text: t()('agent.usage', { agentCommand: AGENT_COMMAND_NAME }) };
      const answer = await core.askAgent(agent.id, message, signal);
      return answer.ok
        ? { kind: 'success', text: answer.text }
        : { kind: 'error', text: answer.text };
    },
  });
}

function registerAskTool(tools: ToolRegistry, core: CoreHub): void {
  const t = translator('en');
  // The registry's disposer is an effect of this (injected) context: unloading withdraws it.
  tools.register({
    name: ASK_AGENT_TOOL,
    description: t('tool.description'),
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: t('tool.message') } },
      required: ['message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, answer: { type: 'string' } },
        required: ['ok', 'answer'],
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; answer?: string };
        return [{ type: 'text', text: `${v.ok ? '' : '[not answered] '}${v.answer ?? ''}` }];
      },
    },
    async execute(args, exec) {
      const message = String((args as { message?: unknown })?.message ?? '').trim();
      if (!message) return { ok: false, answer: 'message is empty' };
      const answer = await core.askAgent(exec.agent?.id ?? 'no-session', message, exec.signal);
      return { ok: answer.ok, answer: answer.text };
    },
  });
}
