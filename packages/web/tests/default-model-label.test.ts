// What the model picker says when no model is chosen (owner, 2026-09-29): which model that is.
import { describe, expect, it } from 'vitest';
import { composerModelOptions, defaultModelLabel } from '../src/chat/useComposerControls.js';
import { translate } from '../src/i18n/index.js';
import type { Agent, Model } from '../src/types.js';

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

describe('a coding agent on the hub’s models (ADR 0029)', () => {
  it("names the hub's default, as Hermes does", () => {
    expect(
      defaultModelLabel(
        agent({
          kind: 'acp',
          model_source: 'hub',
          agent_default_model: 'gpt-5-codex',
          default_model: { provider_id: 'p', model: 'google/gemini-2.5-pro' },
        }),
        MODELS,
        t,
      ),
    ).toBe('Default · Gemini 2.5 Pro');
    // On its own account it is its own settings' model, as before.
    expect(
      defaultModelLabel(
        agent({
          kind: 'acp',
          model_source: 'agent',
          agent_default_model: 'gpt-5-codex',
          default_model: null,
        }),
        MODELS,
        t,
      ),
    ).toBe('Default · gpt-5-codex');
  });

  it('is offered only the models the gateway serves', () => {
    const model = (key: string, agent_gateway?: boolean) =>
      ({
        key,
        provider: key.split('/')[0],
        model: key.split('/').slice(1).join('/'),
        alias: null,
        kind: 'chat',
        visible: true,
        disabled: false,
        ...(agent_gateway === undefined ? {} : { agent_gateway }),
      }) as unknown as Model;
    const catalogue = [
      model('openrouter/qwen/qwen3-coder', true),
      model('openai-codex/gpt-5.5', false),
      model('old-hub/model'),
    ];
    const keys = (options: { value: string }[]) => options.map((option) => option.value);
    expect(
      keys(composerModelOptions(catalogue, agent({ kind: 'acp', model_source: 'hub' }))),
    ).toEqual(['openrouter/qwen/qwen3-coder']);
    // Everyone else, and a coding agent on its own account, sees the whole catalogue.
    expect(
      keys(composerModelOptions(catalogue, agent({ kind: 'acp', model_source: 'agent' }))),
    ).toHaveLength(3);
    expect(keys(composerModelOptions(catalogue, agent({ kind: 'hermes' })))).toHaveLength(3);
    expect(keys(composerModelOptions(catalogue))).toHaveLength(3);
  });

  it('says where the card’s agent gets its models, in both languages', () => {
    expect(translate('en', 'agents.model_source.hub')).toBe("Models: Core Hub's providers");
    expect(translate('ar', 'agents.model_source.agent')).toBe('النماذج: حساب الوكيل نفسه');
  });
});
