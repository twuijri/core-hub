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
import { modules as defaultModules } from '../../server/src/modules/index.js';
import { overrideAgents } from '../../server/src/modules/agents/index.js';
import type { AgentInstaller } from '../../server/src/modules/agents/index.js';
import { createSessionsModule } from '../../server/src/modules/sessions/index.js';
import type {
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
}

/** A runner with real pauses, so a socket can be dropped mid-run and resumed. */
class ScriptedRunner implements AgentRunner {
  private readonly runs = new Map<string, Live>();

  async start(request: AgentRunRequest): Promise<AgentRunAccepted> {
    const text = request.prompt.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
    this.runs.set(request.runId, { queue: scriptFor(text), wake: null, closed: false });
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
      yield step;
    }
    if (live.closed) yield { type: 'completed' };
  }

  async send(runId: string, _input: AgentRunInput): Promise<void> {
    const live = this.runs.get(runId);
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

const sessions = createSessionsModule({
  agents: { find: async (_workspace, agentId) => fakeHermes(agentId) },
  runner: new ScriptedRunner(),
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
