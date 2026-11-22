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
    { id: 'm1', name: 'Model 1', context_window: 1000 },
  ]);

  it('points at the gateway entrance with a placeholder header, never the token', () => {
    expect(row).toMatchObject({
      displayName: 'Core Hub',
      api: 'openai-completions',
      baseURL: 'https://hub.example/api/v1/gateway/openai/v1',
      headers: { Authorization: TOKEN_PLACEHOLDER },
      models: [{ id: 'm1', name: 'Model 1', contextWindow: 1000 }],
    });
    expect(JSON.stringify(row)).not.toContain('hub_at_');
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
