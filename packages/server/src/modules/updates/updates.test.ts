/**
 * `updates`: what a client is offered, and what the hub refuses to offer.
 */
import { describe, expect, it } from 'vitest';
import {
  authed,
  drainJobs,
  expectModuleRegistered,
  signedInHub,
} from '../../../tests/unit/helpers.js';
import { compareRelease, isNewer, parseVersion, updatesModule } from './index.js';

describe('module: updates', () => {
  it('is composed by the app with routes and events registered', async () => {
    await expectModuleRegistered(updatesModule);
  });
});

describe('the version a client sends', () => {
  it('reads `<release>-<channel>.<build>`, and a bare release as build 0', () => {
    expect(parseVersion('1.0.2-test.22')).toEqual({ release: '1.0.2', build: 22 });
    expect(parseVersion('1.0.2')).toEqual({ release: '1.0.2', build: 0 });
    // Nonsense must not crash a check; build 0 loses to any real build, so the worst
    // outcome is being offered an update twice.
    expect(parseVersion('   ')).toEqual({ release: '', build: 0 });
  });

  it('compares releases number by number, not as text', () => {
    expect(compareRelease('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareRelease('1.0.0', '1.0.0')).toBe(0);
    expect(compareRelease('2.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('prefers a newer release, then a newer build of the same release', () => {
    expect(isNewer({ release: '1.1.0', build: 1 }, { release: '1.0.9', build: 99 })).toBe(true);
    expect(isNewer({ release: '1.0.0', build: 24 }, { release: '1.0.0', build: 22 })).toBe(true);
    expect(isNewer({ release: '1.0.0', build: 22 }, { release: '1.0.0', build: 22 })).toBe(false);
    expect(isNewer({ release: '0.9.0', build: 99 }, { release: '1.0.0', build: 1 })).toBe(false);
  });
});

describe('updates: the three answers to "is there a new build?"', () => {
  it('says not_configured when nothing was ever published — not an error', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/updates/check?platform=android&channel=stable&current_version=1.0.0',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        available: false,
        reason: 'not_configured',
        release: null,
      });
    } finally {
      await hub.close();
    }
  });

  it('publishes from an uploaded artefact, then offers it once and only once', async () => {
    const hub = await signedInHub();
    try {
      // The artefact arrives the way any file does.
      const boundary = '----majlis';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.apk"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`,
        ),
        Buffer.from('the-bytes'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const upload = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/attachments',
        payload: body,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(upload.statusCode).toBe(201);
      const attachmentId = (upload.json() as { id: string }).id;

      const published = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/updates/releases',
        payload: {
          platform: 'android',
          channel: 'test',
          version: '1.0.3',
          build: 24,
          notes: { ar: 'إصلاح', en: 'Fix' },
          attachment_id: attachmentId,
        },
      });
      expect(published.statusCode).toBe(202);
      await drainJobs(hub.app);

      const offered = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/updates/check?platform=android&channel=test&current_version=1.0.2-test.22',
      });
      const body1 = offered.json() as { available: boolean; release: Record<string, unknown> };
      expect(body1.available).toBe(true);
      // The download is always a path on this hub, never the place the bytes came from.
      expect(body1.release.download_url).toBe(
        `/api/v1/updates/releases/${body1.release.id as string}/download`,
      );
      expect(body1.release).toMatchObject({ version: '1.0.3', build: 24, size_bytes: 9 });

      const current = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/updates/check?platform=android&channel=test&current_version=1.0.3-test.24',
      });
      expect(current.json()).toMatchObject({ available: false, reason: 'up_to_date' });

      // And the bytes come back.
      const download = await authed(hub, hub.token, {
        method: 'GET',
        url: `/api/v1/updates/releases/${body1.release.id as string}/download`,
      });
      expect(download.statusCode).toBe(200);
      expect(download.body).toBe('the-bytes');
    } finally {
      await hub.close();
    }
  });

  it('refuses to publish a release with no artefact behind it', async () => {
    const hub = await signedInHub();
    try {
      const response = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/updates/releases',
        payload: {
          platform: 'android',
          channel: 'test',
          version: '1.0.3',
          build: 24,
          notes: { ar: '', en: '' },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ details: { reason: 'artifact_required' } });
    } finally {
      await hub.close();
    }
  });

  it('stops offering a release that was unpublished', async () => {
    const hub = await signedInHub();
    try {
      const boundary = '----majlis';
      const upload = await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/attachments',
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.apk"\r\n\r\n`,
          ),
          Buffer.from('x'),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      const attachmentId = (upload.json() as { id: string }).id;
      await authed(hub, hub.token, {
        method: 'POST',
        url: '/api/v1/updates/releases',
        payload: {
          platform: 'ios',
          channel: 'stable',
          version: '2.0.0',
          build: 1,
          notes: { ar: '', en: '' },
          attachment_id: attachmentId,
        },
      });
      await drainJobs(hub.app);
      const listed = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/updates/releases',
      });
      const items = (listed.json() as { items: Array<{ id: string }> }).items;
      expect(items).toHaveLength(1);

      const removed = await authed(hub, hub.token, {
        method: 'DELETE',
        url: `/api/v1/updates/releases/${items[0]!.id}`,
      });
      expect(removed.statusCode).toBe(204);

      const after = await authed(hub, hub.token, {
        method: 'GET',
        url: '/api/v1/updates/check?platform=ios&channel=stable&current_version=1.0.0',
      });
      expect(after.json()).toMatchObject({ available: false, reason: 'not_configured' });
    } finally {
      await hub.close();
    }
  });
});

describe('updates: where builds come from', () => {
  it('never sends the source token back, and keeps it when the client echoes `[stored]`', async () => {
    const hub = await signedInHub();
    try {
      const saved = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/updates/settings',
        payload: {
          default_channel: 'test',
          source: { kind: 'github_release', repo: 'twuijri/majlis-clients', token: 'ghp_secret' },
          auto_publish: true,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({
        default_channel: 'test',
        source: { kind: 'github_release', repo: 'twuijri/majlis-clients', token: '[stored]' },
        auto_publish: true,
      });
      expect(saved.body).not.toContain('ghp_secret');

      // `[stored]` means "keep the one you have", not "my token is the string [stored]".
      const again = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/updates/settings',
        payload: { source: { token: '[stored]' }, auto_publish: false },
      });
      expect(again.json()).toMatchObject({
        source: { repo: 'twuijri/majlis-clients', token: '[stored]' },
        auto_publish: false,
      });

      // And null forgets it.
      const cleared = await authed(hub, hub.token, {
        method: 'PUT',
        url: '/api/v1/updates/settings',
        payload: { source: { token: null } },
      });
      expect(cleared.json()).toMatchObject({ source: { token: null } });
    } finally {
      await hub.close();
    }
  });
});
