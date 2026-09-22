/**
 * The `builtin` adapter: the hub's own agent (ADOPTION-BACKLOG §2.15).
 *
 * Two things are being pinned here. First, the turn: the events an
 * `AgentSession` emits, in order, including a cancel and every way a provider can
 * refuse. Second, the attachments, which are the only place this adapter can quietly
 * lose something — there is no file tool to point at a path with, so a file either goes
 * into the request or the turn is refused by name.
 *
 * The provider itself is scripted through the `models` port, which is exactly the seam
 * the real wiring uses. `models/adapters/chat.test.ts` scripts the HTTP below it.
 */
import { describe, expect, it } from 'vitest';
import type { DirectChatEvent, DirectChatMessage, DirectModelFacts } from '../ports.js';
import {
  AttachmentRefused,
  MAX_TEXT_BYTES,
  buildPrompt,
  createDirectAdapter,
  type DirectModelsPort,
} from './direct.js';
import type { AgentEvent, AgentSession, AgentTarget, PromptBlock } from './types.js';

// ------------------------------------------------------------------- the scripted port

interface PortOptions {
  script?: DirectChatEvent[];
  facts?: DirectModelFacts | null;
  /** Emitted one at a time, waiting on this between frames, so a cancel can land. */
  gapMs?: number;
}

interface ScriptedPort extends DirectModelsPort {
  readonly turns: { messages: DirectChatMessage[]; model: string; providerId: string }[];
  play(script: DirectChatEvent[]): void;
}

function scriptedPort(options: PortOptions = {}): ScriptedPort {
  let script = options.script ?? [{ type: 'completed' as const }];
  const turns: ScriptedPort['turns'] = [];
  return {
    turns,
    play(next) {
      script = next;
    },
    modelFacts: () =>
      options.facts === undefined
        ? {
            providerSlug: 'openai',
            providerLabel: 'OpenAI',
            modelLabel: 'gpt-test',
            vision: false,
            maxOutputTokens: null,
          }
        : options.facts,
    async *directChat(_workspace, request) {
      turns.push({
        messages: request.messages.map((message) => ({ ...message })),
        model: request.model,
        providerId: request.providerId,
      });
      for (const event of script) {
        if (options.gapMs) await new Promise((resolve) => setTimeout(resolve, options.gapMs));
        if (request.signal?.aborted) {
          yield { type: 'failed', code: 'cancelled', message: 'aborted' };
          return;
        }
        yield event;
      }
    },
  };
}

const TARGET: AgentTarget = {
  slug: 'direct',
  name: 'Direct',
  command: [],
  executablePath: null,
  endpoint: null,
  workspace: 'ws-1',
  sessionRef: 'direct-s1',
  model: 'gpt-test',
  modelProviderId: 'prov-1',
};

async function openSession(
  port: DirectModelsPort,
  target: Partial<AgentTarget> = {},
  readFile?: (path: string) => Promise<Uint8Array>,
): Promise<AgentSession> {
  const adapter = createDirectAdapter({
    models: () => port,
    ...(readFile ? { readFile } : {}),
  });
  return adapter.start({ ...TARGET, ...target });
}

/** Everything the session emits for one turn, up to and including its terminal event. */
async function turn(
  session: AgentSession,
  prompt: Parameters<AgentSession['send']>[0],
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const reading = (async () => {
    for await (const event of session.stream()) {
      events.push(event);
      if (event.type === 'run.completed' || event.type === 'run.failed') break;
    }
  })();
  await session.send(prompt);
  await reading;
  return events;
}

// ------------------------------------------------------------------------- the adapter

describe('the direct adapter', () => {
  it('is always installed, runs no tools, and needs nothing on the host', async () => {
    const adapter = createDirectAdapter({ models: () => scriptedPort() });
    expect(adapter.kind).toBe('builtin');
    expect(adapter.selectable).toBe(true);
    // Backlog §2.16: no tools, no approvals, no MCP, no skills on this path yet.
    expect(adapter.capabilities()).toEqual(['streaming', 'vision', 'resume']);
    expect(await adapter.discover()).toEqual([]);
    const probe = await adapter.probe(TARGET);
    expect(probe).toMatchObject({ installed: true, source: 'builtin', error: null });
    expect(probe.runtime.state).toBe('not_applicable');
  });

  it('never carries an install error, because there is no install to go wrong', async () => {
    // Owner decision, 2026-09-22: a bundled agent's card must not show a red line. A probe
    // that ran before the models module mounted used to leave one there for ever; whether
    // a provider is configured is answered by the turn, out loud, at the moment it runs
    // (see "refuses out loud when the hub has no provider store at all" below).
    const adapter = createDirectAdapter({ models: () => null });
    const probe = await adapter.probe(TARGET);
    expect(probe.error).toBeNull();
    expect(probe.installed).toBe(true);
  });
});

describe('a direct turn', () => {
  it('streams deltas, reports usage and completes', async () => {
    const port = scriptedPort({
      script: [
        { type: 'delta', text: 'Hel' },
        { type: 'delta', text: 'lo' },
        {
          type: 'usage',
          modelLabel: 'gpt-test',
          providerId: 'prov-1',
          inputTokens: 7,
          outputTokens: 2,
          costMicroUsd: 42,
          costSource: 'estimated',
        },
        { type: 'completed' },
      ],
    });
    const session = await openSession(port);
    const events = await turn(session, { text: 'hi', blocks: [{ type: 'text', text: 'hi' }] });

    expect(events.map((event) => event.type)).toEqual([
      'message.delta',
      'message.delta',
      'usage',
      'run.completed',
    ]);
    expect(events[2]).toMatchObject({ modelLabel: 'gpt-test', inputTokens: 7, outputTokens: 2 });
    expect(port.turns[0]).toMatchObject({ model: 'gpt-test', providerId: 'prov-1' });
  });

  it('remembers the conversation, so the second turn carries the first', async () => {
    const port = scriptedPort({
      script: [{ type: 'delta', text: 'Marrakesh' }, { type: 'completed' }],
    });
    const session = await openSession(port, { settings: { system_prompt: 'be terse' } });
    await turn(session, { text: 'name a city', blocks: [{ type: 'text', text: 'name a city' }] });
    await turn(session, { text: 'and another', blocks: [{ type: 'text', text: 'and another' }] });

    expect(port.turns[1]?.messages).toEqual([
      { role: 'system', text: 'be terse' },
      { role: 'user', text: 'name a city' },
      { role: 'assistant', text: 'Marrakesh' },
      { role: 'user', text: 'and another' },
    ]);
  });

  it('does not keep a question the provider refused in the history', async () => {
    const port = scriptedPort({
      script: [{ type: 'failed', code: 'rate_limited', message: 'slow down' }],
    });
    const session = await openSession(port);
    await turn(session, { text: 'first', blocks: [{ type: 'text', text: 'first' }] });
    port.play([{ type: 'completed' }]);
    await turn(session, { text: 'second', blocks: [{ type: 'text', text: 'second' }] });

    expect(port.turns[1]?.messages).toEqual([{ role: 'user', text: 'second' }]);
  });

  it('ends as an interrupted run when the hub cancels mid-stream', async () => {
    const port = scriptedPort({
      gapMs: 5,
      script: [
        ...Array.from({ length: 40 }, (_, index) => ({
          type: 'delta' as const,
          text: `${index} `,
        })),
        { type: 'completed' as const },
      ],
    });
    const session = await openSession(port);
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (events.length === 3) await session.interrupt();
        if (event.type === 'run.completed' || event.type === 'run.failed') break;
      }
    })();
    const outcome = await session.send({
      text: 'count',
      blocks: [{ type: 'text', text: 'count' }],
    });
    await reading;

    expect(outcome.stopReason).toBe('cancelled');
    // Not a failure: the hub asked for it, and the run state machine has a state for it.
    expect(events.at(-1)).toEqual({
      type: 'run.completed',
      stopReason: 'cancelled',
      interrupted: true,
    });
    expect(events.filter((event) => event.type === 'message.delta').length).toBeLessThan(40);
  });

  it('passes the provider’s code and its own sentence straight through', async () => {
    const cases: Array<[string, string]> = [
      ['provider_unauthorized', 'Incorrect API key provided'],
      ['rate_limited', 'Rate limit reached for gpt-test'],
      ['not_found', 'The model `nope` does not exist'],
      ['agent_unavailable', 'connect ECONNREFUSED'],
    ];
    for (const [code, message] of cases) {
      const port = scriptedPort({ script: [{ type: 'failed', code, message }] });
      const session = await openSession(port);
      const events = await turn(session, { text: 'x', blocks: [{ type: 'text', text: 'x' }] });
      expect(events.at(-1)).toEqual({ type: 'run.failed', error: message, code });
    }
  });

  it('refuses out loud when nothing is chosen to run on', async () => {
    const session = await openSession(scriptedPort(), { model: null, modelProviderId: null });
    const events = await turn(session, { text: 'x', blocks: [{ type: 'text', text: 'x' }] });
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      code: 'provider_not_configured',
    });
    expect((events.at(-1) as { error: string }).error).toMatch(/no model is chosen/);
  });

  it('refuses out loud when the hub has no provider store at all', async () => {
    const adapter = createDirectAdapter({ models: () => null });
    const session = await adapter.start(TARGET);
    const events = await turn(session, { text: 'x', blocks: [{ type: 'text', text: 'x' }] });
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      code: 'provider_not_configured',
    });
  });

  it('never asks for an approval: there are no tools on this path (§2.16)', async () => {
    const session = await openSession(scriptedPort());
    await expect(session.respond()).rejects.toMatchObject({ code: 'not_implemented' });
  });
});

// ---------------------------------------------------------------------- attachments

const textBlock = (over: Partial<Extract<PromptBlock, { type: 'attachment' }>> = {}) =>
  ({
    type: 'attachment',
    attachmentId: 'att-1',
    kind: 'file',
    name: 'notes.md',
    mime: 'text/markdown',
    sizeBytes: 12,
    path: '/run/in/notes.md',
    ...over,
  }) as PromptBlock;

const reads = (bytes: Uint8Array) => () => Promise.resolve(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe('attachments on the direct path', () => {
  const facts = {
    providerSlug: 'openai',
    providerLabel: 'OpenAI',
    modelLabel: 'gpt-test',
    vision: false,
    maxOutputTokens: null,
  };

  it('inlines a text-like file into the prompt, named', async () => {
    const built = await buildPrompt([{ type: 'text', text: 'summarise this' }, textBlock()], {
      vision: false,
      modelLabel: 'gpt-test',
      readFile: reads(utf8('# Title\nbody')),
    });
    expect(built.images).toEqual([]);
    expect(built.text).toBe(
      'summarise this\n\n--- notes.md ---\n# Title\nbody\n--- end of notes.md ---',
    );
  });

  it('treats a file the browser could not type as text when its extension says so', async () => {
    const built = await buildPrompt(
      [textBlock({ name: 'query.sql', mime: 'application/octet-stream' })],
      { vision: false, modelLabel: 'gpt-test', readFile: reads(utf8('select 1')) },
    );
    expect(built.text).toContain('select 1');
  });

  it('sends an image to a model that accepts images', async () => {
    const built = await buildPrompt(
      [textBlock({ name: 'shot.png', mime: 'image/png', kind: 'image' })],
      { vision: true, modelLabel: 'gpt-vision', readFile: reads(new Uint8Array([1, 2, 3])) },
    );
    expect(built.images).toEqual([
      {
        mime: 'image/png',
        dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
        name: 'shot.png',
      },
    ]);
  });

  it('refuses an image when the chosen model cannot see, and names the model', async () => {
    await expect(
      buildPrompt([textBlock({ name: 'shot.png', mime: 'image/png', kind: 'image' })], {
        vision: false,
        modelLabel: 'gpt-test',
        readFile: reads(new Uint8Array([1])),
      }),
    ).rejects.toMatchObject({ code: 'unsupported_media_type' });
  });

  it('refuses anything that is neither text nor an image, and says why', async () => {
    const refusal = await buildPrompt(
      [textBlock({ name: 'report.pdf', mime: 'application/pdf' })],
      { vision: true, modelLabel: 'gpt-vision', readFile: reads(new Uint8Array([1])) },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AttachmentRefused);
    expect((refusal as AttachmentRefused).code).toBe('unsupported_media_type');
    expect((refusal as Error).message).toContain('report.pdf');
    expect((refusal as Error).message).toContain('application/pdf');
  });

  it('refuses a text file over the stated size instead of truncating it', async () => {
    const refusal = await buildPrompt([textBlock()], {
      vision: false,
      modelLabel: 'gpt-test',
      readFile: reads(utf8('x'.repeat(MAX_TEXT_BYTES + 1))),
    }).catch((error: unknown) => error);
    expect((refusal as AttachmentRefused).code).toBe('payload_too_large');
    expect((refusal as Error).message).toContain(String(MAX_TEXT_BYTES));
  });

  it('refuses a file the hub could not write to disk rather than pretending it went', async () => {
    await expect(
      buildPrompt([textBlock({ path: undefined })], {
        vision: false,
        modelLabel: 'gpt-test',
        readFile: reads(utf8('x')),
      }),
    ).rejects.toMatchObject({ code: 'agent_error' });
  });

  it('fails the run with the refusal, and sends nothing to the provider', async () => {
    const port = scriptedPort({ facts });
    const session = await openSession(port, {}, reads(new Uint8Array([1])));
    const events = await turn(session, {
      text: 'look',
      blocks: [
        { type: 'text', text: 'look' },
        textBlock({ name: 'shot.png', mime: 'image/png', kind: 'image' }),
      ],
    });
    expect(events).toEqual([
      {
        type: 'run.failed',
        code: 'unsupported_media_type',
        error: expect.stringContaining('shot.png') as unknown as string,
      },
    ]);
    expect(port.turns).toEqual([]);
  });
});
