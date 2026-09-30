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

  it('leaves out a model that cannot call tools, and marks one with a small context (§141)', () => {
    const model = (key: string, extra: Partial<Model>) =>
      ({
        key,
        provider: key.split('/')[0],
        model: key.split('/').slice(1).join('/'),
        alias: null,
        kind: 'chat',
        visible: true,
        disabled: false,
        agent_gateway: true,
        context_window: null,
        ...extra,
      }) as unknown as Model;
    const catalogue = [
      model('openrouter/qwen/qwen3-coder', { context_window: 262_144 }),
      model('openrouter/tiny/no-tools', { agent_tools: false, context_window: 131_072 }),
      model('openrouter/small/window', { context_window: 32_768 }),
      model('ollama/unknown', {}),
    ];
    const small = (floor: number) => t('composer.model_small_context', { tokens: floor / 1000 });
    const onHub = agent({ kind: 'acp', model_source: 'hub', gateway_min_context: 64_000 });
    const options = composerModelOptions(catalogue, onHub, small);
    expect(options.map((option) => option.value)).toEqual([
      'openrouter/qwen/qwen3-coder',
      'openrouter/small/window',
      'ollama/unknown',
    ]);
    expect(options[0]?.detail).toBe('openrouter/qwen/qwen3-coder');
    expect(options[1]?.detail).toBe('openrouter/small/window · small context (under 64K)');
    // An unknown window says nothing; on its own account nothing is left out or marked.
    expect(options[2]?.detail).toBe('ollama/unknown');
    const own = composerModelOptions(
      catalogue,
      agent({ kind: 'acp', model_source: 'agent', gateway_min_context: 64_000 }),
      small,
    );
    expect(own).toHaveLength(4);
    expect(own.every((option) => !option.detail?.includes('small context'))).toBe(true);
    expect(translate('ar', 'composer.model_small_context', { tokens: 64 })).toBe(
      'سياق صغير (أقل من 64 ألف)',
    );
  });

  it('says where the card’s agent gets its models, in both languages', () => {
    expect(translate('en', 'agents.model_source.hub')).toBe("Models: Core Hub's providers");
    expect(translate('ar', 'agents.model_source.agent')).toBe('النماذج: حساب الوكيل نفسه');
  });
});
