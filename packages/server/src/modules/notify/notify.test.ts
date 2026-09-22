/**
 * Notices, preferences and webhooks over HTTP.
 */
import { describe, expect, it } from 'vitest';
import {
  authed,
  drainJobs,
  expectModuleRegistered,
  signedInHub,
} from '../../../tests/unit/helpers.js';
import { notifyModule, overrideNotify, record } from './index.js';
import { requireSqlite } from '../../lib/db.js';

type Json = Record<string, unknown>;

const hook = {
  name: 'CI',
  url: 'https://example.com/hook',
  events: ['run.failed'],
  profiles: [],
  enabled: true,
  secret: null,
  include_content: false,
  allow_private_network: false,
  max_retries: 3,
};

const dns = async (host: string) =>
  host === 'example.com' ? ['93.184.216.34'] : host === 'inside.example' ? ['10.0.0.9'] : [];

describe('module: notify', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(notifyModule);
  });
});

describe('notify: the inbox', () => {
  it('is empty on a hub where nothing has happened, and does not invent a welcome', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/notify/notices',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [], next_cursor: null, unread_count: 0 });
    } finally {
      await hub.close();
    }
  });

  it('shows what another module wrote, and marks it read', async () => {
    const hub = await signedInHub();
    try {
      const workspace = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' })
      ).json() as { items: Array<{ id: string }> };
      const db = requireSqlite(hub.app.hub.database);
      record(db, {
        workspace: workspace.items[0]!.id,
        userId: hub.userId,
        kind: 'run_failed',
        title: 'A run failed',
        entityKind: 'session',
        entityId: '01J8QK3ZR2W7M5N4P6T8V9X0SE',
      });

      const listed = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/notices' })
      ).json() as { items: Json[] };
      expect(listed.items).toHaveLength(1);
      // The table's thirteen kinds map onto the contract's seven.
      expect(listed.items[0]).toMatchObject({
        kind: 'run_completed',
        title: 'A run failed',
        read_at: null,
        resource: { kind: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0SE' },
      });

      const read = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/notify/notices/${listed.items[0]!.id as string}`,
        payload: { read: true },
      });
      expect((read.json() as Json).read_at).not.toBeNull();

      const unread = (
        await authed(hub, hub.token, {
          method: 'GET',
          url: '/api/v1/notify/notices?unread=true',
        })
      ).json() as { items: Json[] };
      expect(unread.items).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it('marks everything read at once and says how many', async () => {
    const hub = await signedInHub();
    try {
      const workspace = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/profiles' })
      ).json() as { items: Array<{ id: string }> };
      const db = requireSqlite(hub.app.hub.database);
      for (const title of ['one', 'two', 'three']) {
        record(db, {
          workspace: workspace.items[0]!.id,
          userId: hub.userId,
          kind: 'system',
          title,
        });
      }
      const response = await authed(hub, hub.token, {
        method: 'PATCH',
        url: '/api/v1/notify/notices',
        payload: { before: null },
      });
      expect(response.json()).toEqual({ updated: 3 });
    } finally {
      await hub.close();
    }
  });
});

describe('notify: preferences', () => {
  it('remembers the quiet window it was given, in the zone it was given', async () => {
    const hub = await signedInHub();
    try {
      const window = {
        enabled: true,
        from: '23:30',
        to: '06:15',
        timezone: 'Asia/Riyadh',
      };
      const saved = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/notify/preferences',
        payload: { events: {}, quiet_hours: window },
      });
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as Json).quiet_hours).toEqual(window);
      // And on the way back out — a window that answers 22:00–07:00 whatever you typed
      // is not a setting, it is a decoration.
      const read = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/notify/preferences',
      });
      expect((read.json() as Json).quiet_hours).toEqual(window);
    } finally {
      await hub.close();
    }
  });

  it('keeps a window that was switched off, because it will be switched back on', async () => {
    const hub = await signedInHub();
    try {
      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/notify/preferences',
        payload: {
          events: {},
          quiet_hours: { enabled: true, from: '23:00', to: '05:00', timezone: 'UTC' },
        },
      });
      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/notify/preferences',
        payload: {
          events: {},
          quiet_hours: { enabled: false, from: '23:00', to: '05:00', timezone: 'UTC' },
        },
      });
      const read = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/notify/preferences',
      });
      expect((read.json() as Json).quiet_hours).toEqual({
        enabled: false,
        from: '23:00',
        to: '05:00',
        timezone: 'UTC',
      });
    } finally {
      await hub.close();
    }
  });

  it('stores only what was changed, because a missing kind means "on"', async () => {
    const hub = await signedInHub();
    try {
      const empty = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/preferences' })
      ).json() as Json;
      expect(empty.events).toEqual({});

      await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/notify/preferences',
        payload: {
          events: { run_completed: { in_app: true, push: false } },
          quiet_hours: { enabled: false, from: '22:00', to: '07:00', timezone: 'UTC' },
        },
      });
      const after = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/preferences' })
      ).json() as Json;
      expect(after.events).toEqual({ run_completed: { in_app: true, push: false } });
    } finally {
      await hub.close();
    }
  });
});

describe('notify: webhooks', () => {
  it('refuses a URL that resolves somewhere private, before storing it', async () => {
    overrideNotify({ resolveHost: dns });
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/notify/webhooks',
        payload: { ...hook, url: 'https://inside.example/hook' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ details: { reason: 'url_private' } });

      const listed = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/webhooks' })
      ).json() as { items: unknown[] };
      // Refused means not stored.
      expect(listed.items).toEqual([]);
    } finally {
      overrideNotify({});
      await hub.close();
    }
  });

  it('allows the private one when the person said so on purpose', async () => {
    overrideNotify({ resolveHost: dns });
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/notify/webhooks',
        payload: { ...hook, url: 'https://inside.example/hook', allow_private_network: true },
      });
      expect(response.statusCode).toBe(201);
    } finally {
      overrideNotify({});
      await hub.close();
    }
  });

  it('never sends a signing secret back, and keeps it when the client echoes [stored]', async () => {
    overrideNotify({ resolveHost: dns });
    const hub = await signedInHub();
    try {
      const created = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/notify/webhooks',
        payload: { ...hook, secret: 'top-secret' },
      });
      expect(created.body).not.toContain('top-secret');
      expect((created.json() as Json).secret).toBe('[stored]');

      const id = (created.json() as Json).id as string;
      const kept = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/notify/webhooks/${id}`,
        payload: { secret: '[stored]', name: 'CI renamed' },
      });
      expect(kept.json()).toMatchObject({ name: 'CI renamed', secret: '[stored]' });

      const cleared = await authed(hub, hub.token, {
        method: 'PATCH',
        url: `/api/v1/notify/webhooks/${id}`,
        payload: { secret: null },
      });
      expect((cleared.json() as Json).secret).toBeNull();
    } finally {
      overrideNotify({});
      await hub.close();
    }
  });

  it('sends a signed test and records what came back', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    overrideNotify({
      resolveHost: dns,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          headers: init.headers as Record<string, string>,
          body: String(init.body),
        });
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch,
    });
    const hub = await signedInHub();
    try {
      const created = (
        await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/notify/webhooks',
          payload: { ...hook, secret: 'top-secret' },
        })
      ).json() as Json;

      const test = await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/notify/webhooks/${created.id as string}/test`,
      });
      expect(test.statusCode).toBe(202);
      await drainJobs(hub.app);

      expect(calls).toHaveLength(1);
      // Signed, so the receiver can verify the body instead of trusting it.
      expect(calls[0]!.headers['x-majlis-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(JSON.parse(calls[0]!.body)).toMatchObject({ event: 'webhook.test' });

      const after = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/webhooks' })
      ).json() as { items: Json[] };
      expect((after.items[0]!.stats as Json).delivered).toBe(1);
    } finally {
      overrideNotify({});
      await hub.close();
    }
  });

  it('records a failure rather than pretending the endpoint answered', async () => {
    overrideNotify({
      resolveHost: dns,
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });
    const hub = await signedInHub();
    try {
      const created = (
        await authed(hub, hub.token, {
          method: 'POST',
          url: '/api/v1/notify/webhooks',
          payload: hook,
        })
      ).json() as Json;
      await authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/notify/webhooks/${created.id as string}/test`,
      });
      await drainJobs(hub.app);
      const after = (
        await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/webhooks' })
      ).json() as { items: Json[] };
      expect((after.items[0]!.stats as Json).failed).toBe(1);
      expect((after.items[0]!.stats as Json).last_error).toContain('connection refused');
    } finally {
      overrideNotify({});
      await hub.close();
    }
  });

  it('serves the event catalogue from the contract rather than a list in the code', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/notify/webhook-events',
      });
      const names = (response.json() as { items: Array<{ name: string }> }).items.map(
        (i) => i.name,
      );
      expect(names).toContain('run.completed');
      expect(names.length).toBeGreaterThan(10);
    } finally {
      await hub.close();
    }
  });
});
