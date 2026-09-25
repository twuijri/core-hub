// The e2e hub: the real server (auth, sessions, realtime, static web client) with a scripted
// agent runner in place of the adapters, so the smoke journeys run without a model.
// The script an agent plays is chosen by the text of the prompt (see `scriptFor`).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/src/app/config.js';
import { buildServer } from '../../server/src/app/server.js';
import { createLogger } from '../../server/src/lib/logger.js';
import {
  modules as defaultModules,
  notifierPort,
  profileTransferPorts,
} from '../../server/src/modules/index.js';
import { registerProfileTransfer } from '../../server/src/modules/auth/index.js';
import { fakeProfileRuntime } from '../../server/src/modules/auth/testing/fake-profile-runtime.js';
import { principalScopeResolver } from '../../server/src/modules/auth/index.js';
import { agentModelsPort, overrideAgents } from '../../server/src/modules/agents/index.js';
import { overrideModels } from '../../server/src/modules/models/index.js';
import type { AgentInstaller, HermesApiCall } from '../../server/src/modules/agents/index.js';
import { createSessionsModule } from '../../server/src/modules/sessions/index.js';
import { attachmentsPort } from '../../server/src/modules/knowledge/index.js';
import { SessionsStore } from '../../server/src/modules/sessions/store.js';
import { sessions as sessionRows } from '../../server/src/modules/sessions/schema.js';
import { requireSqlite } from '../../server/src/lib/db.js';
import { createHermesCardApi, registerHermesBoard } from '../../server/src/modules/tasks/index.js';
import { registerHermesCron } from '../../server/src/modules/schedules/index.js';
import { createHermesJobs } from '../../server/src/modules/schedules/hermes-jobs.js';
import { FakeHermesApi } from '../../server/src/modules/schedules/testing/fake-hermes-api.js';
import { fakeHermesPlugins } from '../../server/src/modules/agents/testing/fake-hermes-plugins.js';
import { agentsServiceFor } from '../../server/src/modules/agents/index.js';
import { HermesRefusal, type HermesTask } from '../../server/src/modules/tasks/hermes-kanban.js';
import type {
  AgentAskRequest,
  AgentCompressRequest,
  AgentCompressResult,
  AgentEvent,
  AgentRunAccepted,
  AgentRunInput,
  AgentRunRequest,
  AgentRunner,
  AgentSubagentControl,
  AgentSubagentSignal,
} from '../../server/src/modules/sessions/ports.js';
import { fakeHermes } from '../../server/src/modules/sessions/testing/fake-runner.js';
import { registerChannelSource } from '../../server/src/modules/sessions/index.js';
import { scriptedChannels } from '../../server/src/modules/sessions/testing/scripted-channels.js';
import { listWorkspacesFor } from '../../server/src/modules/auth/index.js';
import {
  loadOrCreateSigningKey,
  signAccessToken,
  verifyAccessToken,
} from '../../server/src/modules/auth/tokens.js';

export const E2E_PASSWORD = 'e2e-owner-password';

/** The hub this process built, once built: journey 34 asks its models module for a turn. */
let hubApp: Awaited<ReturnType<typeof buildServer>> | null = null;

type Step =
  | AgentEvent
  | { type: 'delay'; ms: number }
  | { type: 'await_input' }
  /** Write a file in the session's working folder, as an agent's tool would. */
  | { type: 'write'; path: string; content: string }
  // The real direct path (journey 34): the models module answers the turn, fallback chain and all.
  | { type: 'direct'; workspace: string; text: string }
  // A report about a subagent (§56): told to the hub on its own channel, not in the turn.
  | { type: 'subagent'; signal: AgentSubagentSignal }
  // Waits until the person stops this subagent (or `ms` passes, or the run is stopped).
  | { type: 'until_stopped'; id: string; ms: number };

/** The three files journey 32 writes, opens and reads back. */
const REPORT_HTML =
  '<!doctype html><html><body><h1 id="t">تقرير الربع</h1>' +
  '<script>document.getElementById("t").dataset.ran = "yes";</script></body></html>';
const DATA_CSV = 'البند,المبلغ\nإيجار,1200\nكهرباء,300\n';
const NOTES_MD = '# ملاحظات\n\n- راجع **الميزانية** قبل الخميس\n';

function writes(ref: string, file: string, content: string): Step[] {
  return [
    {
      type: 'tool_started',
      ref,
      name: 'write_file',
      kind: 'file_write',
      title: file,
      input: { path: file },
    },
    { type: 'delay', ms: 150 },
    { type: 'write', path: file, content },
    { type: 'tool_completed', ref, output: `wrote ${file}`, exitCode: 0 },
  ];
}

function scriptFor(prompt: string, workspace = ''): Step[] {
  if (/احتياطي|fallback/i.test(prompt)) {
    // Journey 34 (contract decision §54): the turn is the models module's own — the profile's
    // chat model, its fallback chain as the Defaults tab saved it, and the provider's HTTP
    // (the scripted proxy below, whose first model is down with `auth_unavailable`).
    return [{ type: 'direct', workspace, text: prompt }];
  }
  if (/راجع قائمة الإصدار/.test(prompt)) {
    // An agent step of a workflow drawn on the canvas (journey 32): a short answer the next
    // step reads as `{{steps.<id>.output}}`.
    return [
      { type: 'delay', ms: 400 },
      { type: 'message_delta', text: 'القائمة سليمة: ثلاثة بنود جاهزة.' },
      { type: 'completed' },
    ];
  }
  if (/ملخص الجدولة/.test(prompt)) {
    // A schedule's own run (journey 28): a short answer the history previews and the
    // conversation shows.
    return [
      { type: 'delay', ms: 600 },
      { type: 'message_delta', text: 'ملخص الجدولة: أُنجزت ثلاث مهام، ولا شيء عالق.' },
      { type: 'completed' },
    ];
  }
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
  if (/حتى أوقفك|until stopped/i.test(prompt)) {
    // Works until somebody stops it — by the Stop button, or by archiving its conversation
    // (zzz-chat-history): only an interrupt ends it.
    return [
      { type: 'message_delta', text: 'أعمل على ذلك… ' },
      { type: 'delay', ms: 180_000 },
      { type: 'message_delta', text: 'هذا الجزء لا يصل بعد الإيقاف.' },
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
  if (/اكتب الملفات|write the files/i.test(prompt)) {
    // Files beside the chat (journey 32, decision §48): three files written by a tool in the
    // session's folder, named in the reply so the words become links. `تحديث` writes the
    // report again, so an open tab has something to follow.
    const again = /تحديث/.test(prompt);
    return [
      { type: 'message_delta', text: 'أكتب الملفات الآن.\n\n' },
      ...writes(
        'w1',
        'report.html',
        again ? REPORT_HTML.replace('الربع', 'الربع المحدَّث') : REPORT_HTML,
      ),
      ...(again
        ? []
        : [...writes('w2', 'data.csv', DATA_CSV), ...writes('w3', 'notes.md', NOTES_MD)]),
      {
        type: 'message_delta',
        text: again ? 'حدّثت report.html.' : 'كتبت report.html و data.csv و `notes.md`.',
      },
      { type: 'completed' },
    ];
  }
  if (/عدّل المشروع|edit the project/i.test(prompt)) {
    // The files a run changed (journey 33, decision §49): after journey 32's three files, this
    // run edits two of them and creates a third — the card under the reply counts them.
    return [
      { type: 'message_delta', text: 'أعدّل الملفات.\n\n' },
      ...writes('e1', 'data.csv', DATA_CSV.replace('كهرباء,300', 'كهرباء,350')),
      ...writes('e2', 'notes.md', `${NOTES_MD}- أرسل التقرير\n`),
      ...writes('e3', 'plan.md', '# الخطة\n\n1. راجع الأرقام\n2. أرسل التقرير\n'),
      { type: 'message_delta', text: 'عدّلت data.csv و notes.md وكتبت plan.md.' },
      { type: 'completed' },
    ];
  }
  if (/وزّع العمل|delegate this/i.test(prompt)) {
    // The Subagents panel (journey 33): two subagents start, one calls a tool; the person
    // stops the first, and only then does the second finish and the run end — so the order
    // the journey sees is never a race with the script.
    return [
      { type: 'message_delta', text: 'سأوزّع العمل على وكيلين.' },
      {
        type: 'tool_started',
        ref: 'd1',
        name: 'delegate_task',
        kind: 'custom',
        title: 'delegate_task',
      },
      {
        type: 'subagent',
        signal: {
          phase: 'started',
          id: 'sa-0-tests',
          depth: 0,
          goal: 'راجع ملفات الاختبارات',
          model: 'hermes-4',
          toolCount: 0,
          acceptingSteer: true,
        },
      },
      {
        type: 'subagent',
        signal: {
          phase: 'started',
          id: 'sa-1-notes',
          depth: 0,
          goal: 'اكتب ملاحظات الإصدار',
          model: 'hermes-4',
          toolCount: 0,
          acceptingSteer: true,
        },
      },
      { type: 'delay', ms: 300 },
      {
        type: 'subagent',
        signal: {
          phase: 'tool',
          id: 'sa-0-tests',
          toolName: 'read_file',
          toolPreview: 'tests/status.test.ts',
          toolCount: 1,
        },
      },
      { type: 'until_stopped', id: 'sa-0-tests', ms: 60_000 },
      { type: 'delay', ms: 300 },
      {
        type: 'subagent',
        signal: {
          phase: 'completed',
          id: 'sa-1-notes',
          status: 'completed',
          summary: 'ملاحظات الإصدار جاهزة.',
          toolCount: 2,
        },
      },
      { type: 'tool_completed', ref: 'd1', output: 'done', exitCode: 0 },
      { type: 'message_delta', text: 'انتهى الوكيلان.' },
      { type: 'completed' },
    ];
  }
  if (/ارسم المسار|trace this/i.test(prompt)) {
    // The Trajectory tab (journey 31): a turn that reads a file, a command that fails, and
    // an answer — with pauses, so every step has a duration on the timeline.
    return [
      { type: 'reasoning_delta', text: 'أبدأ بقراءة الملف ثم أشغّل الاختبارات.' },
      { type: 'delay', ms: 200 },
      { type: 'message_delta', text: 'سأقرأ الملف أولًا.' },
      {
        type: 'tool_started',
        ref: 'r1',
        name: 'read_file',
        kind: 'file_read',
        title: 'README.md',
        input: { path: 'README.md' },
      },
      { type: 'delay', ms: 400 },
      { type: 'tool_completed', ref: 'r1', output: '# Core Hub\n', exitCode: 0 },
      { type: 'delay', ms: 150 },
      {
        type: 'tool_started',
        ref: 's1',
        name: 'shell',
        kind: 'shell',
        title: 'pnpm test',
        input: { command: 'pnpm test' },
      },
      { type: 'delay', ms: 600 },
      { type: 'tool_failed', ref: 's1', output: '2 failed, 118 passed', exitCode: 1 },
      { type: 'delay', ms: 150 },
      { type: 'message_delta', text: 'فشل اختباران من ١٢٠.' },
      { type: 'usage', inputTokens: 1200, outputTokens: 60, cacheReadTokens: 800 },
      { type: 'completed' },
    ];
  }
  if (/حمّل المهارة|load the skill/i.test(prompt)) {
    // Usage and Skills usage (journey 32, decision §50): the agent loads a skill the way
    // Hermes does — `skill_view` with the skill's name — then a linked file of it (the same
    // use), and reports its tokens with a cache read.
    return [
      {
        type: 'tool_started',
        ref: 'k1',
        name: 'skill_view',
        kind: 'custom',
        title: 'arxiv',
        input: { name: 'arxiv' },
      },
      { type: 'tool_completed', ref: 'k1', output: '{"success": true, "name": "arxiv"}' },
      {
        type: 'tool_started',
        ref: 'k2',
        name: 'skill_view',
        kind: 'custom',
        title: 'arxiv',
        input: { name: 'arxiv', file_path: 'references/api.md' },
      },
      { type: 'tool_completed', ref: 'k2', output: '{"success": true}' },
      { type: 'message_delta', text: 'وجدت ثلاث أوراق عن الموضوع.' },
      { type: 'usage', inputTokens: 3000, outputTokens: 400, cacheReadTokens: 1000 },
      { type: 'completed' },
    ];
  }
  if (/املأ السياق|fill the context/i.test(prompt)) {
    // A long conversation (journey 32): the agent reports a window three quarters full, as
    // Hermes does with every finished turn, so the meter has its count to show.
    return [
      { type: 'message_delta', text: 'قرأت كل الملفات؛ السياق ممتلئ تقريبًا.' },
      { type: 'context', usedTokens: 150_000, windowTokens: 200_000 },
      { type: 'usage', inputTokens: 149_000, outputTokens: 1_000 },
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
  /** The session's working folder, where `write` steps land. */
  workingDir: string | null;
  wake: (() => void) | null;
  closed: boolean;
  /** The last answer a person gave this run, for scripts that repeat it. */
  answer: string;
  /** The same answer as the agent's tool returns it: `''` for a skip, no "(Recommended)". */
  raw: string;
}

/**
 * One turn on the models module's direct path, as the `direct` agent makes it: the profile's
 * chat model, then its fallback chain (contract decision §54) — every step real but the
 * provider's HTTP, which is `scriptedProvider` below.
 */
async function* directTurn(workspace: string, text: string): AsyncIterable<AgentEvent> {
  const port = hubApp ? agentModelsPort(hubApp.hub.io) : null;
  const primary = port?.defaultModelFor(workspace, 'builtin', null) ?? null;
  if (!port || !primary) {
    yield { type: 'failed', code: 'provider_not_configured', message: 'no chat model is chosen' };
    return;
  }
  const fallbacks = (port.fallbackChain?.(workspace) ?? []).map((member) => ({
    providerId: member.providerId,
    model: member.model,
  }));
  for await (const event of port.directChat(workspace, {
    providerId: primary.provider_id,
    model: primary.model,
    messages: [{ role: 'user', text }],
    fallbacks,
  })) {
    if (event.type === 'delta') yield { type: 'message_delta', text: event.text };
    else if (event.type === 'fallback') {
      yield { type: 'model_fallback', failed: event.failed, answered: event.answered };
    } else if (event.type === 'usage') {
      yield {
        type: 'usage',
        modelLabel: event.modelLabel,
        providerId: event.providerId,
        ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
        ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
      };
    } else if (event.type === 'completed') yield { type: 'completed' };
    else if (event.type === 'failed')
      yield { type: 'failed', code: event.code, message: event.message };
  }
}

/** A runner with real pauses, so a socket can be dropped mid-run and resumed. */
class ScriptedRunner implements AgentRunner {
  private readonly runs = new Map<string, Live>();
  private readonly sessionOfRun = new Map<string, string>();
  private readonly listeners = new Set<(sessionId: string, signal: AgentSubagentSignal) => void>();
  /** `<session>:<subagent>` of the subagents a person stopped. */
  private readonly stopped = new Set<string>();

  onSubagent(listener: (sessionId: string, signal: AgentSubagentSignal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private report(sessionId: string, signal: AgentSubagentSignal): void {
    for (const listener of this.listeners) listener(sessionId, signal);
  }

  /** Hermes-like (`full`): a stop is confirmed at once, a note is queued, the tail is text. */
  subagents(sessionId: string): AgentSubagentControl {
    return {
      support: 'full',
      list: async () => [],
      interrupt: async (id) => {
        this.stopped.add(`${sessionId}:${id}`);
        this.report(sessionId, { phase: 'completed', id, status: 'interrupted', summary: null });
        return true;
      },
      steer: async () => 'queued',
      tail: async (id) => ({ available: true, text: `${id}: أعمل…`, truncated: false }),
    };
  }

  async start(request: AgentRunRequest): Promise<AgentRunAccepted> {
    this.sessionOfRun.set(request.runId, request.sessionId);
    const text = request.prompt.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    this.runs.set(request.runId, {
      queue: scriptFor(text, request.workspace),
      workingDir: request.workingDir,
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
      if (step.type === 'write') {
        if (live.workingDir) writeFileSync(path.join(live.workingDir, step.path), step.content);
        continue;
      }
      if (step.type === 'await_input') {
        await new Promise<void>((resolve) => {
          live.wake = resolve;
        });
        continue;
      }
      if (step.type === 'direct') {
        yield* directTurn(step.workspace, step.text);
        continue;
      }
      if (step.type === 'subagent') {
        const sessionId = this.sessionOfRun.get(runId);
        if (sessionId) this.report(sessionId, step.signal);
        continue;
      }
      if (step.type === 'until_stopped') {
        const sessionId = this.sessionOfRun.get(runId) ?? '';
        const until = Date.now() + step.ms;
        while (!live.closed && Date.now() < until && !this.stopped.has(`${sessionId}:${step.id}`)) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
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
   * `/compress` (journey 32, decision §57): long enough that the progress is seen, then the
   * window as a real Hermes reports it after compressing — much emptier.
   */
  async compress(request: AgentCompressRequest): Promise<AgentCompressResult> {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      agentSessionRef: request.agentSessionRef ?? `e2e-${request.sessionId}`,
      status: 'compressed',
      beforeTokens: 150_000,
      afterTokens: 24_000,
      beforeMessages: 40,
      afterMessages: 6,
      context: { usedTokens: 24_000, windowTokens: 200_000, estimated: false },
      message: 'Compressed: 40 → 6 messages',
    };
  }

  /** `/steer` into a running scripted turn: taken, as Hermes takes it. */
  async steer(): Promise<'queued' | 'rejected'> {
    return 'queued';
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
const port = Number(process.env.COREHUB_E2E_PORT ?? 8791);
// Journey 4 (first-run setup, ADR 0011) needs the opposite hub: no owner, no
// HUB_ADMIN_PASSWORD (set up in the open window, ADR 0019), and a data directory the test can
// check for the fallback claim token. Playwright
// starts that one as a second web server with COREHUB_E2E_MODE=setup and a data dir it names.
const setupMode = process.env.COREHUB_E2E_MODE === 'setup';
const namedDataDir = process.env.COREHUB_E2E_DATA_DIR;
const dataDir = namedDataDir ?? mkdtempSync(path.join(tmpdir(), 'corehub-e2e-'));
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
/**
 * Hermes's own API for the agent tools (ADR 0015), scripted: an MCP server called `broken`
 * fails in Hermes's words and any other lists two tools; a WhatsApp pairing hands out one
 * code, then a second, and is linked on the next question — so journey 23 sees a code drawn,
 * replaced, and the channel linked, without a phone or a network.
 */
let pairingPolls = 0;
/**
 * Hermes's pairing store, played on the files Hermes keeps it in (`platforms/pairing/` of the
 * profile) — so a Deny, which the hub makes on that file itself, is seen by the next list, as
 * it is with the real Hermes. Journey 30 starts with two senders waiting in `default`.
 */
const hermesHome = (profile: string) =>
  profile === 'default'
    ? path.join(dataDir, 'hermes')
    : path.join(dataDir, 'hermes', 'profiles', profile);
const PAIRING_PLATFORMS = ['whatsapp', 'telegram'] as const;
const pairingFile = (profile: string, kind: 'pending' | 'approved', platform = 'whatsapp') =>
  path.join(hermesHome(profile), 'platforms', 'pairing', `${platform}-${kind}.json`);
const readPairing = (profile: string, kind: 'pending' | 'approved', platform = 'whatsapp') => {
  const file = pairingFile(profile, kind, platform);
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>)
    : {};
};
const writePairing = (
  profile: string,
  kind: 'pending' | 'approved',
  value: Record<string, Record<string, unknown>>,
  platform = 'whatsapp',
) => {
  mkdirSync(path.dirname(pairingFile(profile, kind, platform)), { recursive: true });
  writeFileSync(pairingFile(profile, kind, platform), JSON.stringify(value));
};
function seedPairing(): void {
  const now = Date.now() / 1000;
  writePairing('default', 'pending', {
    '3f9a1c0e7b2d4a55': {
      hash: 'e2e',
      salt: 'e2e',
      user_id: '966500000001@s.whatsapp.net',
      user_name: 'سارة',
      created_at: now - 4 * 60,
    },
    '8c21d0f4a9e3b716': {
      hash: 'e2e',
      salt: 'e2e',
      user_id: '966500000002@s.whatsapp.net',
      user_name: '',
      created_at: now - 30,
    },
  });
}
const scriptedHermesApi: HermesApiCall = async <T>(
  method: string,
  route: string,
  body?: unknown,
): Promise<T> => {
  const answer = (value: unknown) => value as T;
  const url = new URL(route, 'http://hermes');
  if (method === 'GET' && url.pathname.endsWith('/pairing')) {
    const profile = url.searchParams.get('profile') ?? 'default';
    const now = Date.now() / 1000;
    return answer({
      pending: PAIRING_PLATFORMS.flatMap((platform) =>
        Object.entries(readPairing(profile, 'pending', platform)).map(([id, entry]) => ({
          platform,
          request_id: id,
          user_id: entry.user_id,
          user_name: entry.user_name,
          age_minutes: Math.floor((now - Number(entry.created_at)) / 60),
        })),
      ),
      approved: PAIRING_PLATFORMS.flatMap((platform) =>
        Object.entries(readPairing(profile, 'approved', platform)).map(([id, entry]) => ({
          platform,
          user_id: id,
          ...entry,
        })),
      ),
    });
  }
  if (url.pathname.endsWith('/pairing/approve')) {
    const {
      profile = 'default',
      request_id: id,
      platform = 'whatsapp',
    } = body as {
      profile?: string;
      request_id: string;
      platform?: string;
    };
    const pending = readPairing(profile, 'pending', platform);
    const entry = pending[id];
    if (!entry) throw new Error('Pairing request or code not found or expired');
    delete pending[id];
    writePairing(profile, 'pending', pending, platform);
    const approved = readPairing(profile, 'approved', platform);
    approved[String(entry.user_id)] = {
      user_name: entry.user_name,
      approved_at: Date.now() / 1000,
    };
    writePairing(profile, 'approved', approved, platform);
    return answer({ ok: true, user: { user_id: entry.user_id, user_name: entry.user_name } });
  }
  if (url.pathname.endsWith('/pairing/revoke')) {
    const {
      profile = 'default',
      user_id: user,
      platform = 'whatsapp',
    } = body as { profile?: string; user_id: string; platform?: string };
    const approved = readPairing(profile, 'approved', platform);
    delete approved[user];
    writePairing(profile, 'approved', approved, platform);
    return answer({ ok: true });
  }
  const mcp = /^\/api\/mcp\/servers\/([^/]+)\/test/.exec(route);
  if (mcp) {
    return mcp[1] === 'broken'
      ? answer({
          ok: false,
          error: "[Errno 2] No such file or directory: 'not-a-command'",
          tools: [],
        })
      : answer({
          ok: true,
          tools: [
            { name: 'read_file', description: 'Read a file from the allowed folders.' },
            { name: 'list_directory', description: 'List a folder.' },
          ],
        });
  }
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  if (route.endsWith('/whatsapp/onboarding/start')) {
    pairingPolls = 0;
    return answer({ pairing_id: 'e2e-pairing', status: 'installing', expires_at: expires });
  }
  if (method === 'GET' && route.includes('/whatsapp/onboarding/')) {
    pairingPolls += 1;
    if (pairingPolls < 4) {
      return answer({
        status: 'waiting',
        qr_payload: 'https://wa.me/e2e#first-code',
        expires_at: expires,
      });
    }
    if (pairingPolls < 8) {
      return answer({
        status: 'waiting',
        qr_payload: 'https://wa.me/e2e#second-code',
        expires_at: expires,
      });
    }
    // Linked: Hermes's bridge leaves the phone's session in the profile, and the channel is
    // read from it — the account the Channels page names afterwards.
    const session = path.join(hermesHome('default'), 'platforms', 'whatsapp', 'session');
    mkdirSync(session, { recursive: true });
    writeFileSync(
      path.join(session, 'creds.json'),
      JSON.stringify({ me: { id: '966500000000:4@s.whatsapp.net', name: 'مكتب المركز' } }),
    );
    if (pairingPolls === 8) seedPairing();
    return answer({
      status: 'connected',
      account_name: 'مكتب المركز',
      account_phone: '966500000000',
    });
  }
  if (method === 'PUT' && url.pathname.endsWith('/messaging/platforms/whatsapp')) {
    // What Hermes writes when the pairing is applied: the switch, in the profile's `.env`.
    const home = hermesHome(url.searchParams.get('profile') ?? 'default');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, '.env'), 'WHATSAPP_ENABLED=true\nWHATSAPP_MODE=bot\n');
    return answer({ ok: true });
  }
  return answer({ ok: true });
};

/**
 * Hermes's own `hermes plugins` command, played in memory (journey 28): Hermes ships `disk-cleanup` and
 * `security-guidance`, its catalog has `chrome-profiles`, and an install takes long enough that the
 * page is seen waiting on it.
 */
const scriptedPlugins = fakeHermesPlugins({ installDelayMs: 1500 });

/**
 * Telegram's Bot API as linking asks it (journey 31), scripted: one token belongs to the bot
 * @corehub_e2e_bot, any other is refused as Telegram refuses it. The moment the bot is asked
 * about, a stranger has "messaged" it in the default profile — Hermes's pairing file gets the
 * request the journey then approves — so no phone and no network are involved.
 */
const E2E_TELEGRAM_TOKEN = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const scriptedTelegram: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (url.endsWith(`/bot${E2E_TELEGRAM_TOKEN}/getMe`)) {
    writePairing(
      'default',
      'pending',
      {
        '5d1e2f3a4b5c6d7e': {
          hash: 'e2e',
          salt: 'e2e',
          user_id: '555666777',
          user_name: 'Noura',
          created_at: Date.now() / 1000 - 60,
        },
      },
      'telegram',
    );
    return json(200, {
      ok: true,
      result: {
        id: 7012345678,
        is_bot: true,
        first_name: 'مساعد المركز',
        username: 'corehub_e2e_bot',
      },
    });
  }
  return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
};

/**
 * Discord's API as linking asks it (journey 41), scripted: one token belongs to the bot
 * @corehub_discord, any other is refused as Discord refuses it (`401: Unauthorized`).
 */
const E2E_DISCORD_TOKEN = 'fake-discord-token-for-e2e-only-000000000000000000000000000000001';
const scriptedPlatforms: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const auth = new Headers(init?.headers).get('authorization');
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  // Discord's `users/@me`, the one question linking asks it.
  if (
    url.startsWith('https://discord.com/') &&
    url.endsWith('@me') &&
    auth === `Bot ${E2E_DISCORD_TOKEN}`
  ) {
    return json(200, {
      id: '1234567890123456789',
      username: 'corehub_discord',
      global_name: 'مساعد ديسكورد',
      bot: true,
    });
  }
  return json(401, { message: '401: Unauthorized', code: 0 });
};

overrideAgents({
  pathValue: path.join(dataDir, 'no-such-bin'),
  installer: e2eInstaller,
  adapterOptions: { hermes: { fetchImpl: scriptedGateway } },
  hermesApi: scriptedHermesApi,
  hermesCli: scriptedPlugins.cli,
  pairingPollMs: 700,
  telegramFetch: scriptedTelegram,
  channelProbe: { fetchImpl: scriptedPlatforms },
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
/**
 * The owner's proxy on 2026-09-25 (journey 34): its first model is down with
 * `503 auth_unavailable`, the second answers.
 */
export const E2E_PROXY_URL = 'http://proxy.e2e/v1';
const proxyAnswer = 'أجاب النموذج الاحتياطي بدل النموذج المعطّل.';
function scriptedProxy(url: string, init: RequestInit | undefined): Response {
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (url.endsWith('/models')) {
    return json(200, { data: [{ id: 'gemini-3.8-flash-high' }, { id: 'gpt-backup' }] });
  }
  const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
  if (body.model === 'gemini-3.8-flash-high') {
    return json(503, {
      error: {
        message:
          'auth_unavailable: no auth available (providers=antigravity, model=gemini-3.8-flash-high)',
      },
    });
  }
  const frames = [
    { choices: [{ delta: { content: proxyAnswer } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 14, completion_tokens: 9 } },
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const scriptedProvider: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(E2E_PROXY_URL)) return scriptedProxy(url, init);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  if (url.endsWith('/models')) return json({ data: bigCatalogue });
  // Speech (journey 32, DECISIONS §63): a scripted Whisper that hears one sentence, and a
  // voice that answers with a tenth of a second of real silence the browser can play.
  if (url.endsWith('/audio/transcriptions')) return json({ text: 'لخّص اجتماع اليوم' });
  if (url.endsWith('/audio/speech')) {
    return new Response(silentWav(), { status: 200, headers: { 'content-type': 'audio/wav' } });
  }
  return json({ ok: true });
};

/** A playable WAV: 16-bit mono PCM at 8 kHz, a tenth of a second of silence. */
function silentWav(): ArrayBuffer {
  const samples = 800;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}
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

/**
 * Hermes's profile archives, scripted (ADR 0014 stage 2): an export is the archive Hermes
 * would write — with a `.env` inside, so the journey sees the hub leave it out — and an
 * import makes the profile. Everything after Hermes is the real hub: the job, the check of
 * the archive, the file kept for its requester, the new workspace.
 */
const profileArchives = fakeProfileRuntime((profile) => [
  { path: 'SOUL.md', content: `The ${profile} profile, exported for the e2e journey.\n` },
  { path: 'memories/MEMORY.md', content: 'Remembers teal. يتذكّر الأزرق المخضر.\n' },
  { path: '.env', content: 'OPENAI_API_KEY=sk-e2e-never-leaves-0123456789\n' },
]);
registerProfileTransfer((app) => profileTransferPorts(app, profileArchives.runtime));

/**
 * Hermes's channel conversations, scripted (contract decision §61): one Telegram conversation
 * in the default profile, as Hermes's server would list it. Off until a journey turns it on
 * (`/__e2e/channels`) — every other journey sees a hub with no Hermes to read, as before, so
 * their lists and screenshots do not change.
 */
let channelsOn = false;
const E2E_T0 = Date.parse('2026-09-25T09:15:00Z') / 1000;
const hermesChannels = scriptedChannels(
  {
    default: {
      sessions: [
        {
          id: '20260925_091500_e2e0tg01',
          source: 'telegram',
          user_id: '5550001',
          chat_id: '5550001',
          chat_type: 'dm',
          display_name: 'أحمد من تيليجرام',
          title: null,
          message_count: 2,
          started_at: E2E_T0,
          last_active: E2E_T0 + 300,
          preview: 'متى موعد التسليم؟',
        },
      ],
      messages: {
        '20260925_091500_e2e0tg01': [
          { id: 1, role: 'user', content: 'متى موعد التسليم؟', timestamp: E2E_T0 },
          {
            id: 2,
            role: 'assistant',
            content: 'موعد التسليم **يوم الخميس**، وسأذكّرك قبله بيوم.',
            timestamp: E2E_T0 + 300,
          },
        ],
      },
    },
  },
  {
    // The hub's default workspace is Hermes's `default` profile (ADR 0014). `app` is the hub
    // built below; nothing asks before it exists.
    profileOf: (workspace) =>
      listWorkspacesFor(requireSqlite(app.hub.database), { id: '', role: 'owner' }).some(
        (row) => row.id === workspace && row.isDefault,
      )
        ? 'default'
        : null,
  },
);
registerChannelSource(() => (channelsOn ? hermesChannels : null));

const sessions = createSessionsModule({
  agents: { find: async (_workspace, agentId) => fakeHermes(agentId) },
  runner: new ScriptedRunner(),
  // The real file store, as the composition root wires it: a chat's attachments, and the
  // transcript "Continue in Core Hub" keeps (§62).
  attachments: attachmentsPort,
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

// Test-only control: a real git repository in the default profile's folder (tasks stage 2).
// Made when the worktree journey asks, not at boot, so no other journey sees the folder.
app.post('/__e2e/git-repo', async () => {
  const repo = path.join(dataDir, 'workspaces', 'default', 'e2e-repo');
  if (!existsSync(path.join(repo, '.git'))) {
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
        cwd: repo,
        stdio: 'ignore',
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'README.md'), '# e2e\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'first');
  }
  return { path: repo };
});

// Test-only control: drop every sessions socket, like a hub restart (journey 3).
// Test-only control: Hermes's scripted channel conversations on or off (journey 33).
app.post('/__e2e/channels', async (request) => {
  channelsOn = (request.body as { on?: boolean } | null)?.on === true;
  return { ok: true, on: channelsOn };
});

app.post('/__e2e/drop-sockets', async () => {
  app.hub.io.of('/rt/sessions').disconnectSockets(true);
  return { ok: true };
});

// Test-only control: a long history for a conversation that already exists — the texts are
// appended in order, alternating the person and the agent, straight into the store (as if
// written over months), so the chat has more than one page to scroll back through.
app.post('/__e2e/seed-messages', async (request) => {
  const { session_id, texts } = request.body as { session_id: string; texts: string[] };
  const db = requireSqlite(app.hub.database);
  const row = db
    .select()
    .from(sessionRows)
    .all()
    .find((each) => each.id === session_id);
  if (!row) return { ok: false };
  const store = new SessionsStore(db);
  texts.forEach((text, index) => {
    const user = index % 2 === 0;
    store.appendMessage({
      workspace: row.workspace,
      ownerId: row.ownerId,
      sessionId: row.id,
      runId: null,
      role: user ? 'user' : 'assistant',
      authorKind: user ? 'user' : 'agent',
      authorId: user ? row.ownerId : row.agentId,
      content: text,
      parts: [],
      attachmentIds: [],
    });
  });
  return { ok: true, count: texts.length };
});

// Test-only control: the same access token, already expired — what a laptop that slept
// past the token's lifetime wakes up holding (zzz-realtime-token).
app.post('/__e2e/expire-token', async (request) => {
  const { token } = request.body as { token: string };
  const key = loadOrCreateSigningKey(dataDir);
  const claims = await verifyAccessToken(key, token, Date.now());
  const expired = await signAccessToken(
    key,
    { userId: claims.sub, role: claims.role, sessionId: claims.sid },
    Date.now() - 60 * 60_000,
    60,
  );
  return { token: expired };
});

// Test-only control: lines in the hub's log rings, as the hub and a profile's Hermes gateway
// would have written them (zzzzzz-perf-logs) — the e2e hub runs no Hermes to write its own.
app.post('/__e2e/seed-logs', async (request) => {
  const { lines } = request.body as {
    lines: Array<{
      level: 'error' | 'warn' | 'info' | 'debug';
      source: 'hub' | 'hermes';
      profile?: string;
      message: string;
    }>;
  };
  for (const line of lines) app.hub.logs.push(line);
  return { ok: true, count: lines.length };
});

hubApp = app;
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
