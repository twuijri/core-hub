import { describe, expect, it } from 'vitest';
import {
  listOperations,
  loadOpenApiDocument,
  serverBasePath,
  toRoutePattern,
} from '../src/document.js';

describe('openapi document', () => {
  const doc = loadOpenApiDocument();

  it('exists and is OpenAPI 3.1 (ADR 0003)', () => {
    expect(doc).not.toBeNull();
    expect(doc?.openapi.startsWith('3.1')).toBe(true);
  });

  it('serves everything under /api/v1 (ARCHITECTURE §Contract)', () => {
    expect(serverBasePath(doc!)).toBe('/api/v1');
  });

  it('declares the health operation and an operationId on every operation', () => {
    const ops = listOperations(doc!);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) expect(op.operationId, `${op.method} ${op.path}`).toBeTruthy();
    expect(ops.some((op) => op.method === 'get' && op.fullPath === '/api/v1/health')).toBe(true);
  });

  it('converts contract paths into Fastify route patterns', () => {
    expect(toRoutePattern('/sessions/{id}/messages/{messageId}')).toBe(
      '/sessions/:id/messages/:messageId',
    );
  });
});
