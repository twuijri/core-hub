// The Swift generator reads a prepared copy of the contract (scripts/swift-openapi.mjs).
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script without type declarations
import { loadDocument } from '../scripts/lib.mjs';
// @ts-expect-error — a plain .mjs script without type declarations
import { prepareForSwift, withoutNull } from '../scripts/swift-openapi.mjs';

type Schema = Record<string, unknown> & {
  required?: string[];
  properties?: Record<string, Schema>;
  allOf?: Schema[];
};

const prepared = () =>
  prepareForSwift(loadDocument()) as {
    components: { schemas: Record<string, Schema> };
    paths: Record<string, Record<string, { parameters?: { $ref?: string }[] }>>;
  };

describe('prepareForSwift', () => {
  it('turns a nullable $ref into an optional property', () => {
    const session = prepared().components.schemas.Session!.allOf![1]!;
    for (const name of ['category_id', 'active_run_id', 'last_message_at', 'title', 'usage']) {
      expect(session.required).not.toContain(name);
      const prop = session.properties![name]!;
      expect(JSON.stringify(prop.oneOf ?? prop.type ?? '')).not.toContain('null');
    }
    expect(session.required).toContain('agent_id');
    expect(session.properties!.category_id).toEqual({ $ref: '#/components/schemas/Ulid' });
  });

  it('copies path-item parameters into each operation', () => {
    const doc = prepared();
    const refs = doc.paths['/sessions/{session_id}/runs']!.post!.parameters!.map((p) => p.$ref);
    expect(refs).toContain('#/components/parameters/SessionId');
    expect(refs).toContain('#/components/parameters/Profile');
    expect(doc.paths['/sessions/{session_id}/runs']!.parameters).toBeUndefined();
  });

  it('renames the components Swift already owns, and every reference to them', () => {
    const doc = prepared();
    expect(doc.components.schemas.Task).toBeUndefined();
    expect(doc.components.schemas.Locale).toBeUndefined();
    expect(doc.components.schemas.HubTask).toBeDefined();
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"#/components/schemas/Task"');
    expect(text).not.toContain('"#/components/schemas/Locale"');
  });

  it('never rewrites the source document', () => {
    const before = JSON.stringify(loadDocument());
    prepared();
    expect(JSON.stringify(loadDocument())).toBe(before);
  });

  it('keeps a non-null branch and its siblings', () => {
    expect(withoutNull({ description: 'd', oneOf: [{ $ref: '#/x' }, { type: 'null' }] })).toEqual({
      description: 'd',
      $ref: '#/x',
    });
    expect(withoutNull({ type: ['string', 'null'], maxLength: 3 })).toEqual({
      type: 'string',
      maxLength: 3,
    });
  });
});
