// While the hub's model gateway waits out a provider's refusal or tries the next model of the
// chain, the live indicator says so (owner, 2026-10-01: 88 s of "Thinking" with nothing else).
import { describe, expect, it } from 'vitest';
import { modelStatusWords } from '../src/chat/RunStatus.js';
import { initialChat, reduce } from '../src/chat/transcript.js';
import { translate } from '../src/i18n/index.js';
import type { Envelope } from '../src/realtime/envelope.js';

const t = (key: string, values?: Record<string, string | number>) => translate('en', key, values);
const envelope = (event: string, payload: Record<string, unknown>, seq: number): Envelope =>
  ({
    event,
    namespace: '/rt/sessions',
    profile: 'default',
    ts: '2026-10-01T10:00:00Z',
    seq,
    payload,
  }) as Envelope;

describe('run.status', () => {
  it('is held for its run until the model speaks', () => {
    let state = reduce(
      initialChat(),
      envelope(
        'run.status',
        {
          session_id: 'S',
          run_id: 'R',
          phase: 'waiting',
          provider: 'Google Antigravity',
          model: 'gemini-3.8-flash-high',
          seconds: 5,
          reason: 'no_capacity',
        },
        1,
      ),
      'S',
    );
    expect(state.modelStatus).toMatchObject({
      runId: 'R',
      phase: 'waiting',
      reason: 'no_capacity',
    });
    const at = state.modelStatus!.atMs;
    expect(modelStatusWords({ modelStatus: state.modelStatus }, t, at + 2_000)).toBe(
      'Google Antigravity · gemini-3.8-flash-high has no capacity right now — asking again in 3s',
    );
    state = reduce(
      state,
      envelope(
        'run.status',
        {
          session_id: 'S',
          run_id: 'R',
          phase: 'trying',
          provider: 'ChatGPT',
          model: 'gpt-6-sol',
          seconds: null,
          reason: 'no_capacity',
        },
        2,
      ),
      'S',
    );
    expect(modelStatusWords({ modelStatus: state.modelStatus }, t, Date.now())).toBe(
      'Trying ChatGPT · gpt-6-sol…',
    );
    state = reduce(
      state,
      envelope('message.delta', { session_id: 'S', run_id: 'R', message_id: 'M', delta: 'hi' }, 3),
      'S',
    );
    expect(state.modelStatus).toBeNull();
  });

  it('a limit that passes says so, and says nothing when there is nothing', () => {
    expect(
      modelStatusWords(
        {
          modelStatus: {
            runId: 'R',
            phase: 'waiting',
            provider: 'CLI Proxy',
            model: 'gemini-3-flash',
            seconds: 20,
            reason: 'rate_limited',
            atMs: 0,
          },
        },
        t,
        0,
      ),
    ).toBe('CLI Proxy · gemini-3-flash is limiting requests — asking again in 20s');
    expect(modelStatusWords({ modelStatus: null }, t, 0)).toBeNull();
  });
});
