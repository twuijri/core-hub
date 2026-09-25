/**
 * The subagent book (contract decision §47), with no agent and no socket: reports in, records
 * and events out. Every event is checked against its schema in `packages/contracts/events`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { memoryDb } from '../../../tests/unit/helpers.js';
import type { AgentSubagentControl } from './ports.js';
import type { SessionsRealtime } from './realtime.js';
import { SessionsStore } from './store.js';
import { KEPT_TOOLS, SubagentBook } from './subagents.js';

const eventsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../contracts/events/sessions',
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as FormatsPlugin;
addFormats(ajv);

function envelopeErrors(event: string, payload: unknown): string[] {
  const schema = JSON.parse(readFileSync(path.join(eventsDir, `${event}.schema.json`), 'utf8'));
  delete schema.$id;
  const validate = ajv.compile(schema);
  const envelope = {
    event,
    namespace: '/rt/sessions',
    profile: 'work',
    ts: '2026-09-25T10:00:00Z',
    seq: 1,
    payload,
  };
  return validate(envelope)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

const WORKSPACE = '01J8QK3ZR2W7M5N4P6T8V9X0WS';
const OWNER = '01J8QK3ZR2W7M5N4P6T8V9X0HM';

function setup(control: AgentSubagentControl | null = null) {
  const store = new SessionsStore(memoryDb());
  const session = store.createSession({
    workspace: WORKSPACE,
    ownerId: OWNER,
    agentId: '01J8QK3ZR2W7M5N4P6T8V9X0AG',
    title: 'x',
    source: 'chat',
    modelLabel: null,
    provider: null,
    reasoningEffort: null,
    workingDir: null,
    categoryId: null,
    parentSessionId: null,
  });
  const emitted: Array<{ profile: string; event: string; payload: unknown }> = [];
  const realtime = {
    emitToProfileFor(profile: string, _sessionId: string, event: string, payload: unknown) {
      emitted.push({ profile, event, payload });
      return {} as never;
    },
  } as unknown as SessionsRealtime;
  let clock = Date.parse('2026-09-25T10:00:00Z');
  const book = new SubagentBook({
    store,
    realtime,
    activeRunOf: () => '01J8QK3ZR2W7M5N4P6T8V9X0RN',
    control: () => control,
    now: () => (clock += 1000),
  });
  book.remember(session.id, { workspace: WORKSPACE, profile: 'work', ownerId: OWNER });
  return { store, book, emitted, sessionId: session.id };
}

describe('the subagent book (§47)', () => {
  it('folds reports into one record each and announces every change in the contract shape', () => {
    const { book, emitted, sessionId } = setup();
    book.onSignal(sessionId, {
      phase: 'started',
      id: 'a',
      goal: 'g',
      toolCount: 0,
      acceptingSteer: true,
    });
    book.onSignal(sessionId, { phase: 'tool', id: 'a', toolName: 'read_file', toolPreview: 'x' });
    book.onSignal(sessionId, { phase: 'tool', id: 'a', toolName: 'terminal' });
    book.onSignal(sessionId, { phase: 'completed', id: 'a', status: 'failed', summary: 'boom' });
    expect(emitted.map((e) => e.event)).toEqual([
      'subagent.started',
      'subagent.updated',
      'subagent.updated',
      'subagent.completed',
    ]);
    for (const { event, payload } of emitted) expect(envelopeErrors(event, payload)).toEqual([]);
    expect(emitted.every((e) => e.profile === 'work')).toBe(true);
    const [record] = book.list(WORKSPACE, sessionId);
    expect(record).toMatchObject({
      id: 'a',
      status: 'failed',
      toolCount: 2,
      lastTool: 'terminal',
      summary: 'boom',
      acceptingSteer: false,
      runId: '01J8QK3ZR2W7M5N4P6T8V9X0RN',
    });
    expect(record!.finishedAt! - record!.startedAt).toBe(3000);
  });

  it('keeps the conversation’s subagents on it, and reads one a restart cut short as interrupted', () => {
    const { store, book, sessionId } = setup();
    book.onSignal(sessionId, { phase: 'started', id: 'live', goal: 'still going' });
    book.onSignal(sessionId, { phase: 'started', id: 'done', goal: 'finished' });
    book.onSignal(sessionId, { phase: 'completed', id: 'done', status: 'completed' });
    // A new process: nothing live, only what the conversation kept.
    const after = new SubagentBook({
      store,
      realtime: {} as SessionsRealtime,
      activeRunOf: () => null,
      control: () => null,
    });
    expect(after.list(WORKSPACE, sessionId).map((r) => [r.id, r.status])).toEqual([
      ['done', 'completed'],
      ['live', 'interrupted'],
    ]);
    expect(() => after.get(WORKSPACE, sessionId, 'nope')).toThrow();
  });

  it('keeps the last tools only, and ignores a conversation it never ran', () => {
    const { book, emitted, sessionId } = setup();
    book.onSignal(sessionId, { phase: 'started', id: 'a', goal: 'g' });
    for (let i = 0; i < KEPT_TOOLS + 5; i += 1) {
      book.onSignal(sessionId, { phase: 'tool', id: 'a', toolName: `t${i}` });
    }
    const [record] = book.list(WORKSPACE, sessionId);
    expect(record!.tools).toHaveLength(KEPT_TOOLS);
    expect(record!.tools[0]!.name).toBe('t5');
    expect(record!.toolCount).toBe(KEPT_TOOLS + 5);
    const before = emitted.length;
    book.onSignal('01J8QK3ZR2W7M5N4P6T8V9X0ZZ', { phase: 'started', id: 'x', goal: 'g' });
    expect(emitted).toHaveLength(before);
  });

  it('closes one the agent no longer knows when asked to stop it', async () => {
    const { book, sessionId } = setup({
      support: 'full',
      interrupt: async () => false,
    });
    book.onSignal(sessionId, { phase: 'started', id: 'a', goal: 'g', acceptingSteer: true });
    const record = await book.interrupt(WORKSPACE, sessionId, 'a');
    expect(record.status).toBe('interrupted');
    expect(book.runningFor(OWNER, new Set([WORKSPACE]))).toEqual([]);
    expect(book.finishedFor(OWNER, new Set([WORKSPACE]), 0).map((f) => f.record.id)).toEqual(['a']);
    expect(book.finishedFor('someone-else', new Set([WORKSPACE]), 0)).toEqual([]);
  });
});
