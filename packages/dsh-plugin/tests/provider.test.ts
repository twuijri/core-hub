import { describe, expect, it } from 'vitest';
import {
  providerRow,
  sameProvider,
  withBearer,
  withProvider,
  withoutProvider,
} from '../src/provider.js';
import { TOKEN_PLACEHOLDER } from '../src/names.js';

describe('the Core Hub provider row', () => {
  const row = providerRow('https://hub.example', [
    { id: 'm1', name: 'Model 1', context_window: 1000, image: false },
  ]);

  it('points at the gateway entrance with a placeholder header, never the token', () => {
    expect(row).toMatchObject({
      displayName: 'Core Hub',
      api: 'openai-completions',
      baseURL: 'https://hub.example/api/v1/gateway/openai/v1',
      headers: { Authorization: TOKEN_PLACEHOLDER },
      models: [{ id: 'm1', name: 'Model 1', contextWindow: 1000, input: ['text'] }],
    });
    expect(JSON.stringify(row)).not.toContain('hub_at_');
  });

  it('declares images per model, only for the models the hub says take them', () => {
    // Owner, 2026-11-23: an image to chatgpt-subscription/gpt-6.2-sol was refused by the harness
    // ("the current model does not support images"): with no `input`, pi-ai assumes text only.
    const both = providerRow('https://hub.example', [
      { id: 'chatgpt-subscription/gpt-6.2-sol', name: null, context_window: null, image: true },
      { id: 'kimi-subscription/kimi-k2', name: null, context_window: null, image: false },
    ]);
    expect(both.models).toEqual([
      { id: 'chatgpt-subscription/gpt-6.2-sol', input: ['text', 'image'] },
      { id: 'kimi-subscription/kimi-k2', input: ['text'] },
    ]);
    // Never a provider-wide claim: a model that cannot see would be refused mid-turn.
    expect(both).not.toHaveProperty('defaultInput');
  });

  it('keeps every other provider', () => {
    const current = { retry: 1, providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } };
    const next = withProvider(current, row);
    expect(next).toEqual({
      retry: 1,
      providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' }, corehub: row },
    });
    expect(sameProvider(next, row)).toBe(true);
    expect(withoutProvider(next)).toEqual(current);
  });

  it('puts the bearer on Core Hub requests only', () => {
    const mine = new Headers({ Authorization: TOKEN_PLACEHOLDER });
    withBearer('corehub', mine, 'hub_at_x');
    expect(mine.get('authorization')).toBe('Bearer hub_at_x');
    const other = new Headers({ Authorization: 'Bearer theirs' });
    withBearer('openai', other, 'hub_at_x');
    expect(other.get('authorization')).toBe('Bearer theirs');
    withBearer('corehub', mine, null);
    expect(mine.get('authorization')).toBe('Bearer hub_at_x');
  });
});
