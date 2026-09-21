import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isReservedPath } from '../../src/app/web.js';
import { testHub, type TestHub } from './helpers.js';

describe('the built web client served from /', () => {
  let hub: TestHub;
  let webDir: string;
  beforeAll(async () => {
    webDir = mkdtempSync(path.join(tmpdir(), 'majlis-web-'));
    mkdirSync(path.join(webDir, 'assets'));
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
    hub = await testHub({}, { webDir });
  });
  afterAll(async () => {
    await hub.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it('answers / and any deep link with index.html (SPA fallback)', async () => {
    for (const url of ['/', '/chat/01J8QK3ZR2W7M5N4P6T8V9X0YA', '/settings/display']) {
      const res = await hub.app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('id="root"');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
    expect(hub.app.hub.web).toBe(true);
  });

  it('serves fingerprinted assets as immutable', async () => {
    const res = await hub.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('never shadows the API: unknown /api paths keep the JSON envelope, health still answers', async () => {
    const missing = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/no-such-thing',
      headers: { accept: 'text/html' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'not_found' });
    const health = await hub.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    const rt = await hub.app.inject({
      method: 'GET',
      url: '/rt/?EIO=4&transport=polling',
      headers: { accept: 'text/html' },
    });
    expect(rt.headers['content-type']).not.toMatch(/text\/html/);
  });

  it('a JSON-only client on a page path gets the JSON 404, not index.html', async () => {
    const res = await hub.app.inject({
      method: 'GET',
      url: '/chat',
      headers: { accept: 'application/json' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });

  it('reserves /api and /rt', () => {
    expect(isReservedPath('/api/v1/sessions?limit=1')).toBe(true);
    expect(isReservedPath('/rt/?EIO=4')).toBe(true);
    expect(isReservedPath('/rt')).toBe(true);
    expect(isReservedPath('/rtx')).toBe(false);
    expect(isReservedPath('/apix')).toBe(false);
  });
});

describe('a hub built without the web client', () => {
  it('keeps / as a JSON 404', async () => {
    const hub = await testHub({}, { webDir: path.join(tmpdir(), 'majlis-no-web-here') });
    try {
      const res = await hub.app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'text/html' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not_found' });
      expect(hub.app.hub.web).toBe(false);
    } finally {
      await hub.close();
    }
  });
});
