import { describe, expect, it } from 'vitest';
import { answerFor, sameApp } from '../src/screen-consent.js';
import {
  dshCommand,
  emptyFold,
  foldEvent,
  parseScreenRequest,
  screenPatch,
  screenProfileManifest,
  screenPrompt,
} from '../src/screen.js';

describe('screen requests', () => {
  it('validates and bounds the request', () => {
    expect(parseScreenRequest({})).toMatchObject({ ok: false });
    expect(
      parseScreenRequest({ task: '  open Notes ', app: 'Notes', time_budget_s: 99999, model: 'm' }),
    ).toEqual({
      ok: true,
      request: { task: 'open Notes', app: 'Notes', timeBudgetS: 3600, model: 'm' },
    });
    expect(parseScreenRequest({ task: 'x', time_budget_s: -1 })).toMatchObject({
      request: { timeBudgetS: 300, app: null },
    });
  });

  it('frames the task and keeps it to the app', () => {
    const prompt = screenPrompt({
      task: 'Make a note',
      app: 'Notes',
      timeBudgetS: 60,
      model: null,
    });
    expect(prompt).toContain('"Notes"');
    expect(prompt.endsWith('Make a note')).toBe(true);
  });
});

describe('the headless event stream', () => {
  it('folds session, steps, text and the final answer', () => {
    let s = emptyFold();
    for (const line of [
      '{"type":"session","sessionId":"session-1"}',
      '{"type":"tool_call","name":"run_code"}',
      'not json',
      '{"type":"text","text":"Opening Notes"}',
      '{"type":"tool_call","name":"run_code"}',
      '{"type":"final","sessionId":"session-1","reason":{"kind":"completed"},"text":"Made the note."}',
    ])
      s = foldEvent(s, line);
    expect(s).toEqual({
      sessionId: 'session-1',
      steps: 2,
      lastText: 'Opening Notes',
      finalText: 'Made the note.',
      reason: 'completed',
      error: null,
      finished: true,
    });
  });

  it('keeps an error', () => {
    expect(foldEvent(emptyFold(), '{"type":"error","message":"no model"}')).toMatchObject({
      error: 'no model',
      finished: true,
    });
  });
});

describe('the screen profile', () => {
  it('composes headless with Computer Use, PTC and the hub as provider, without the token', () => {
    const patch = screenPatch({
      hub: 'https://hub.example',
      model: 'claude-sonnet-4-5',
      consentPlugin: '/x/dist/screen-consent.js',
      app: 'Notes',
    });
    expect(patch).toContain('baseURL: "https://hub.example/api/v1/gateway/openai/v1"');
    expect(patch).toContain('apiKeyEnv: COREHUB_DSH_TOKEN');
    expect(patch).toContain('- id: tool-executor-ptc\n  disabled: false');
    expect(patch).toContain('agentPreset: false');
    expect(patch).toContain('app: "Notes"');
    expect(JSON.parse(screenProfileManifest()).dsh.profile.bundles).toContain(
      '@deepseek-ai/dsh-cua-bundle',
    );
  });

  it('starts the harness the way this process was started', () => {
    expect(dshCommand(['/opt/dsh', '--x'])).toEqual({ file: '/opt/dsh', args: ['--x'], env: {} });
    expect(
      dshCommand(null, {
        execPath: '/usr/bin/node',
        argv: ['/usr/bin/node', '/lib/dsh/bin.js'],
        versions: process.versions,
      }),
    ).toEqual({ file: '/usr/bin/node', args: ['/lib/dsh/bin.js'], env: {} });
    expect(
      dshCommand(null, {
        execPath: '/Applications/DSH.app/Contents/MacOS/DSH',
        argv: ['x', '/r/cli.js'],
        versions: { ...process.versions, electron: '40.0.0' },
      }).env,
    ).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });
});

describe('the screen consent answerer', () => {
  const approval = (subject: string) => ({
    id: 'q',
    intent: {
      kind: 'approval',
      approve: 'Allow',
      reject: 'Deny',
      always: 'Always',
      subject: { name: subject },
    },
  });

  it('grants the requested app for the session only, refuses others', () => {
    expect(answerFor([approval('Notes')], 'Notes')).toEqual({
      answers: [{ id: 'q', selected: ['Allow'] }],
    });
    expect(answerFor([approval('Mail')], 'Notes')).toEqual({
      answers: [{ id: 'q', selected: ['Deny'] }],
    });
    expect(answerFor([approval('Mail')], null)).toEqual({
      answers: [{ id: 'q', selected: ['Allow'] }],
    });
    expect(sameApp('notes', 'Notes.app')).toBe(true);
  });

  it('answers a plain question with "decide yourself"', () => {
    expect(answerFor([{ id: 'p' }], null)?.answers[0]).toMatchObject({ id: 'p', selected: [] });
    expect(answerFor([], null)).toBeNull();
  });
});
