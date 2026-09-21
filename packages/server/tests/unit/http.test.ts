import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpenApiDocument } from '@majlis/contracts';
import { defineModule } from '../../src/lib/module.js';
import { testHub, type TestHub } from './helpers.js';

const contract: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'test', version: '0' },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/health': { get: { operationId: 'getHealth', responses: { '200': { description: 'ok' } } } },
    '/things/{id}': {
      get: { operationId: 'getThing', responses: { '200': { description: 'ok' } } },
      delete: { operationId: 'deleteThing', responses: { '204': { description: 'gone' } } },
    },
  },
};

describe('http composition', () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await testHub({}, { contract });
  });
  afterAll(async () => {
    await hub.close();
  });

  it('serves GET /api/v1/health with the documented shape', async () => {
    const res = await hub.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      server_version: expect.any(String),
      uptime_seconds: expect.any(Number),
    });
  });

  it('answers unknown paths with the {error, code} envelope, localised by Accept-Language', async () => {
    const en = await hub.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(en.statusCode).toBe(404);
    expect(en.json()).toEqual({ error: 'The requested item does not exist.', code: 'not_found' });
    const ar = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/nope',
      headers: { 'accept-language': 'ar,en;q=0.5' },
    });
    expect(ar.json()).toEqual({ error: 'العنصر المطلوب غير موجود.', code: 'not_found' });
  });

  it('mounts a documented 501 stub for every contract operation no module implements', async () => {
    expect(hub.app.hub.stubs).toEqual(['GET /api/v1/things/:id', 'DELETE /api/v1/things/:id']);
    const res = await hub.app.inject({ method: 'DELETE', url: '/api/v1/things/42' });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({
      error: expect.any(String),
      code: 'not_implemented',
      details: { operationId: 'deleteThing' },
    });
  });

  it('does not stub an operation a module already implements (health)', () => {
    expect(hub.app.hub.stubs.some((stub) => stub.endsWith('/health'))).toBe(false);
  });

  it('reads the workspace scope header with a default (ADR 0005)', async () => {
    const scopeModule = defineModule({
      name: 'audit',
      registerRoutes(app) {
        app.get('/__scope', async (request) => ({ profile: request.hubProfile }));
      },
      registerEvents() {},
    });
    const scoped = await testHub({}, { contract: null, modules: [scopeModule] });
    try {
      const none = await scoped.app.inject({ method: 'GET', url: '/api/v1/__scope' });
      expect(none.json()).toEqual({ profile: 'default' });
      const work = await scoped.app.inject({
        method: 'GET',
        url: '/api/v1/__scope',
        headers: { 'x-hub-profile': 'work' },
      });
      expect(work.json()).toEqual({ profile: 'work' });
    } finally {
      await scoped.close();
    }
  });
});
