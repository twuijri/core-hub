// The e2e hub: the real server (auth, sessions, realtime, static web client) with a scripted
// agent runner in place of the adapters, so the smoke journeys run without a model.
// The script an agent plays is chosen by the text of the prompt (see `scriptFor`).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/src/app/config.js';
import { buildServer } from '../../server/src/app/server.js';
import { createLogger } from '../../server/src/lib/logger.js';
import { modules as defaultModules, notifierPort } from '../../server/src/modules/index.js';
import { principalScopeResolver } from '../../server/src/modules/auth/index.js';
import { overrideAgents } from '../../server/src/modules/agents/index.js';
import { overrideModels } from '../../server/src/modules/models/index.js';
import type { AgentInstaller } from '../../server/src/modules/agents/index.js';
import { createSessionsModule } from '../../server/src/modules/sessions/index.js';
import { createHermesCardApi, registerHermesBoard } from '../../server/src/modules/tasks/index.js';
import { registerHermesCron } from '../../server/src/modules/schedules/index.js';
import { createHermesJobs } from '../../server/src/modules/schedules/hermes-jobs.js';
import { FakeHermesApi } from '../../server/src/modules/schedules/testing/fake-hermes-api.js';
import { agentsServiceFor } from '../../server/src/modules/agents/index.js';
import { HermesRefusal, type HermesTask } from '../../server/src/modules/tasks/hermes-kanban.js';
import type {
  AgentAskRequest,
  AgentEvent,
  AgentRunAccepted,
  AgentRunInput,
  AgentRunRequest,
  AgentRunner,
} from '../../server/src/modules/sessions/ports.js';
import { fakeHermes } from '../../server/src/modules/sessions/testing/fake-runner.js';

export const E2E_PASSWORD = 'e2e-owner-password';

type Step = AgentEvent | { type: 'delay'; ms: number } | { type: 'await_input' };

function scriptFor(prompt: string): Step[] {
  if (/ملاحظات الإصدار/.test(prompt)) {
    // A task the board started (journey 22). Slow enough that the card is seen running,
    // and it ends the way the task prompt asks: with a short summary, which the card
    // then shows in Review.
    return [
      { type: 'reasoning_delta', text: 'أقرأ سجل التغييرات…' },
      { type: 'delay', ms: 2500 },
      {
        type: 'message_delta',
        text: 'جمعت ملاحظات الإصدار في ثلاثة أقسام: الجديد، والإصلاحات، وما تغيّر في التثبيت. بقي: مراجعة الصياغة.',
      },
      { type: 'completed' },
    ];
  }
  if (/ترجم الدليل/.test(prompt)) {
    // A task that is still running when the board is photographed (zz-task-board): its
    // turning green frame has to be seen next to the other stages, so it does not end.
    return [
      { type: 'reasoning_delta', text: 'أقرأ الدليل…' },
      { type: 'delay', ms: 180_000 },
      { type: 'message_delta', text: 'ترجمت الدليل.' },
      { type: 'completed' },
    ];
  }
  if (/رد طويل|long reply/i.test(prompt)) {
    // A reply that grows for a few seconds, taller than the screen: the transcript must
    // follow it while the person is at the bottom, and leave them be when they are not.
    const steps: Step[] = [];
    for (let line = 1; line <= 60; line += 1) {
      steps.push({ type: 'message_delta', text: `سطر ${line}\n\n` }, { type: 'delay', ms: 120 });
    }
    return [...steps, { type: 'completed' }];
  }
  if (/اسألني|ask me/i.test(prompt)) {
    // A question with choices, answered on the card above the composer (journey 19). The
    // reply repeats the answer: `{answer}` is filled in with what the person sent.
    // As Hermes does it: the `clarify` tool starts, asks, and returns what it was told
    // (`{raw}` is the answer as Hermes receives it, `""` for a skip), and the question
    // waits five minutes, counted down on the card.
    return [
      {
        type: 'tool_started',
        ref: 'c1',
        name: 'clarify',
        input: { question: 'وش الجهاز اللي تبي تتصل فيه؟' },
      },
      {
        type: 'approval_requested',
        ref: 'q1',
        kind: 'question',
        title: 'وش الجهاز اللي تبي تتصل فيه؟',
        choices: [
          { value: 'ماك (Recommended)', label: 'ماك (Recommended)' },
          { value: 'ويندوز', label: 'ويندوز' },
          { value: 'لينكس', label: 'لينكس' },
        ],
        answerMode: 'both',
        toolRef: 'c1',
        expiresInMs: 5 * 60_000,
      },
      { type: 'await_input' },
      {
        type: 'tool_completed',
        ref: 'c1',
        output: '{"question": "وش الجهاز اللي تبي تتصل فيه؟", "user_response": "{raw}"}',
      },
      { type: 'message_delta', text: 'اخترت: {answer}' },
      { type: 'completed' },
    ];
  }
  if (/approve|موافقة/i.test(prompt)) {
    return [
      { type: 'message_delta', text: 'سأحتاج إذنك لتشغيل الأمر. ' },
      {
        type: 'approval_requested',
        ref: 'a1',
        kind: 'tool_call',
        title: 'تنفيذ أمر',
        description: 'يريد الوكيل تشغيل الأمر التالي',
        command: 'pnpm test',
        allowAlways: true,
        answerMode: 'choice',
      },
      { type: 'await_input' },
      { type: 'message_delta', text: 'شكرًا، تمت الموافقة وانتهى الأمر.' },
      { type: 'usage', inputTokens: 12, outputTokens: 8 },
      { type: 'completed' },
    ];
  }
  if (/يفكّر الآن|think out loud/i.test(prompt)) {
    // A run that is alive but says nothing for a while. Two things need that shape:
    // the live indicator is then the *only* thing telling the person the agent is
    // working (so the design pass can photograph it doing its job), and a second
    // message can be queued before any reply exists, which is how two messages from
    // the same speaker end up next to each other and group.
    return [
      { type: 'delay', ms: 6000 },
      {
        type: 'tool_started',
        ref: 't1',
        name: 'read_file',
        kind: 'shell',
        title: 'docs/clients/DESIGN.md',
      },
      { type: 'delay', ms: 120_000 },
      { type: 'message_delta', text: 'انتهيت.' },
      { type: 'completed' },
    ];
  }
  if (/in english|بالإنجليزية/i.test(prompt)) {
    // An English reply with a table and a code block: the agent's side has to be able to
    // use the whole column, which a 70%-wide bubble could not.
    return [
      { type: 'reasoning_delta', text: 'Comparing the two options before answering.' },
      {
        type: 'message_delta',
        text: '## Two ways to do it\n\nThe short answer is **the second one**.\n\n| Option | Cost | Notes |\n| --- | --- | --- |\n| Poll the hub | high | simple, wasteful |\n| Subscribe | low | one socket, resumable |\n\n',
      },
      { type: 'tool_started', ref: 't1', name: 'read_file', kind: 'shell', title: 'events.md' },
      { type: 'delay', ms: 120 },
      { type: 'tool_completed', ref: 't1', output: 'after_seq is the cursor.\n', exitCode: 0 },
      {
        type: 'message_delta',
        text: '```ts\nsocket.emit("subscribe", { session_id, after_seq });\n```\n',
      },
      { type: 'usage', inputTokens: 41, outputTokens: 96 },
      { type: 'completed' },
    ];
  }
  if (/stop me|أوقفني/i.test(prompt)) {
    // Long enough that the stop button is never a race: only an interrupt ends this run.
    return [
      { type: 'message_delta', text: 'أبدأ عملًا طويلًا… ' },
      { type: 'delay', ms: 120_000 },
      { type: 'message_delta', text: 'هذا الجزء لا يجب أن يصل بعد الإيقاف.' },
      { type: 'completed' },
    ];
  }
  if (/slow|بطيء/i.test(prompt)) {
    // The pause has to outlast creating the session, navigating and hydrating the screen,
    // or the journey would be racing the script instead of testing the resume.
    return [
      { type: 'message_delta', text: 'الجزء الأول من الرد. ' },
      { type: 'delay', ms: 8000 },
      { type: 'message_delta', text: 'والجزء الثاني بعد الانقطاع.' },
      { type: 'completed' },
    ];
  }
  return [
    { type: 'reasoning_delta', text: 'أفكر في الرد…' },
    {
      type: 'message_delta',
      text: '# مرحبا\n\nهذا **رد** مبثوث من المشغّل المكتوب بالسيناريو.\n\n',
    },
    { type: 'tool_started', ref: 't1', name: 'shell', kind: 'shell', title: 'ls -la' },
    { type: 'delay', ms: 150 },
    { type: 'tool_completed', ref: 't1', output: 'total 0\nREADME.md\n', exitCode: 0 },
    { type: 'message_delta', text: '```ts\nconst answer = 42;\n```\n' },
    { type: 'usage', inputTokens: 20, outputTokens: 30 },
    { type: 'completed' },
  ];
}

interface Live {
  queue: Step[];
  wake: (() => void) | null;
  closed: boolean;
  /** The last answer a person gave this run, for scripts that repeat it. */
  answer: string;
  /** The same answer as the agent's tool returns it: `''` for a skip, no "(Recommended)". */
  raw: string;
}

/** A runner with real pauses, so a socket can be dropped mid-run and resumed. */
class ScriptedRunner implements AgentRunner {
  private readonly runs = new Map<string, Live>();

  async start(request: AgentRunRequest): Promise<AgentRunAccepted> {
    const text = request.prompt.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    this.runs.set(request.runId, {
      queue: scriptFor(text),
      wake: null,
      closed: false,
      answer: '',
      raw: '',
    });
    return {
      agentSessionRef: request.agentSessionRef ?? `e2e-${request.sessionId}`,
      agentRunRef: `e2e-run-${request.runId}`,
    };
  }

  async *stream(runId: string): AsyncIterable<AgentEvent> {
    const live = this.runs.get(runId);
    if (!live) return;
    while (live.queue.length > 0 && !live.closed) {
      const step = live.queue.shift() as Step;
      if (step.type === 'delay') {
        // Interruptible: a pause that ignored `interrupt()` would make the stop button
        // look broken for as long as the script says, which is not what a real agent does.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            live.wake = null;
            resolve();
          }, step.ms);
          live.wake = () => {
            clearTimeout(timer);
            live.wake = null;
            resolve();
          };
        });
        continue;
      }
      if (step.type === 'await_input') {
        await new Promise<void>((resolve) => {
          live.wake = resolve;
        });
        continue;
      }
      if (step.type === 'tool_completed' && step.output) {
        yield { ...step, output: step.output.replace('{raw}', live.raw) };
        continue;
      }
      yield step.type === 'message_delta'
        ? { ...step, text: step.text.replace('{answer}', live.answer) }
        : step;
    }
    if (live.closed) yield { type: 'completed' };
  }

  async send(runId: string, input: AgentRunInput): Promise<void> {
    const live = this.runs.get(runId);
    // Skipped is "deny" with no answer, as the card sends it.
    if (live) live.answer = input.decision === 'deny' ? 'تخطّيت' : (input.answer ?? '');
    if (live)
      live.raw =
        input.decision === 'deny' ? '' : (input.answer ?? '').replace(/ \(Recommended\)$/, '');
    live?.wake?.();
    if (live) live.wake = null;
  }

  async interrupt(runId: string): Promise<void> {
    const live = this.runs.get(runId);
    if (!live) return;
    live.queue = [];
    live.closed = true;
    live.wake?.();
  }

  /**
   * The one-shot question the hub asks to name a session (contract decision §26). The
   * scripted agent answers in the language of the prompt it is naming, and dresses the
   * answer the way a real model does — quotes and a full stop — so the journey proves the
   * hub's own cleanup, not a fixture that was already clean.
   */
  async ask(request: AgentAskRequest): Promise<string | null> {
    return /[\u0600-\u06FF]/.test(request.prompt)
      ? '«خطة الإطلاق في ثلاث مراحل».'
      : '"A launch plan in three stages."';
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.MAJLIS_E2E_PORT ?? 8791);
// Journey 4 (first-run setup, ADR 0011) needs the opposite hub: no owner, no
// HUB_ADMIN_PASSWORD, and a data directory the test can read the claim token from. Playwright
// starts that one as a second web server with MAJLIS_E2E_MODE=setup and a data dir it names.
const setupMode = process.env.MAJLIS_E2E_MODE === 'setup';
const namedDataDir = process.env.MAJLIS_E2E_DATA_DIR;
const dataDir = namedDataDir ?? mkdtempSync(path.join(tmpdir(), 'majlis-e2e-'));
if (namedDataDir) {
  // A fresh hub on every start, so the journey is the same on the first run and on a retry.
  rmSync(namedDataDir, { recursive: true, force: true });
  mkdirSync(namedDataDir, { recursive: true });
}
// The registry (agents.list) is the real module seeded from the catalog; the sessions module
// asks this directory whether an agent can take a turn — every catalog id plays the script.
// The journeys must say the same thing on every machine: a Hermes running on the
// developer's box must not decide whether the agent picker has an enabled card, and CI
// (which has none) must not end up with every card disabled. So the installer reports the
// catalog's agents as present on disk and the health check passes; the turns themselves
// come from ScriptedRunner below, never from a real agent.
const e2eInstaller: AgentInstaller = {
  root: path.join(dataDir, 'agents'),
  binDirFor: (id) => path.join(dataDir, 'agents', id, 'bin'),
  isPresent: () => true,
  async install(entry, report) {
    await report(100, 'installed');
    return {
      version: '0.0.0-e2e',
      executablePath: path.join(dataDir, 'agents', entry.id, 'bin', entry.binary),
    };
  },
  async uninstall() {},
  async health() {
    return { ok: true, version: '0.0.0-e2e', error: null };
  },
};
// Neither a gateway on the developer's box nor its absence on a CI runner may decide a
// journey, so the probe is scripted: a healthy Hermes, always. Turns still come from
// ScriptedRunner below; nothing here talks to a real agent.
const scriptedGateway: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith('/health')) {
    return new Response(JSON.stringify({ status: 'ok', version: '0.0.0-e2e' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('not found', { status: 404 });
};
overrideAgents({
  pathValue: path.join(dataDir, 'no-such-bin'),
  installer: e2eInstaller,
  adapterOptions: { hermes: { fetchImpl: scriptedGateway } },
});

/**
 * A provider with a catalogue the size of a real one. The owner connected OpenRouter,
 * the fetch returned 443 models, and the plain dropdown made finding one impossible —
 * this is that list, so the searchable picker is exercised at the size that broke.
 * Nothing here reaches the network: the provider adapters get this `fetch` and no other.
 */
const FAMILIES = [
  'claude-opus',
  'claude-sonnet',
  'claude-haiku',
  'gpt',
  'gemini',
  'llama',
  'mistral',
  'qwen',
  'deepseek',
  'command-r',
];
const bigCatalogue = Array.from({ length: 443 }, (_, i) => {
  const family = FAMILIES[i % FAMILIES.length] as string;
  const variant = i % 3 === 0 ? '-thinking' : i % 3 === 1 ? '-instruct' : '';
  return { id: `${family}-${Math.floor(i / FAMILIES.length) + 1}${variant}`, object: 'model' };
});
const scriptedProvider: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  if (url.endsWith('/models')) return json({ data: bigCatalogue });
  return json({ ok: true });
};
overrideModels({ fetchImpl: scriptedProvider });

/**
 * Hermes's own board, scripted: one card Hermes finished, and a Hermes that refuses to let
 * it go — so journey 17 can show the card's mark and Hermes's refusal in Hermes's words.
 * Whether the developer's box has a real Hermes must not decide what the board shows.
 *
 * Its server (ADR 0015) is scripted too, answering the two calls journey 17 makes: open the
 * card, edit its words. An edit lands on the card, so the next read shows Hermes's copy.
 */
const hermesCard: HermesTask = {
  id: 't_e2e00001',
  title: 'راجعت سجل التغييرات',
  body: null,
  assignee: null,
  status: 'done',
  priority: 0,
  created_at: 0,
  result: null,
};
registerHermesBoard(() => ({
  kanban: () => ({
    list: async () => [hermesCard],
    show: async (id) => (id === hermesCard.id ? hermesCard : null),
    create: async () => {
      throw new HermesRefusal('create', 'the e2e board takes no new cards');
    },
    // Hermes's card is not a week old; the scripted board archives nothing.
    archive: async () => {},
    move: async (id) => {
      throw new HermesRefusal('archive', `cannot archive ${id}: its summary is not written yet`);
    },
  }),
  agentId: () => null,
  api: () => hermesServer,
  profiles: () => [],
}));

const hermesServer = createHermesCardApi({
  warm: () => {},
  request: async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    // Hermes's path for the one card (`…/plugins/kanban/tasks/{id}`), nothing else.
    if (!route.endsWith(`/kanban/tasks/${hermesCard.id}`)) {
      throw new HermesRefusal(`${method} ${route}`, 'the e2e Hermes answers one card only');
    }
    if (method === 'PATCH') {
      const patch = (body ?? {}) as { title?: string; body?: string; priority?: number };
      if (patch.title !== undefined) hermesCard.title = patch.title.trim();
      if (patch.body !== undefined) hermesCard.body = patch.body;
      if (patch.priority !== undefined) hermesCard.priority = patch.priority;
    }
    return { task: hermesCard, comments: [] } as T;
  },
});

/**
 * Hermes's scheduler, scripted: the same in-memory jobs API the unit tests use, behind
 * the real client. Its zone is one no developer's browser is in, so journey 18 always meets
 * the refusal that names Hermes's zone and the button that adopts it.
 */
const hermesJobs = new FakeHermesApi();
registerHermesCron((app) => ({
  jobs: () =>
    createHermesJobs({
      baseUrl: 'http://hermes.e2e',
      apiKey: () => 'e2e',
      fetch: hermesJobs.fetch,
    }),
  agentId: (workspace) =>
    agentsServiceFor(app)
      .list({ id: workspace, slug: '', name: '', isDefault: false }, { kind: 'hermes' })
      .find((agent) => agent.slug === 'hermes')?.id ?? null,
  timezone: () => 'Pacific/Chatham',
  throttleMs: 0,
}));

const sessions = createSessionsModule({
  agents: { find: async (_workspace, agentId) => fakeHermes(agentId) },
  runner: new ScriptedRunner(),
  // The real wiring, not a stub: the journeys then prove that a finished run actually
  // reaches the inbox, which is the only claim worth making about notifications. The
  // scope resolver has to be the real one too — the derived one invents a local owner id,
  // and a notice written for a person who is not signed in is a notice nobody sees.
  scopes: principalScopeResolver,
  notifier: notifierPort,
  agentTimeoutMs: 30_000,
});
const app = await buildServer({
  config: loadConfig({
    DATA_DIR: dataDir,
    PORT: String(port),
    ...(setupMode ? {} : { HUB_ADMIN_PASSWORD: E2E_PASSWORD }),
  }),
  logger: createLogger({ level: 'warn' }),
  modules: defaultModules.map((module) => (module.name === 'sessions' ? sessions : module)),
  webDir: path.resolve(here, '..', 'dist'),
});

// Test-only control: drop every sessions socket, like a hub restart (journey 3).
app.post('/__e2e/drop-sockets', async () => {
  app.hub.io.of('/rt/sessions').disconnectSockets(true);
  return { ok: true };
});

await app.listen({ port, host: '127.0.0.1' });
console.log(
  `e2e hub listening on http://127.0.0.1:${port} (web: ${app.hub.web}, setup: ${setupMode})`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      rmSync(dataDir, { recursive: true, force: true });
      process.exit(0);
    });
  });
}
