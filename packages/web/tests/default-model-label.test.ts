// What the model picker says when no model is chosen (owner, 2026-09-29): which model that is.
import { describe, expect, it } from 'vitest';
import { defaultModelLabel } from '../src/chat/useComposerControls.js';
import { translate } from '../src/i18n/index.js';
import type { Agent } from '../src/types.js';

const t = (key: string, values?: Record<string, string | number>) => translate('en', key, values);
const agent = (over: Partial<Agent>) => over as Agent;
const MODELS = [{ value: 'openrouter/google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' }];

describe('the default model, named', () => {
  it("Hermes: the profile's default, by its catalogue label", () => {
    expect(
      defaultModelLabel(
        agent({
          kind: 'hermes',
          default_model: { provider_id: 'p', model: 'google/gemini-2.5-pro' },
        }),
        MODELS,
        t,
      ),
    ).toBe('Default · Gemini 2.5 Pro');
    expect(
      defaultModelLabel(
        agent({ kind: 'hermes', default_model: { provider_id: 'p', model: 'x-1' } }),
        [],
        t,
      ),
    ).toBe('Default · x-1');
    expect(defaultModelLabel(agent({ kind: 'hermes', default_model: null }), MODELS, t)).toBeNull();
  });

  it("a coding agent: its own settings' model, else only the agent knows", () => {
    expect(
      defaultModelLabel(
        agent({ kind: 'acp', agent_default_model: 'gpt-5-codex', default_model: null }),
        MODELS,
        t,
      ),
    ).toBe('Default · gpt-5-codex');
    expect(defaultModelLabel(agent({ kind: 'acp', default_model: null }), MODELS, t)).toBe(
      "Agent's own default",
    );
    expect(translate('ar', 'composer.model_agent_default')).toBe('افتراضي الوكيل نفسه');
  });
});
