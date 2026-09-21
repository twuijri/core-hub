// The e2e hub: the real server (auth, sessions, realtime, static web client) with a scripted
// agent runner in place of the adapters, so the three smoke journeys run without a model.
// The script an agent plays is chosen by the text of the prompt (see `scriptFor`).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/src/app/config.js';
import { buildServer } from '../../server/src/app/server.js';
import { createLogger } from '../../server/src/lib/logger.js';
import { modules as defaultModules } from '../../server/src/modules/index.js';
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
  if (/slow|بطيء/i.test(prompt)) {
    return [
      { type: 'message_delta', text: 'الجزء الأول من الرد. ' },
      { type: 'delay', ms: 2500 },
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
        await new Promise((resolve) => setTimeout(resolve, step.ms));
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
const dataDir = mkdtempSync(path.join(tmpdir(), 'majlis-e2e-'));
// The registry (agents.list) is the real module seeded from the catalog; the sessions module
// asks this directory whether an agent can take a turn — every catalog id plays the script.
const sessions = createSessionsModule({
  agents: { find: async (_workspace, agentId) => fakeHermes(agentId) },
  runner: new ScriptedRunner(),
  agentTimeoutMs: 30_000,
});
const app = await buildServer({
  config: loadConfig({ DATA_DIR: dataDir, PORT: String(port), HUB_ADMIN_PASSWORD: E2E_PASSWORD }),
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
console.log(`e2e hub listening on http://127.0.0.1:${port} (web: ${app.hub.web})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      rmSync(dataDir, { recursive: true, force: true });
      process.exit(0);
    });
  });
}
