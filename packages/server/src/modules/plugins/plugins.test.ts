import { describe, expect, it } from 'vitest';
import { authed, signedInHub, expectModuleRegistered } from '../../../tests/unit/helpers.js';
import { pluginsModule } from './index.js';

describe('module: plugins', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(pluginsModule);
  });
});

describe('plugins: what is installed on this hub', () => {
  it('answers an empty list on a hub with no plugins, and does not invent one', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/plugins' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [] });
    } finally {
      await hub.close();
    }
  });
});
